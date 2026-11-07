import { apiRequest } from './api.js?v=sb6';
import { API_ORIGIN as MEDIA_BASE_URL, R2_UPLOADS_ENABLED } from './config.js?v=sb5';
import { downloadOriginal, refreshExpiredMedia, uploadPublicMedia } from './r2-uploads.js';
import { timeAgo } from './time-ago.js';
import { protectMedia } from './media-protect.js';
import { openCamera } from './camera-capture.js';
import { attachEmojiPicker } from './emoji-picker.js';
import { openShareDialog, absoluteMediaUrl } from './share.js?v=5';

let viewerTimer = null;
let currentStoryGroup = [];
let currentStoryIndex = 0;
let currentStoryUsername = 'user';
let viewerIsAdmin = false;

const mediaUrl = url => /^https?:/i.test(url) ? url : `${MEDIA_BASE_URL}${url}`;

export async function initStoriesCarousel() {
  const addButton = document.getElementById('add-story-btn');
  const fileInput = document.getElementById('story-upload-input');
  if (addButton && fileInput) {
    addButton.addEventListener('click', () => {
      if (!localStorage.getItem('vynzo_token')) {
        window.location.href = './pages/login.html';
        return;
      }
      fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) await uploadStory(file, addButton);
    });
  }
  document.getElementById('camera-story-btn')?.addEventListener('click', () => {
    if (!localStorage.getItem('vynzo_token')) {
      window.location.href = './pages/login.html';
      return;
    }
    openCamera(file => uploadStory(file, addButton));
  });
  document.addEventListener('vynzo:scope', refreshStoriesCarousel);
  await refreshStoriesCarousel();
}

async function refreshStoriesCarousel() {
  const container = document.getElementById('stories-container');
  if (!container) return [];

  try {
    const scope = ['all', 'me'].includes(window.vynzoFeedScope) ? `?scope=${window.vynzoFeedScope}` : '';
    const data = await apiRequest(`/stories${scope}`);
    viewerIsAdmin = Boolean(data.viewer_is_admin);
    const groups = data.usersWithStories || [];
    renderStories(container, groups);
    return groups;
  } catch (err) {
    console.error('Failed to load stories:', err);
    container.innerHTML = '<p class="story-load-error">Could not load stories. Please refresh to try again.</p>';
    return [];
  }
}

function renderStories(container, usersWithStories) {
  const currentUser = getCurrentUser();
  container.replaceChildren();

  if (!usersWithStories.length) {
    const empty = document.createElement('span');
    empty.className = 'story-empty-state';
    empty.textContent = 'No active stories yet';
    container.appendChild(empty);
    return;
  }

  const orderedUsers = [...usersWithStories].sort((left, right) =>
    Number(right.user_id === currentUser.id) - Number(left.user_id === currentUser.id)
  );
  orderedUsers.forEach(userGroup => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'story-avatar-item story-avatar-button';

    const ring = document.createElement('span');
    ring.className = 'story-preview-ring';
    const latestStory = userGroup.stories[userGroup.stories.length - 1];
    if (latestStory.media_type === 'video') {
      const video = document.createElement('video');
      refreshExpiredMedia(video, latestStory, 'story');
      video.className = 'story-preview-media';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'none';
      video.src = mediaUrl(latestStory.media_url);
      ring.appendChild(video);
      const playIcon = document.createElement('span');
      playIcon.className = 'story-preview-play';
      playIcon.textContent = '▶';
      ring.appendChild(playIcon);
    } else {
      const preview = document.createElement('img');
      refreshExpiredMedia(preview, latestStory, 'story');
      preview.className = 'story-preview-media';
      preview.alt = 'Open story';
      preview.loading = 'lazy';
      preview.decoding = 'async';
      preview.src = mediaUrl(latestStory.media_url);
      ring.appendChild(preview);
    }

    const avatar = document.createElement('span');
    avatar.className = 'story-preview-avatar';
    if (userGroup.avatar_url) {
      const avatarImage = document.createElement('img');
      avatarImage.src = mediaUrl(userGroup.avatar_url);
      avatarImage.alt = '';
      avatar.appendChild(avatarImage);
    } else {
      avatar.textContent = (userGroup.username || 'u')[0].toUpperCase();
    }
    ring.appendChild(avatar);

    const label = document.createElement('span');
    label.className = 'story-username';
    label.textContent = userGroup.user_id === currentUser.id
      ? 'Your story'
      : `@${userGroup.username || 'user'}`;

    item.append(ring, label);
    item.addEventListener('click', () => openStoryViewer(userGroup));
    container.appendChild(item);
  });
}

async function uploadStory(file, button) {
  const status = document.getElementById('story-upload-status');

  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    status.textContent = 'Choose an image or video file.';
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    status.textContent = 'Media must be 50 MB or smaller.';
    return;
  }

  button.disabled = true;
  status.textContent = 'Uploading...';

  try {
    const isProtected = document.getElementById('story-protect')?.checked || false;
    let data;
    if (R2_UPLOADS_ENABLED) {
      data = await uploadPublicMedia(file, {
        kind: 'story', protected: isProtected, onProgress: message => { status.textContent = message; }
      });
    } else {
      const formData = new FormData();
      formData.append('media', file);
      formData.append('protected', isProtected ? 'true' : 'false');
      data = await apiRequest('/stories/upload', {
        method: 'POST',
        body: formData
      });
    }

    const groups = await refreshStoriesCarousel();
    const ownerStories = groups.find(group => group.user_id === data.story.user_id);
    if (ownerStories) openStoryViewer(ownerStories, data.story.id);
    status.textContent = 'Story added. It will be visible for 24 hours.';
  } catch (err) {
    console.error('Story upload failed:', err);
    status.textContent = err.message || 'Could not upload story. Please try again.';
  } finally {
    button.disabled = false;
  }
}

function ensureStoryViewer() {
  let modal = document.getElementById('story-viewer-modal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'story-viewer-modal';
  modal.className = 'story-viewer-modal';
  modal.innerHTML = `
    <section class="story-viewer-content" role="dialog" aria-modal="true" aria-label="Story">
      <div class="story-progress-container" id="story-progress-container"></div>
      <header class="story-viewer-header">
        <span id="story-viewer-author"></span>
        <select class="story-privacy-select" id="story-privacy-select" aria-label="Who can watch this story" hidden>
          <option value="everyone">🌍 Everyone</option>
          <option value="friends">👥 Friends</option>
          <option value="only_me">🔒 Only me</option>
        </select>
        <button class="story-delete-btn" id="story-delete-btn" type="button" hidden>Delete</button>
        <button class="story-delete-btn" id="story-original-btn" type="button" hidden>Download original</button>
        <button class="story-close-btn" type="button" aria-label="Close story">&times;</button>
      </header>
      <div class="story-media-wrapper" id="story-media-wrapper"></div>
      <div class="story-viewer-actions">
        <button class="story-like-btn" id="story-like-btn" type="button"></button>
        <button class="story-comments-count" id="story-comments-count" type="button"></button>
        <button class="story-share-btn" id="story-share-btn" type="button">Share</button>
      </div>
      <section class="story-comments-panel" aria-label="Story comments">
        <div class="story-comments-list" id="story-comments-list"></div>
        <form class="story-comment-form" id="story-comment-form">
          <input id="story-comment-input" type="text" maxlength="500" placeholder="Add a comment..." aria-label="Add a comment" required>
          <button type="submit">Send</button>
        </form>
      </section>
      <div class="story-navigation">
        <button id="story-previous-btn" type="button" aria-label="Previous story">‹</button>
        <button id="story-next-btn" type="button" aria-label="Next story">›</button>
      </div>
    </section>
  `;
  document.body.appendChild(modal);

  modal.querySelector('.story-close-btn').addEventListener('click', closeStoryViewer);
  modal.addEventListener('click', event => {
    if (event.target === modal) closeStoryViewer();
  });
  modal.querySelector('#story-previous-btn').addEventListener('click', () => showStory(currentStoryIndex - 1));
  modal.querySelector('#story-next-btn').addEventListener('click', () => showStory(currentStoryIndex + 1));
  modal.querySelector('#story-like-btn').addEventListener('click', toggleCurrentStoryLike);
  modal.querySelector('#story-share-btn').addEventListener('click', () => {
    const story = currentStoryGroup?.[currentStoryIndex];
    if (!story) return;
    if (story.is_protected) { alert('Protected stories cannot be shared.'); return; }
    openShareDialog({
      title: 'Share story',
      text: `${story.media_type === 'video' ? '🎬' : '🖼'} Story by @${currentStoryUsername || 'user'}`,
      url: absoluteMediaUrl(story.media_url),
      preview: { type: story.media_type === 'video' ? 'video' : 'image', kind: 'story', id: story.id, r2: Boolean(story.has_original) }
    });
  });
  modal.querySelector('#story-comments-count').addEventListener('click', () => {
    modal.querySelector('#story-comment-input').focus();
  });
  modal.querySelector('#story-delete-btn').addEventListener('click', deleteCurrentStory);
  modal.querySelector('#story-original-btn').addEventListener('click', async () => {
    const story = currentStoryGroup[currentStoryIndex];
    if (!story?.is_owner) return;
    try { await downloadOriginal('story', story.id); }
    catch (error) { alert(error.message || 'Could not download the original.'); }
  });
  modal.querySelector('#story-privacy-select').addEventListener('change', async event => {
    const story = currentStoryGroup[currentStoryIndex];
    const select = event.target;
    if (!story?.is_owner) return;
    const previous = story.privacy || 'everyone';
    try {
      await apiRequest(`/stories/${story.id}/privacy`, { method: 'PATCH', body: JSON.stringify({ privacy: select.value }) });
      story.privacy = select.value;
    } catch (err) {
      select.value = previous;
      alert(err.message || 'Could not change who can watch this story.');
    }
  });
  modal.querySelector('#story-comment-form').addEventListener('submit', submitStoryComment);
  attachEmojiPicker(modal.querySelector('#story-comment-form'), modal.querySelector('#story-comment-input'));
  modal.addEventListener('pointerenter', pauseStoryAdvance);
  modal.addEventListener('pointerleave', scheduleStoryAdvance);
  modal.addEventListener('focusin', pauseStoryAdvance);
  modal.addEventListener('focusout', event => {
    if (!modal.contains(event.relatedTarget)) scheduleStoryAdvance();
  });
  return modal;
}

export async function openUserStories(userId) {
  const data = await apiRequest('/stories?scope=any');
  viewerIsAdmin = Boolean(data.viewer_is_admin);
  const group = (data.usersWithStories || []).find(item => item.user_id === userId);
  if (group) openStoryViewer(group);
  return Boolean(group);
}

function openStoryViewer(userGroup, storyId = null) {
  currentStoryGroup = userGroup.stories;
  currentStoryUsername = userGroup.username || 'user';
  const modal = ensureStoryViewer();
  modal.classList.add('active');
  const storyIndex = storyId
    ? currentStoryGroup.findIndex(story => story.id === storyId)
    : 0;
  showStory(storyIndex >= 0 ? storyIndex : 0);
}

function showStory(index) {
  if (index < 0) return;
  if (index >= currentStoryGroup.length) {
    closeStoryViewer();
    return;
  }

  currentStoryIndex = index;
  const story = currentStoryGroup[index];
  const modal = ensureStoryViewer();
  const progressContainer = modal.querySelector('#story-progress-container');
  progressContainer.innerHTML = currentStoryGroup.map((_, progressIndex) => `
    <div class="story-progress-bar"><div class="story-progress-fill ${progressIndex < index ? 'complete' : progressIndex === index && story.media_type !== 'video' ? 'current' : ''}"></div></div>
  `).join('');

  modal.querySelector('#story-viewer-author').innerHTML =
    `@${escapeHtml(currentStoryUsername)} <small class="story-time">${timeAgo(story.created_at)}</small>`;
  const deleteButton = modal.querySelector('#story-delete-btn');
  const privacySelect = modal.querySelector('#story-privacy-select');
  privacySelect.hidden = !story.is_owner;
  privacySelect.value = story.privacy || 'everyone';
  deleteButton.hidden = !(story.is_owner || viewerIsAdmin);
  deleteButton.textContent = story.is_owner ? 'Delete' : 'Remove (admin)';
  modal.querySelector('#story-original-btn').hidden = !story.is_owner || !story.has_original;
  modal.querySelector('#story-like-btn').textContent =
    `${story.is_liked ? '♥' : '♡'} ${Number(story.likes_count) || 0}`;
  modal.querySelector('#story-like-btn').classList.toggle('liked', Boolean(story.is_liked));
  modal.querySelector('#story-comments-count').textContent =
    `Comments · ${Number(story.comments_count) || 0}`;
  modal.querySelector('#story-media-wrapper').innerHTML = story.media_type === 'video'
    ? `<video class="story-media" src="${escapeHtml(mediaUrl(story.media_url))}" autoplay controls playsinline></video>`
    : `<img class="story-media" src="${escapeHtml(mediaUrl(story.media_url))}" alt="Story shared by ${escapeHtml(currentStoryGroup.username || 'user')}">`;
  const storyWrapper = modal.querySelector('#story-media-wrapper');
  refreshExpiredMedia(storyWrapper.querySelector('.story-media'), story, 'story');
  if (story.is_protected) protectMedia(storyWrapper);
  else delete storyWrapper.dataset.protected;

  const video = modal.querySelector('video');
  clearTimeout(viewerTimer);
  if (video) {
    video.addEventListener('ended', () => showStory(currentStoryIndex + 1), { once: true });
  } else {
    scheduleStoryAdvance();
  }

  loadStoryComments(story);
  apiRequest(`/stories/${story.id}/view`, { method: 'POST' }).catch(err => {
    console.error('Failed to record story view:', err);
  });
}

function pauseStoryAdvance() {
  clearTimeout(viewerTimer);
}

function scheduleStoryAdvance() {
  clearTimeout(viewerTimer);
  const modal = document.getElementById('story-viewer-modal');
  if (!modal?.classList.contains('active') || modal.querySelector('video')) return;
  viewerTimer = setTimeout(() => showStory(currentStoryIndex + 1), 15000);
}

async function loadStoryComments(story) {
  const list = document.getElementById('story-comments-list');
  list.replaceChildren();
  setStoryCommentFormState(false);
  try {
    const data = await apiRequest(`/stories/${story.id}/comments`);
    if (currentStoryGroup[currentStoryIndex]?.id !== story.id) return;
    data.comments.forEach(comment => appendStoryComment(list, comment));
    setStoryCommentFormState(false);
    if (!data.comments.length) {
      const empty = document.createElement('p');
      empty.className = 'story-comments-empty';
      empty.textContent = 'Be the first to comment.';
      list.appendChild(empty);
    }
  } catch (err) {
    console.error('Failed to load story comments:', err);
    if (currentStoryGroup[currentStoryIndex]?.id === story.id) {
      list.textContent = 'Could not load comments.';
    }
  }
}

function setStoryCommentFormState(hasCommented) {
  const input = document.getElementById('story-comment-input');
  const button = document.querySelector('#story-comment-form button[type="submit"]');
  if (!input || !button) return;
  input.disabled = hasCommented;
  button.disabled = hasCommented;
  input.placeholder = hasCommented ? 'You already commented on this story' : 'Add a comment...';
  if (hasCommented) input.value = '';
}

async function toggleCurrentStoryLike() {
  const story = currentStoryGroup[currentStoryIndex];
  if (!story) return;
  const button = document.getElementById('story-like-btn');
  button.disabled = true;
  try {
    const result = await apiRequest(`/stories/${story.id}/like`, { method: 'POST' });
    const currentCount = Number(story.likes_count) || 0;
    story.likes_count = Math.max(0, currentCount + (result.liked ? 1 : -1));
    story.is_liked = result.liked;
    button.textContent = `${story.is_liked ? '♥' : '♡'} ${story.likes_count}`;
    button.classList.toggle('liked', story.is_liked);
  } catch (err) {
    console.error('Failed to update story like:', err);
    alert(err.message || 'Please log in to like stories.');
  } finally {
    button.disabled = false;
  }
}

async function submitStoryComment(event) {
  event.preventDefault();
  const story = currentStoryGroup[currentStoryIndex];
  const input = document.getElementById('story-comment-input');
  const content = input.value.trim();
  if (!story || !content) return;

  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const result = await apiRequest(`/stories/${story.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content })
    });
    const list = document.getElementById('story-comments-list');
    list.querySelector('.story-comments-empty')?.remove();
    appendStoryComment(list, result.comment);
    list.scrollTop = list.scrollHeight;
    input.value = '';
    story.comments_count = (Number(story.comments_count) || 0) + 1;
    document.getElementById('story-comments-count').textContent =
      `Comments · ${story.comments_count}`;
  } catch (err) {
    console.error('Failed to add story comment:', err);
    alert(err.message || 'Could not add comment. Please try again.');
  } finally {
    submitButton.disabled = document.getElementById('story-comment-input').disabled;
  }
}

function appendStoryComment(list, comment) {
  const item = document.createElement('p');
  item.className = 'story-comment-item';
  const author = document.createElement('strong');
  author.textContent = `@${comment.username || 'user'} `;
  const content = document.createElement('span');
  content.textContent = comment.content;
  item.append(author, content);
  list.appendChild(item);
}

async function deleteCurrentStory() {
  const story = currentStoryGroup[currentStoryIndex];
  if (!story || !(story.is_owner || viewerIsAdmin)) return;
  let moderationReason = null;
  if (story.is_owner) {
    if (!confirm('Delete this story? This cannot be undone.')) return;
  } else {
    moderationReason = prompt('Remove this story and notify the user. Reason (shown to the user):', 'it violates the Vynzo community guidelines');
    if (moderationReason === null) return;
  }

  const button = document.getElementById('story-delete-btn');
  button.disabled = true;
  try {
    if (story.is_owner) await apiRequest(`/stories/${story.id}`, { method: 'DELETE' });
    else await apiRequest(`/stories/${story.id}/moderate`, { method: 'POST', body: JSON.stringify({ reason: moderationReason }) });
    currentStoryGroup.splice(currentStoryIndex, 1);
    await refreshStoriesCarousel();
    if (currentStoryGroup.length) {
      showStory(Math.min(currentStoryIndex, currentStoryGroup.length - 1));
    } else {
      closeStoryViewer();
    }
  } catch (err) {
    console.error('Failed to delete story:', err);
    alert(err.message || 'Could not delete story. Please try again.');
  } finally {
    button.disabled = false;
  }
}

function closeStoryViewer() {
  clearTimeout(viewerTimer);
  const modal = document.getElementById('story-viewer-modal');
  if (!modal) return;
  modal.querySelector('video')?.pause();
  modal.classList.remove('active');
}

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  } catch (err) {
    console.error('Could not read the current user:', err);
    return {};
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[character]));
}
