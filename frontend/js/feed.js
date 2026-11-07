import { apiRequest } from './api.js?v=sb6';
import { timeAgo } from './time-ago.js';
import { API_ORIGIN } from './config.js?v=sb4';
import { uploadMedia } from './uploads.js?v=up2';
import { downloadOriginal, refreshExpiredMedia } from './r2-uploads.js';
import { openVideoOptions, initSharedVideoReceiver } from './video-create.js?v=vc1';
import { attachEmojiPicker } from './emoji-picker.js';
import { protectMedia } from './media-protect.js';
import { openShareDialog, absoluteMediaUrl } from './share.js?v=4';

export async function initFeed() {
  const container = document.getElementById('feed-container');
  if (!container) return;

  initPostComposer();
  if (!container.dataset.scopeBound) {
    container.dataset.scopeBound = 'true';
    document.addEventListener('vynzo:scope', () => { loadFeed(container); loadLiveStrip(); });
    setInterval(() => { if (document.visibilityState === 'visible') loadLiveStrip(); }, 30000);
  }
  loadLiveStrip();
  await loadFeed(container);
}

async function loadLiveStrip() {
  const strip = document.getElementById('feed-live-strip');
  if (!strip) return;
  if (window.vynzoFeedScope !== 'all' || !localStorage.getItem('vynzo_token')) {
    strip.hidden = true;
    return;
  }
  try {
    const data = await apiRequest('/live');
    const streams = data.liveStreams || [];
    if (!streams.length) {
      strip.hidden = true;
      strip.replaceChildren();
      return;
    }
    strip.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'feed-live-heading';
    heading.textContent = '🔴 Live now';
    strip.appendChild(heading);
    const row = document.createElement('div');
    row.className = 'feed-live-row';
    streams.forEach(stream => {
      const card = document.createElement('a');
      card.className = 'feed-live-card';
      card.href = `./pages/live.html?sessionId=${encodeURIComponent(stream.id)}`;
      const avatar = document.createElement('span');
      avatar.className = 'feed-live-avatar';
      if (stream.host_avatar_url) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = /^https?:/i.test(stream.host_avatar_url) ? stream.host_avatar_url : `${API_ORIGIN}${stream.host_avatar_url}`;
        avatar.appendChild(img);
      } else {
        avatar.textContent = (stream.host_display_name || stream.host_username || '?').charAt(0).toUpperCase();
      }
      const badge = document.createElement('span');
      badge.className = 'feed-live-badge';
      badge.textContent = 'LIVE';
      const name = document.createElement('strong');
      name.textContent = stream.host_display_name || stream.host_username || 'user';
      const title = document.createElement('small');
      title.textContent = `${stream.visibility === 'friends' ? '👥 ' : ''}${stream.title} · 👁 ${stream.viewer_count}`;
      card.append(avatar, badge, name, title);
      row.appendChild(card);
    });
    strip.appendChild(row);
    strip.hidden = false;
  } catch (err) {
    console.error('Failed to load live strip:', err);
  }
}

const FEED_PAGE = 20;

async function loadFeed(container, offset = 0) {
  try {
    const params = new URLSearchParams({ limit: String(FEED_PAGE), offset: String(offset) });
    if (['all', 'me'].includes(window.vynzoFeedScope)) params.set('scope', window.vynzoFeedScope);
    const data = await apiRequest(`/posts/feed?${params}`);
    container.querySelector('.feed-more')?.remove();
    if (!data.posts || data.posts.length === 0) {
      if (offset === 0) container.innerHTML = '<div class="post-placeholder"><p>No posts yet. Add a photo or video to start the home feed.</p></div>';
      return;
    }

    const reel = window.vynzoFeedScope !== 'me';
    if (offset === 0) {
      reelObserver?.disconnect();
      container.classList.toggle('reel-feed', reel);
      container.innerHTML = '';
      container.scrollTop = 0;
    }
    const cards = data.posts.map(post => createPostCard(post, reel));
    cards.forEach(card => container.appendChild(card));
    if (reel) {
      if (offset === 0) observeReels(container);
      else cards.forEach(card => reelObserver?.observe(card));
    }
    if (data.posts.length >= FEED_PAGE) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'feed-more';
      more.textContent = 'Load more';
      more.addEventListener('click', () => { more.disabled = true; loadFeed(container, offset + FEED_PAGE); });
      container.appendChild(more);
    }

  } catch (err) {
    console.error('Failed to load feed:', err);
    container.innerHTML = '<div class="post-placeholder"><p>Error loading feed. Please try again.</p></div>';
  }
}

function initPostComposer() {
  const photoButton = document.getElementById('add-photo-post-btn');
  const videoButton = document.getElementById('add-video-post-btn');
  const photoInput = document.getElementById('photo-post-input');
  const videoInput = document.getElementById('video-post-input');
  if (!photoButton || !videoButton || !photoInput || !videoInput || photoButton.dataset.initialized) return;

  photoButton.dataset.initialized = 'true';
  videoButton.dataset.initialized = 'true';
  photoButton.addEventListener('click', () => openPostPicker(photoInput));
  videoButton.addEventListener('click', () => {
    if (!localStorage.getItem('vynzo_token')) {
      window.location.href = './pages/login.html';
      return;
    }
    openVideoOptions({ onFile: createPost, fileInput: videoInput });
  });
  initSharedVideoReceiver({ onPost: createPost, captionInput: document.getElementById('post-caption') });
  [photoInput, videoInput].forEach(input => input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) await createPost(file);
  }));
}

function openPostPicker(input) {
  if (!localStorage.getItem('vynzo_token')) {
    window.location.href = './pages/login.html';
    return;
  }
  input.click();
}

async function createPost(file) {
  const status = document.getElementById('post-upload-status');
  const buttons = [
    document.getElementById('add-photo-post-btn'),
    document.getElementById('add-video-post-btn')
  ].filter(Boolean);

  if (file.size > 50 * 1024 * 1024) {
    status.textContent = 'Media must be 50 MB or smaller.';
    return false;
  }
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
    status.textContent = 'Choose a supported photo or video file.';
    return false;
  }

  buttons.forEach(button => { button.disabled = true; });
  status.textContent = 'Uploading post...';
  try {
    const caption = document.getElementById('post-caption').value.trim();
    await uploadMedia(file, caption, message => { status.textContent = message; });
    document.getElementById('post-caption').value = '';
    status.textContent = 'Post added to the home feed.';
    await initFeed();
    return true;
  } catch (err) {
    console.error('Post upload failed:', err);
    status.textContent = err.message || 'Could not upload post. Please try again.';
    return false;
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

function createPrivacySelect(post, bind = true) {
  const select = document.createElement('select');
  select.className = 'post-privacy-select';
  select.setAttribute('aria-label', 'Who can see this post');
  select.innerHTML = '<option value="everyone">🌍 Everyone</option><option value="friends">👥 Friends</option><option value="only_me">🔒 Only me</option>';
  select.value = post.privacy || 'everyone';
  select.addEventListener('click', event => event.stopPropagation());
  if (bind) select.addEventListener('change', async () => {
    const previous = post.privacy || 'everyone';
    try {
      await apiRequest(`/posts/${post.id}/privacy`, { method: 'PATCH', body: JSON.stringify({ privacy: select.value }) });
      post.privacy = select.value;
      document.querySelectorAll(`.post-privacy-select[data-post-id="${post.id}"]`).forEach(s => { s.value = post.privacy; });
    } catch (err) {
      select.value = previous;
      alert(err.message || 'Could not change who can see this post.');
    }
  });
  select.dataset.postId = post.id;
  return select;
}

let reelObserver = null;
let reelMuted = true;

function observeReels(container) {
  reelObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const video = entry.target.querySelector('video');
      if (!video) return;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
        video.muted = reelMuted;
        video.play().catch(() => {
          video.muted = true;
          video.play().catch(() => {});
        });
      } else {
        video.pause();
      }
    });
  }, { root: null, threshold: [0, 0.6, 1] });
  container.querySelectorAll('.post-card').forEach(card => reelObserver.observe(card));
}

function createPostCard(post, reel = false) {
  const card = document.createElement('article');
  card.className = 'post-card';
  card.dataset.postId = post.id;

  const isVideo = post.media_type === 'video';
  const authorUsername = post.author_username || 'user';
  const mediaButton = document.createElement('button');
  mediaButton.type = 'button';
  mediaButton.className = 'post-thumbnail-button';
  mediaButton.setAttribute('aria-label', `Open ${isVideo ? 'video' : 'image'} post by @${authorUsername}`);

  const media = document.createElement(isVideo ? 'video' : 'img');
  refreshExpiredMedia(media, post, 'post');
  media.className = 'post-media';
  if (isVideo) {
    media.preload = reel ? 'none' : 'metadata';
  } else {
    media.loading = 'lazy';
    media.decoding = 'async';
  }
  media.src = /^https?:/i.test(post.media_url) ? post.media_url : `${API_ORIGIN}${post.media_url}`;
  if (isVideo && reel) {
    media.muted = reelMuted;
    media.playsInline = true;
    media.loop = true;
  } else if (isVideo) {
    media.muted = true;
    media.playsInline = true;
    media.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(media.duration) && media.duration > 0) media.currentTime = Math.min(0.1, media.duration / 2);
    }, { once: true });
    mediaButton.addEventListener('pointerenter', () => media.play().catch(() => {}));
    mediaButton.addEventListener('pointerleave', () => {
      media.pause();
      media.currentTime = 0;
    });
  } else {
    media.alt = `Post by @${authorUsername}`;
  }
  mediaButton.appendChild(media);

  if (isVideo && reel) {
    const sound = document.createElement('span');
    sound.className = 'reel-sound';
    sound.setAttribute('aria-hidden', 'true');
    const paintSound = () => { sound.textContent = reelMuted ? '🔇' : '🔊'; };
    paintSound();
    sound.addEventListener('click', event => {
      event.stopPropagation();
      reelMuted = !reelMuted;
      document.querySelectorAll('.reel-feed video').forEach(v => { v.muted = reelMuted; });
      document.querySelectorAll('.reel-sound').forEach(s => { s.textContent = reelMuted ? '🔇' : '🔊'; });
    });
    mediaButton.appendChild(sound);
  } else if (isVideo) {
    const playIndicator = document.createElement('span');
    playIndicator.className = 'post-video-indicator';
    playIndicator.setAttribute('aria-hidden', 'true');
    playIndicator.textContent = '▶';
    mediaButton.appendChild(playIndicator);
  }

  if (reel && isVideo) {
    mediaButton.addEventListener('click', () => { if (media.paused) media.play().catch(() => {}); else media.pause(); });
  } else if (!reel) {
    mediaButton.addEventListener('click', () => openPostViewer(post));
  }

  const details = document.createElement('div');
  details.className = 'post-details';
  details.innerHTML = `
    <div class="post-author-row"><span class="post-author">@${escapeHtml(authorUsername)}</span><span class="post-time">${timeAgo(post.created_at)}</span></div>
    ${post.caption ? `<p class="post-caption">${escapeHtml(post.caption)}</p>` : ''}
  `;
  details.querySelector('.post-author-row').prepend(createAuthorAvatar(post));
  makeAuthorLink(details.querySelector('.post-author-row'), post);

  const actions = document.createElement('div');
  actions.className = 'post-actions';
  actions.innerHTML = `
    <button class="post-action like-btn ${post.is_liked ? 'liked' : ''}" type="button" aria-label="Like post">
      ♥ <span class="action-count">${post.likes_count}</span>
    </button>
    <button class="post-action comment-count" type="button" aria-label="View comments">💬 <span class="action-count">${post.comments_count}</span></button>
    ${reel ? '<button class="post-action share-btn" type="button" aria-label="Share post">Share</button>' : ''}
  `;

  if (reel) {
    // Instagram-style post: author on top, media, actions, then caption.
    card.classList.add('insta-card');
    const header = document.createElement('div');
    header.className = 'post-header';
    const authorRow = details.querySelector('.post-author-row');
    header.append(authorRow);
    const caption = details.querySelector('.post-caption');
    details.textContent = '';
    if (caption) details.append(caption);
    card.append(header, mediaButton, actions);
    if (caption) card.append(details);
  } else {
    card.append(mediaButton, details, actions);
  }

  if (post.is_protected) {
    protectMedia(mediaButton);
    const badge = document.createElement('span');
    badge.className = 'protected-badge';
    badge.textContent = '🔒 Protected';
    mediaButton.appendChild(badge);
  }
  if (post.is_owner) {
    actions.appendChild(createPrivacySelect(post));
    if (post.has_original) {
      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'post-action';
      download.textContent = 'Download original';
      download.addEventListener('click', async () => {
        try { await downloadOriginal('post', post.id); }
        catch (error) { alert(error.message || 'Could not download the original.'); }
      });
      actions.appendChild(download);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'post-action post-delete-btn';
    del.textContent = '🗑 Delete';
    del.addEventListener('click', () => deleteOwnPost(post));
    actions.appendChild(del);
  }
  // Like Button Event Listener
  card.querySelector('.comment-count').addEventListener('click', () => openPostViewer(post));
  card.querySelector('.share-btn')?.addEventListener('click', () => sharePost(post));
  const likeBtn = card.querySelector('.like-btn');
  likeBtn.addEventListener('click', async () => {
    try {
      const res = await apiRequest(`/posts/${post.id}/like`, { method: 'POST' });
      post.is_liked = res.liked;
      post.likes_count = Math.max(0, (Number(post.likes_count) || 0) + (res.liked ? 1 : -1));
      syncFeedCard(post);
    } catch (err) {
      alert('Please login to like posts.');
    }
  });

  return card;
}

function sharePost(post) {
  if (post.is_protected) { alert('Protected posts cannot be shared.'); return; }
  const kind = post.media_type === 'video' ? '🎬 Video' : '🖼 Image';
  openShareDialog({
    title: `Share ${post.media_type === 'video' ? 'video' : 'image'}`,
    text: `${kind} by @${post.author_username || 'user'}${post.caption ? `: ${post.caption.slice(0, 120)}` : ''}`,
    url: absoluteMediaUrl(post.media_url),
    preview: { type: post.media_type === 'video' ? 'video' : 'image', kind: 'post', id: post.id, r2: Boolean(post.has_original) }
  });
}

export function openPostViewer(post, posts = null) {
  viewerPosts = Array.isArray(posts) && posts.includes(post) ? posts : null;
  showPostViewer(post);
}

function showPostViewer(post) {
  let modal = document.getElementById('post-viewer-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'post-viewer-modal';
    modal.className = 'post-viewer-modal';
    modal.innerHTML = `
      <section class="post-viewer-content" role="dialog" aria-modal="true" aria-label="Post media">
        <button class="post-viewer-close" type="button" aria-label="Close media viewer">&times;</button>
        <div class="post-viewer-media" id="post-viewer-media"></div>
        <nav class="post-viewer-navigation" aria-label="Profile posts" hidden>
          <button type="button" class="post-viewer-previous" aria-label="Previous post">↑ Previous</button>
          <span class="post-viewer-position" aria-live="polite"></span>
          <button type="button" class="post-viewer-next" aria-label="Next post">Next ↓</button>
        </nav>
        <div class="post-viewer-details">
          <div class="post-author-row"><span id="post-viewer-avatar-slot"></span><strong id="post-viewer-author"></strong></div>
          <p id="post-viewer-caption"></p>
        </div>
        <div class="post-viewer-social">
          <button class="post-viewer-like" id="post-viewer-like" type="button"></button>
          <button class="post-viewer-share" id="post-viewer-share" type="button">Share</button>
          <div class="post-viewer-comments" id="post-viewer-comments" aria-live="polite"></div>
          <form class="post-viewer-comment-form" id="post-viewer-comment-form">
            <input id="post-viewer-comment-input" type="text" maxlength="500" placeholder="Add a comment..." aria-label="Add a comment" required>
            <button type="submit">Send</button>
          </form>
        </div>
      </section>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#post-viewer-like').addEventListener('click', togglePostViewerLike);
    modal.querySelector('#post-viewer-share').addEventListener('click', () => viewerPost && sharePost(viewerPost));
    modal.querySelector('#post-viewer-comment-form').addEventListener('submit', submitPostViewerComment);
    attachEmojiPicker(modal.querySelector('#post-viewer-comment-form'), modal.querySelector('#post-viewer-comment-input'));
    modal.querySelector('.post-viewer-close').addEventListener('click', closePostViewer);
    modal.querySelector('.post-viewer-previous').addEventListener('click', () => navigateViewer(-1));
    modal.querySelector('.post-viewer-next').addEventListener('click', () => navigateViewer(1));
    const viewerMedia = modal.querySelector('#post-viewer-media');
    let touchStart = null;
    viewerMedia.addEventListener('touchstart', event => {
      if (viewerPosts && event.touches.length === 1) {
        touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }
    }, { passive: true });
    viewerMedia.addEventListener('touchend', event => {
      if (!touchStart || event.changedTouches.length !== 1) return;
      const dx = event.changedTouches[0].clientX - touchStart.x;
      const dy = event.changedTouches[0].clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(dy) >= 60 && Math.abs(dy) > Math.abs(dx) * 1.5) navigateViewer(dy < 0 ? 1 : -1);
    }, { passive: true });
    viewerMedia.addEventListener('touchcancel', () => { touchStart = null; });
    let lastWheelNavigation = 0;
    viewerMedia.addEventListener('wheel', event => {
      if (!viewerPosts || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      event.preventDefault();
      if (Math.abs(event.deltaY) < 10 || Date.now() - lastWheelNavigation < 600) return;
      lastWheelNavigation = Date.now();
      navigateViewer(event.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    modal.addEventListener('click', event => {
      if (event.target === modal) closePostViewer();
    });
    document.addEventListener('keydown', event => {
      if (!modal.classList.contains('active')) return;
      if (event.key === 'Escape') closePostViewer();
      else if (viewerPosts && ['ArrowUp', 'ArrowDown'].includes(event.key) &&
        !event.target.closest('input, textarea, select, video, [contenteditable="true"]')) {
        event.preventDefault();
        navigateViewer(event.key === 'ArrowDown' ? 1 : -1);
      }
    });
  }

  const mediaContainer = modal.querySelector('#post-viewer-media');
  mediaContainer.querySelector('video')?.pause();
  mediaContainer.replaceChildren();
  const media = document.createElement(post.media_type === 'video' ? 'video' : 'img');
  refreshExpiredMedia(media, post, 'post');
  media.src = /^https?:/i.test(post.media_url) ? post.media_url : `${API_ORIGIN}${post.media_url}`;
  if (post.media_type === 'video') {
    media.controls = true;
    media.autoplay = true;
    media.playsInline = true;
    if (!viewerPosts) media.addEventListener('ended', () => closePostViewer());
  } else {
    media.alt = `Post by @${post.author_username || 'user'}`;
  }
  mediaContainer.appendChild(media);
  if (post.is_protected) protectMedia(mediaContainer);
  else {
    delete mediaContainer.dataset.protected;
    mediaContainer.classList.remove('is-protected-media');
  }
  const index = viewerPosts ? viewerPosts.indexOf(post) : -1;
  const navigation = modal.querySelector('.post-viewer-navigation');
  modal.classList.toggle('has-profile-navigation', Boolean(viewerPosts && viewerPosts.length > 1));
  navigation.hidden = !viewerPosts || viewerPosts.length < 2;
  modal.querySelector('.post-viewer-previous').disabled = index <= 0;
  modal.querySelector('.post-viewer-next').disabled = !viewerPosts || index >= viewerPosts.length - 1;
  modal.querySelector('.post-viewer-position').textContent = viewerPosts ? `${index + 1} / ${viewerPosts.length}` : '';
  modal.querySelector('#post-viewer-comment-input').value = '';
  let viewerDelete = modal.querySelector('#post-viewer-delete');
  if (!viewerDelete) {
    viewerDelete = document.createElement('button');
    viewerDelete.id = 'post-viewer-delete';
    viewerDelete.type = 'button';
    viewerDelete.className = 'post-delete-btn';
    viewerDelete.textContent = '🗑 Delete';
    viewerDelete.addEventListener('click', () => viewerPost && deleteOwnPost(viewerPost));
    modal.querySelector('.post-viewer-details').appendChild(viewerDelete);
  }
  let viewerPrivacy = modal.querySelector('#post-viewer-privacy');
  if (!viewerPrivacy) {
    viewerPrivacy = createPrivacySelect(post, false);
    viewerPrivacy.id = 'post-viewer-privacy';
    modal.querySelector('.post-viewer-details').appendChild(viewerPrivacy);
  }
  viewerPrivacy.dataset.postId = post.id;
  viewerPrivacy.value = post.privacy || 'everyone';
  viewerPrivacy.hidden = !post.is_owner;
  viewerPrivacy.onchange = async () => {
    const target = viewerPost;
    if (!target) return;
    try {
      await apiRequest(`/posts/${target.id}/privacy`, { method: 'PATCH', body: JSON.stringify({ privacy: viewerPrivacy.value }) });
      target.privacy = viewerPrivacy.value;
      document.querySelectorAll(`.post-privacy-select[data-post-id="${target.id}"]`).forEach(s => { s.value = target.privacy; });
    } catch (err) {
      if (viewerPost === target) viewerPrivacy.value = target.privacy || 'everyone';
      alert(err.message || 'Could not change who can see this post.');
    }
  };
  viewerDelete.hidden = !post.is_owner;
  let viewerOriginal = modal.querySelector('#post-viewer-original');
  if (!viewerOriginal) {
    viewerOriginal = document.createElement('button');
    viewerOriginal.id = 'post-viewer-original';
    viewerOriginal.type = 'button';
    viewerOriginal.textContent = 'Download original';
    viewerOriginal.addEventListener('click', async () => {
      if (!viewerPost) return;
      try { await downloadOriginal('post', viewerPost.id); }
      catch (error) { alert(error.message || 'Could not download the original.'); }
    });
    modal.querySelector('.post-viewer-details').appendChild(viewerOriginal);
  }
  viewerOriginal.hidden = !post.is_owner || !post.has_original;
  modal.querySelector('#post-viewer-author').textContent = `@${post.author_username || 'user'}`;
  modal.querySelector('#post-viewer-author').textContent = `@${post.author_username || 'user'} · ${timeAgo(post.created_at)}`;
  modal.querySelector('#post-viewer-avatar-slot').replaceChildren(createAuthorAvatar(post));
  modal.querySelector('#post-viewer-caption').textContent = post.caption || '';
  viewerPost = post;
  renderPostViewerLike();
  loadPostViewerComments(post);
  modal.classList.add('active');
}

let viewerPost = null;
let viewerPosts = null;
let viewerGeneration = 0;

function navigateViewer(direction) {
  if (!viewerPosts || !viewerPost) return;
  const next = viewerPosts[viewerPosts.indexOf(viewerPost) + direction];
  if (next) showPostViewer(next);
}

async function deleteOwnPost(post) {
  if (!confirm('Delete this post permanently?')) return;
  try {
    await apiRequest(`/posts/${post.id}`, { method: 'DELETE' });
    closePostViewer();
    document.querySelectorAll(`[data-post-id="${post.id}"]`).forEach(el => el.remove());
    document.dispatchEvent(new CustomEvent('vynzo:post-deleted', { detail: { id: post.id } }));
  } catch (err) {
    alert(err.message || 'Could not delete the post.');
  }
}
function renderPostViewerLike() {
  const button = document.getElementById('post-viewer-like');
  if (!button || !viewerPost) return;
  button.textContent = `${viewerPost.is_liked ? '♥' : '♡'} ${Number(viewerPost.likes_count) || 0}`;
  button.classList.toggle('liked', Boolean(viewerPost.is_liked));
}

function syncFeedCard(post) {
  const card = document.querySelector(`.post-card[data-post-id="${post.id}"]`);
  if (!card) return;
  card.querySelector('.like-btn')?.classList.toggle('liked', Boolean(post.is_liked));
  const likeCount = card.querySelector('.like-btn .action-count');
  if (likeCount) likeCount.textContent = Number(post.likes_count) || 0;
  const commentCount = card.querySelector('.comment-count .action-count');
  if (commentCount) commentCount.textContent = Number(post.comments_count) || 0;
}

function setPostCommentFormState(hasCommented) {
  const input = document.getElementById('post-viewer-comment-input');
  const button = document.querySelector('#post-viewer-comment-form button[type="submit"]');
  if (!input || !button) return;
  input.disabled = hasCommented;
  button.disabled = hasCommented;
  input.placeholder = hasCommented ? 'You already commented on this post' : 'Add a comment...';
  if (hasCommented) input.value = '';
}

function appendPostComment(list, comment) {
  const item = document.createElement('p');
  const author = document.createElement('strong');
  author.textContent = `@${comment.username || 'user'} `;
  const content = document.createElement('span');
  content.textContent = comment.content;
  item.append(author, content);
  list.appendChild(item);
}

function currentUserId() {
  try {
    return JSON.parse(localStorage.getItem('vynzo_user') || '{}').id;
  } catch (err) {
    return undefined;
  }
}

async function loadPostViewerComments(post) {
  const list = document.getElementById('post-viewer-comments');
  const generation = ++viewerGeneration;
  list.replaceChildren();
  setPostCommentFormState(false);
  try {
    const data = await apiRequest(`/posts/${post.id}/comments`);
    if (viewerPost !== post || generation !== viewerGeneration) return;
    if (!data.comments.length) list.textContent = 'No comments yet. Be the first!';
    data.comments.forEach(comment => appendPostComment(list, comment));
    setPostCommentFormState(false);
  } catch (err) {
    if (viewerPost === post && generation === viewerGeneration) list.textContent = 'Could not load comments.';
  }
}

async function togglePostViewerLike() {
  const post = viewerPost;
  if (!post) return;
  const button = document.getElementById('post-viewer-like');
  button.disabled = true;
  try {
    const result = await apiRequest(`/posts/${post.id}/like`, { method: 'POST' });
    post.likes_count = Math.max(0, (Number(post.likes_count) || 0) + (result.liked ? 1 : -1));
    post.is_liked = result.liked;
    if (viewerPost === post) renderPostViewerLike();
    syncFeedCard(post);
  } catch (err) {
    alert(err.message || 'Please log in to like posts.');
  } finally {
    button.disabled = false;
  }
}

async function submitPostViewerComment(event) {
  event.preventDefault();
  const post = viewerPost;
  const generation = viewerGeneration;
  const input = document.getElementById('post-viewer-comment-input');
  const content = input.value.trim();
  if (!post || !content) return;
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const result = await apiRequest(`/posts/${post.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content })
    });
    post.comments_count = (Number(post.comments_count) || 0) + 1;
    syncFeedCard(post);
    if (viewerPost === post && viewerGeneration === generation) {
      const list = document.getElementById('post-viewer-comments');
      if (!list.querySelector('p')) list.replaceChildren();
      appendPostComment(list, result.comment);
      input.value = '';
    }
  } catch (err) {
    alert(err.message || 'Could not add comment. Please try again.');
  } finally {
    submitButton.disabled = input.disabled;
  }
}

function closePostViewer() {
  const modal = document.getElementById('post-viewer-modal');
  if (!modal) return;
  modal.querySelector('video')?.pause();
  modal.querySelector('#post-viewer-media').replaceChildren();
  modal.classList.remove('active');
  viewerPost = null;
  viewerPosts = null;
  viewerGeneration++;
}

function makeAuthorLink(row, post) {
  if (!post.author_id) return;
  const open = async event => {
    event.stopPropagation();
    try {
      const { openUserProfile } = await import('./users.js?v=report-reasons1');
      openUserProfile(post.author_id);
    } catch (err) {
      console.error('Could not open profile:', err);
    }
  };
  row.querySelectorAll('.post-author, .post-author-avatar').forEach(el => {
    el.classList.add('post-author-link');
    el.title = `View @${post.author_username || 'user'}'s profile`;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('click', open);
    el.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(event); }
    });
  });
}

function createAuthorAvatar(post) {
  const name = post.author_username || 'user';
  const avatar = document.createElement('span');
  avatar.className = 'post-author-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  const fallback = () => { avatar.replaceChildren(); avatar.textContent = name.charAt(0).toUpperCase(); };
  if (post.author_avatar_url) {
    const image = document.createElement('img');
    image.alt = '';
    image.src = /^https?:/i.test(post.author_avatar_url) ? post.author_avatar_url : `${API_ORIGIN}${post.author_avatar_url}`;
    image.addEventListener('error', fallback, { once: true });
    avatar.appendChild(image);
  } else {
    fallback();
  }
  return avatar;
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}