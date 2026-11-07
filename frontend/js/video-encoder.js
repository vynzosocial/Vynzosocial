const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export async function encodePlaybackVideo(file, onProgress) {
  if (!(file instanceof File) || !file.type.startsWith('video/') || file.size === 0) {
    throw new Error('Choose a video to encode.');
  }
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error('Video must be 50 MB or smaller.');
  }
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    throw new Error('This device does not support video encoding.');
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

    const duration = await input.computeDuration() - await input.getFirstTimestamp();
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('The video duration could not be determined.');
    }
    const width = await videoTracks[0].getDisplayWidth();
    const height = await videoTracks[0].getDisplayHeight();
    const videoBitrate = Math.max(250000, Math.min(8000000, Math.floor(file.size * 8 / duration * 0.7 - 192000)));
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conversion = await Conversion.init({
      input,
      output,
      video: { codec: 'avc', quality: new Quality({ bitrate: videoBitrate }), forceTranscode: true },
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
    if (target.buffer.byteLength >= file.size || target.buffer.byteLength > MAX_VIDEO_BYTES) {
      throw new Error('This device could not produce a smaller playback copy of this video.');
    }

    const playback = new File([target.buffer], `${file.name.replace(/\.[^.]+$/, '')}-playback.mp4`, { type: 'video/mp4' });
    resultInput = new Input({ source: new BlobSource(playback), formats: ALL_FORMATS });
    const resultVideo = await resultInput.getVideoTracks();
    const resultAudio = await resultInput.getAudioTracks();
    const resultDuration = await resultInput.computeDuration() - await resultInput.getFirstTimestamp();
    if (resultVideo.length !== videoTracks.length || resultAudio.length !== audioTracks.length ||
        await resultVideo[0].getDisplayWidth() !== width || await resultVideo[0].getDisplayHeight() !== height ||
        !Number.isFinite(resultDuration) ||
        Math.abs(duration - resultDuration) > Math.max(0.25, duration * 0.01)) {
      throw new Error('The encoded video did not preserve its tracks and duration.');
    }

    return { original: file, playback, savedBytes: file.size - playback.size };
  } finally {
    if (resultInput) resultInput.dispose();
    input.dispose();
  }
}
