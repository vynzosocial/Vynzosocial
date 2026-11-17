import { createCameraSwitcher } from './camera-devices.js';

export const MAX_CAMERA_VIDEO_SECONDS = 10;

export function chooseMessageCamera(onPhoto, onVideo) {
  const overlay = document.createElement('div');
  overlay.className = 'message-camera-overlay';
  const panel = document.createElement('div');
  panel.className = 'message-camera-panel';
  const close = () => {
    document.removeEventListener('keydown', escape);
    overlay.remove();
  };
  const escape = event => { if (event.key === 'Escape') close(); };
  for (const [label, action] of [
    ['Take photo', onPhoto],
    [`Record video (up to ${MAX_CAMERA_VIDEO_SECONDS}s)`, onVideo],
    ['Cancel', () => {}]
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => { close(); action(); });
    panel.append(button);
  }
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Camera');
  overlay.append(panel);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', escape);
  document.body.append(overlay);
}

export async function recordMessageVideo(onCapture, onError) {
  let stream;
  let recorder;
  let timer;
  let clock;
  let cancelled = false;
  let disposed = false;
  const overlay = document.createElement('div');
  overlay.className = 'message-camera-overlay';
  const panel = document.createElement('div');
  panel.className = 'message-camera-panel';
  const preview = document.createElement('video');
  preview.autoplay = true;
  preview.muted = true;
  preview.playsInline = true;
  const status = document.createElement('p');
  status.textContent = `Camera videos can be up to ${MAX_CAMERA_VIDEO_SECONDS} seconds.`;
  status.setAttribute('role', 'status');
  const record = document.createElement('button');
  record.type = 'button';
  record.textContent = 'Start recording';
  record.disabled = true;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const flip = document.createElement('button');
  flip.type = 'button';
  flip.textContent = 'Switch camera';
  flip.disabled = true;
  const cameraSwitcher = createCameraSwitcher({
    getStream: () => disposed ? null : stream,
    constraints: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
    onChanged: () => { preview.srcObject = stream; },
    onError
  });
  flip.addEventListener('click', async () => {
    if (recorder || cameraSwitcher.switching) return;
    flip.disabled = true;
    record.disabled = true;
    try {
      await cameraSwitcher.switchCamera();
    } finally {
      flip.disabled = false;
      record.disabled = false;
    }
  });
  panel.append(preview, status, flip, record, cancel);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Record camera video');
  overlay.append(panel);
  document.body.append(overlay);

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    clearInterval(clock);
    stream?.getTracks().forEach(track => track.stop());
    document.removeEventListener('keydown', escape);
    document.removeEventListener('visibilitychange', hidden);
    overlay.remove();
  };
  const stop = () => {
    record.disabled = true;
    if (recorder?.state === 'recording') recorder.stop();
  };
  const dismiss = () => { cancelled = true; stop(); cleanup(); };
  const escape = event => { if (event.key === 'Escape') dismiss(); };
  const hidden = () => { if (document.visibilityState === 'hidden') dismiss(); };
  cancel.addEventListener('click', dismiss);
  overlay.addEventListener('click', event => { if (event.target === overlay) dismiss(); });
  document.addEventListener('keydown', escape);
  document.addEventListener('visibilitychange', hidden);

  try {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('Camera video recording is not supported on this device.');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    if (disposed) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    preview.srcObject = stream;
    await preview.play();
    if (disposed) return;
    record.disabled = false;
    flip.disabled = false;
    record.addEventListener('click', () => {
      if (recorder) { stop(); return; }
      try {
        const mimeType = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
          .find(type => MediaRecorder.isTypeSupported(type));
        if (!mimeType) throw new Error('Video recording is not supported on this device.');
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000 });
        const chunks = [];
        recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
        recorder.addEventListener('error', event => {
          cancelled = true;
          cleanup();
          onError(event.error?.message || 'Camera recording failed. Please try again.');
        });
        recorder.addEventListener('stop', () => {
          cleanup();
          if (cancelled) return;
          const type = mimeType.split(';')[0];
          const blob = new Blob(chunks, { type });
          if (!blob.size) { onError('No video was recorded. Please try again.'); return; }
          onCapture(new File([blob], `camera-${Date.now()}.${type === 'video/mp4' ? 'mp4' : 'webm'}`, { type }));
        });
        recorder.start();
        flip.disabled = true;
        record.textContent = 'Stop recording';
        const started = Date.now();
        timer = setTimeout(stop, MAX_CAMERA_VIDEO_SECONDS * 1000);
        clock = setInterval(() => {
          status.textContent = `Recording ${Math.min(MAX_CAMERA_VIDEO_SECONDS, Math.floor((Date.now() - started) / 1000))}/${MAX_CAMERA_VIDEO_SECONDS}s`;
        }, 200);
      } catch (error) {
        cancelled = true;
        cleanup();
        onError(error.message || 'Could not start camera recording.');
      }
    });
  } catch (error) {
    const wasCancelled = disposed;
    cleanup();
    if (!wasCancelled) onError(error.message || 'Camera or microphone permission was denied.');
  }
}
