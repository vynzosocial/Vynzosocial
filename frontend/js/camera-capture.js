const DURATIONS = [
  { value: 15, label: '15s' },
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
  { value: 60, label: 'Free' }
];
const MAX_SECONDS = 60;

export function openCamera(onCapture, options = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Camera is not supported in this browser.');
    return;
  }

  let stream = null;
  let recorder = null;
  let chunks = [];
  let timer = null;
  let elapsed = 0;
  let limit = 15;
  const videoOnly = options.videoOnly === true;
  let mode = videoOnly ? 'video' : 'photo';
  let facing = 'user';
  let result = null;

  const overlay = document.createElement('div');
  overlay.className = 'camera-overlay';
  overlay.innerHTML = `
    <div class="camera-dialog" role="dialog" aria-modal="true" aria-label="Camera">
      <button type="button" class="camera-close" aria-label="Close camera">×</button>
      <div class="camera-stage">
        <video class="camera-live" autoplay muted playsinline></video>
        <div class="camera-result" hidden></div>
        <span class="camera-timer" hidden>0:00</span>
      </div>
      <p class="camera-message" aria-live="polite"></p>
      <div class="camera-modes">
        <button type="button" data-mode="photo" class="active">Photo</button>
        <button type="button" data-mode="video">Video</button>
      </div>
      <div class="camera-durations" hidden></div>
      <div class="camera-actions">
        <button type="button" class="camera-flip">Flip</button>
        <button type="button" class="camera-shutter" aria-label="Capture"></button>
        <button type="button" class="camera-retake" hidden>Retake</button>
        <button type="button" class="camera-use" hidden>Use this</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = (selector) => overlay.querySelector(selector);
  const live = $('.camera-live');
  const resultBox = $('.camera-result');
  const timerLabel = $('.camera-timer');
  const message = $('.camera-message');
  const shutter = $('.camera-shutter');
  const durationsBox = $('.camera-durations');
  const modesBox = $('.camera-modes');
  const flipButton = $('.camera-flip');

  DURATIONS.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = option.label;
    button.dataset.index = index;
    if (index === 0) button.classList.add('active');
    durationsBox.appendChild(button);
  });

  function formatTime(seconds) {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function stopStream() {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
  }

  async function startStream() {
    stopStream();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing },
        audio: mode === 'video'
      });
      live.srcObject = stream;
      message.textContent = '';
    } catch (err) {
      message.textContent = 'Could not access the camera or microphone. Allow permission in your browser, or in Settings > Apps > Vynzo > Permissions, then try again.';
    }
  }

  function close() {
    clearInterval(timer);
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    stopStream();
    if (result?.url) URL.revokeObjectURL(result.url);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }

  function onKey(event) {
    if (event.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);

  function showResult(file) {
    if (result?.url) URL.revokeObjectURL(result.url);
    result = { file, url: URL.createObjectURL(file) };
    resultBox.replaceChildren();
    const isVideo = file.type.startsWith('video/');
    const element = document.createElement(isVideo ? 'video' : 'img');
    element.src = result.url;
    if (isVideo) {
      element.controls = true;
      element.playsInline = true;
    }
    resultBox.appendChild(element);
    resultBox.hidden = false;
    live.hidden = true;
    timerLabel.hidden = true;
    shutter.hidden = true;
    flipButton.hidden = true;
    modesBox.hidden = true;
    durationsBox.hidden = true;
    $('.camera-retake').hidden = false;
    $('.camera-use').hidden = false;
  }

  function resetToLive() {
    if (result?.url) URL.revokeObjectURL(result.url);
    result = null;
    resultBox.hidden = true;
    resultBox.replaceChildren();
    live.hidden = false;
    shutter.hidden = false;
    flipButton.hidden = false;
    modesBox.hidden = videoOnly;
    durationsBox.hidden = mode !== 'video';
    $('.camera-retake').hidden = true;
    $('.camera-use').hidden = true;
  }

  function capturePhoto() {
    if (!live.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = live.videoWidth;
    canvas.height = live.videoHeight;
    canvas.getContext('2d').drawImage(live, 0, 0);
    canvas.toBlob(blob => {
      if (blob) showResult(new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
  }

  function stopRecording() {
    if (recorder && recorder.state === 'recording') recorder.stop();
  }

  function startRecording() {
    if (!stream || typeof MediaRecorder === 'undefined') {
      message.textContent = 'Video recording is not supported in this browser.';
      return;
    }
    chunks = [];
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      .find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => {
      clearInterval(timer);
      shutter.classList.remove('recording');
      const baseType = (recorder.mimeType || 'video/webm').split(';')[0];
      const extension = baseType === 'video/mp4' ? 'mp4' : 'webm';
      showResult(new File(chunks, `camera-${Date.now()}.${extension}`, { type: baseType }));
    };
    recorder.start(1000);
    elapsed = 0;
    timerLabel.hidden = false;
    timerLabel.textContent = `0:00 / ${formatTime(limit)}`;
    shutter.classList.add('recording');
    durationsBox.hidden = true;
    modesBox.hidden = true;
    flipButton.hidden = true;
    timer = setInterval(() => {
      elapsed += 1;
      timerLabel.textContent = `${formatTime(elapsed)} / ${formatTime(limit)}`;
      if (elapsed >= limit) stopRecording();
    }, 1000);
  }

  shutter.addEventListener('click', () => {
    if (mode === 'photo') capturePhoto();
    else if (recorder?.state === 'recording') stopRecording();
    else startRecording();
  });

  modesBox.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', async () => {
      mode = button.dataset.mode;
      modesBox.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
      durationsBox.hidden = mode !== 'video';
      shutter.classList.toggle('video-mode', mode === 'video');
      await startStream();
    });
  });

  durationsBox.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    limit = Math.min(DURATIONS[Number(button.dataset.index)].value, MAX_SECONDS);
    durationsBox.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
  });

  flipButton.addEventListener('click', async () => {
    facing = facing === 'user' ? 'environment' : 'user';
    await startStream();
  });
  $('.camera-retake').addEventListener('click', resetToLive);
  $('.camera-use').addEventListener('click', () => {
    const file = result?.file;
    close();
    if (file) onCapture(file);
  });
  $('.camera-close').addEventListener('click', close);
  overlay.addEventListener('click', event => {
    if (event.target === overlay) close();
  });

  if (videoOnly) {
    modesBox.hidden = true;
    durationsBox.hidden = false;
    shutter.classList.add('video-mode');
  }
  startStream();
}
