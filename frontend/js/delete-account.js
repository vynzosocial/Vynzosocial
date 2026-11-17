import { apiRequest } from './api.js?v=sb6';
import { signOutSupabase } from './supabase-client.js';

document.addEventListener('DOMContentLoaded', () => {
  let user = {};
  try {
    user = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  } catch (error) {
    console.error('Could not read the signed-in account:', error);
  }
  setupAccountDeletion(user);
});

function setupAccountDeletion(user) {
  const passwordForm = document.getElementById('account-deletion-password-form');
  const codeForm = document.getElementById('account-deletion-code-form');
  const passwordInput = document.getElementById('account-deletion-password');
  const codeInput = document.getElementById('account-deletion-code');
  const requestButton = document.getElementById('account-deletion-request-button');
  const confirmButton = document.getElementById('account-deletion-confirm-button');
  const backButton = document.getElementById('account-deletion-back-button');
  const status = document.getElementById('account-deletion-status');

  passwordInput.value = '';
  window.addEventListener('pageshow', () => { passwordInput.value = ''; });

  if (!user?.id) {
    passwordForm.querySelectorAll('input, button').forEach(control => { control.disabled = true; });
    codeForm.querySelectorAll('input, button').forEach(control => { control.disabled = true; });
    setStatus(status, 'Log in to permanently delete your account.', 'error');
    return;
  }

  passwordForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (requestButton.disabled) return;
    if (!passwordInput.value) {
      setStatus(status, 'Enter your current password to delete your account.', 'error');
      passwordInput.focus();
      return;
    }
    if (!window.confirm('Are you sure you want to permanently delete your account and its data? This cannot be undone.')) return;

    requestButton.disabled = true;
    setStatus(status, 'Verifying your password and sending a confirmation code...', '');
    try {
      const result = await apiRequest('/auth/delete-account/request-code', {
        method: 'POST',
        body: JSON.stringify({ password: passwordInput.value }),
        timeoutMs: 45000
      });
      if (result.otp_sent !== true) throw new Error('The server did not confirm the email code was sent.');
      passwordInput.value = '';
      passwordForm.hidden = true;
      codeForm.hidden = false;
      codeInput.focus();
      setStatus(status, 'A 4-digit confirmation code was sent to your verified email address.', 'success');
    } catch (error) {
      console.error('Could not request account deletion:', error);
      setStatus(status, error.message || 'Could not send the confirmation code. Please try again.', 'error');
    } finally {
      requestButton.disabled = false;
    }
  });

  codeForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (confirmButton.disabled) return;
    const code = codeInput.value.trim();
    if (!/^\d{4}$/.test(code)) {
      setStatus(status, 'Enter the 4-digit code from your email.', 'error');
      codeInput.focus();
      return;
    }

    confirmButton.disabled = true;
    backButton.disabled = true;
    setStatus(status, 'Verifying your code and deleting your account...', '');
    try {
      const result = await apiRequest('/auth/delete-account/confirm', {
        method: 'POST',
        body: JSON.stringify({ code }),
        timeoutMs: 240000
      });
      if (result.deleted !== true) throw new Error('The server did not confirm permanent account deletion.');
      codeInput.value = '';
      setStatus(status, 'Your account and data have been permanently deleted.', 'success');
      try {
        await signOutSupabase({ scope: 'local', unregister: false });
      } catch (error) {
        console.error('Account deleted, but this device could not clear its local session:', error);
        localStorage.removeItem('vynzo_token');
        localStorage.removeItem('vynzo_user');
      }
      window.location.href = '../index.html';
    } catch (error) {
      console.error('Could not complete account deletion:', error);
      setStatus(status, error.message || 'Could not delete your account. Please try again.', 'error');
      confirmButton.disabled = false;
      backButton.disabled = false;
    }
  });

  backButton.addEventListener('click', () => {
    passwordInput.value = '';
    codeInput.value = '';
    codeForm.hidden = true;
    passwordForm.hidden = false;
    setStatus(status, 'Enter your password again to request a new email code.', '');
    passwordInput.focus();
  });
}

function setStatus(element, message, type) {
  element.textContent = message;
  element.className = `settings-status${type ? ` is-${type}` : ''}`;
}
