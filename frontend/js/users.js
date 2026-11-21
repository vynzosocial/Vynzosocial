import { apiRequest } from './api.js?v=sb6';
import { openPostViewer } from './feed.js?v=repost1';
import { protectMedia } from './media-protect.js';
import { openUserStories } from './stories.js?v=share5';
import { refreshExpiredMedia } from './r2-uploads.js';

import { API_ORIGIN as MEDIA_BASE_URL } from './config.js?v=sb4';
import { pageMemoryAccount, readPageMemory, writePageMemory, removePageMemory } from './page-memory.js';

export function initAccountSearch() {
  const form = document.getElementById('account-search-form');
  const input = document.getElementById('account-search-input');
  const results = document.getElementById('account-search-results');
  if (!form || !input || !results) return;

  let searchGeneration = 0;
  let activeQuery = '';
  const search = async (query, refresh = false) => {
    const generation = ++searchGeneration;
    await searchAccounts(query, results, () => generation === searchGeneration, refresh);
  };
  form.addEventListener('submit', event => {
    event.preventDefault();
    activeQuery = input.value.trim();
    search(activeQuery);
  });

  input.addEventListener('input', () => {
    activeQuery = '';
    searchGeneration++;
    removePageMemory('find:search');
    if (!input.value.trim()) {
      results.hidden = true;
      results.replaceChildren();
    }
  });

  initConnections();
  const savedSearch = readPageMemory('find:search');
  if (savedSearch?.query?.length >= 2 && Array.isArray(savedSearch.users)) {
    input.value = savedSearch.query;
    activeQuery = savedSearch.query;
    renderAccounts(results, savedSearch.users);
    search(activeQuery, true);
  }
  window.setInterval(() => {
    if (!document.hidden && activeQuery && !results.contains(document.activeElement)) {
      search(activeQuery, true);
    }
  }, 30000);
}

function liveFirst(users) {
  return users.filter(user => user.is_live).concat(users.filter(user => !user.is_live));
}

function initConnections() {
  const list = document.getElementById('connections-list');
  const tabs = document.querySelectorAll('.people-tab');
  if (!list || !tabs.length) return;

  const savedType = readPageMemory('find:tab');
  let activeType = ['following', 'followers'].includes(savedType) ? savedType : 'following';
  let generation = 0;
  const load = async (type, refresh = false) => {
    activeType = type;
    const request = ++generation;
    const cached = readPageMemory(`find:connections:${type}`);
    if (!refresh) {
      writePageMemory('find:tab', type);
      tabs.forEach(tab => {
        const active = tab.dataset.type === type;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      });
      if (Array.isArray(cached)) renderConnections(cached, type);
      else renderSearchMessage(list, 'Loading...');
    }
    const account = pageMemoryAccount();
    try {
      const data = await apiRequest(`/users/connections?type=${type}`);
      if (request !== generation || (account && pageMemoryAccount() !== account)) return;
      const users = type === 'followers' ? data.users.filter(user => !user.is_following) : data.users;
      writePageMemory(`find:connections:${type}`, users.slice(0, 100).map(user => ({ ...user, is_live: false })), account);
      renderConnections(users, type);
    } catch (err) {
      console.error('Could not load connections:', err);
      if (request === generation && (!refresh || (cached && !readPageMemory(`find:connections:${type}`)))) {
        const message = err.message || 'Log in to see your friends, following, and followers.';
        if (readPageMemory(`find:connections:${type}`)) appendSearchError(list, message);
        else renderSearchMessage(list, message);
      }
    }
  };

  function renderConnections(users, type) {
    list.replaceChildren();
    if (!users.length) {
      renderSearchMessage(list, type === 'following'
        ? 'You are not following anyone yet. Friends and people you follow will appear here.'
        : 'No followers waiting for a follow back.');
      return;
    }
    liveFirst(users).forEach(user => list.appendChild(createAccountResult(user, true, () => load(activeType, true))));
  }

  tabs.forEach(tab => tab.addEventListener('click', () => load(tab.dataset.type)));
  load(activeType);
  window.setInterval(() => {
    if (!document.hidden && !list.contains(document.activeElement)) load(activeType, true);
  }, 30000);
}

async function searchAccounts(query, container, isCurrent, refresh = false) {
  if (query.length < 2) {
    renderSearchMessage(container, 'Enter at least 2 characters to search.');
    return;
  }

  container.hidden = false;
  if (!refresh) {
    const saved = readPageMemory('find:search');
    if (saved?.query === query && Array.isArray(saved.users)) renderAccounts(container, saved.users);
    else renderSearchMessage(container, 'Searching accounts...');
  }
  const account = pageMemoryAccount();
  try {
    const data = await apiRequest(`/users/search?q=${encodeURIComponent(query)}`);
    if (!isCurrent() || (account && pageMemoryAccount() !== account)) return;
    writePageMemory('find:search', {
      query, users: data.users.slice(0, 100).map(user => ({ ...user, is_live: false }))
    }, account);
    renderAccounts(container, data.users);
  } catch (err) {
    console.error('Account search failed:', err);
    if (isCurrent()) {
      const saved = readPageMemory('find:search');
      if (saved?.query === query) appendSearchError(container, err.message || 'Could not refresh accounts.');
      else renderSearchMessage(container, err.message || 'Could not search accounts. Please try again.');
    }
  }
}

function renderAccounts(container, users) {
  container.hidden = false;
  container.replaceChildren();
  if (!users.length) {
    renderSearchMessage(container, 'No accounts found.');
    return;
  }
  liveFirst(users).forEach(user => container.appendChild(createAccountResult(user)));
}

function appendSearchError(container, message) {
  container.querySelector('.account-search-refresh-error')?.remove();
  const status = document.createElement('p');
  status.className = 'account-search-message account-search-refresh-error';
  status.textContent = message;
  container.appendChild(status);
}

function createLiveIndicator(user) {
  const link = document.createElement('a');
  link.className = 'account-live-indicator';
  link.setAttribute('aria-label', `Watch ${user.display_name || user.username} live`);
  link.title = 'Watch live';
  const inPages = window.location.pathname.includes('/pages/');
  link.href = `${inPages ? '' : 'pages/'}live.html?sessionId=${encodeURIComponent(user.live_session_id)}`;
  link.addEventListener('click', event => event.stopPropagation());
  link.addEventListener('keydown', event => event.stopPropagation());
  return link;
}

// Red LIVE pill that opens the user's running stream.
function createLiveBadge(user) {
  const badge = document.createElement('a');
  badge.className = 'account-live-badge';
  badge.textContent = `\u25CF LIVE${user.live_title ? ' \u00B7 ' + user.live_title : ''}`;
  const inPages = window.location.pathname.includes('/pages/');
  badge.href = `${inPages ? '' : 'pages/'}live.html?sessionId=${encodeURIComponent(user.live_session_id)}`;
  badge.style.cssText = 'display:inline-block;margin-top:4px;padding:2px 10px;border-radius:12px;background:#e5334b;color:#fff;font-size:12px;font-weight:700;text-decoration:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;box-shadow:0 0 10px rgba(229,51,75,.7)';
  badge.addEventListener('click', event => event.stopPropagation());
  badge.addEventListener('keydown', event => event.stopPropagation());
  return badge;
}

function createAccountResult(user, isConnection = false, onFollowChanged) {
  const row = document.createElement('article');
  row.className = `account-search-result${isConnection ? ' account-connection' : ''}`;

  const avatar = document.createElement('span');
  avatar.className = `account-search-avatar${user.is_live ? ' is-live' : ''}`;
  if (user.avatar_url) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      avatar.textContent = (user.username || 'u')[0].toUpperCase();
    }, { once: true });
    image.src = /^https?:/i.test(user.avatar_url) ? user.avatar_url : `${MEDIA_BASE_URL}${user.avatar_url}`;
    avatar.appendChild(image);
  } else {
    avatar.textContent = (user.username || 'u')[0].toUpperCase();
  }

  const identity = document.createElement('span');
  identity.className = 'account-search-identity';
  const nameRow = document.createElement('span');
  nameRow.className = 'account-search-name-row';
  const name = document.createElement('strong');
  name.textContent = user.display_name || user.username;
  nameRow.appendChild(name);
  if (user.is_live) nameRow.appendChild(createLiveIndicator(user));
  const username = document.createElement('small');
  username.textContent = `@${user.username}`;
  const counts = document.createElement('small');
  counts.className = 'account-search-counts';
  counts.textContent = `${user.friends_count ?? 0} friends · ${user.followers_count ?? 0} followers`;
  identity.append(nameRow, username, counts);
  if (isConnection) {
    const relationship = document.createElement('small');
    relationship.className = 'account-search-relationship';
    relationship.textContent = user.is_friend
      ? 'Friend (you follow each other)'
      : user.is_following ? "Following (doesn't follow you back)" : "Follows you (you don't follow back)";
    identity.appendChild(relationship);
  }

  const viewButton = document.createElement('button');
  viewButton.type = 'button';
  viewButton.className = 'account-profile-button';
  viewButton.textContent = 'View profile';
  viewButton.addEventListener('click', () => openUserProfile(user.id));

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'account-follow-button';
  updateFollowButton(button, user);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = user.is_following || user.follow_requested
        ? await apiRequest(`/users/${user.id}/follow`, { method: 'DELETE' })
        : await apiRequest(`/users/${user.id}/follow`, { method: 'POST' });
      user.is_following = result.is_following;
      user.follow_requested = result.follow_requested;
      user.is_friend = result.is_friend;
      updateFollowButton(button, user);
      if (onFollowChanged) await onFollowChanged();
    } catch (err) {
      console.error('Could not update account follow:', err);
      alert(err.message || 'Could not update account. Please try again.');
    } finally {
      button.disabled = false;
    }
  });

  avatar.title = `View @${user.username}'s profile`;
  avatar.tabIndex = 0;
  avatar.setAttribute('role', 'button');
  avatar.addEventListener('click', () => openUserProfile(user.id));
  avatar.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openUserProfile(user.id);
    }
  });
  identity.title = `View @${user.username}'s profile`;
  identity.tabIndex = 0;
  identity.setAttribute('role', 'button');
  identity.addEventListener('click', () => openUserProfile(user.id));
  identity.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openUserProfile(user.id);
    }
  });

  row.append(avatar, identity, viewButton, button);
  return row;
}

let profileRequest = 0;

export async function openUserProfile(userId) {
  const request = ++profileRequest;
  const modal = ensureProfileModal();
  modal.classList.add('active');
  const content = modal.querySelector('.account-profile-content');
  content.innerHTML = '<p class="account-profile-status">Loading profile...</p>';

  try {
    const data = await apiRequest(`/users/${userId}/profile`);
    if (request === profileRequest) renderUserProfile(content, data.profile, data.posts);
  } catch (err) {
    console.error('Could not load user profile:', err);
    if (request !== profileRequest) return;
    content.innerHTML = '';
    const message = document.createElement('p');
    message.className = 'account-profile-status';
    message.textContent = err.message || 'Could not load this profile.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => openUserProfile(userId));
    content.append(message, retry);
  }
}

function ensureProfileModal() {
  let modal = document.getElementById('account-profile-modal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'account-profile-modal';
  modal.className = 'account-profile-modal';
  modal.innerHTML = `
    <section class="account-profile-dialog" role="dialog" aria-modal="true" aria-label="Account profile">
      <button class="account-profile-close" type="button" aria-label="Close profile">&times;</button>
      <div class="account-profile-content"></div>
    </section>
  `;
  document.body.appendChild(modal);
  modal.querySelector('.account-profile-close').addEventListener('click', () => modal.classList.remove('active'));
  modal.addEventListener('click', event => {
    if (event.target === modal) modal.classList.remove('active');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.getElementById('post-viewer-modal')?.classList.contains('active')) {
      modal.classList.remove('active');
    }
  });
  return modal;
}

function createProfileReportForm(profileId, reportButton) {
  const form = document.createElement('form');
  form.className = 'account-profile-report-form';
  form.hidden = true;

  const heading = document.createElement('h3');
  heading.textContent = 'Report this profile';

  const reasonLabel = document.createElement('label');
  reasonLabel.textContent = 'What is the issue?';
  const reasonSelect = document.createElement('select');
  reasonSelect.name = 'reason';
  reasonSelect.required = true;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a reason';
  placeholder.disabled = true;
  placeholder.selected = true;
  reasonSelect.appendChild(placeholder);

  const reasons = [
    ['Harassment, threats, hate speech or bullying', 'Harassment, threats, hate speech or bullying'],
    ['Nudity or sexual content', 'Nudity, sexual content or sharing private images without consent'],
    ['Violence or self-harm', 'Violence, graphic abuse, self-harm or illegal activity'],
    ['Spam, scams, fake account or impersonation', 'Spam, scams, fake account or impersonation'],
    ['Privacy or copyright', 'Privacy or copyright violation'],
    ['Other', 'Something else']
  ];
  reasons.forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    reasonSelect.appendChild(option);
  });
  reasonLabel.appendChild(reasonSelect);

  const detailsLabel = document.createElement('label');
  detailsLabel.textContent = 'Additional details (optional)';
  const detailsInput = document.createElement('textarea');
  detailsInput.name = 'details';
  detailsInput.maxLength = 1000;
  detailsInput.rows = 3;
  detailsInput.placeholder = 'Add details to help us review your report';
  detailsLabel.appendChild(detailsInput);

  const actions = document.createElement('div');
  actions.className = 'account-profile-report-actions';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'account-profile-report-cancel';
  cancelButton.textContent = 'Cancel';
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'account-profile-report-submit';
  submitButton.textContent = 'Submit report';
  actions.append(cancelButton, submitButton);

  const status = document.createElement('p');
  status.className = 'account-profile-report-status';
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  form.append(heading, reasonLabel, detailsLabel, actions, status);
  cancelButton.addEventListener('click', () => {
    form.hidden = true;
    form.reset();
    status.hidden = true;
    status.textContent = '';
    status.removeAttribute('role');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    cancelButton.disabled = true;
    submitButton.disabled = true;
    reasonSelect.disabled = true;
    detailsInput.disabled = true;
    status.hidden = false;
    status.removeAttribute('role');
    status.textContent = 'Sending report...';
    try {
      const details = detailsInput.value.trim();
      const reason = details ? `${reasonSelect.value}: ${details}` : reasonSelect.value;
      const result = await apiRequest('/moderation/report', {
        method: 'POST',
        body: JSON.stringify({ target_type: 'profile', target_id: profileId, reason })
      });
      status.textContent = result.message || 'Report submitted. Thank you.';
      reportButton.disabled = true;
    } catch (err) {
      console.error('Could not report profile:', err);
      status.setAttribute('role', 'alert');
      status.textContent = err.message || 'Could not submit the report. Please try again.';
      cancelButton.disabled = false;
      submitButton.disabled = false;
      reasonSelect.disabled = false;
      detailsInput.disabled = false;
    }
  });
  return form;
}

function createLiveNotificationControl(profile) {
  const label = document.createElement('label');
  label.className = 'account-live-notification';
  const input = document.createElement('input');
  input.type = 'checkbox';
  const text = document.createElement('span');
  text.textContent = 'Notify me when this friend goes live';
  const status = document.createElement('span');
  status.className = 'account-live-notification-status';
  status.setAttribute('role', 'status');
  if (typeof profile.live_notifications_enabled !== 'boolean') {
    input.disabled = true;
    status.textContent = 'Live notifications are temporarily unavailable.';
  } else {
    input.checked = profile.live_notifications_enabled;
  }
  input.addEventListener('change', async () => {
    const previous = profile.live_notifications_enabled;
    const requested = input.checked;
    input.disabled = true;
    status.textContent = '';
    try {
      const result = await apiRequest(`/users/${profile.id}/live-notifications`, {
        method: requested ? 'POST' : 'DELETE'
      });
      if (result.live_notifications_enabled !== requested) {
        throw new Error('Unexpected live notification setting.');
      }
      profile.live_notifications_enabled = requested;
    } catch (error) {
      console.error('Could not update live notifications:', error);
      input.checked = previous;
      status.textContent = 'Could not update live notifications. Please try again.';
    } finally {
      input.disabled = false;
    }
  });
  label.append(input, text, status);
  return label;
}

function renderUserProfile(container, profile, posts) {
  container.replaceChildren();

  const header = document.createElement('header');
  header.className = 'account-profile-header';
  const avatar = document.createElement('span');
  avatar.className = 'account-profile-avatar';
  if (profile.avatar_url) {
    const image = document.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    image.addEventListener('error', () => {
      avatar.textContent = (profile.username || 'u')[0].toUpperCase();
    }, { once: true });
    image.src = /^https?:/i.test(profile.avatar_url) ? profile.avatar_url : `${MEDIA_BASE_URL}${profile.avatar_url}`;
    avatar.appendChild(image);
  } else {
    avatar.textContent = (profile.username || 'u')[0].toUpperCase();
  }

  const identity = document.createElement('div');
  identity.className = 'account-profile-identity';
  const name = document.createElement('h2');
  name.textContent = profile.display_name || profile.username;
  const username = document.createElement('p');
  username.textContent = `@${profile.username}`;
  identity.append(name, username);
  if (profile.is_live) identity.appendChild(createLiveBadge(profile));
  if (profile.is_owner && profile.vynzo_id) {
    const privateId = document.createElement('small');
    privateId.className = 'account-profile-private-id';
    privateId.textContent = `Private Vynzo ID: ${profile.vynzo_id}`;
    identity.appendChild(privateId);
  }

  const followButton = document.createElement('button');
  followButton.type = 'button';
  followButton.className = 'account-follow-button';
  updateFollowButton(followButton, profile);
  followButton.hidden = profile.is_owner;
  followButton.addEventListener('click', async () => {
    followButton.disabled = true;
    try {
      const result = profile.is_following || profile.follow_requested
        ? await apiRequest(`/users/${profile.id}/follow`, { method: 'DELETE' })
        : await apiRequest(`/users/${profile.id}/follow`, { method: 'POST' });
      profile.is_following = result.is_following;
      profile.follow_requested = result.follow_requested;
      profile.is_friend = result.is_friend;
      await openUserProfile(profile.id);
    } catch (err) {
      console.error('Could not update profile follow:', err);
      alert(err.message || 'Could not update account. Please try again.');
    } finally {
      followButton.disabled = false;
    }
  });

  const reportButton = document.createElement('button');
  reportButton.type = 'button';
  reportButton.className = 'account-report-button';
  reportButton.textContent = 'Report profile';
  reportButton.hidden = profile.is_owner;

  const reportForm = createProfileReportForm(profile.id, reportButton);
  reportButton.addEventListener('click', () => {
    reportForm.hidden = false;
    reportForm.querySelector('select').focus();
  });

  const messageButton = document.createElement('button');
  messageButton.type = 'button';
  messageButton.className = 'account-message-button';
  messageButton.textContent = 'Message';
  messageButton.hidden = profile.is_owner;
  if (profile.can_message === false) {
    messageButton.disabled = true;
    messageButton.title = profile.message_block_reason || 'Messages are turned off for this account.';
    messageButton.textContent = 'Messages off';
  }
  messageButton.addEventListener('click', async () => {
    messageButton.disabled = true;
    try {
      const result = await apiRequest('/messages/conversations', {
        method: 'POST',
        body: JSON.stringify({ recipientId: profile.id })
      });
      const currentPath = window.location.pathname;
      const messagesPage = currentPath.includes('/pages/')
        ? 'messages.html'
        : 'pages/messages.html';
      const messagesUrl = new URL(messagesPage, window.location.href);
      messagesUrl.searchParams.set('conversationId', result.conversationId);
      window.location.href = messagesUrl.href;
    } catch (err) {
      console.error('Could not start direct message:', err);
      alert(err.message || 'Could not start a conversation. Please try again.');
      messageButton.disabled = false;
    }
  });

  const blockButton = document.createElement('button');
  blockButton.type = 'button';
  blockButton.className = 'account-block-button';
  blockButton.hidden = profile.is_owner;
  blockButton.textContent = profile.is_blocked ? 'Unblock' : 'Block';
  blockButton.style.cssText = 'background:transparent;border:1px solid #e5334b;color:#e5334b;border-radius:999px;padding:6px 14px;cursor:pointer;font:inherit';
  blockButton.addEventListener('click', async () => {
    const unblocking = Boolean(profile.is_blocked);
    const question = unblocking
      ? `Unblock @${profile.username}?`
      : `Block @${profile.username}? You will no longer see each other's posts, stories, comments or blogs, and any follow between you will be removed.`;
    if (!window.confirm(question)) return;
    blockButton.disabled = true;
    try {
      await apiRequest(`/moderation/block/${profile.id}`, { method: unblocking ? 'DELETE' : 'POST' });
      await openUserProfile(profile.id);
    } catch (err) {
      console.error('Could not update block:', err);
      alert(err.message || 'Could not update block. Please try again.');
      blockButton.disabled = false;
    }
  });

  if (profile.is_blocked) {
    followButton.hidden = true;
    messageButton.hidden = true;
  }
  header.append(avatar, identity, messageButton, followButton, reportButton, blockButton);
  container.appendChild(header);
  if (!profile.is_owner && !profile.is_blocked && profile.is_friend) {
    container.appendChild(createLiveNotificationControl(profile));
  }
  if (!profile.is_owner) container.appendChild(reportForm);

  const storyButton = document.createElement('button');
  storyButton.type = 'button';
  storyButton.className = 'account-story-button';
  storyButton.textContent = '? View story';
  storyButton.hidden = true;
  storyButton.addEventListener('click', () => openUserStories(profile.id));
  container.appendChild(storyButton);
  if (!profile.is_blocked) apiRequest('/stories?scope=any').then(data => {
    if ((data.usersWithStories || []).some(item => item.user_id === profile.id)) {
      storyButton.hidden = false;
      avatar.classList.add('has-story');
      avatar.style.cursor = 'pointer';
      avatar.addEventListener('click', () => openUserStories(profile.id));
    }
  }).catch(() => {});

  const stats = document.createElement('div');
  stats.className = 'account-profile-stats';
  stats.innerHTML = `
    <span><strong>${profile.posts_count ?? '—'}</strong> posts</span>
    <span><strong>${profile.friends_count ?? 0}</strong> friends</span>
    <span><strong>${profile.followers_count}</strong> followers</span>
    <span><strong>${profile.following_count ?? '—'}</strong> following</span>
  `;
  container.appendChild(stats);

  if (!profile.is_owner && profile.like_stats) {
    const ls = profile.like_stats;
    const likesBox = document.createElement('div');
    likesBox.className = 'account-profile-likes';
    likesBox.style.cssText = 'margin:10px 0;padding:10px 14px;border-radius:14px;background:rgba(255,80,130,.1);border:1px solid rgba(255,80,130,.28);text-align:center;';
    likesBox.innerHTML = `
      <div class="account-likes-total">❤️ <strong>${(ls.images || 0) + (ls.videos || 0) + (ls.blogs || 0)}</strong> total likes</div>
      <div class="account-likes-breakdown" style="display:flex;justify-content:center;gap:14px;flex-wrap:wrap;margin-top:4px;font-size:13px;opacity:.85;">
        <span>🖼️ ${ls.images || 0} images</span>
        <span>🎬 ${ls.videos || 0} videos</span>
        <span>📝 ${ls.blogs || 0} blogs</span>
      </div>
    `;
    container.appendChild(likesBox);
  }
  if (profile.bio) {
    const bio = document.createElement('p');
    bio.className = 'account-profile-bio';
    bio.textContent = profile.bio;
    container.appendChild(bio);
  }
  if (/^[A-Za-z0-9._]{1,30}$/.test(profile.instagram_username || '')) {
    const instagram = document.createElement('a');
    instagram.className = 'account-profile-instagram';
    instagram.href = `https://www.instagram.com/${profile.instagram_username}/`;
    instagram.target = '_blank';
    instagram.rel = 'noopener noreferrer';
    instagram.textContent = `📷 Instagram @${profile.instagram_username}`;
    container.appendChild(instagram);
  }
  if (/^[A-Za-z0-9.]{1,50}$/.test(profile.facebook_username || '')) {
    const facebook = document.createElement('a');
    facebook.className = 'account-profile-facebook';
    facebook.href = `https://www.facebook.com/${profile.facebook_username}`;
    facebook.target = '_blank';
    facebook.rel = 'noopener noreferrer';
    facebook.textContent = `📘 Facebook @${profile.facebook_username}`;
    container.appendChild(facebook);
  }
  if (/^[A-Za-z0-9._-]{1,30}$/.test(profile.snapchat_username || '')) {
    const snapchat = document.createElement('a');
    snapchat.className = 'account-profile-snapchat';
    snapchat.href = `https://www.snapchat.com/add/${profile.snapchat_username}`;
    snapchat.target = '_blank';
    snapchat.rel = 'noopener noreferrer';
    snapchat.textContent = `👻 Snapchat @${profile.snapchat_username}`;
    container.appendChild(snapchat);
  }

  const postsHeading = document.createElement('h3');
  postsHeading.className = 'account-profile-posts-heading';
  const locked = profile.is_private && !profile.can_view_content && !profile.is_owner;
  postsHeading.textContent = locked ? 'Private profile' : 'Posts';
  container.appendChild(postsHeading);

  if (locked) {
    const note = document.createElement('p');
    note.className = 'account-profile-private-note';
    note.textContent = 'This profile is private. Posts, videos and stories are only visible to friends — you both need to add each other.';
    container.appendChild(note);
    return;
  }

  if (!posts.length) {
    const empty = document.createElement('p');
    empty.className = 'account-profile-status';
    empty.textContent = 'This account has not shared any posts yet.';
    container.appendChild(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'account-profile-post-grid';
  const viewerPosts = posts.map(post => ({
    ...post,
    author_username: post.author_username || profile.username,
    author_avatar_url: post.is_repost ? post.author_avatar_url : profile.avatar_url
  }));
  viewerPosts.forEach(post => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'account-profile-post';
    button.setAttribute('aria-label', `Open ${post.media_type} post by @${post.author_username}`);
    const media = document.createElement(post.media_type === 'video' ? 'video' : 'img');
    refreshExpiredMedia(media, post, 'post');
    media.src = /^https?:/i.test(post.media_url) ? post.media_url : `${MEDIA_BASE_URL}${post.media_url}`;
    media.className = 'account-profile-post-media';
    if (post.media_type === 'video') {
      media.muted = true;
      media.playsInline = true;
      media.preload = 'metadata';
      media.addEventListener('loadedmetadata', () => {
        button.classList.remove('preview-unavailable');
        button.setAttribute('aria-label', `Open video post by @${post.author_username}`);
      });
      media.addEventListener('loadedmetadata', () => {
        if (media.duration > 0) {
          media.currentTime = Math.min(0.1, media.duration / 2);
        }
      }, { once: true });
      media.addEventListener('error', () => {
        button.classList.add('preview-unavailable');
        button.setAttribute('aria-label', `Video preview unavailable. Open post by @${post.author_username}`);
      }, { once: true });
    } else {
      media.alt = `Post by @${post.author_username}`;
    }
    button.appendChild(media);
    button.dataset.postId = post.id;
    if (post.is_repost) {
      button.dataset.repostId = post.id;
      const badge = document.createElement('span');
      badge.className = 'account-profile-repost-indicator';
      badge.textContent = 'Repost';
      button.appendChild(badge);
    }
    if (post.is_protected) protectMedia(button);
    if (post.media_type === 'video') {
      const indicator = document.createElement('span');
      indicator.className = 'account-profile-video-indicator';
      indicator.textContent = '▶';
      button.appendChild(indicator);
    }
    button.addEventListener('click', () => openPostViewer(post, viewerPosts));
    grid.appendChild(button);
  });
  container.appendChild(grid);
}

function updateFollowButton(button, user) {
  if (user.is_friend) {
    button.textContent = 'Friends';
    button.classList.add('is-following', 'is-friend');
    button.setAttribute('aria-label', `Remove your follow of @${user.username}; you are friends`);
  } else if (user.is_following) {
    button.textContent = 'Following';
    button.classList.add('is-following');
    button.classList.remove('is-friend');
    button.setAttribute('aria-label', `Unfollow @${user.username}`);
  } else if (user.follow_requested) {
    button.textContent = 'Requested';
    button.classList.add('is-following');
    button.classList.remove('is-friend');
    button.setAttribute('aria-label', `Cancel follow request to @${user.username}`);
  } else {
    button.textContent = user.follows_me ? 'Follow back' : 'Follow';
    button.classList.remove('is-following', 'is-friend');
    button.setAttribute('aria-label', `${user.follows_me ? 'Follow back' : 'Follow'} @${user.username}`);
  }
}

function renderSearchMessage(container, message) {
  container.replaceChildren();
  const status = document.createElement('p');
  status.className = 'account-search-message';
  status.textContent = message;
  container.appendChild(status);
  container.hidden = false;
}
