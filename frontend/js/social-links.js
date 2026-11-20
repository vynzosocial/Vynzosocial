import { apiRequest } from './api.js?v=sb6';

const form = document.getElementById('social-links-form');
const status = document.getElementById('social-links-status');
const retry = document.getElementById('social-links-retry');
const networks = ['instagram', 'facebook', 'snapchat'];
let profile;
let userId;

function setStatus(message, type = '') {
  status.textContent = message;
  status.className = `settings-status${type ? ` is-${type}` : ''}`;
}

function disableForm(disabled) {
  form.querySelectorAll('input, button').forEach(control => { control.disabled = disabled; });
}

async function loadLinks() {
  retry.hidden = true;
  disableForm(true);
  setStatus('Loading links...');
  try {
    const user = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
    if (!user.id) {
      setStatus('Log in to edit your links.', 'error');
      return;
    }
    userId = user.id;
    const data = await apiRequest(`/users/${encodeURIComponent(userId)}/profile`);
    profile = data.profile;
    for (const network of networks) {
      form.elements[network].value = profile[`${network}_username`] || '';
    }
    disableForm(false);
    setStatus('');
  } catch (error) {
    console.error('Could not load social links:', error);
    setStatus(error.message || 'Could not load your links. Please try again.', 'error');
    retry.hidden = false;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!profile || !form.reportValidity()) return;
  disableForm(true);
  setStatus('Saving links...');
  try {
    const current = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
    if (current.id !== userId) throw new Error('Your account changed. Reopen this page to edit links.');
    // The existing profile endpoint requires username and bio on every update.
    const latest = await apiRequest(`/users/${encodeURIComponent(userId)}/profile`);
    if (JSON.parse(localStorage.getItem('vynzo_user') || '{}').id !== userId) {
      throw new Error('Your account changed. Reopen this page to edit links.');
    }
    const body = { username: latest.profile.username, bio: latest.profile.bio || '' };
    for (const network of networks) body[network] = form.elements[network].value.trim();
    const result = await apiRequest('/users/me/profile', { method: 'PATCH', body: JSON.stringify(body) });
    const stored = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
    if (stored.id !== userId) throw new Error('Your account changed. Reopen this page to see your links.');
    localStorage.setItem('vynzo_user', JSON.stringify({ ...stored, ...result.user }));
    profile = result.user;
    for (const network of networks) form.elements[network].value = profile[`${network}_username`] || '';
    setStatus('Links saved.', 'success');
  } catch (error) {
    console.error('Could not save social links:', error);
    setStatus(error.message || 'Could not save your links. Please try again.', 'error');
  } finally {
    disableForm(false);
  }
});

retry.addEventListener('click', loadLinks);
void loadLinks();
