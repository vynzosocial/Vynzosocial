/**
 * Image-to-Video converter with audio support
 * Creates videos from images with optional audio (extracted from video or device microphone)
 * Supports multiple images, various transitions, and a selectable length of 15, 30 or 60 seconds.
 * Everything is rendered and encoded on the device.
 */

export const DURATION_OPTIONS = [15, 30, 60];
const MAX_DURATION_SECONDS = 60;
const DEFAULT_DURATION_SECONDS = 30;
export const MIN_DURATION_SECONDS = 0.5;
const MAX_IMAGES = 30;
const OUTPUT_WIDTH = 720;
const OUTPUT_HEIGHT = 1280;
const FRAMERATE = 30;
const VIDEO_BITS_PER_SECOND = 4_000_000;
const AUDIO_BITS_PER_SECOND = 128_000;

// Animation transition types
const TRANSITIONS = {
  static: { name: 'Static', duration: 1 },
  'zoom-in': { name: 'Zoom In', duration: 1.5 },
  'zoom-out': { name: 'Zoom Out', duration: 1.5 },
  fade: { name: 'Fade', duration: 1 },
  pan: { name: 'Pan', duration: 1.5 }
};

/**
 * Extract audio from a video file
 * Returns audio as WAV blob for easier manipulation
 */
export async function extractAudioFromVideo(videoFile, onProgress, { start = 0, duration } = {}) {
  if (!(videoFile instanceof File) || !videoFile.type.startsWith('video/')) {
    throw new Error('Please select a valid video file to extract audio from.');
  }
  if (!Number.isFinite(start) || start < 0 ||
      (duration !== undefined && (!Number.isFinite(duration) || duration <= 0))) {
    throw new Error('Please select a valid audio segment.');
  }

  const { Input, BlobSource, BufferTarget, ALL_FORMATS, Conversion, Output, WavOutputFormat } =
    await import('../vendor/mediabunny/mediabunny.min.mjs');

  const input = new Input({ source: new BlobSource(videoFile), formats: ALL_FORMATS });
  try {
    const audioTracks = await input.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error('This video does not contain an audio track.');
    }

    const firstTimestamp = await input.getFirstTimestamp();
    const videoDuration = await input.computeDuration() - firstTimestamp;
    if (!Number.isFinite(videoDuration) || videoDuration <= 0 || start >= videoDuration) {
      throw new Error('The video duration could not be determined.');
    }

    const target = new BufferTarget();
    const output = new Output({ format: new WavOutputFormat(), target });

    const conversion = await Conversion.init({
      input,
      output,
      video: { discard: true },
      audio: (track, index) => index === 1 ? { codec: 'pcm-s16' } : { discard: true },
      trim: {
        start: firstTimestamp + start,
        end: firstTimestamp + Math.min(videoDuration, start + (duration ?? videoDuration))
      },
      showWarnings: false
    });

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.filter(track => track.reason !== 'discarded_by_user')
        .map(track => track.reason).join(', ');
      throw new Error(`This device cannot extract audio from this video${reasons ? `: ${reasons}` : '.'}`);
    }

    if (onProgress) conversion.onProgress = progress => onProgress(Math.round(progress * 100));
    await conversion.execute();

    if (!target.buffer || target.buffer.byteLength === 0) {
      throw new Error('No audio was extracted from the video.');
    }

    const audioBlob = new Blob([target.buffer], { type: 'audio/wav' });
    return {
      audio: audioBlob,
      duration: Math.min(videoDuration - start, duration ?? videoDuration),
      fileName: `${videoFile.name.replace(/\.[^.]+$/, '')}-audio.wav`
    };
  } finally {
    input.dispose();
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not read image "${file.name}".`)); };
    img.src = url;
  });
}

// Draws the image cropped to fill the frame, with the selected motion applied.
function drawFrame(ctx, img, transition, progress, localTime, imageSeconds) {
  const w = OUTPUT_WIDTH;
  const h = OUTPUT_HEIGHT;
  const cover = Math.max(w / img.width, h / img.height);
  let zoom = 1;
  let panProgress = 0.5;
  if (transition === 'zoom-in') zoom = 1 + 0.15 * progress;
  else if (transition === 'zoom-out') zoom = 1.15 - 0.15 * progress;
  else if (transition === 'pan') { zoom = 1.15; panProgress = progress; }

  const drawW = img.width * cover * zoom;
  const drawH = img.height * cover * zoom;
  const x = -(drawW - w) * panProgress;
  const y = (h - drawH) / 2;

  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (transition === 'fade') {
    const edge = Math.min(0.5, imageSeconds / 3);
    ctx.globalAlpha = Math.max(0, Math.min(1, localTime / edge, (imageSeconds - localTime) / edge));
  }
  ctx.drawImage(img, x, y, drawW, drawH);
  ctx.globalAlpha = 1;
}

function pickRecorderMimeType() {
  return [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ].find(type => MediaRecorder.isTypeSupported(type)) || '';
}

async function decodeAudio(audioContext, blob) {
  try {
    return await audioContext.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error('This audio format is not supported on this device. Try a different audio source.');
  }
}

/**
 * Renders the slideshow in real time to a canvas and records it, mixing the chosen
 * audio into the same recording so the result is a single playable video.
 */
async function renderSlideshow({ images, transitions, seconds, audioBuffer, audioElement, audioContext, audioStart = 0, onProgress }) {
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_WIDTH;
  canvas.height = OUTPUT_HEIGHT;
  const ctx = canvas.getContext('2d');
  drawFrame(ctx, images[0], 'static', 0, 0, 1);

  const stream = canvas.captureStream(FRAMERATE);
  let source = null;
  if (audioBuffer || audioElement) {
    const destination = audioContext.createMediaStreamDestination();
    if (audioElement) {
      source = audioContext.createMediaElementSource(audioElement);
    } else {
      source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
    }
    source.connect(destination);
    destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
  }

  const mimeType = pickRecorderMimeType();
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND
  });
  const chunks = [];
  recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data); };

  return new Promise((resolve, reject) => {
    const imageSeconds = seconds / images.length;
    recorder.onerror = event => {
      stream.getTracks().forEach(track => track.stop());
      reject(new Error(`Recording error: ${event.error?.message || 'unknown'}`));
    };
    if (audioElement) {
      audioElement.onerror = () => {
        recorder.onstop = null;
        if (recorder.state !== 'inactive') recorder.stop();
        stream.getTracks().forEach(track => track.stop());
        reject(new Error('Could not play audio from the selected video.'));
      };
    }
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      if (!chunks.length) {
        reject(new Error('The device did not produce a video. Please try again.'));
      } else {
        resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' }));
      }
    };

    const tick = () => {
      const elapsed = (performance.now() - startedAt) / 1000;
      if (elapsed >= seconds) {
        if (audioElement) audioElement.pause();
        else if (source) source.stop();
        if (recorder.state !== 'inactive') recorder.stop();
        return;
      }
      const index = Math.min(images.length - 1, Math.floor(elapsed / imageSeconds));
      const localTime = elapsed - index * imageSeconds;
      drawFrame(ctx, images[index], transitions[index] || 'static', localTime / imageSeconds, localTime, imageSeconds);
      if (onProgress) onProgress(Math.min(99, Math.round((elapsed / seconds) * 100)));
      requestAnimationFrame(tick);
    };
    let startedAt;
    recorder.start(1000);
    drawFrame(ctx, images[0], 'static', 0, 0, imageSeconds);
    stream.getVideoTracks()[0]?.requestFrame?.();
    const startPlayback = audioElement ? audioElement.play() : Promise.resolve();
    startPlayback.then(() => {
      if (source && !audioElement) source.start(0, audioStart);
      startedAt = performance.now();
      requestAnimationFrame(tick);
    }).catch(error => {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      stream.getTracks().forEach(track => track.stop());
      reject(new Error(`Could not play the selected audio: ${error.message}`));
    });
  });
}

async function prepareVideoAudio(file, start) {
  const { Input, BlobSource, ALL_FORMATS } = await import('../vendor/mediabunny/mediabunny.min.mjs');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (!(await input.getAudioTracks()).length) throw new Error('This video does not contain an audio track.');
  } finally {
    input.dispose();
  }

  const url = URL.createObjectURL(file);
  const audio = document.createElement('video');
  audio.playsInline = true;
  audio.preload = 'auto';
  audio.src = url;
  try {
    await new Promise((resolve, reject) => {
      audio.onloadedmetadata = resolve;
      audio.onerror = () => reject(new Error('This device cannot play audio from this video.'));
    });
    if (!Number.isFinite(audio.duration) || start >= audio.duration) {
      throw new Error('The selected audio start is past the end of the video.');
    }
    if (start > 0) {
      await new Promise((resolve, reject) => {
        audio.onseeked = resolve;
        audio.onerror = () => reject(new Error('Could not seek to the selected audio.'));
        audio.currentTime = start;
      });
    }
    return { audio, url, duration: audio.duration };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * Main function: create a video file from images and optional audio.
 * audioSource may include start and end times in seconds; video length follows that segment.
 * options.maxSeconds: 15, 30 or 60.
 */
export async function createVideoFromImages(imageFiles, audioSource, transitions, onProgress, options = {}) {
  if (!imageFiles || imageFiles.length === 0) {
    throw new Error('Please select at least one image.');
  }
  if (imageFiles.length > MAX_IMAGES) {
    throw new Error(`Please select at most ${MAX_IMAGES} images.`);
  }
  const maxSeconds = options.maxSeconds ?? DEFAULT_DURATION_SECONDS;
  if (!DURATION_OPTIONS.includes(maxSeconds)) {
    throw new Error(`Video length must be ${DURATION_OPTIONS.join(', ')} seconds.`);
  }
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error('This browser cannot create videos on the device. Please update your browser.');
  }

  const images = await Promise.all(imageFiles.map(loadImage));

  let audioBlob = audioSource?.blob || null;
  const audioStart = audioSource?.start ?? 0;
  const audioEnd = audioSource?.end;
  if (!Number.isFinite(audioStart) || audioStart < 0) {
    throw new Error('Please select a valid audio start time.');
  }
  if (audioEnd !== undefined && (!Number.isFinite(audioEnd) || audioEnd <= audioStart)) {
    throw new Error('The audio end time must be after the start time.');
  }
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const videoAudio = !audioBlob && audioSource?.type === 'extracted' && audioSource.file;
  if ((audioBlob || videoAudio) && !AudioContextClass) {
    throw new Error('This device cannot process audio for video creation.');
  }
  const audioContext = (audioBlob || videoAudio) ? new AudioContextClass() : null;
  let preparedAudio;
  try {
    let audioBuffer = null;
    let seconds = maxSeconds;
    if (audioContext) {
      if (audioContext.state === 'suspended') await audioContext.resume();
      if (audioContext.state === 'suspended') throw new Error('Audio playback is blocked on this device. Please try again.');
    }
    if (videoAudio) {
      preparedAudio = await prepareVideoAudio(videoAudio, audioStart);
      seconds = Math.min(maxSeconds, (audioEnd ?? preparedAudio.duration) - audioStart, preparedAudio.duration - audioStart);
    } else if (audioBlob) {
      audioBuffer = await decodeAudio(audioContext, audioBlob);
      if (audioStart >= audioBuffer.duration) throw new Error('The selected audio start is past the end of the audio.');
      seconds = Math.min(maxSeconds, (audioEnd ?? audioBuffer.duration) - audioStart, audioBuffer.duration - audioStart);
    }
    if (seconds < MIN_DURATION_SECONDS) throw new Error('The selected audio is too short. Choose at least half a second.');

    if (onProgress) onProgress(0);
    const blob = await renderSlideshow({ images, transitions, seconds, audioBuffer, audioElement: preparedAudio?.audio, audioContext, audioStart, onProgress });
    if (onProgress) onProgress(100);

    const baseType = blob.type.split(';')[0];
    const extension = baseType === 'video/mp4' ? 'mp4' : 'webm';
    const file = new File([blob], `image-video-${Date.now()}.${extension}`, { type: baseType });
    const { Input, BlobSource, ALL_FORMATS } = await import('../vendor/mediabunny/mediabunny.min.mjs');
    const result = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      if (!(await result.getVideoTracks()).length || (audioContext && !(await result.getAudioTracks()).length)) {
        throw new Error('The device could not create a video with all selected tracks. Please try again.');
      }
    } finally {
      result.dispose();
    }
    return file;
  } finally {
    if (preparedAudio) {
      preparedAudio.audio.pause();
      preparedAudio.audio.removeAttribute('src');
      preparedAudio.audio.load();
      URL.revokeObjectURL(preparedAudio.url);
    }
    if (audioContext) audioContext.close().catch(() => {});
  }
}

/**
 * Record audio from the device microphone.
 * Pass a `controller` object to receive a `stop()` function for ending the recording early.
 */
export async function recordAudioFromMicrophone(maxDuration = DEFAULT_DURATION_SECONDS, controller = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks = [];

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, maxDuration * 1000);
    const release = () => { clearTimeout(timeout); stream.getTracks().forEach(track => track.stop()); };

    controller.stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
    recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data); };
    recorder.onstop = () => {
      release();
      resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    };
    recorder.onerror = event => {
      release();
      reject(new Error(`Recording error: ${event.error?.message || 'unknown'}`));
    };
    recorder.start();
  });
}

export function getAvailableTransitions() {
  return Object.keys(TRANSITIONS).map(key => ({
    value: key,
    label: TRANSITIONS[key].name,
    duration: TRANSITIONS[key].duration
  }));
}

export function validateDuration(seconds) {
  return seconds >= MIN_DURATION_SECONDS && seconds <= MAX_DURATION_SECONDS;
}
