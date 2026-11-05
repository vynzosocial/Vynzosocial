import { apiRequest } from './api.js?v=sb6';
import { getSelectedLiveAudience } from './live.js?v=vis3';

const list = document.getElementById('live-audience-list');
const message = document.getElementById('live-audience-message');
const search = document.getElementById('live-audience-search');
const count = document.getElementById('live-audience-count');
const save = document.getElementById('live-audience-save');
const selected = new Set(getSelectedLiveAudience());
let friends = [];

function updateSelection() {
  const checkboxes = list.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach(input => {
    input.checked = selected.has(input.value);
    input.disabled = !input.checked && selected.size >= 200;
  });
  count.textContent = `${selected.size} selected`;
  save.disabled = selected.size === 0;
}

function renderFriends() {
  const query = search.value.trim().toLowerCase();
  const filtered = friends.filter(friend => {
    const username = String(friend.username || '').toLowerCase();
    const displayName = String(friend.display_name || '').toLowerCase();
    return !query || username.includes(query) || displayName.includes(query);
  });
  list.replaceChildren();
  if (!filtered.length) {
    message.textContent = friends.length ? 'No friends match your search.' : 'You do not have any friends to select yet.';
    return;
  }
  message.textContent = '';
  filtered.forEach(friend => {
    const label = document.createElement('label');
    label.className = 'live-audience-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = friend.id;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked && selected.size >= 200) {
        checkbox.checked = false;
        message.textContent = 'You can choose up to 200 friends for one livestream.';
        return;
      }
      if (checkbox.checked) selected.add(friend.id);
      else selected.delete(friend.id);
      message.textContent = '';
      updateSelection();
    });

    const avatar = document.createElement('span');
    avatar.className = 'live-audience-avatar';
    const displayName = String(friend.display_name || friend.username || 'Friend');
    avatar.textContent = displayName.trim().charAt(0).toUpperCase() || 'F';
    if (friend.avatar_url) {
      const image = document.createElement('img');
      image.src = /^https?:/i.test(friend.avatar_url)
        ? friend.avatar_url
        : new URL(friend.avatar_url, window.location.origin).href;
      image.alt = '';
      image.addEventListener('error', () => {
        image.remove();
        avatar.textContent = displayName.trim().charAt(0).toUpperCase() || 'F';
      }, { once: true });
      avatar.replaceChildren(image);
    }

    const name = document.createElement('span');
    name.className = 'live-audience-name';
    const fullName = document.createElement('strong');
    fullName.textContent = displayName;
    const username = document.createElement('span');
    username.textContent = friend.username ? `@${friend.username}` : '';
    name.append(fullName, username);
    label.append(checkbox, avatar, name);
    list.appendChild(label);
  });
  updateSelection();
}

async function loadFriends() {
  if (!localStorage.getItem('vynzo_token')) {
    message.textContent = 'Log in to choose friends for your livestream.';
    return;
  }
  try {
    const data = await apiRequest('/users/friends');
    friends = Array.isArray(data.friends) ? data.friends.filter(friend => friend && typeof friend.id === 'string') : [];
    const friendIds = new Set(friends.map(friend => friend.id));
    selected.forEach(id => { if (!friendIds.has(id)) selected.delete(id); });
    renderFriends();
  } catch (err) {
    console.error('Could not load friends for livestream audience:', err);
    message.textContent = err.message || 'Could not load your friends. Please try again.';
  }
}

search.addEventListener('input', renderFriends);
save.addEventListener('click', () => {
  try {
    sessionStorage.setItem('vynzo_live_selected_viewers', JSON.stringify([...selected]));
    window.location.href = 'live.html';
  } catch (err) {
    console.error('Could not save the selected livestream audience:', err);
    message.textContent = 'Could not save your selection. Please check your browser storage settings.';
  }
});

loadFriends();
