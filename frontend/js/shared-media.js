import { apiRequest } from './api.js?v=sb6';
import { restoreSupabaseSession } from './supabase-client.js';
import { shareLoginUrl } from './share-login.js?v=1';

const params = new URLSearchParams(location.search);
const kind = params.get('kind');
const id = params.get('id');
const type = params.get('type');
const status = document.getElementById('shared-status');
const login = document.getElementById('shared-login');

async function showSharedMedia() {
  if (!['post', 'story'].includes(kind) || !['image', 'video'].includes(type)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) {
    status.textContent = 'This shared media link is invalid.';
    return;
  }
  try {
    await restoreSupabaseSession();
    if (!localStorage.getItem('vynzo_token')) {
      login.href = shareLoginUrl(location);
      login.hidden = false;
      status.textContent = 'Log in to see this shared media. Its privacy settings still apply.';
      return;
    }
    const result = await apiRequest(`/media/playback?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`);
    const url = new URL(result.url);
    if (url.protocol !== 'https:') throw new Error('The media URL is invalid.');
    const media = document.createElement(type === 'video' ? 'video' : 'img');
    if (type === 'video') {
      media.controls = true;
      media.playsInline = true;
    } else media.alt = 'Shared image';
    media.addEventListener('error', () => {
      status.hidden = false;
      status.textContent = 'Could not load this media. Please try again.';
    }, { once: true });
    media.src = url.toString();
    document.getElementById('shared-content').append(media);
    status.hidden = true;
  } catch (error) {
    console.error('Could not open shared media:', error);
    status.textContent = error.message || 'This media is unavailable.';
  }
}

showSharedMedia();
