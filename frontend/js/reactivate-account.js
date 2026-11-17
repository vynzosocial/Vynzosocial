import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';

const button = document.getElementById('activate-account');
const status = document.getElementById('activation-status');
let token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', `${location.pathname}${location.search}`);

if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
  status.textContent = 'This activation link is invalid. Sign in again to request a new email.';
  button.hidden = true;
} else {
  button.disabled = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Reactivating your account...';
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/vynzo-api/api/auth/reactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
        body: JSON.stringify({ token }),
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      });
      const result = await response.json();
      if (!response.ok || result.activated !== true) throw new Error(result.error || 'Could not reactivate your account.');
      token = null;
      button.hidden = true;
      status.textContent = 'Your account is active again. You can now log in.';
    } catch (error) {
      status.textContent = error.message || 'Could not reactivate your account. Please try again.';
      button.disabled = false;
    }
  });
}
