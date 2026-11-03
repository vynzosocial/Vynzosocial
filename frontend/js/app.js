import { restoreSupabaseSession } from './supabase-client.js';
import { initFeed } from './feed.js?v=prot4';
import { initStoriesCarousel } from './stories.js?v=prot4';
import { initHomeFriends } from './home-friends.js';
import { API_ORIGIN } from './config.js';

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

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await restoreSupabaseSession();
  } catch (err) {
    console.error('Unable to restore the Supabase session:', err);
  }

  const welcomePage = document.getElementById('welcome-page');
  const feedApp = document.getElementById('feed-app');

  if (!localStorage.getItem('vynzo_token')) {
    welcomePage.hidden = false;
    feedApp.hidden = true;
    return;
  }

  welcomePage.hidden = true;
  feedApp.hidden = false;
  renderHomeUser();

  const themeToggleBtn = document.getElementById('theme-toggle');
  const body = document.body;

  const savedTheme = localStorage.getItem('vynzo_theme') || 'dark-theme';
  body.className = `${savedTheme} home-page`;

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      if (body.classList.contains('dark-theme')) {
        body.className = 'light-theme home-page';
        localStorage.setItem('vynzo_theme', 'light-theme');
      } else {
        body.className = 'dark-theme home-page';
        localStorage.setItem('vynzo_theme', 'dark-theme');
      }
    });
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
  initFeed();
  initStoriesCarousel();
  initHomeFriends();
  console.log('Vynzo Client, Feed & Stories Initialized.');
});
