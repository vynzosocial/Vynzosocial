const FILTERS = {
  warm: 'sepia(0.18) saturate(1.12)',
  cool: 'saturate(0.9) hue-rotate(10deg)',
  vivid: 'contrast(1.08) saturate(1.3)',
  mono: 'grayscale(1)'
};
const FACE_FILTERS = new Set([
  'lipstick', 'blush', 'glasses', 'party', 'eyeshadow', 'eyeliner',
  'lashes', 'eyebrows', 'eyes-blue', 'eyes-green', 'eyes-violet', 'hat', 'stars', 'skin'
]);
const IRIS_FILTERS = new Set(['eyes-blue', 'eyes-green', 'eyes-violet']);
const BACKGROUNDS = { 'background-blue': '#385f96', 'background-purple': '#694888', 'background-dark': '#212231' };

export async function createCameraFilter(track, name, onError, signal, backgroundImage) {
  const isBackground = name in BACKGROUNDS || name === 'background-image';
  if (!FILTERS[name] && !FACE_FILTERS.has(name) && !isBackground) throw new Error('Unknown camera filter.');
  if (name === 'background-image' && !backgroundImage) throw new Error('Choose a background image.');
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context || !('filter' in context) || typeof canvas.captureStream !== 'function') {
    video.srcObject = null;
    throw new Error('Camera filters are not supported by this browser.');
  }

  let output;
  let frame = null;
  let stopped = false;
  let filter = name;
  let faceTracker = null;
  let backgroundRenderer = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (faceTracker) faceTracker.stop();
    if (backgroundRenderer) backgroundRenderer.stop();
    if (frame !== null) cancelAnimationFrame(frame);
    if (output) output.getTracks().forEach(outputTrack => outputTrack.stop());
    video.pause();
    video.srcObject = null;
    track.removeEventListener('ended', sourceEnded);
  };
  const sourceEnded = () => {
    stop();
    onError(new Error('The camera stopped while a filter was active.'));
  };
  try {
    let timer;
    let abort;
    try {
      await Promise.race([
        video.play(),
        new Promise((_, reject) => {
          abort = () => reject(new Error('Camera filter setup was cancelled.'));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => reject(new Error('Camera filter setup timed out.')), 10000);
        })
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    if (signal?.aborted) throw new Error('Camera filter setup was cancelled.');
    if (track.readyState !== 'live' || !video.videoWidth || !video.videoHeight) {
      throw new Error('The camera video is not available.');
    }
    if (FACE_FILTERS.has(name)) {
      const { createFaceTracker } = await import('./live-face-effects.js?v=4');
      faceTracker = await createFaceTracker(video, signal, error => {
        stop();
        onError(error);
      }, { iris: IRIS_FILTERS.has(name) });
      if (signal?.aborted || stopped) throw new Error('Camera filter setup was cancelled.');
    }
    if (isBackground) {
      const { createBackgroundRenderer } = await import('./live-background.js?v=1');
      backgroundRenderer = await createBackgroundRenderer(video, BACKGROUNDS[name] || backgroundImage, signal, error => {
        stop();
        onError(error);
      });
      if (signal?.aborted || stopped) throw new Error('Camera filter setup was cancelled.');
    }
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    let lastDraw = 0;
    const draw = time => {
      if (stopped) return;
      try {
        if (time - lastDraw >= 1000 / 24) {
          context.filter = FILTERS[filter] || 'none';
          if (backgroundRenderer) backgroundRenderer.draw(context, canvas.width, canvas.height);
          else context.drawImage(video, 0, 0, canvas.width, canvas.height);
          if (faceTracker) faceTracker.draw(context, filter, canvas.width, canvas.height);
          lastDraw = time;
        }
        frame = requestAnimationFrame(draw);
      } catch (error) {
        stop();
        onError(error);
      }
    };
    context.filter = FILTERS[filter] || 'none';
    if (backgroundRenderer) backgroundRenderer.draw(context, canvas.width, canvas.height);
    else context.drawImage(video, 0, 0, canvas.width, canvas.height);
    output = canvas.captureStream(24);
    const outputTrack = output.getVideoTracks()[0];
    if (!outputTrack) throw new Error('The browser could not create filtered video.');
    track.addEventListener('ended', sourceEnded);
    frame = requestAnimationFrame(draw);
    return {
      track: outputTrack,
      supportsFilter(value) {
        return backgroundRenderer ? false : faceTracker ? FACE_FILTERS.has(value) && (!IRIS_FILTERS.has(value) || faceTracker.hasIris) : Boolean(FILTERS[value]);
      },
      setFilter(value) {
        if (backgroundRenderer || (faceTracker ? !FACE_FILTERS.has(value) || (IRIS_FILTERS.has(value) && !faceTracker.hasIris) : !FILTERS[value])) {
          throw new Error('Unknown or unsupported camera filter.');
        }
        filter = value;
      },
      stop
    };
  } catch (error) {
    stop();
    throw error;
  }
}
