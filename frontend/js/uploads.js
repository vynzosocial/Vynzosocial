import { apiRequest } from './api.js?v=sb6';
import { R2_UPLOADS_ENABLED } from './config.js?v=sb5';
import { uploadPublicMedia } from './r2-uploads.js?v=repost1';

export async function uploadMedia(file, caption, onProgress, allowRepost = true) {
  const token = localStorage.getItem('vynzo_token');
  if (!token) {
    throw new Error('User must be logged in to upload');
  }

  const isProtected = document.getElementById('post-protect')?.checked || false;
  if (R2_UPLOADS_ENABLED) {
    return uploadPublicMedia(file, { kind: 'post', caption, protected: isProtected, allowRepost, onProgress });
  }
  const formData = new FormData();
  formData.append('media', file);
  formData.append('caption', caption);
  formData.append('protected', isProtected ? 'true' : 'false');
  formData.append('allowRepost', String(allowRepost));

  return apiRequest('/posts/upload', {
    method: 'POST',
    body: formData
  });
}