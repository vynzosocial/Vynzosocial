import { apiRequest } from './api.js?v=sb4';
import { openUserProfile } from './users.js';

import { API_ORIGIN as MEDIA_BASE_URL } from './config.js?v=sb4';
let refreshInterval = null;
let loading = false;

export async function initHomeFriends() {
  const container = document.getElementById('home-friends-list');
  if (!container) return;

  await loadFriends(container);
  clearInterval(refreshInterval);
  refreshInterval = setInterval(() => loadFriends(container), 5000);
}

async function loadFriends(container) {
  if (loading) return;
  loading = true;
  loadRequests();
  try {
    const data = await apiRequest('/users/friends');
    renderFriends(container, data.friends);
  } catch (err) {
    console.error('Failed to load friends:', err);
    renderMessage(container, err.message || 'Could not load friends. Please try again.');
  } finally {
    loading = false;
  }
}

async function loadRequests() {
  const section = document.getElementById('home-requests-section');
  const list = document.getElementById('home-requests-list');
  if (!section || !list) return;
  try {
    const data = await apiRequest('/users/follow-requests');
    const requests = data.requests || [];
    section.hidden = requests.length === 0;
    list.replaceChildren(...requests.map(request => createRequestCard(request, loadRequests)));
  } catch (err) {
    console.error('Failed to load friend requests:', err);
  }
}

function createRequestCard(user, reload) {
  const card = createFriendCard({ ...user, is_live: false });
  const status = card.querySelector('.home-friend-status');
  status.textContent = 'Add back';
  status.style.cursor = 'pointer';
  const view = document.createElement('span');
  view.className = 'home-friend-status';
  view.textContent = 'View profile';
  view.style.cursor = 'pointer';
  view.addEventListener('click', event => {
    event.stopPropagation();
    openUserProfile(user.id);
  });
  status.before(view);
  status.addEventListener('click', async event => {
    event.stopPropagation();
    status.textContent = 'Adding...';
    try {
      await apiRequest(`/users/${encodeURIComponent(user.id)}/follow`, { method: 'POST' });
      reload();
      loadFriends(document.getElementById('home-friends-list'));
    } catch (err) {
      status.textContent = 'Add back';
    }
  });
  return card;
}

function renderFriends(container, friends) {
  container.replaceChildren();
  if (!friends.length) {
    renderMessage(container, 'No friends yet. Follow each other to become friends.');
    return;
  }

  friends.forEach(friend => container.appendChild(createFriendCard(friend)));
}

function createFriendCard(friend) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = `home-friend-card${friend.is_live ? ' is-live' : ''}`;
  card.setAttribute(
    'aria-label',
    friend.is_live
      ? `Watch ${friend.display_name || friend.username} live`
      : `View ${friend.display_name || friend.username}'s profile`
  );

  const avatar = document.createElement('span');
  avatar.className = 'home-friend-avatar';
  avatar.textContent = (friend.display_name || friend.username || 'u')[0].toUpperCase();
  if (friend.avatar_url) {
    const image = document.createElement('img');
    image.src = /^https?:/i.test(friend.avatar_url) ? friend.avatar_url : `${MEDIA_BASE_URL}${friend.avatar_url}`;
    image.alt = '';
    image.addEventListener('error', () => image.remove(), { once: true });
    avatar.appendChild(image);
  }

  const identity = document.createElement('span');
  identity.className = 'home-friend-identity';
  const name = document.createElement('strong');
  name.textContent = friend.display_name || friend.username;
  const username = document.createElement('small');
  username.textContent = `@${friend.username}`;
  identity.append(name, username);

  const status = document.createElement('span');
  status.className = 'home-friend-status';
  if (friend.is_live) {
    status.textContent = `LIVE · ${friend.live_title || 'Join stream'}`;
  } else {
    status.textContent = 'View profile';
  }

  card.append(avatar, identity, status);
  card.addEventListener('click', () => {
    if (friend.is_live) {
      window.location.href = `./pages/live.html?sessionId=${encodeURIComponent(friend.live_session_id)}`;
      return;
    }
    openUserProfile(friend.id);
  });
  return card;
}

function renderMessage(container, message) {
  const status = document.createElement('p');
  status.className = 'home-friends-message';
  status.textContent = message;
  container.replaceChildren(status);
}
