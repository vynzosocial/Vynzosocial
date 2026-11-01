import { API_BASE_URL } from './config.js';

export async function uploadMedia(file, caption) {
  const token = localStorage.getItem('vynzo_token');
  if (!token) {
    throw new Error('User must be logged in to upload');
  }

  const formData = new FormData();
  formData.append('media', file);
  formData.append('caption', caption);
  formData.append('protected', document.getElementById('post-protect')?.checked ? 'true' : 'false');

  const response = await fetch(`${API_BASE_URL}/posts/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Upload failed');
  }

  return data;
}