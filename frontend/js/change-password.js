import { requireSupabase } from './supabase-client.js';

const form = document.getElementById('change-password-form');
const statusEl = document.getElementById('change-password-status');

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `settings-status${type ? ` is-${type}` : ''}`;
}

let signedIn = false;
try {
  signedIn = Boolean(JSON.parse(localStorage.getItem('vynzo_user') || '{}').id);
} catch {
  signedIn = false;
}
if (!signedIn) {
  form.querySelectorAll('input, button').forEach(control => { control.disabled = true; });
  setStatus('Log in to change your password.', 'error');
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const current = document.getElementById('current-password').value;
  const next = document.getElementById('new-password').value;
  const confirmation = document.getElementById('confirm-new-password').value;
  const button = form.querySelector('button[type="submit"]');

  if (next.length < 6) return setStatus('The new password must be at least 6 characters.', 'error');
  if (next !== confirmation) return setStatus('The new passwords do not match.', 'error');
  if (next === current) return setStatus('The new password must be different from the current one.', 'error');

  button.disabled = true;
  setStatus('Updating password...', '');
  try {
    const supabase = requireSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const email = sessionData.session?.user?.email;
    if (!sessionData.session) throw new Error('Please log in again to change your password.');
    if (email) {
      const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: current });
      if (verifyError) throw new Error('Your current password is incorrect.');
    }
    const { error } = await supabase.auth.updateUser({ password: next });
    if (error) throw error;
    form.reset();
    setStatus('Your password has been updated.', 'success');
  } catch (err) {
    setStatus(err.message || 'Could not update your password.', 'error');
  } finally {
    button.disabled = false;
  }
});
