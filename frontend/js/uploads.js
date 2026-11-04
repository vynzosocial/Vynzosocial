import { apiRequest } from './api.js?v=sb4';

export async function uploadMedia(file, caption) {
  const token = localStorage.getItem('vynzo_token');
  if (!token) {
    throw new Error('User must be logged in to upload');
  }

  const formData = new FormData();
  formData.append('media', file);
  formData.append('caption', caption);
  formData.append('protected', document.getElementById('post-protect')?.checked ? 'true' : 'false');

  return apiRequest('/posts/upload', {
    method: 'POST',
    body: formData
  });
}