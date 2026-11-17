const MAX_EDGE = 1200;

export async function createVideoCover(file) {
  if (!(file instanceof File) || !file.type.startsWith('video/') || !file.size) {
    throw new Error('Choose a valid video to create a cover.');
  }
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Video cover generation timed out.')), 15000);
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('Could not decode the video cover.'));
      video.src = url;
      video.load();
    });
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('The video has no displayable frame.');
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Video cover generation is unavailable on this device.');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('Could not encode the video cover.')), 'image/webp', 0.8);
    });
    if (blob.type !== 'image/webp') throw new Error('WebP video covers are not supported on this device.');
    return new File([blob], 'cover.webp', { type: 'image/webp' });
  } finally {
    clearTimeout(timer);
    video.onloadeddata = null;
    video.onerror = null;
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
