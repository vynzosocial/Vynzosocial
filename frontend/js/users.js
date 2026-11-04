import { apiRequest } from './api.js?v=sb6';
import { openPostViewer } from './feed.js?v=up1';
import { protectMedia } from './media-protect.js';
import { openUserStories } from './stories.js?v=up1';

import { API_ORIGIN as MEDIA_BASE_URL } from './config.js?v=sb4';

export function initAccountSearch() {
  const form = document.getElementById('account-search-form');
  const input = document.getElementById('account-search-input');
  const results = document.getElementById('account-search-results');
  if (!form || !input || !results) return;

  form.addEventListener('submit', event => {
    event.preventDefault();
    searchAccounts(input.value.trim(), results);
  });

  input.addEventListener('input', () => {
    if (!input.value.trim()) {
      results.hidden = true;
      results.replaceChildren();
    }
  });

  initConnections();
}

function initConnections() {
  const list = document.getElementById('connections-list');
  const tabs = document.querySelectorAll('.people-tab');
  if (!list || !tabs.length) return;

  const load = async type => {
    tabs.forEach(tab => {
      const active = tab.dataset.type === type;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    renderSearchMessage(list, 'Loading...');
    try {
      const data = await apiRequest(`/users/connections?type=${type}`);
      list.replaceChildren();
      if (!data.users.length) {
        renderSearchMessage(list, type === 'friends'
          ? 'No friends yet. Friends are people you follow who follow you back.'
          : 'No followers yet. People who follow you will appear here.');
        return;
      }
      data.users.forEach(user => list.appendChild(createAccountResult(user)));
    } catch (err) {
      console.error('Could not load connections:', err);
      renderSearchMessage(list, err.message || 'Log in to see your friends and followers.');
    }
  };

  tabs.forEach(tab => tab.addEventListener('click', () => load(tab.dataset.type)));
  load('friends');
}

async function searchAccounts(query, container) {
  if (query.length < 2) {
    renderSearchMessage(container, 'Enter at least 2 characters to search.');
    return;
  }

  container.hidden = false;
  renderSearchMessage(container, 'Searching accounts...');
  try {
    const data = await apiRequest(`/users/search?q=${encodeURIComponent(query)}`);
    container.replaceChildren();
    if (!data.users.length) {
      renderSearchMessage(container, 'No accounts found.');
      return;
    }

    data.users.forEach(user => container.appendChild(createAccountResult(user)));
  } catch (err) {
    console.error('Account search failed:', err);
    renderSearchMessage(container, err.message || 'Could not search accounts. Please try again.');
  }
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
  return badge;
}

function createAccountResult(user) {
  const row = document.createElement('article');
  row.className = 'account-search-result';

  const avatar = document.createElement('span');
  avatar.className = 'account-search-avatar';
  if (user.avatar_url) {
    const image = document.createElement('img');
    image.src = /^https?:/i.test(user.avatar_url) ? user.avatar_url : `${MEDIA_BASE_URL}${user.avatar_url}`;
    image.alt = '';
    avatar.appendChild(image);
  } else {
    avatar.textContent = (user.username || 'u')[0].toUpperCase();
  }

  const identity = document.createElement('span');
  identity.className = 'account-search-identity';
  const name = document.createElement('strong');
  name.textContent = user.display_name || user.username;
  const username = document.createElement('small');
  username.textContent = `@${user.username}`;
  const counts = document.createElement('small');
  counts.className = 'account-search-counts';
  counts.textContent = `${user.friends_count ?? 0} friends · ${user.followers_count ?? 0} followers`;
  identity.append(name, username, counts);
  if (user.is_live) identity.appendChild(createLiveBadge(user));

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

export async function openUserProfile(userId) {
  const modal = ensureProfileModal();
  modal.classList.add('active');
  const content = modal.querySelector('.account-profile-content');
  content.innerHTML = '<p class="account-profile-status">Loading profile...</p>';

  try {
    const data = await apiRequest(`/users/${userId}/profile`);
    renderUserProfile(content, data.profile, data.posts);
  } catch (err) {
    console.error('Could not load user profile:', err);
    content.innerHTML = '';
    const message = document.createElement('p');
    message.className = 'account-profile-status';
    message.textContent = err.message || 'Could not load this profile.';
    content.appendChild(message);
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

function renderUserProfile(container, profile, posts) {
  container.replaceChildren();

  const header = document.createElement('header');
  header.className = 'account-profile-header';
  const avatar = document.createElement('span');
  avatar.className = 'account-profile-avatar';
  if (profile.avatar_url) {
    const image = document.createElement('img');
    image.src = /^https?:/i.test(profile.avatar_url) ? profile.avatar_url : `${MEDIA_BASE_URL}${profile.avatar_url}`;
    image.alt = '';
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
  header.append(avatar, identity, messageButton, followButton, blockButton);
  container.appendChild(header);

  const storyButton = document.createElement('button');
  storyButton.type = 'button';
  storyButton.className = 'account-story-button';
  storyButton.textContent = '▶ View story';
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

  if (profile.bio) {
    const bio = document.createElement('p');
    bio.className = 'account-profile-bio';
    bio.textContent = profile.bio;
    container.appendChild(bio);
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
  posts.forEach(post => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'account-profile-post';
    button.setAttribute('aria-label', `Open ${post.media_type} post by @${profile.username}`);
    const media = document.createElement(post.media_type === 'video' ? 'video' : 'img');
    media.src = /^https?:/i.test(post.media_url) ? post.media_url : `${MEDIA_BASE_URL}${post.media_url}`;
    media.className = 'account-profile-post-media';
    if (post.media_type === 'video') {
      media.muted = true;
      media.playsInline = true;
      media.preload = 'metadata';
    } else {
      media.alt = `Post by @${profile.username}`;
    }
    button.appendChild(media);
    button.dataset.postId = post.id;
    if (post.is_protected) protectMedia(button);
    if (post.media_type === 'video') {
      const indicator = document.createElement('span');
      indicator.className = 'account-profile-video-indicator';
      indicator.textContent = '▶';
      button.appendChild(indicator);
    }
    button.addEventListener('click', () => openPostViewer({
      ...post,
      author_username: profile.username,
      author_avatar_url: profile.avatar_url
    }));
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
