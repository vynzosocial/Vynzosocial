import { apiRequest } from './api.js?v=sb6';
import { API_ORIGIN } from './config.js?v=sb4';
import { shareMessage } from './share-data.js?v=1';

export const SHARE_BASE_URL = 'https://www.vynzosocial.com';

export function absoluteMediaUrl(url) {
  if (!url) return '';
  return /^https?:/i.test(url) ? url : `${API_ORIGIN}${url}`;
}


export async function openShareDialog({ title = 'Share', text = '', url, preview }) {
  if (!url) return;
  document.getElementById('share-dialog-overlay')?.remove();
  const message = shareMessage(text, url, preview);

  const overlay = document.createElement('div');
  overlay.id = 'share-dialog-overlay';
  overlay.className = 'share-dialog-overlay';
  const dialog = document.createElement('section');
  dialog.className = 'share-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const heading = document.createElement('h3');
  heading.textContent = title;
  const status = document.createElement('p');
  status.className = 'share-dialog-status';
  status.textContent = 'Loading your friends...';
  const list = document.createElement('div');
  list.className = 'share-dialog-list';
  const footer = document.createElement('div');
  footer.className = 'share-dialog-footer';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy link';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      status.textContent = 'Link copied.';
    } catch {
      window.prompt('Copy this link:', url);
    }
  });
  footer.append(copy);
  if (navigator.share) {
    const more = document.createElement('button');
    more.type = 'button';
    more.textContent = 'More…';
    more.addEventListener('click', () => navigator.share({ title, text, url }).catch(() => {}));
    footer.append(more);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', () => overlay.remove());
  footer.append(close);
  dialog.append(heading, status, list, footer);
  overlay.append(dialog);
  overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
  document.body.append(overlay);

  let friends = [];
  try {
    friends = (await apiRequest('/users/friends')).friends || [];
  } catch (err) {
    status.textContent = err.message || 'Please log in to share.';
    return;
  }
  status.textContent = friends.length ? 'Choose a friend to send this to:' : 'You have no friends to share with yet. You can copy the link.';
  friends.forEach(friend => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'share-dialog-row';
    const who = document.createElement('span');
    who.className = 'share-dialog-who';
    const avatar = document.createElement('span');
    avatar.className = 'share-dialog-avatar';
    avatar.textContent = (friend.display_name || friend.username || 'u')[0].toUpperCase();
    if (friend.avatar_url) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = absoluteMediaUrl(friend.avatar_url);
      avatar.textContent = '';
      avatar.append(image);
    }
    const name = document.createElement('span');
    name.textContent = friend.display_name || `@${friend.username}`;
    who.append(avatar, name);
    const action = document.createElement('span');
    action.className = 'share-dialog-send';
    action.textContent = 'Send';
    row.append(who, action);
    row.addEventListener('click', async () => {
      if (row.disabled) return;
      row.disabled = true;
      action.textContent = '...';
      try {
        const chat = await apiRequest('/messages/conversations', {
          method: 'POST',
          body: JSON.stringify({ recipientId: friend.id })
        });
        await apiRequest(`/messages/${encodeURIComponent(chat.conversationId)}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: message })
        });
        action.textContent = 'Sent';
      } catch (err) {
        row.disabled = false;
        action.textContent = 'Retry';
        status.textContent = err.message || 'Could not send. Try again.';
      }
    });
    list.append(row);
  });
}
