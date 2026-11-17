import { apiRequest } from './api.js?v=sb7';
import { encodePlaybackVideo } from './video-encoder.js';
import { createVideoCover } from './video-cover.js';
import { createImageCover } from './image-cover.js';

const MAX_BYTES = 50 * 1024 * 1024;
const UPLOAD_FALLBACK_URL = 'https://www.vynzosocial.com/media-stage';
const FILE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime'
]);

async function putStagedFile(workerUrl, permit, file) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240000);
  try {
    const options = {
      method: 'PUT',
      headers: { 'Content-Type': file.type, 'X-Upload-Permit': permit },
      body: file,
      signal: controller.signal
    };
    let response;
    try {
      response = await fetch(new URL('/stage', workerUrl), options);
    } catch (error) {
      if (controller.signal.aborted || !(error instanceof TypeError)) throw error;
      console.warn('Direct media upload failed; trying the Vynzo upload gateway.', error);
      if (controller.signal.aborted) throw error;
      try {
        response = await fetch(UPLOAD_FALLBACK_URL, { ...options, body: file.slice(0, file.size, file.type) });
      } catch (gatewayError) {
        if (controller.signal.aborted || !(gatewayError instanceof TypeError)) throw gatewayError;
        console.error('Media upload gateway failed:', gatewayError);
        throw new Error('Could not reach the media upload service. Check your connection and try again.');
      }
    }
    if (!response.ok) {
      throw new Error(`R2 could not store the media (HTTP ${response.status}).`);
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The media upload timed out. Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function uploadPublicMedia(file, { kind, caption = '', protected: isProtected = false, allowRepost = true, onProgress } = {}) {
  if (!(file instanceof File) || !FILE_TYPES.has(file.type) || !file.size || file.size > MAX_BYTES ||
      !['post', 'story'].includes(kind)) {
    throw new Error('Choose a supported image or video file up to 50 MB.');
  }
  onProgress?.('Preparing selected media...');
  try {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength !== file.size) throw new Error('Selected media read was incomplete.');
    file = new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
  } catch (error) {
    console.error('Could not read the selected media:', error);
    throw new Error('The app could not read this selection from Gallery. Try selecting it again or choose it from My Files.');
  }
  let playback;
  let cover;
  if (file.type.startsWith('video/')) {
    onProgress?.('Encoding video on this device...');
    ({ playback } = await encodePlaybackVideo(file, value => {
      onProgress?.(`Encoding video on this device: ${Math.floor(value * 100)}%`);
    }));
  }
  try {
    cover = playback ? await createVideoCover(playback) : await createImageCover(file);
    if (cover.size > 2 * 1024 * 1024) throw new Error('Media preview exceeds the upload limit.');
  } catch (error) {
    if (playback) throw error;
    console.warn('Could not generate media preview:', error);
    onProgress?.('Media preview unavailable; a fallback sharing preview will be used.');
    cover = null;
  }
  const metadata = item => ({ contentType: item.type, size: item.size });
  const stage = await apiRequest('/media/stage', {
    method: 'POST',
    body: JSON.stringify({ kind, original: metadata(file), playback: playback ? metadata(playback) : null, cover: cover ? metadata(cover) : null })
  });
  if (!stage?.workerUrl || !stage?.uploadId || !stage?.permits?.original ||
      (playback && !stage.permits.playback) || (cover && !stage.permits.cover)) {
    throw new Error('The media service returned an invalid upload permit.');
  }
  const workerUrl = new URL(stage.workerUrl);
  if (workerUrl.protocol !== 'https:') throw new Error('The media service URL must use HTTPS.');
  try {
    onProgress?.('Uploading original media...');
    await putStagedFile(workerUrl, stage.permits.original, file);
    if (playback) {
      onProgress?.('Uploading the optimized playback copy...');
      await putStagedFile(workerUrl, stage.permits.playback, playback);
    }
    if (cover) {
      onProgress?.('Uploading video cover...');
      await putStagedFile(workerUrl, stage.permits.cover, cover);
    }
  } catch (error) {
    try {
      await apiRequest('/media/abort', { method: 'POST', body: JSON.stringify({ kind, uploadId: stage.uploadId }) });
    } catch (cleanupError) {
      console.error('Failed to clean up staged media:', cleanupError);
    }
    throw error;
  }
  onProgress?.('Publishing media...');
  return apiRequest('/media/publish', {
    method: 'POST',
    timeoutMs: 240000,
    body: JSON.stringify({
      kind, uploadId: stage.uploadId, mediaType: playback ? 'video' : 'image',
      caption, protected: Boolean(isProtected), allowRepost
    })
  });
}

export async function downloadOriginal(kind, id) {
  const data = await apiRequest(`/media/original?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
  const url = new URL(data.url);
  if (url.protocol !== 'https:') throw new Error('The original media URL is invalid.');
  const link = document.createElement('a');
  link.href = url.toString();
  link.rel = 'noopener';
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function refreshExpiredMedia(element, item, kind) {
  if (!item.has_original && !item.has_expiring_media_url) return;
  let refreshing = false;
  element.addEventListener('error', async () => {
    if (refreshing) return;
    let expires;
    try {
      const permit = new URL(element.currentSrc || element.src).searchParams.get('permit');
      const payload = permit?.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      expires = JSON.parse(atob(payload)).expires;
    } catch {
      return;
    }
    if (!Number.isSafeInteger(expires) || expires * 1000 > Date.now() + 5000) return;
    refreshing = true;
    const position = element.currentTime;
    const resume = typeof element.play === 'function' && !element.paused;
    try {
      const result = await apiRequest(`/media/playback?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(item.id)}`);
      const url = new URL(result.url);
      if (url.protocol !== 'https:') throw new Error('The playback URL is invalid.');
      item.media_url = url.toString();
      if (Number.isFinite(position) && position > 0) {
        element.addEventListener('loadedmetadata', () => { element.currentTime = position; }, { once: true });
      }
      element.src = item.media_url;
      if (resume) await element.play();
    } catch (error) {
      console.error('Could not refresh expired media:', error);
    } finally {
      refreshing = false;
    }
  });
}
