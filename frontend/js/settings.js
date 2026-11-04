import { apiRequest } from './api.js?v=sb2';
import { signOutSupabase } from './supabase-client.js';

import { API_ORIGIN as MEDIA_BASE_URL } from './config.js?v=sb2';

document.addEventListener('DOMContentLoaded', () => {
  const userInfoEl = document.getElementById('user-info-display');
  const profileForm = document.getElementById('profile-settings-form');
  const usernameInput = document.getElementById('profile-username');
  const bioInput = document.getElementById('profile-bio');
  const bioCount = document.getElementById('bio-character-count');
  const photoInput = document.getElementById('profile-photo-input');
  const photoPreview = document.getElementById('profile-photo-preview');
  const photoFallback = document.getElementById('profile-photo-fallback');
  const saveProfileButton = document.getElementById('save-profile-button');
  const photoButton = document.getElementById('profile-photo-button');
  const photoStatus = document.getElementById('profile-photo-status');
  const heading = document.getElementById('profile-settings-heading');
  const status = document.getElementById('profile-status');
  const logoutBtn = document.getElementById('logout-btn');
  const user = readStoredUser();
  let previewUrl = null;

  if (!user.id) {
    userInfoEl.textContent = 'Log in to edit your profile.';
    profileForm.querySelectorAll('input, textarea, button').forEach(control => {
      control.disabled = true;
    });
    photoInput.disabled = true;
    photoButton.disabled = true;
  } else {
    if (user.username) heading.textContent = `@${user.username}`;
    userInfoEl.textContent = `Logged in as @${user.username}${user.email ? ` (${user.email})` : ''}`;
    loadProfile(user).catch(err => {
      console.error('Could not load profile settings:', err);
      setStatus(status, err.message || 'Could not load profile settings.', 'error');
    });
  }

  bioInput.addEventListener('input', () => {
    bioCount.textContent = String(bioInput.value.length);
  });

  photoButton.addEventListener('click', () => {
    if (user.id) photoInput.click();
  });

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    if (!file || !user.id) return;

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    photoPreview.src = previewUrl;
    photoPreview.hidden = false;
    photoFallback.hidden = true;

    photoButton.disabled = true;
    setStatus(photoStatus, 'Saving your profile photo...', '');
    try {
      const body = new FormData();
      body.append('avatar', file);
      const result = await apiRequest('/users/me/avatar', { method: 'PUT', body });
      storeUpdatedUser(result.user);
      Object.assign(user, result.user);
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      renderPhoto(photoPreview, photoFallback, user.avatar_url);
      setStatus(photoStatus, 'Profile photo saved.', 'success');
    } catch (err) {
      console.error('Could not update profile photo:', err);
      renderPhoto(photoPreview, photoFallback, user.avatar_url);
      setStatus(photoStatus, err.message || 'Could not upload profile photo. Please try again.', 'error');
    } finally {
      photoInput.value = '';
      photoButton.disabled = false;
    }
  });

  profileForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!user.id) return;

    saveProfileButton.disabled = true;
    setStatus(status, 'Saving your profile...', '');
    try {
      const result = await apiRequest('/users/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          username: usernameInput.value,
          bio: bioInput.value
        })
      });
      storeUpdatedUser(result.user, result.token);
      Object.assign(user, result.user);
      userInfoEl.textContent = `Logged in as @${user.username}${user.email ? ` (${user.email})` : ''}`;
      heading.textContent = `@${user.username}`;
      setStatus(status, 'Profile updated successfully.', 'success');
    } catch (err) {
      console.error('Could not update profile:', err);
      setStatus(status, err.message || 'Could not update profile. Please try again.', 'error');
    } finally {
      saveProfileButton.disabled = false;
    }
  });

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await signOutSupabase();
        window.location.href = '../index.html';
      } catch (err) {
        console.error('Could not sign out:', err);
        setStatus(status, err.message || 'Could not sign out. Please try again.', 'error');
      }
    });
  }
});

function formatStat(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  if (number <= 5000) return String(number);
  const compact = (divisor, suffix) => `${Math.floor(number / divisor * 10) / 10}${suffix}`;
  return number < 1000000 ? compact(1000, 'K') : compact(1000000, 'M');
}

async function loadProfile(user) {
  const data = await apiRequest(`/users/${encodeURIComponent(user.id)}/profile`);
  const profile = data.profile;
  document.getElementById('profile-vynzo-id').value = profile.vynzo_id || 'Unavailable';
  document.getElementById('profile-settings-heading').textContent = `@${profile.username}`;
  const likes = profile.like_stats || {};
  const stats = {
    'stat-followers': profile.followers_count,
    'stat-following': profile.following_count,
    'stat-likes-total': likes.total,
  };
  Object.entries(stats).forEach(([id, value]) => {
    document.getElementById(id).textContent = formatStat(value);
  });
  document.getElementById('profile-username').value = profile.username || '';
  document.getElementById('profile-bio').value = profile.bio || '';
  document.getElementById('bio-character-count').textContent = String((profile.bio || '').length);
  renderPhoto(
    document.getElementById('profile-photo-preview'),
    document.getElementById('profile-photo-fallback'),
    profile.avatar_url
  );
  const updatedUser = { ...user, ...profile };
  localStorage.setItem('vynzo_user', JSON.stringify(updatedUser));
  Object.assign(user, updatedUser);
  setupPrivacyToggle(Boolean(profile.is_private));
  setupMessagePrivacy(profile.message_privacy || 'everyone');
  setupPostsPrivacy(profile.posts_privacy || 'everyone');
  setupFollowingPrivacy(profile.following_privacy || 'everyone');
  setupReadReceipts(profile.read_receipts !== false);
  setupCallSetting(profile.allow_calls !== false);
}

const CALL_HINTS = {
  on: 'Friends can start voice and video calls with you.',
  off: 'Nobody can call you, and you cannot start calls.'
};

function setupCallSetting(allowed) {
  const select = document.getElementById('allow-calls-select');
  const hint = document.getElementById('allow-calls-hint');
  const status = document.getElementById('allow-calls-status');
  let saved = allowed ? 'on' : 'off';
  select.value = saved;
  hint.textContent = CALL_HINTS[saved];
  select.disabled = false;
  select.onchange = async () => {
    const wanted = select.value;
    select.disabled = true;
    setStatus(status, 'Saving...', '');
    try {
      const result = await apiRequest('/users/me/privacy', {
        method: 'PATCH',
        body: JSON.stringify({ allow_calls: wanted === 'on' })
      });
      saved = result.allow_calls ? 'on' : 'off';
      select.value = saved;
      hint.textContent = CALL_HINTS[saved];
      storeUpdatedUser({ allow_calls: result.allow_calls });
      setStatus(status, 'Call setting saved.', 'success');
    } catch (err) {
      select.value = saved;
      setStatus(status, err.message || 'Could not update call setting.', 'error');
    } finally {
      select.disabled = false;
    }
  };
}

const POSTS_PRIVACY_HINTS = {
  everyone: 'Anyone on Vynzo can see your posts (private profiles still limit this to friends).',
  friends: 'Only people you and they have both added can see your posts.',
  only_me: 'Only you can see your posts.'
};

function setupPostsPrivacy(current) {
  const select = document.getElementById('posts-privacy-select');
  const hint = document.getElementById('posts-privacy-hint');
  const status = document.getElementById('posts-privacy-status');
  let saved = POSTS_PRIVACY_HINTS[current] ? current : 'everyone';
  select.value = saved;
  hint.textContent = POSTS_PRIVACY_HINTS[saved];
  select.disabled = false;
  select.onchange = async () => {
    const wanted = select.value;
    select.disabled = true;
    setStatus(status, 'Saving...', '');
    try {
      const result = await apiRequest('/users/me/privacy', {
        method: 'PATCH',
        body: JSON.stringify({ posts_privacy: wanted })
      });
      saved = result.posts_privacy;
      select.value = saved;
      hint.textContent = POSTS_PRIVACY_HINTS[saved];
      storeUpdatedUser({ posts_privacy: saved });
      setStatus(status, 'Post visibility saved.', 'success');
    } catch (err) {
      select.value = saved;
      setStatus(status, err.message || 'Could not update post visibility.', 'error');
    } finally {
      select.disabled = false;
    }
  };
}

const FOLLOWING_PRIVACY_HINTS = {
  everyone: 'Anyone on Vynzo can see who you follow.',
  friends: 'Only people you and they have both added can see who you follow.',
  only_me: 'Only you can see who you follow.'
};

function setupFollowingPrivacy(current) {
  const select = document.getElementById('following-privacy-select');
  const hint = document.getElementById('following-privacy-hint');
  const status = document.getElementById('following-privacy-status');
  let saved = FOLLOWING_PRIVACY_HINTS[current] ? current : 'everyone';
  select.value = saved;
  hint.textContent = FOLLOWING_PRIVACY_HINTS[saved];
  select.disabled = false;
  select.onchange = async () => {
    const wanted = select.value;
    select.disabled = true;
    setStatus(status, 'Saving...', '');
    try {
      const result = await apiRequest('/users/me/privacy', {
        method: 'PATCH',
        body: JSON.stringify({ following_privacy: wanted })
      });
      saved = result.following_privacy;
      select.value = saved;
      hint.textContent = FOLLOWING_PRIVACY_HINTS[saved];
      storeUpdatedUser({ following_privacy: saved });
      setStatus(status, 'Following visibility saved.', 'success');
    } catch (err) {
      select.value = saved;
      setStatus(status, err.message || 'Could not update following visibility.', 'error');
    } finally {
      select.disabled = false;
    }
  };
}

const READ_RECEIPT_HINTS = {
  on: 'People you chat with can see when you have read their messages, and you can see when they read yours.',
  off: 'Nobody sees when you read their messages, and you cannot see when they read yours.'
};

function setupReadReceipts(enabled) {
  const select = document.getElementById('read-receipts-select');
  const hint = document.getElementById('read-receipts-hint');
  const status = document.getElementById('read-receipts-status');
  let saved = enabled ? 'on' : 'off';
  select.value = saved;
  hint.textContent = READ_RECEIPT_HINTS[saved];
  select.disabled = false;
  select.onchange = async () => {
    const wanted = select.value;
    select.disabled = true;
    setStatus(status, 'Saving...', '');
    try {
      const result = await apiRequest('/users/me/privacy', {
        method: 'PATCH',
        body: JSON.stringify({ read_receipts: wanted === 'on' })
      });
      saved = result.read_receipts ? 'on' : 'off';
      select.value = saved;
      hint.textContent = READ_RECEIPT_HINTS[saved];
      storeUpdatedUser({ read_receipts: result.read_receipts });
      setStatus(status, 'Read receipt setting saved.', 'success');
    } catch (err) {
      select.value = saved;
      setStatus(status, err.message || 'Could not update read receipts.', 'error');
    } finally {
      select.disabled = false;
    }
  };
}

const MESSAGE_PRIVACY_HINTS = {
  everyone: 'Anyone on Vynzo can send you a message.',
  friends: 'Only people you and they have both added can message you.',
  nobody: 'Nobody can start or continue a chat with you.'
};

function setupMessagePrivacy(current) {
  const select = document.getElementById('message-privacy-select');
  const hint = document.getElementById('message-privacy-hint');
  const status = document.getElementById('message-privacy-status');
  let saved = MESSAGE_PRIVACY_HINTS[current] ? current : 'everyone';
  select.value = saved;
  hint.textContent = MESSAGE_PRIVACY_HINTS[saved];
  select.disabled = false;
  select.onchange = async () => {
    const wanted = select.value;
    select.disabled = true;
    setStatus(status, 'Saving...', '');
    try {
      const result = await apiRequest('/users/me/privacy', {
        method: 'PATCH',
        body: JSON.stringify({ message_privacy: wanted })
      });
      saved = result.message_privacy;
      select.value = saved;
      hint.textContent = MESSAGE_PRIVACY_HINTS[saved];
      storeUpdatedUser({ message_privacy: saved });
      setStatus(status, 'Message setting saved.', 'success');
    } catch (err) {
      select.value = saved;
      setStatus(status, err.message || 'Could not update message setting.', 'error');
    } finally {
      select.disabled = false;
    }
  };
}
function privacyHint(isPrivate) {
  return isPrivate
    ? 'On — only friends can see your posts, videos and stories.'
    : 'Off — everyone can see your posts, videos and stories.';
}

function setupPrivacyToggle(isPrivate) {
  const toggle = document.getElementById('private-profile-toggle');
  const hint = document.getElementById('privacy-hint');
  const status = document.getElementById('privacy-status');
  toggle.checked = isPrivate;
  toggle.disabled = false;
  hint.textContent = privacyHint(isPrivate);
  toggle.onchange = async () => {
    const wanted = toggle.checked;
    toggle.disabled = true;
    setStatus(status, 'Saving...', '');
    try {
      const result = await apiRequest('/users/me/privacy', {
        method: 'PATCH',
        body: JSON.stringify({ is_private: wanted })
      });
      toggle.checked = result.is_private;
      hint.textContent = privacyHint(result.is_private);
      storeUpdatedUser({ is_private: result.is_private });
      setStatus(status, result.is_private ? 'Your profile is now private.' : 'Your profile is now public.', 'success');
    } catch (err) {
      toggle.checked = !wanted;
      setStatus(status, err.message || 'Could not update privacy.', 'error');
    } finally {
      toggle.disabled = false;
    }
  };
}

function renderPhoto(preview, fallback, avatarUrl) {
  if (avatarUrl) {
    preview.src = /^https?:/i.test(avatarUrl) ? avatarUrl : `${MEDIA_BASE_URL}${avatarUrl}`;
    preview.hidden = false;
    fallback.hidden = true;
    return;
  }

  preview.removeAttribute('src');
  preview.hidden = true;
  fallback.textContent = (readStoredUser().display_name || readStoredUser().username || 'V')[0].toUpperCase();
  fallback.hidden = false;
}

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  } catch (err) {
    console.error('Stored account information is invalid:', err);
    return {};
  }
}

function storeUpdatedUser(user, token) {
  const currentUser = readStoredUser();
  localStorage.setItem('vynzo_user', JSON.stringify({ ...currentUser, ...user }));
  if (token) localStorage.setItem('vynzo_token', token);
}

function setStatus(element, message, type) {
  element.textContent = message;
  element.className = `settings-status${type ? ` is-${type}` : ''}`;
}
