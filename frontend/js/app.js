import { restoreSupabaseSession } from './supabase-client.js';
try { screen.orientation?.lock?.('portrait').catch(() => {}); } catch { /* unsupported */ }
import { initFeed } from './feed.js?v=share3';
import { initStoriesCarousel } from './stories.js?v=share3';
import { initHomeFriends } from './home-friends.js?v=share2';
import { apiRequest } from './api.js?v=sb6';
import { API_ORIGIN } from './config.js?v=sb4';

function renderHomeUser() {
  const user = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  const name = user.display_name || user.username || '';
  const nameEl = document.getElementById('home-user-name');
  const avatarEl = document.getElementById('home-user-avatar');
  if (!nameEl || !avatarEl) return;
  nameEl.textContent = name;
  avatarEl.replaceChildren();
  if (user.avatar_url) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = /^https?:/i.test(user.avatar_url) ? user.avatar_url : `${API_ORIGIN}${user.avatar_url}`;
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = (name || '?').charAt(0).toUpperCase();
  }
}

async function refreshHomeUser() {
  try {
    const user = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
    if (!user.id) return;
    const profile = await apiRequest(`/users/${encodeURIComponent(user.id)}/profile`);
    const fresh = profile.profile || profile.user || profile;
    localStorage.setItem('vynzo_user', JSON.stringify({
      ...user,
      username: fresh.username || user.username,
      display_name: fresh.display_name || user.display_name,
      avatar_url: fresh.avatar_url || user.avatar_url || null
    }));
    renderHomeUser();
  } catch (err) {
    console.error('Unable to load your profile:', err);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const sessionRestore = restoreSupabaseSession().catch(err => {
    console.error('Unable to restore the Supabase session:', err);
  });

  const welcomePage = document.getElementById('welcome-page');
  const feedApp = document.getElementById('feed-app');

  if (!localStorage.getItem('vynzo_token')) {
    await sessionRestore;
    if (!localStorage.getItem('vynzo_token')) {
      welcomePage.hidden = false;
      feedApp.hidden = true;
      return;
    }
  }

  welcomePage.hidden = true;
  feedApp.hidden = false;
  renderHomeUser();
  refreshHomeUser();

  const themeToggleBtn = document.getElementById('theme-toggle');
  const body = document.body;

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => window.VynzoTheme?.toggle());
  }

  // Initialize Feed and Stories Carousel
  window.vynzoFeedScope = 'me';
  body.dataset.feedScope = 'me';
  const scopeTabs = document.querySelectorAll('.home-topbar .tab-btn, .tab-btn');
  scopeTabs.forEach(tab => tab.addEventListener('click', () => {
    scopeTabs.forEach(t => t.classList.toggle('active', t === tab));
    window.vynzoFeedScope = tab.dataset.scope || 'following';
    body.dataset.feedScope = window.vynzoFeedScope;
    document.dispatchEvent(new CustomEvent('vynzo:scope'));
  }));
  void Promise.all([
    initFeed(),
    initStoriesCarousel(),
    initHomeFriends()
  ]).catch(err => console.error('Failed to initialize the home page:', err));
  console.log('Vynzo Client, Feed & Stories Initialized.');
});
