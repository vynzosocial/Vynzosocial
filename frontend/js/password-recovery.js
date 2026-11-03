import { requireSupabase } from './supabase-client.js';

document.addEventListener('DOMContentLoaded', async () => {
  const errorEl = document.getElementById('error-message');
  const successEl = document.getElementById('success-message');
  let supabase;
  try {
    supabase = requireSupabase();
  } catch (error) {
    errorEl.textContent = error.message || 'Password recovery is not available right now.';
    return;
  }

  const recoveryForm = document.getElementById('password-recovery-form');
  const resetForm = document.getElementById('reset-password-form');

  if (recoveryForm) {
    recoveryForm.addEventListener('submit', async event => {
      event.preventDefault();
      const email = document.getElementById('email').value.trim();
      const button = recoveryForm.querySelector('button[type="submit"]');
      errorEl.textContent = '';
      button.disabled = true;

      try {
        const redirectTo = new URL('reset-password.html', window.location.href).href;
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        successEl.textContent = 'If an account exists for that email, a secure password reset link will be sent.';
        successEl.hidden = false;
        recoveryForm.hidden = true;
      } catch (error) {
        errorEl.textContent = error.message || 'Unable to send a password reset email.';
      } finally {
        button.disabled = false;
      }
    });
  }

  if (resetForm) {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (!data.session) {
        throw new Error('This password reset link is invalid or expired. Request a new one to continue.');
      }
      resetForm.hidden = false;
    } catch (error) {
      errorEl.textContent = error.message || 'Unable to verify this password reset link.';
    }

    resetForm.addEventListener('submit', async event => {
      event.preventDefault();
      const password = document.getElementById('password').value;
      const confirmation = document.getElementById('confirm-password').value;
      const button = resetForm.querySelector('button[type="submit"]');
      errorEl.textContent = '';

      if (password !== confirmation) {
        errorEl.textContent = 'The passwords do not match.';
        return;
      }

      button.disabled = true;
      try {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        resetForm.hidden = true;
        document.getElementById('login-link').hidden = true;
        document.getElementById('home-link').hidden = false;
        successEl.textContent = 'Your password has been updated.';
        successEl.hidden = false;
      } catch (error) {
        errorEl.textContent = error.message || 'Unable to update your password.';
      } finally {
        button.disabled = false;
      }
    });
  }
});
