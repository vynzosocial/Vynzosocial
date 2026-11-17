const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MIN_DURATION_SECONDS = 1;
const MAX_DURATION_SECONDS = 60;
const MAX_LANDSCAPE_WIDTH = 1280;
const MAX_LANDSCAPE_HEIGHT = 720;
const VIDEO_BITRATE = 1_500_000;
const FRAME_RATE = 30;

export async function encodePlaybackVideo(file, onProgress, { trimToSeconds } = {}) {
  if (!(file instanceof File) || !file.type.startsWith('video/') || file.size === 0) {
    throw new Error('Choose a video to encode.');
  }
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error('Video must be 50 MB or smaller.');
  }
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    throw new Error('This device does not support video encoding.');
  }
  if (trimToSeconds !== undefined && (!Number.isFinite(trimToSeconds) || trimToSeconds <= MIN_DURATION_SECONDS || trimToSeconds > MAX_DURATION_SECONDS)) {
    throw new Error('The video duration limit is invalid.');
  }

  const { Input, Output, BlobSource, BufferTarget, ALL_FORMATS, Mp4OutputFormat, Conversion, Quality } =
    await import('../vendor/mediabunny/mediabunny.min.mjs');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let resultInput;
  try {
    const videoTracks = await input.getVideoTracks();
    const audioTracks = await input.getAudioTracks();
    if (videoTracks.length !== 1 || audioTracks.length > 1) {
      throw new Error('This video must contain one video track and at most one audio track.');
    }

    const firstTimestamp = await input.getFirstTimestamp();
    const duration = await input.computeDuration() - firstTimestamp;
    if (!Number.isFinite(duration) || duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
      throw new Error('Videos must be between 1 and 60 seconds long.');
    }
    // Leave room for codec frame padding while enforcing the camera's hard limit.
    const outputDuration = trimToSeconds === undefined ? duration : Math.min(duration, trimToSeconds - 0.1);
    const width = await videoTracks[0].getDisplayWidth();
    const height = await videoTracks[0].getDisplayHeight();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
      throw new Error('The video dimensions could not be determined.');
    }
    const maxWidth = width >= height ? MAX_LANDSCAPE_WIDTH : MAX_LANDSCAPE_HEIGHT;
    const maxHeight = width >= height ? MAX_LANDSCAPE_HEIGHT : MAX_LANDSCAPE_WIDTH;
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    const outputWidth = Math.max(2, Math.floor(width * scale / 2) * 2);
    const outputHeight = Math.max(2, Math.floor(height * scale / 2) * 2);
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conversion = await Conversion.init({
      input,
      output,
      ...(trimToSeconds === undefined ? {} : { trim: { start: firstTimestamp, end: firstTimestamp + outputDuration } }),
      video: {
        codec: 'avc',
        width: outputWidth,
        height: outputHeight,
        fit: 'contain',
        frameRate: FRAME_RATE,
        quality: new Quality({ bitrate: VIDEO_BITRATE }),
        forceTranscode: true
      },
      audio: { codec: 'aac' },
      showWarnings: false
    });
    if (!conversion.isValid || conversion.discardedTracks.length) {
      const reasons = conversion.discardedTracks.map(track => track.reason).join(', ');
      throw new Error(`This device cannot encode all video and audio tracks${reasons ? `: ${reasons}` : '.'}`);
    }
    if (onProgress) conversion.onProgress = onProgress;
    await conversion.execute();
    if (!target.buffer || target.buffer.byteLength === 0) {
      throw new Error('The video encoder produced an empty file.');
    }
    if (target.buffer.byteLength > MAX_VIDEO_BYTES) {
      throw new Error('The optimized video exceeds the 50 MB upload limit.');
    }

    const playback = new File([target.buffer], `${file.name.replace(/\.[^.]+$/, '')}-playback.mp4`, { type: 'video/mp4' });
    resultInput = new Input({ source: new BlobSource(playback), formats: ALL_FORMATS });
    const resultVideo = await resultInput.getVideoTracks();
    const resultAudio = await resultInput.getAudioTracks();
    const resultDuration = await resultInput.computeDuration() - await resultInput.getFirstTimestamp();
    if (resultVideo.length !== videoTracks.length || resultAudio.length !== audioTracks.length ||
        await resultVideo[0].getDisplayWidth() !== outputWidth || await resultVideo[0].getDisplayHeight() !== outputHeight ||
        !Number.isFinite(resultDuration) || resultDuration < MIN_DURATION_SECONDS || resultDuration > (trimToSeconds ?? MAX_DURATION_SECONDS) ||
        Math.abs(outputDuration - resultDuration) > Math.max(0.25, outputDuration * 0.01)) {
      throw new Error('The encoded video did not preserve its tracks and duration.');
    }

    return { original: file, playback, savedBytes: file.size - playback.size };
  } finally {
    if (resultInput) resultInput.dispose();
    input.dispose();
  }
}
