import { apiRequest, apiBlobRequest } from './api.js?v=view-once-lifecycle1';
import { API_ORIGIN } from './config.js?v=sb4';
import { supabase } from './supabase-client.js';
import { createRealtimeSocket } from './realtime.js?v=sb15';
import { attachEmojiPicker } from './emoji-picker.js?v=multiline1';
import { attachChatComposer } from './chat-composer.js?v=1';
import { initCalls, startCall } from './calls.js?v=audio3';
import { parseSharedMessage } from './share-data.js?v=2';
import { setScreenGuard } from './screen-guard.js';
import { createImageCover } from './image-cover.js';
import { encodePlaybackVideo } from './video-encoder.js';
import { chooseMessageCamera, recordMessageVideo, MAX_CAMERA_VIDEO_SECONDS } from './message-camera.js';
import { createCameraSwitcher } from './camera-devices.js';
import { pageMemoryAccount, readPageMemory, writePageMemory } from './page-memory.js';

let socket = null;
let currentConversationMeta = null;
let currentConversationId = null;
let conversationMembers = [];
let replyingTo = null;
let conversationRefreshInterval = null;
let backgroundRefreshInProgress = false;
let readReceiptsEnabled = true;
let messageRefreshRequest = 0;
let conversationRefreshRequest = 0;
const messageRenderSignatures = new WeakMap();
const conversationRenderData = new WeakMap();
const latestMessageMediaSources = new WeakMap();
const pendingMessages = new Map();
const conversationsAwaitingRead = new Map();
let readReceiptVersion = 0;
const MAX_VIDEO_SECONDS = 60;
const MAX_VOICE_SECONDS = 300;
const VOICE_PATTERN = /\.(weba|m4a|ogg)(\?.*)?$/i;
const STICKER_MESSAGE_CONTENT = '[vynzo-sticker]';
const STICKER_EMOJIS = ['😀', '🥰', '😂', '😎', '🥳', '😭', '😡', '🤔', '😍', '👍', '👏', '❤️', '🔥', '✨', '🎉', '👋'];

export async function initMessaging() {
  const container = document.getElementById('conversations-list');
  if (!container) return;

  const currentUser = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  if (!currentUser.id) {
    container.innerHTML = '<p style="padding:16px; color:var(--text-muted);">Please login to view messages.</p>';
    return;
  }

  const cached = readPageMemory('conversations');
  if (cached) renderConversations(cached, currentUser);
  const token = localStorage.getItem('vynzo_token');
  initCalls();
  socket = createRealtimeSocket({
    auth: token ? { token } : {}
  });
  socket.on('connect', () => {
    if (currentConversationId) joinConversation(currentConversationId);
  });
  socket.on('conversation_changed', event => {
    refreshConversations().catch(() => {});
    if (!event || event.conversation_id === currentConversationId) refreshCurrentConversation().catch(() => {});
  });
  socket.on('connect_error', err => {
    console.error('Message realtime connection failed:', err.message);
  });

  async function retryConversationLoad() {
    try {
      const conversations = await refreshConversations();
      const requestedConversationId = new URLSearchParams(window.location.search).get('conversationId');
      if (requestedConversationId) {
        const conversation = conversations.find(item => item.id === requestedConversationId);
        if (conversation) {
          await selectConversation(conversation, currentUser);
          return;
        }
      }
      showChatError('Select a conversation to start chatting.');
    } catch (err) {
      console.error('Could not retry loading conversations:', err);
      showConversationError(err.message || 'Could not load your conversations.', retryConversationLoad, Boolean(readPageMemory('conversations')));
    }
  }

  try {
    const conversations = await refreshConversations();
    const requestedConversationId = new URLSearchParams(window.location.search).get('conversationId');
    if (requestedConversationId) {
      const conversation = conversations.find(item => item.id === requestedConversationId);
      if (conversation) {
        await selectConversation(conversation, currentUser);
      } else {
        showChatError('This conversation is not available for your account.');
      }
    }
  } catch (err) {
    console.error('Failed to load conversations:', err);
    showChatError(err.message || 'Could not load your conversations. Please try again.');
    showConversationError(err.message || 'Could not load your conversations.', retryConversationLoad, Boolean(readPageMemory('conversations')));
  }

  if (!conversationRefreshInterval) {
    conversationRefreshInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshVisibleConversations();
    }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshVisibleConversations();
    });
  }

}

function refreshVisibleConversations() {
  if (backgroundRefreshInProgress) return;
  backgroundRefreshInProgress = true;
  Promise.all([
    refreshConversations().catch(err => console.error('Failed to refresh conversations:', err)),
    refreshCurrentConversation().catch(err => console.error('Failed to refresh messages:', err))
  ]).finally(() => {
    backgroundRefreshInProgress = false;
  });
}

async function refreshCurrentConversation() {
  const conversationId = currentConversationId;
  const container = document.getElementById('chat-messages-container');
  if (!conversationId || !container) return;

  const request = ++messageRefreshRequest;
  const data = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/messages`);
  if (request !== messageRefreshRequest || currentConversationId !== conversationId || document.getElementById('chat-messages-container') !== container) return;

  const currentUser = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  const existingIds = new Set(
    [...container.querySelectorAll('.message-bubble')].filter(bubble => !bubble.closest('[data-pending-id]')).map(bubble => bubble.dataset.messageId)
  );
  const hasNewIncoming = data.messages.some(message =>
    message.sender_id !== currentUser.id && !existingIds.has(message.id)
  );
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  readReceiptsEnabled = data.read_receipts !== false;
  conversationMembers = data.members || conversationMembers;

  const rows = new Map([...container.querySelectorAll('.message-bubble')].filter(bubble => !bubble.closest('[data-pending-id]')).map(bubble =>
    [bubble.dataset.messageId, bubble.closest('.message-row')]
  ));
  const orderedRows = [];
  const newRows = [];
  for (const message of data.messages) {
    const next = createMessageRow(message, currentUser);
    const signature = messageContentSignature(next);
    let row = rows.get(message.id);
    rows.delete(message.id);
    if (!row || messageRenderSignatures.get(row) !== signature) {
      if (row) {
        row.querySelector('.voice-player')?._audio?.pause();
        row.replaceWith(next);
      }
      row = next;
      messageRenderSignatures.set(row, signature);
      newRows.push(row);
    } else {
      syncMessageMetadata(row, next);
      refreshMessageMediaSources(row, next);
    }
    orderedRows.push(row);
  }
  for (const row of rows.values()) {
    row.querySelector('.voice-player')?._audio?.pause();
    row.remove();
  }
  placeMessageItems(container, [...orderedRows, ...pendingRows(conversationId)]);
  for (const row of newRows) hydrateSharedPreviews(row);
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
  if (hasNewIncoming || conversationsAwaitingRead.has(conversationId)) markConversationRead(conversationId);
}

function createMessageRow(message, currentUser) {
  // Inert parsing keeps snapshot comparisons from requesting the media again.
  const template = document.createElement('template');
  template.innerHTML = messageMarkup(message, currentUser);
  return template.content.firstElementChild;
}

function messageContentSignature(row) {
  const copy = row.cloneNode(true);
  copy.querySelectorAll('.message-edit-button, .message-delete-button, .message-status').forEach(node => node.remove());
  copy.querySelectorAll('[src], [data-src]').forEach(node => {
    for (const attribute of ['src', 'data-src']) {
      if (node.hasAttribute(attribute)) node.setAttribute(attribute, messageMediaIdentity(node.getAttribute(attribute)));
    }
  });
  copy.querySelector('.message-bubble')?.removeAttribute('data-seen');
  return copy.outerHTML;
}

function syncMessageMetadata(row, next) {
  for (const selector of ['.message-edit-button', '.message-delete-button', '.message-status']) {
    const current = row.querySelector(selector);
    const replacement = next.querySelector(selector);
    if (current?.outerHTML === replacement?.outerHTML) continue;
    if (current && replacement) current.replaceWith(replacement);
    else if (current) current.remove();
    else row.querySelector('.message-bubble').append(replacement);
  }
}

function refreshMessageMediaSources(current, next) {
  const sources = new Map([...next.querySelectorAll('img[src], video[src]')].map(media =>
    [messageMediaIdentity(media.getAttribute('src')), media.getAttribute('src')]
  ));
  current.querySelectorAll('img[src], video[src]').forEach(media => {
    const source = sources.get(messageMediaIdentity(media.getAttribute('src')));
    if (source) {
      latestMessageMediaSources.set(media, source);
      if (media instanceof HTMLImageElement && media.complete && !media.naturalWidth && media.getAttribute('src') !== source) {
        media.src = source;
      }
    }
  });
  const player = current.querySelector('.voice-player');
  const nextPlayer = next.querySelector('.voice-player');
  if (player && nextPlayer) player.dataset.src = nextPlayer.dataset.src;
}

function placeMessageItems(container, items) {
  const wanted = new Set(items);
  for (const node of [...container.children]) {
    if (!wanted.has(node)) node.remove();
  }
  let cursor = container.firstElementChild;
  for (const item of items) {
    if (item !== cursor) container.insertBefore(item, cursor);
    cursor = item.nextElementSibling;
  }
}

function pendingRows(conversationId) {
  return [...pendingMessages.values()].filter(entry => entry.conversationId === conversationId).map(entry => entry.row);
}

function beginPendingMessage(conversationId, currentUser, { content = '', file = null, viewOnce = false, reply = null } = {}) {
  const id = `pending-${crypto.randomUUID()}`;
  const url = file && !viewOnce ? URL.createObjectURL(file) : null;
  const row = createMessageRow({
    id, sender_id: currentUser.id, content, created_at: new Date().toISOString(),
    media_url: url, local_media_type: file?.type, view_once: viewOnce, pending: true,
    reply_to: reply ? { id: reply.id, sender_name: reply.name, text: reply.text } : null
  }, currentUser);
  row.dataset.pendingId = id;
  row.setAttribute('aria-busy', 'true');
  row.querySelectorAll('button').forEach(button => { button.disabled = true; });
  const entry = { id, conversationId, row, url };
  pendingMessages.set(id, entry);
  if (currentConversationId === conversationId) {
    const container = document.getElementById('chat-messages-container');
    if (container) { container.append(row); container.scrollTop = container.scrollHeight; }
  }
  return entry;
}

function endPendingMessage(entry) {
  if (!entry || !pendingMessages.delete(entry.id)) return;
  entry.row.remove();
  if (entry.url) URL.revokeObjectURL(entry.url);
}

async function prepareMessageBody(conversationId, { content = '', file = null, replyId = null } = {}) {
  if (file && file.size <= 6 * 1024 * 1024) {
    const body = new FormData();
    body.append('content', content);
    body.append('media', file);
    if (replyId) body.append('reply_to_id', replyId);
    return body;
  }
  if (!file) return JSON.stringify({ content, reply_to_id: replyId });
  const upload = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/upload-url`, {
    method: 'POST',
    body: JSON.stringify({ content_type: file.type })
  });
  const { error } = await supabase.storage.from('uploads')
    .uploadToSignedUrl(upload.path, upload.token, file, { contentType: file.type });
  if (error) throw new Error(`Upload failed: ${error.message || 'please check your connection and try again.'}`);
  return JSON.stringify({ content, reply_to_id: replyId, media_path: upload.path });
}

async function refreshConversations() {
  const request = ++conversationRefreshRequest;
  const account = pageMemoryAccount();
  const userId = JSON.parse(localStorage.getItem('vynzo_user') || '{}').id;
  const data = await apiRequest('/messages');
  if (request !== conversationRefreshRequest || JSON.parse(localStorage.getItem('vynzo_user') || '{}').id !== userId) return [];
  const currentUser = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  writePageMemory('conversations', data.conversations.slice(0, 100).map(conv => ({
    id: conv.id, is_group: conv.is_group, group_name: conv.group_name, other_user_id: conv.other_user_id,
    other_username: conv.other_username, other_display_name: conv.other_display_name,
    other_avatar_url: conv.other_avatar_url, unread_count: conv.unread_count,
    created_at: conv.last_message?.created_at || conv.created_at, cached_preview: true
  })), account);
  renderConversations(data.conversations, currentUser);
  return data.conversations;
}

function renderConversations(conversations, currentUser) {
  const container = document.getElementById('conversations-list');
  if (!container) return;

  const unreadOf = conv => Number(conv.unread_count) || 0;
  const timeOf = conv => new Date(conv.last_message?.created_at || conv.created_at || 0).getTime();
  conversations = [...conversations].sort((a, b) => {
    const unreadDiff = (unreadOf(b) > 0) - (unreadOf(a) > 0);
    return unreadDiff || timeOf(b) - timeOf(a);
  });
  const total = conversations.reduce((sum, conv) => sum + unreadOf(conv), 0);
  const totalBadge = document.getElementById('unread-total');
  if (totalBadge) {
    totalBadge.textContent = total > 99 ? '99+' : String(total);
    totalBadge.hidden = total === 0;
  }

  if (conversations.length === 0) {
    container.innerHTML = '<p style="padding:16px; color:var(--text-muted);">No messages yet.</p>';
    return;
  }

  const existing = new Map([...container.querySelectorAll('.conversation-item')].map(item =>
    [item.dataset.conversationId, item]
  ));
  const orderedItems = [];
  conversations.forEach(conv => {
    let item = existing.get(conv.id);
    const conversationName = getConversationName(conv);
    const unread = unreadOf(conv);
    if (!item) {
      item = document.createElement('div');
      item.className = 'conversation-item';
      item.dataset.conversationId = conv.id;
      item.innerHTML = `
      ${avatarMarkup(conv.other_avatar_url, conversationName, 'author-avatar')}
      <div>
        <div style="font-weight:${unread ? 800 : 600};">${escapeHtml(conversationName)}</div>
        <div style="font-size:12px; color:var(--text-muted);">${escapeHtml(conv.cached_preview ? 'Open conversation' : conv.last_message ? messagePreview(conv.last_message) : 'No messages')}</div>
      </div>
      ${unread ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
    `;
      item.addEventListener('click', () => {
        selectConversation(conversationRenderData.get(item), currentUser);
      });
    } else {
      const previous = conversationRenderData.get(item);
      if (messageMediaIdentity(previous.other_avatar_url || '') !== messageMediaIdentity(conv.other_avatar_url || '')) {
        const template = document.createElement('template');
        template.innerHTML = avatarMarkup(conv.other_avatar_url, conversationName, 'author-avatar');
        item.firstElementChild.replaceWith(template.content.firstElementChild);
      } else {
        const image = item.querySelector('.author-avatar img');
        if (image && conv.other_avatar_url) {
          latestMessageMediaSources.set(image, /^https?:/i.test(conv.other_avatar_url) ? conv.other_avatar_url : `${API_ORIGIN}${conv.other_avatar_url}`);
        }
        if (!conv.other_avatar_url && previous && getConversationName(previous) !== conversationName) {
          item.firstElementChild.textContent = conversationName.replace(/^@/, '').charAt(0).toUpperCase() || '?';
        }
      }
      const details = item.children[1];
      if (details.children[0].textContent !== conversationName) details.children[0].textContent = conversationName;
      details.children[0].style.fontWeight = unread ? '800' : '600';
      const preview = conv.cached_preview ? 'Open conversation' : conv.last_message ? messagePreview(conv.last_message) : 'No messages';
      if (details.children[1].textContent !== preview) details.children[1].textContent = preview;
      let badge = item.querySelector('.unread-badge');
      if (!unread) badge?.remove();
      else {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'unread-badge';
          item.append(badge);
        }
        const count = unread > 99 ? '99+' : String(unread);
        if (badge.textContent !== count) badge.textContent = count;
      }
    }
    conversationRenderData.set(item, conv);
    item.classList.toggle('active', conv.id === currentConversationId);
    orderedItems.push(item);
  });
  placeMessageItems(container, orderedItems);
}

const mobileChatQuery = window.matchMedia('(max-width: 700px)');
let stickerViewer = null;

function openChatView() {
  const container = document.querySelector('.messaging-container');
  if (!container || !mobileChatQuery.matches || container.classList.contains('chat-open')) return;
  container.classList.add('chat-open');
  history.pushState({ vynzoChat: true }, '');
}

function closeChatView() {
  document.querySelector('.messaging-container')?.classList.remove('chat-open');
  if (currentConversationId) {
    currentConversationId = null;
    window.__vynzoOpenConversation = null;
    currentConversationMeta = null;
    document.querySelectorAll('.conversation-item.active').forEach(item => item.classList.remove('active'));
    refreshConversations().catch(() => {});
  }
}

function goBackToList() {
  if (history.state && history.state.vynzoChat) history.back();
  else closeChatView();
}

window.addEventListener('popstate', event => {
  if (stickerViewer) {
    stickerViewer.dismiss();
    return;
  }
  if (event.state?.vynzoStickerViewer) return;
  if (document.querySelector('.messaging-container')?.classList.contains('chat-open')) closeChatView();
});

function selectConversation(conversation, currentUser) {
  currentConversationMeta = conversation;
  openChatView();
  document.querySelectorAll('.conversation-item').forEach(item => {
    item.classList.toggle('active', item.dataset.conversationId === conversation.id);
  });
  return loadConversation(conversation.id, currentUser, getConversationName(conversation), conversation.other_avatar_url);
}

async function loadConversation(conversationId, currentUser, conversationName = 'Conversation', avatarUrl = '') {
  currentConversationId = conversationId;
  window.__vynzoOpenConversation = conversationId;
  replyingTo = null;
  if (socket.connected) joinConversation(conversationId);

  const chatArea = document.getElementById('chat-area');
  try {
    const data = await apiRequest(`/messages/${conversationId}/messages`);
    readReceiptsEnabled = data.read_receipts !== false;
    conversationMembers = data.members || [];
    renderChatWindow(chatArea, data.messages, currentUser, conversationName, avatarUrl);
    markConversationRead(conversationId);
  } catch (err) {
    console.error('Failed to load messages:', err);
    showChatError(err.message || 'Could not load this conversation. Please try again.');
  }
}

function notifyPeer(conversationId) {
  const peerId = currentConversationMeta?.id === conversationId ? currentConversationMeta.other_user_id : null;
  if (peerId && socket) socket.emit('notify_peer', { userId: peerId, conversation_id: conversationId });
}

function markConversationRead(conversationId) {
  const version = ++readReceiptVersion;
  conversationsAwaitingRead.set(conversationId, version);
  if (document.hidden || currentConversationId !== conversationId) return;
  apiRequest(`/messages/${encodeURIComponent(conversationId)}/read`, { method: 'POST' }).then(() => {
    if (conversationsAwaitingRead.get(conversationId) === version) conversationsAwaitingRead.delete(conversationId);
    notifyPeer(conversationId);
    document.dispatchEvent(new CustomEvent('vynzo:messages-read'));
    refreshConversations().catch(err => console.error('Could not refresh read conversations:', err));
  }).catch(err => {
    console.error('Could not mark conversation as read:', err);
  });
}

function renderChatWindow(chatArea, messages, currentUser, conversationName, avatarUrl = '') {
  chatArea.innerHTML = `
    <div class="chat-header">
      <button type="button" class="chat-back-btn" id="chat-back-btn" aria-label="Back to messages" title="Back">←</button>
      ${avatarMarkup(avatarUrl, conversationName, 'chat-header-avatar')}
      <div>
        <strong>${escapeHtml(conversationName)}</strong>
      </div>
      ${currentConversationMeta && !currentConversationMeta.is_group ? `
        <div class="chat-call-actions">
          <button type="button" class="chat-call-btn" id="voice-call-btn" aria-label="Voice call" title="Voice call">📞</button>
          <button type="button" class="chat-call-btn" id="video-call-btn" aria-label="Video call" title="Video call">🎥</button>
          <button type="button" class="chat-call-btn" id="hide-sender-btn" aria-label="Delete a person's messages" title="Delete a person's messages (for you)">🙈</button>
          <button type="button" class="chat-call-btn" id="delete-chat-btn" aria-label="Delete conversation" title="Delete conversation">🗑</button>
        </div>
      ` : `
        <div class="chat-call-actions">
          <button type="button" class="chat-call-btn" id="hide-sender-btn" aria-label="Delete a person's messages" title="Delete a person's messages (for you)">🙈</button>
          <button type="button" class="chat-call-btn" id="delete-chat-btn" aria-label="Delete conversation" title="Delete conversation">🗑</button>
        </div>
      `}
    </div>
    <div class="chat-messages" id="chat-messages-container">
      ${messages.map(m => messageMarkup(m, currentUser)).join('')}
    </div>
    <form class="chat-input-form" id="chat-form">
      <div class="reply-bar" id="reply-bar" hidden></div>      <div class="chat-attachment-preview" id="chat-attachment-preview" hidden></div>
      <button class="attach-btn" type="button" id="attach-btn" aria-label="Attach photo or video" title="Photo or video (video up to 60 seconds)">📎</button>
      <button class="attach-btn" type="button" id="camera-btn" aria-label="Take a photo" title="Take a photo with the camera">📷</button>
      <button class="attach-btn sticker-open-btn" type="button" id="sticker-open-btn" aria-label="Send a sticker" title="Stickers">✨</button>
      <input type="file" id="chat-camera-input" accept="image/*" capture="environment" hidden>
      <button class="attach-btn" type="button" id="voice-btn" aria-label="Record a voice message" title="Record a voice message">🎤</button>
      <input type="file" id="chat-file-input" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" hidden>
      <textarea class="chat-input" id="chat-input-field" rows="1" placeholder="Type a message..." aria-label="Type a message"></textarea>
      <button type="submit" class="send-btn"><span>Send</span><span aria-hidden="true">➤</span></button>
    </form>
    <p class="chat-send-status" id="chat-send-status" role="status" aria-live="polite" hidden></p>
  `;

  const msgContainer = document.getElementById('chat-messages-container');
  for (const row of msgContainer.querySelectorAll('.message-row')) {
    const template = document.createElement('template');
    template.innerHTML = row.outerHTML;
    messageRenderSignatures.set(row, messageContentSignature(template.content.firstElementChild));
  }
  hydrateSharedPreviews(msgContainer);
  msgContainer.append(...pendingRows(currentConversationId));
  msgContainer.scrollTop = msgContainer.scrollHeight;

  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input-field');
  const resizeComposer = attachChatComposer(input, form);
  const status = document.getElementById('chat-send-status');
  const fileInput = document.getElementById('chat-file-input');
  const preview = document.getElementById('chat-attachment-preview');
  let attachment = null;
  let viewOnce = false;
  let sending = false;
  let preparingAttachment = false;
  let preparation = 0;
  attachEmojiPicker(form, input);
  document.getElementById('sticker-open-btn').addEventListener('click', () => {
    openStickerPicker(currentUser.id, async sticker => {
      await sendSticker(sticker, currentConversationId, currentUser, status);
    });
  });

  const callMeta = currentConversationMeta;
  [['voice-call-btn', false], ['video-call-btn', true]].forEach(([id, video]) => {
    const button = document.getElementById(id);
    if (!button || !callMeta) return;
    button.addEventListener('click', () => startCall({
      conversationId: callMeta.id,
      calleeId: callMeta.other_user_id,
      name: conversationName,
      avatarUrl: avatarUrl,
      video
    }));
  });
  const clearAttachment = () => {
    preview.querySelectorAll('audio, video, img').forEach(media => {
      if (typeof media.pause === 'function') media.pause();
      if (media.src.startsWith('blob:')) URL.revokeObjectURL(media.src);
    });
    attachment = null;
    viewOnce = false;
    status.hidden = true;
    fileInput.value = '';
    preview.replaceChildren();
    preview.hidden = true;
  };


  msgContainer.addEventListener('click', async event => {
    const sticker = event.target.closest('.sticker-media-link');
    if (sticker) {
      openStickerViewer(sticker);
      return;
    }
    const sharedMedia = event.target.closest('.shared-media-preview');
    if (sharedMedia) {
      await openSharedMedia(sharedMedia);
      return;
    }
    const open = event.target.closest('.view-once-open');
    if (!open) return;
    const bubble = open.closest('.message-bubble');
    open.disabled = true;
    try {
      await openViewOnce(currentConversationId, bubble.dataset.messageId);
      notifyPeer(currentConversationId);
      open.replaceWith(Object.assign(document.createElement('span'), { className: 'view-once-chip opened', textContent: '📷 Photo · Opened' }));
    } catch (err) {
      status.textContent = err.message || 'This photo is no longer available.';
      status.hidden = false;
      if (err.code === 'view_once_temporarily_unavailable') {
        open.disabled = false;
      } else {
        open.replaceWith(Object.assign(document.createElement('span'), { className: 'view-once-chip opened', textContent: '📷 Photo · Opened' }));
      }
    }
  });

  socket.off('view_once_opened');
  socket.on('view_once_opened', event => {
    if (event.conversation_id !== currentConversationId) return;
    const chip = msgContainer.querySelector(`[data-message-id="${event.message_id}"] .view-once-chip`);
    if (chip) {
      chip.classList.add('opened');
      chip.textContent = '📷 Photo · Opened';
      if (chip.tagName === 'BUTTON') chip.replaceWith(Object.assign(document.createElement('span'), { className: 'view-once-chip opened', textContent: '📷 Photo · Opened' }));
    }
  });

  document.getElementById('attach-btn').addEventListener('click', () => fileInput.click());
  const cameraInput = document.getElementById('chat-camera-input');
  document.getElementById('camera-btn').addEventListener('click', () => {
    const error = message => {
      status.textContent = message;
      status.hidden = false;
    };
    chooseMessageCamera(() => {
      if (!navigator.mediaDevices?.getUserMedia) cameraInput.click();
      else openCameraCapture(file => useFile(file), error);
    }, () => recordMessageVideo(file => useFile(file, { cameraVideo: true }), error));
  });
  cameraInput.addEventListener('change', () => {
    const file = cameraInput.files?.[0];
    cameraInput.value = '';
    if (file) useFile(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) useFile(file);
  });
  const voiceButton = document.getElementById('voice-btn');
  let recorder = null;
  let recordTimer = null;
  let recordStarted = 0;
  const stopTracks = stream => stream.getTracks().forEach(track => track.stop());

  function showAudioPreview(file) {
    clearAttachment();
    attachment = file;
    const audio = document.createElement('audio');
    audio.src = URL.createObjectURL(file);
    audio.controls = true;
    audio.controlsList = 'nodownload noplaybackrate';
    audio.addEventListener('contextmenu', e => e.preventDefault());
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove voice message');
    remove.addEventListener('click', clearAttachment);
    preview.append(audio, remove);
    preview.hidden = false;
    status.textContent = 'Voice message ready. Press Send.';
    status.hidden = false;
  }

  function resetVoiceButton() {
    clearInterval(recordTimer);
    voiceButton.classList.remove('recording');
    voiceButton.textContent = '🎤';
    voiceButton.setAttribute('aria-label', 'Record a voice message');
  }

  voiceButton.addEventListener('click', async () => {
    if (recorder) {
      recorder.stop();
      return;
    }
    status.hidden = true;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      status.textContent = 'Voice messages are not supported on this device.';
      status.hidden = false;
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
    } catch {
      status.textContent = 'Microphone access was denied. Allow the microphone to record voice messages.';
      status.hidden = false;
      return;
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg']
      .find(type => MediaRecorder.isTypeSupported(type));
    const chunks = [];
    try {
      recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64_000 });
    } catch {
      stopTracks(stream);
      status.textContent = 'Voice messages are not supported on this device.';
      status.hidden = false;
      return;
    }
    const active = recorder;
    active.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
    active.addEventListener('stop', () => {
      stopTracks(stream);
      recorder = null;
      resetVoiceButton();
      const baseType = (active.mimeType || mimeType || 'audio/webm').split(';')[0];
      const blob = new Blob(chunks, { type: baseType });
      const seconds = (Date.now() - recordStarted) / 1000;
      if (!blob.size || seconds < 0.7) {
        status.textContent = !blob.size
          ? 'No audio was recorded. Please try again.'
          : 'Recording too short. Please record a longer voice message.';
        status.hidden = false;
        return;
      }
      const ext = { 'audio/webm': 'weba', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' }[baseType] || 'weba';
      showAudioPreview(new File([blob], `voice-${Date.now()}.${ext}`, { type: baseType }));
    });
    recordStarted = Date.now();
    active.start();
    voiceButton.classList.add('recording');
    voiceButton.setAttribute('aria-label', 'Stop recording');
    const tick = () => {
      const seconds = Math.floor((Date.now() - recordStarted) / 1000);
      voiceButton.textContent = `⏹ ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      if (seconds >= MAX_VOICE_SECONDS && active.state === 'recording') active.stop();
    };
    tick();
    recordTimer = setInterval(tick, 500);
  });

  async function useFile(file, { cameraVideo = false } = {}) {
    const request = ++preparation;
    preparingAttachment = true;
    const sendButton = form.querySelector('.send-btn');
    sendButton.disabled = true;
    status.textContent = 'Preparing attachment...';
    status.hidden = false;
    try {
      if (!file.type) {
        const guessed = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[(file.name.split('.').pop() || '').toLowerCase()];
        if (guessed) file = new File([file], file.name, { type: guessed });
      }
      if (file.type.startsWith('video/')) {
        if (file.size > 50 * 1024 * 1024) throw new Error('This video is larger than 50 MB. Choose a shorter one.');
        const { playback } = await encodePlaybackVideo(file, progress => {
          if (request === preparation) status.textContent = `Compressing video... ${Math.round(progress * 100)}%`;
        }, cameraVideo ? { trimToSeconds: MAX_CAMERA_VIDEO_SECONDS } : {});
        if (cameraVideo || playback.size < file.size) file = playback;
      } else if (file.size > 50 * 1024 * 1024) {
        throw new Error('File is too large (max 50MB).');
      }
      if (file.type.startsWith('image/')) file = await shrinkImage(file);
      if (request !== preparation || !form.isConnected) return;
      clearAttachment();
      attachment = file;
      const url = URL.createObjectURL(file);
      const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'img');
      media.src = url;
      if (media.tagName === 'VIDEO') media.muted = true;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Remove attachment');
      remove.addEventListener('click', clearAttachment);
      preview.append(media, remove);
      if (file.size <= 50 * 1024 * 1024 && (file.type.startsWith('video/') || file.size <= 10 * 1024 * 1024)) {
        const label = document.createElement('label');
        label.className = 'view-once-toggle';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.addEventListener('change', () => { viewOnce = box.checked; });
        label.append(box, document.createTextNode(' 👁 View once'));
        preview.append(label);
      }
      preview.hidden = false;
      status.textContent = 'Attachment ready. Press Send.';
      status.hidden = false;
    } catch (err) {
      if (request !== preparation) return;
      clearAttachment();
      status.textContent = err.message || 'Could not use this file.';
      status.hidden = false;
    } finally {
      if (request === preparation) {
        preparingAttachment = false;
        sendButton.disabled = sending;
      }
    }
  }

  document.getElementById('chat-back-btn').addEventListener('click', goBackToList);

  document.getElementById('delete-chat-btn').addEventListener('click', async () => {
    const conversationId = currentConversationId;
    if (!window.confirm('Delete this whole conversation? It will be removed for you only; the other person keeps their copy.')) return;
    status.hidden = true;
    try {
      await apiRequest(`/messages/${encodeURIComponent(conversationId)}`, { method: 'DELETE' });
      document.querySelector(`.conversation-item[data-conversation-id="${CSS.escape(conversationId)}"]`)?.remove();
      if (!document.querySelector('#conversations-list .conversation-item')) {
        document.getElementById('conversations-list').innerHTML = '<p style="padding:16px; color:var(--text-muted);">No messages yet.</p>';
      }
      if (currentConversationId === conversationId) {
        currentConversationId = null;
        window.__vynzoOpenConversation = null;
        currentConversationMeta = null;
        showChatError('Select a conversation to start chatting.');
        goBackToList();
      }
      refreshConversations().catch(err => {
        console.error('Could not refresh conversations:', err);
      });
    } catch (err) {
      console.error('Could not delete conversation:', err);
      status.textContent = err.message || 'Could not delete this conversation. Please try again.';
      status.hidden = false;
    }
  });

  input.addEventListener('input', () => {
    status.hidden = true;
  });

  const replyBar = document.getElementById('reply-bar');
  const renderReplyBar = () => {
    replyBar.replaceChildren();
    replyBar.hidden = !replyingTo;
    if (!replyingTo) return;
    const label = document.createElement('span');
    label.className = 'reply-bar-text';
    const name = document.createElement('strong');
    name.textContent = `Replying to ${replyingTo.name}`;
    const text = document.createElement('span');
    text.textContent = replyingTo.text;
    label.append(name, text);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '×';
    cancel.setAttribute('aria-label', 'Cancel reply');
    cancel.addEventListener('click', () => { replyingTo = null; renderReplyBar(); });
    replyBar.append(label, cancel);
  };
  renderReplyBar();

  msgContainer.addEventListener('click', event => {
    const replyButton = event.target.closest('.message-reply-button');
    if (replyButton) {
      const bubble = replyButton.closest('.message-bubble');
      const row = bubble.closest('.message-row');
      replyingTo = {
        id: bubble.dataset.messageId,
        name: row.querySelector('.message-sender-name')?.textContent || 'message',
        text: bubble.dataset.replyText || '📎 Photo / video'
      };
      renderReplyBar();
      input.focus();
      return;
    }
    const quote = event.target.closest('.reply-quote[data-reply-id]');
    if (quote) {
      const target = msgContainer.querySelector(`[data-message-id="${CSS.escape(quote.dataset.replyId)}"]`);
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('reply-highlight');
      setTimeout(() => target.classList.remove('reply-highlight'), 1500);
    }
  });

  document.getElementById('hide-sender-btn').addEventListener('click', () => {
    const conversationId = currentConversationId;
    const overlay = document.createElement('div');
    overlay.className = 'hide-sender-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'hide-sender-dialog';
    const heading = document.createElement('strong');
    heading.textContent = 'Delete all messages from…';
    const note = document.createElement('p');
    note.textContent = 'Removed for you only. Others keep their copy, and new messages still arrive.';
    dialog.append(heading, note);
    conversationMembers.forEach(member => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = member.is_me ? 'Me (my own messages)' : (member.display_name || member.username || 'Unknown');
      button.addEventListener('click', async () => {
        if (!window.confirm(`Delete all messages from ${button.textContent} in this chat? This only affects your view.`)) return;
        button.disabled = true;
        try {
          await apiRequest(`/messages/${encodeURIComponent(conversationId)}/senders/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
          overlay.remove();
          if (currentConversationId === conversationId) await refreshCurrentConversation();
        } catch (err) {
          button.disabled = false;
          status.textContent = err.message || 'Could not delete these messages.';
          status.hidden = false;
          overlay.remove();
        }
      });
      dialog.append(button);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'hide-sender-cancel';
    close.textContent = 'Cancel';
    close.addEventListener('click', () => overlay.remove());
    dialog.append(close);
    overlay.append(dialog);
    overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  });

  msgContainer.addEventListener('click', async event => {
    const editButton = event.target.closest('.message-edit-button');
    if (editButton) {
      const editBubble = editButton.closest('.message-bubble');
      const contentEl = editBubble.querySelector('.message-content');
      const edited = window.prompt('Edit your message', contentEl.textContent);
      const next = edited === null ? '' : edited.trim();
      if (!next || next === contentEl.textContent) return;
      status.hidden = true;
      try {
        const result = await apiRequest(
          `/messages/${encodeURIComponent(currentConversationId)}/messages/${encodeURIComponent(editBubble.dataset.messageId)}`,
          { method: 'PATCH', body: JSON.stringify({ content: next }) }
        );
        contentEl.textContent = result.message.content;
        if (!editBubble.querySelector('.message-edited')) {
          contentEl.insertAdjacentHTML('afterend', '<span class="message-edited">(edited)</span>');
        }
        notifyPeer(currentConversationId);
        refreshConversations().catch(() => {});
      } catch (err) {
        console.error('Could not edit message:', err);
        status.textContent = err.message || 'Could not edit this message. Please try again.';
        status.hidden = false;
      }
      return;
    }
    const button = event.target.closest('.message-delete-button');
    if (!button) return;

    const bubble = button.closest('.message-bubble');
    const messageId = bubble.dataset.messageId;
    const conversationId = currentConversationId;
    const forMe = button.title.startsWith('Delete for me');
    if (!window.confirm(forMe ? 'Delete this message for you only? The other person will still see it.' : 'Delete this message for everyone?')) return;

    button.disabled = true;
    status.hidden = true;
    try {
      await apiRequest(
        `/messages/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE' }
      );
      bubble.closest('.message-row').remove();
      refreshConversations().catch(err => {
        console.error('Could not refresh conversation preview:', err);
      });
    } catch (err) {
      console.error('Could not delete message:', err);
      status.textContent = err.message || 'Could not delete this message. Please try again.';
      status.hidden = false;
      button.disabled = false;
      if (/already been seen/i.test(err.message || '')) button.remove();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending || preparingAttachment) return;
    const content = input.value.trim();
    if (!content && !attachment) return;
    const conversationId = currentConversationId;
    const file = attachment;
    const once = viewOnce;
    const reply = replyingTo;
    const sendButton = form.querySelector('.send-btn');
    sending = true;
    sendButton.disabled = true;
    status.hidden = true;
    let pending;
    try {
      pending = beginPendingMessage(conversationId, currentUser, { content, file, viewOnce: once, reply });
      if (file && once) {
        const photoBody = new FormData();
        photoBody.append('photo', file);
        const sent = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/view-once`, { method: 'POST', body: photoBody });
        endPendingMessage(pending);
        if (currentConversationId === conversationId) appendMessage(msgContainer, sent.message, currentUser);
        if (attachment === file && !preparingAttachment) clearAttachment();
        if (content) {
          pending = beginPendingMessage(conversationId, currentUser, { content });
          const text = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/messages`, {
            method: 'POST',
            body: JSON.stringify({ content })
          });
          if (currentConversationId === conversationId) appendMessage(msgContainer, text.message, currentUser);
        }
        if (currentConversationId === conversationId) {
          if (input.value.trim() === content) input.value = '';
          resizeComposer();
        }
        notifyPeer(conversationId);
        refreshConversations().catch(() => {});
        return;
      }
      const body = await prepareMessageBody(conversationId, { content, file, replyId: reply?.id });
      const result = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        body
      });
      if (currentConversationId === conversationId) {
        appendMessage(msgContainer, result.message, currentUser);
        if (input.value.trim() === content) input.value = '';
        resizeComposer();
        if (attachment === file && !preparingAttachment) clearAttachment();
        if (replyingTo === reply) {
          replyingTo = null;
          renderReplyBar();
        }
      }
      notifyPeer(conversationId);
      refreshConversations().catch(err => {
        console.error('Could not refresh conversation preview:', err);
      });
    } catch (err) {
      console.error('Could not send message:', err);
      status.textContent = err.message || 'Message was not sent. Your text is still here; try again.';
      status.hidden = false;
    } finally {
      endPendingMessage(pending);
      sending = false;
      sendButton.disabled = preparingAttachment;
    }
  });

  // Listen for live incoming messages if not already attached
  socket.off('receive_message');
  socket.on('receive_message', (msg) => {
    refreshConversations().catch(() => {});
    if (msg.conversation_id === currentConversationId) {
      appendMessage(msgContainer, msg, currentUser);
      if (msg.sender_id !== currentUser.id && document.visibilityState === 'visible') {
        markConversationRead(msg.conversation_id);
      }
    }
  });
  socket.off('messages_read');
  socket.on('messages_read', event => {
    if (event.conversation_id !== currentConversationId || event.reader_id === currentUser.id) return;
    const readAt = new Date(event.read_at).getTime();
    msgContainer.querySelectorAll('.message-bubble.outgoing').forEach(bubble => {
      if (bubble.closest('[data-pending-id]')) return;
      if (new Date(bubble.dataset.createdAt).getTime() > readAt) return;
      const del = bubble.querySelector('.message-delete-button');
      if (del) del.title = 'Delete for me (already seen)';
      bubble.dataset.seen = '1';
      bubble.querySelector('.message-edit-button')?.remove();
      const label = bubble.querySelector('.message-status');
      if (label && event.show_receipt && readReceiptsEnabled) {
        label.textContent = 'Seen';
        label.classList.add('seen');
      }
    });
  });
  socket.off('message_deleted');
  socket.on('message_deleted', event => {
    if (event.conversation_id !== currentConversationId) return;
    messageRefreshRequest++;
    msgContainer.querySelector(`[data-message-id="${event.message_id}"]`)?.closest('.message-row')?.remove();
    refreshConversations().catch(err => {
      console.error('Could not refresh conversation preview:', err);
    });
  });
}

// Live preview returns the captured frame as a JPEG File.
async function openCameraCapture(onCapture, onError) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
  } catch {
    onError('Camera access was blocked. Allow the camera in your browser settings and try again.');
    return;
  }
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:16px';
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.style.cssText = 'max-width:100%;max-height:70vh;border-radius:12px;background:#000';
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;gap:12px';
  const shoot = document.createElement('button');
  shoot.type = 'button';
  shoot.textContent = '📸 Take photo';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const flip = document.createElement('button');
  flip.type = 'button';
  flip.textContent = 'Switch camera';
  let closed = false;
  const cameraSwitcher = createCameraSwitcher({
    getStream: () => closed ? null : stream,
    onChanged: () => { video.srcObject = stream; },
    onError
  });
  flip.addEventListener('click', async () => {
    flip.disabled = true;
    shoot.disabled = true;
    try { await cameraSwitcher.switchCamera(); }
    finally {
      flip.disabled = false;
      shoot.disabled = false;
    }
  });
  [shoot, flip, cancel].forEach(b => { b.style.cssText = 'padding:10px 18px;border-radius:999px;border:0;font:inherit;cursor:pointer'; });
  const close = () => {
    closed = true;
    stream.getTracks().forEach(track => track.stop());
    overlay.remove();
  };
  cancel.addEventListener('click', close);
  shoot.addEventListener('click', () => {
    if (!video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      close();
      if (blob) onCapture(new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  });
  bar.append(shoot, flip, cancel);
  overlay.append(video, bar);
  document.body.appendChild(overlay);
}

function joinConversation(conversationId) {
  socket.timeout(5000).emit('join_conversation', conversationId, (err, response) => {
    if (err || !response || !response.ok) {
      console.error('Could not join conversation:', err || response?.error);
    }
  });
}

function appendMessage(container, message, currentUser) {
  if (!container.isConnected) {
    if (message.conversation_id !== currentConversationId) return;
    container = document.getElementById('chat-messages-container');
    if (!container) return;
  }
  if (container.querySelector(`[data-message-id="${message.id}"]`)) return;
  messageRefreshRequest++;

  const bubble = createMessageRow(message, currentUser);
  messageRenderSignatures.set(bubble, messageContentSignature(bubble));
  container.appendChild(bubble);
  hydrateSharedPreviews(bubble);
  container.scrollTop = container.scrollHeight;
}

function linkifyText(text) {
  return escapeHtml(text).replace(/https?:\/\/[^\s<]+/g, url =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

function messageMarkup(message, currentUser) {
  const isOutgoing = message.sender_id === currentUser.id;
  const isSticker = message.content === STICKER_MESSAGE_CONTENT;
  const shared = parseSharedMessage(message.content);
  const senderName = message.sender_display_name
    || message.display_name
    || message.sender_username
    || message.username
    || (isOutgoing ? currentUser.display_name || currentUser.username || 'You' : 'Unknown sender');
  return `
    <div class="message-row ${isOutgoing ? 'outgoing' : 'incoming'}">
      <span class="message-sender">
        ${avatarMarkup(message.sender_avatar_url || message.avatar_url || (isOutgoing ? currentUser.avatar_url : ''), senderName, 'message-avatar')}
        <span class="message-sender-name">${escapeHtml(senderName)}</span>
      </span>
      <div class="message-bubble ${isOutgoing ? 'outgoing' : 'incoming'}${isSticker ? ' sticker-message' : ''}" data-message-id="${escapeHtml(message.id)}" data-reply-text="${escapeHtml(replyText(message))}" data-created-at="${escapeHtml(String(message.created_at || ''))}">
        ${replyQuoteMarkup(message.reply_to)}
        ${mediaMarkup(message)}
        ${message.view_once ? viewOnceMarkup(message, isOutgoing) : ''}
        ${shared ? sharedMessageMarkup(shared, message, senderName, isOutgoing ? currentUser.avatar_url : '') : message.content && !isSticker ? `<span class="message-content">${linkifyText(message.content)}</span>` : ''}
        ${message.edited_at ? '<span class="message-edited">(edited)</span>' : ''}
        <button class="message-reply-button" type="button" aria-label="Reply to this message" title="Reply">↩</button>
        ${isOutgoing && message.content && !shared && !isSticker && !message.view_once && message.can_unsend !== false ? '<button class="message-edit-button" type="button" aria-label="Edit message" title="Edit message">✎</button>' : ''}
        ${isOutgoing ? `<button class="message-delete-button" type="button" aria-label="Delete message" title="${message.can_unsend === false && !message.view_once ? 'Delete for me (already seen)' : 'Delete for everyone (only until it is seen)'}">×</button>` : ''}
        ${message.pending ? '<span class="message-status">Sending...</span>' : isOutgoing && readReceiptsEnabled ? `<span class="message-status ${message.seen ? 'seen' : ''}">${message.seen ? 'Seen' : 'Sent'}</span>` : ''}
      </div>
    </div>
  `;
}

// Phone photos are often 5 MB+; resizing keeps uploads quick on mobile data.
async function shrinkImage(file) {
  let bytes;
  try {
    bytes = await file.arrayBuffer();
    if (!file.size || bytes.byteLength !== file.size) throw new Error('Selected image read was incomplete.');
  } catch (error) {
    console.error('Could not read the selected message image:', error);
    throw new Error('The app could not read this photo from Gallery. Select it again or choose it from My Files.');
  }
  file = new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
  if (file.type === 'image/gif' || file.size <= 300 * 1024) return file;
  const compressed = await createImageCover(file);
  if (compressed.size >= file.size) return file;
  return new File([compressed], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, { type: compressed.type });
}

function replyText(message) {
  if (message.view_once) return '📷 View-once photo';
  if (message.content === STICKER_MESSAGE_CONTENT) return '✨ Sticker';
  const shared = parseSharedMessage(message.content);
  if (shared) return shared.text;
  const text = message.content || (message.media_url ? (VOICE_PATTERN.test(messageMediaPath(message.media_url)) ? '🎤 Voice message' : '📎 Photo / video') : '');
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

function messagePreview(message) {
  if (message.content === STICKER_MESSAGE_CONTENT) return '✨ Sticker';
  const shared = parseSharedMessage(message.content);
  if (shared) return shared.text;
  return message.content || (message.view_once ? '📷 View-once photo' : message.media_url ? (VOICE_PATTERN.test(messageMediaPath(message.media_url)) ? '🎤 Voice message' : '📎 Photo / video') : 'No messages');
}

function sharedMessageMarkup(shared, message, senderName, fallbackAvatar = '') {
  const { preview, text, url } = shared;
  if (preview.type === 'blog') {
    return `<a class="shared-blog-preview" href="blogs.html#/a/${escapeHtml(preview.id)}" data-id="${escapeHtml(preview.id)}">
      <span class="shared-media-frame"><span class="shared-media-status">Loading blog…</span></span>
      <span class="shared-media-caption">${escapeHtml(text)}</span>
    </a>`;
  }
  if (preview.type === 'live') {
    const name = typeof preview.name === 'string' ? preview.name : senderName;
    const avatar = typeof preview.avatar === 'string' ? preview.avatar : message.sender_avatar_url || message.avatar_url || fallbackAvatar;
    const safeAvatar = /^(https?:\/\/|\/)/i.test(avatar) && !avatar.startsWith('//') ? avatar : '';
    return `<a class="shared-live-preview" href="${escapeHtml(url)}">
      ${avatarMarkup(safeAvatar, name, 'shared-live-avatar')}
      <span><strong>${escapeHtml(name)}</strong><span>${escapeHtml(text)}</span><b>Join live →</b></span>
    </a>`;
  }
  const attrs = preview.r2 ? ` data-kind="${preview.kind}" data-id="${escapeHtml(preview.id)}"` : '';
  return `<button type="button" class="shared-media-preview" data-url="${escapeHtml(url)}" data-type="${preview.type}"${attrs} aria-label="Open shared ${preview.type}">
    <span class="shared-media-frame"><span class="shared-media-status">Loading ${preview.type}…</span></span>
    <span class="shared-media-caption">${escapeHtml(text)}</span>
  </button>`;
}

async function sharedMediaUrl(button) {
  if (!button.dataset.kind) return button.dataset.url;
  const result = await apiRequest(`/media/playback?kind=${encodeURIComponent(button.dataset.kind)}&id=${encodeURIComponent(button.dataset.id)}`);
  const url = new URL(result.url);
  if (url.protocol !== 'https:') throw new Error('The media URL is invalid.');
  return url.toString();
}

function hydrateSharedPreviews(container) {
  container.querySelectorAll('.shared-blog-preview').forEach(async link => {
    const frame = link.querySelector('.shared-media-frame');
    try {
      const { article } = await apiRequest(`/blogs/${encodeURIComponent(link.dataset.id)}`);
      if (!link.isConnected) return;
      link.querySelector('.shared-media-caption').textContent = article.title;
      if (!article.cover_url) {
        frame.textContent = '📝';
        return;
      }
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => { frame.textContent = 'Preview unavailable.'; }, { once: true });
      image.src = article.cover_url.startsWith('/uploads/') ? API_ORIGIN + article.cover_url : article.cover_url;
      frame.replaceChildren(image);
    } catch (error) {
      console.error('Could not load shared blog preview:', error);
      frame.textContent = 'Preview unavailable. Tap to open.';
    }
  });
  container.querySelectorAll('.shared-media-preview').forEach(async button => {
    const frame = button.querySelector('.shared-media-frame');
    try {
      const url = await sharedMediaUrl(button);
      if (!button.isConnected) return;
      const media = document.createElement(button.dataset.type === 'video' ? 'video' : 'img');
      media.src = url;
      if (button.dataset.type === 'video') {
        media.muted = true;
        media.playsInline = true;
        media.preload = 'metadata';
        media.addEventListener('loadedmetadata', () => {
          if (media.duration > 0) media.currentTime = Number.isFinite(media.duration) ? Math.min(0.1, media.duration / 2) : 0.1;
        }, { once: true });
      } else {
        media.alt = '';
        media.loading = 'lazy';
      }
      media.addEventListener('error', () => { frame.textContent = 'Preview unavailable. Tap to try opening.'; }, { once: true });
      frame.replaceChildren(media);
      if (button.dataset.type === 'video') {
        const play = document.createElement('span');
        play.className = 'shared-media-play';
        play.textContent = '▶';
        frame.append(play);
      }
    } catch (error) {
      console.error('Could not load shared media preview:', error);
      frame.textContent = 'Preview unavailable. Tap to try opening.';
    }
  });
}

async function openSharedMedia(button) {
  const overlay = document.createElement('div');
  overlay.className = 'shared-media-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `Shared ${button.dataset.type}`);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'shared-media-close';
  close.textContent = 'Close';
  const dismiss = () => { overlay.remove(); button.focus(); };
  close.addEventListener('click', dismiss);
  const status = document.createElement('p');
  status.textContent = 'Loading media…';
  overlay.append(close, status);
  overlay.addEventListener('click', event => { if (event.target === overlay) dismiss(); });
  overlay.addEventListener('keydown', event => { if (event.key === 'Escape') dismiss(); });
  document.body.append(overlay);
  close.focus();
  try {
    const url = await sharedMediaUrl(button);
    if (!overlay.isConnected) return;
    const media = document.createElement(button.dataset.type === 'video' ? 'video' : 'img');
    media.src = url;
    if (button.dataset.type === 'video') {
      media.controls = true;
      media.playsInline = true;
    } else media.alt = 'Shared image';
    media.addEventListener('error', () => { media.replaceWith(status); status.textContent = 'Could not open this media.'; }, { once: true });
    status.replaceWith(media);
  } catch (error) {
    console.error('Could not open shared media:', error);
    status.textContent = error.message || 'Could not open this media.';
  }
}

function replyQuoteMarkup(reply) {
  if (!reply) return '';
  if (reply.unavailable) return '<div class="reply-quote unavailable">Original message unavailable</div>';
  return `<div class="reply-quote" data-reply-id="${escapeHtml(reply.id)}"><strong>${escapeHtml(reply.sender_name)}</strong><span>${escapeHtml(reply.text)}</span></div>`;
}

function viewOnceMarkup(message, isOutgoing) {
  if (message.viewed_at) return '<span class="view-once-chip opened">📷 Photo · Opened</span>';
  if (isOutgoing) return '<span class="view-once-chip">📷 Photo · view once</span>';
  return '<button type="button" class="view-once-chip view-once-open">📷 Photo · tap to view once</button>';
}

function messageMediaPath(value) {
  const { url, claims } = messageMediaReference(value);
  if (claims?.storage === 'legacy-file' && claims.scope === 'message' && typeof claims.path === 'string') {
    return claims.path;
  }
  return url.pathname;
}

function messageMediaReference(value) {
  const url = new URL(value, API_ORIGIN || location.href);
  const permit = url.searchParams.get('permit');
  if (permit) {
    try {
      const payload = permit.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(payload));
      // Presentation only; the media server still verifies the permit and access.
      return { url, claims };
    } catch (error) {
      console.error('Could not identify the message attachment:', error);
    }
  }
  return { url, claims: null };
}

function messageMediaIdentity(value) {
  if (!value) return '';
  const { url, claims } = messageMediaReference(value);
  if (claims?.storage === 'legacy-file' && ['message', 'avatar'].includes(claims.scope) && typeof claims.path === 'string') {
    const { expires, ...reference } = claims;
    url.searchParams.set('permit', JSON.stringify(reference));
    return url.href;
  }
  return value;
}

function mediaMarkup(message) {
  if (message.view_once) return '';
  if (!message.media_url) return '';
  const src = /^(https?:|blob:)/i.test(message.media_url) ? message.media_url : `${API_ORIGIN}${message.media_url}`;
  const path = messageMediaPath(message.media_url);
  if (message.local_media_type?.startsWith('audio/') || VOICE_PATTERN.test(path)) {
    return `<div class="voice-player" data-src="${escapeHtml(src)}"><button type="button" class="voice-play" aria-label="Play voice message">▶</button><input class="voice-seek" type="range" min="0" max="100" value="0" step="0.1" aria-label="Seek"><span class="voice-time">0:00</span></div>`;
  }
  if (message.local_media_type?.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(path)) {
    return `<video class="message-media" src="${escapeHtml(src)}" controls preload="metadata" playsinline></video>`;
  }
  const isSticker = message.content === STICKER_MESSAGE_CONTENT;
  if (isSticker) return `<button type="button" class="sticker-media-link" aria-label="Open sticker"><img class="message-media sticker-media" src="${escapeHtml(src)}" alt="Sticker"></button>`;
  return `<button type="button" class="sticker-media-link photo-media-link" aria-label="Open photo"><img class="message-media photo-thumb" src="${escapeHtml(src)}" alt="Shared photo" loading="lazy"></button>`;
}

function openStickerViewer(button) {
  if (stickerViewer) return;
  const image = button.querySelector('img');
  if (!image) return;
  const overlay = document.createElement('div');
  overlay.className = 'shared-media-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', image.alt || 'Sticker');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'shared-media-close';
  close.textContent = 'Back to messages';
  const preview = document.createElement('img');
  preview.alt = image.alt || 'Sticker';
  preview.src = image.currentSrc || image.src;
  preview.addEventListener('error', () => {
    const error = document.createElement('p');
    error.textContent = 'Could not open this image.';
    preview.replaceWith(error);
  }, { once: true });
  const keydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      back();
    }
  };
  const dismiss = () => {
    document.removeEventListener('keydown', keydown);
    overlay.remove();
    stickerViewer = null;
    if (button.isConnected) button.focus();
  };
  let closing = false;
  const back = () => {
    if (closing) return;
    closing = true;
    if (history.state?.vynzoStickerViewer) history.back();
    else dismiss();
  };
  close.addEventListener('click', back);
  overlay.addEventListener('click', event => { if (event.target === overlay) back(); });
  document.addEventListener('keydown', keydown);
  overlay.append(close, preview);
  document.body.append(overlay);
  stickerViewer = { dismiss };
  history.pushState({ ...history.state, vynzoStickerViewer: true }, '');
  close.focus();
}

function openStickerPicker(userId, onSelect) {
  const overlay = document.createElement('div');
  overlay.className = 'sticker-overlay';
  const dialog = document.createElement('section');
  dialog.className = 'sticker-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'sticker-dialog-title');

  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.id = 'sticker-dialog-title';
  title.textContent = 'Stickers';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'sticker-close';
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', 'Close stickers');
  header.append(title, closeButton);

  const picker = document.createElement('div');
  picker.className = 'sticker-picker';
  const pickerActions = document.createElement('div');
  pickerActions.className = 'sticker-picker-actions';
  const createButton = document.createElement('label');
  createButton.className = 'sticker-create-button';
  createButton.textContent = '＋ Create sticker';
  const deleteModeButton = document.createElement('button');
  deleteModeButton.type = 'button';
  deleteModeButton.className = 'sticker-secondary-button';
  deleteModeButton.textContent = 'Delete stickers';
  deleteModeButton.setAttribute('aria-pressed', 'false');
  let deleteMode = false;
  deleteModeButton.addEventListener('click', () => {
    deleteMode = !deleteMode;
    deleteModeButton.setAttribute('aria-pressed', String(deleteMode));
    deleteModeButton.classList.toggle('is-active', deleteMode);
    deleteModeButton.textContent = deleteMode ? 'Done deleting' : 'Delete stickers';
    grid.classList.toggle('is-delete-mode', deleteMode);
  });
  pickerActions.append(createButton, deleteModeButton);
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.className = 'sticker-file-input';
  fileInput.setAttribute('aria-label', 'Choose image for sticker');
  createButton.appendChild(fileInput);
  const grid = document.createElement('div');
  grid.className = 'sticker-grid';
  const status = document.createElement('p');
  status.className = 'sticker-status';
  status.setAttribute('role', 'status');
  picker.append(pickerActions, grid, status);

  const editor = document.createElement('div');
  editor.className = 'sticker-editor';
  editor.hidden = true;
  dialog.append(header, picker, editor);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  let disposeEditor = null;
  const close = () => {
    disposeEditor?.();
    document.removeEventListener('keydown', escape);
    overlay.remove();
  };
  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  const escape = event => {
    if (event.key === 'Escape' && document.body.contains(overlay)) {
      close();
    }
  };
  document.addEventListener('keydown', escape);

  const send = async (sticker, options = {}) => {
    status.textContent = '';
    fileInput.disabled = true;
    for (const button of grid.querySelectorAll('button')) button.disabled = true;
    try {
      const sending = onSelect(sticker);
      if (!options.keepOpen) close();
      await sending;
      fileInput.disabled = false;
      for (const button of grid.querySelectorAll('button')) button.disabled = false;
      if (options.keepOpen) status.textContent = 'Sticker saved and sent.';
    } catch (err) {
      console.error('Could not send sticker:', err);
      status.textContent = err.message || 'Could not send the sticker. Please try again.';
      fileInput.disabled = false;
      for (const button of grid.querySelectorAll('button')) button.disabled = false;
    }
  };

  const renderGrid = async () => {
    grid.replaceChildren();
    for (const emoji of STICKER_EMOJIS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sticker-emoji-tile';
      button.textContent = emoji;
      button.setAttribute('aria-label', `Send ${emoji} sticker`);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await send({ file: await makeEmojiSticker(emoji), name: `${emoji} sticker` });
        } catch (err) {
          console.error('Could not create emoji sticker:', err);
          status.textContent = err.message || 'Could not create this sticker.';
          button.disabled = false;
        }
      });
      grid.appendChild(button);
    }
    try {
      const stickers = await getSavedStickers(userId);
      stickers.forEach(sticker => {
        const tile = document.createElement('div');
        tile.className = 'sticker-image-tile';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sticker-image-send';
        button.title = `Send ${sticker.name || 'custom sticker'}`;
        const image = document.createElement('img');
        image.src = URL.createObjectURL(sticker.blob);
        image.alt = sticker.name || 'Custom sticker';
        image.addEventListener('load', () => URL.revokeObjectURL(image.src), { once: true });
        button.appendChild(image);
        button.addEventListener('click', () => {
          if (deleteMode) return;
          send({ file: new File([sticker.blob], 'sticker.png', { type: sticker.blob.type || 'image/png' }), name: sticker.name || 'Custom sticker' });
        });
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'sticker-delete-button';
        deleteButton.textContent = '×';
        deleteButton.title = `Delete ${sticker.name || 'sticker'}`;
        deleteButton.setAttribute('aria-label', `Delete ${sticker.name || 'sticker'}`);
        deleteButton.addEventListener('click', async () => {
          deleteButton.disabled = true;
          try {
            await deleteSavedSticker(userId, sticker.id);
            tile.remove();
            status.textContent = 'Sticker deleted.';
          } catch (err) {
            console.error('Could not delete saved sticker:', err);
            status.textContent = err.message || 'Could not delete this sticker.';
            deleteButton.disabled = false;
          }
        });
        tile.append(button, deleteButton);
        grid.appendChild(tile);
      });
    } catch (err) {
      console.error('Could not load saved stickers:', err);
      status.textContent = err.message || 'Could not load your saved stickers.';
    }
  };
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    status.textContent = '';
    fileInput.disabled = true;
    try {
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) {
        throw new Error('Choose a JPG, PNG, GIF, or WebP image.');
      }
      if (!file.size || file.size > 10 * 1024 * 1024) {
        throw new Error('Choose a non-empty image no larger than 10 MB.');
      }
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength !== file.size) throw new Error('The selected image could not be read completely.');
      const selected = new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
      disposeEditor?.();
      disposeEditor = await showStickerEditor(editor, picker, selected, async blob => {
        const stickerName = file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Custom sticker';
        await saveSticker(userId, blob, stickerName);
        editor.hidden = true;
        picker.hidden = false;
        disposeEditor = null;
        await renderGrid();
        await send({ file: new File([blob], 'sticker.png', { type: blob.type || 'image/png' }), name: stickerName }, { keepOpen: true });
      });
    } catch (err) {
      console.error('Could not open sticker editor:', err);
      editor.hidden = true;
      picker.hidden = false;
      status.textContent = err.message || 'Could not open this image.';
    } finally {
      fileInput.value = '';
      fileInput.disabled = false;
    }
  });

  renderGrid();
}

async function showStickerEditor(editor, picker, file, onSave) {
  picker.hidden = true;
  editor.hidden = false;
  editor.replaceChildren();

  let source;
  let sourceUrl = null;
  try {
    source = await createImageBitmap(file);
  } catch {
    sourceUrl = URL.createObjectURL(file);
    const image = new Image();
    image.src = sourceUrl;
    try {
      await image.decode();
      source = image;
    } catch (err) {
      URL.revokeObjectURL(sourceUrl);
      throw new Error('This image could not be opened.');
    }
  }

  const width = Math.max(1, Math.round(source.width * Math.min(1, 512 / Math.max(source.width, source.height))));
  const height = Math.max(1, Math.round(source.height * Math.min(1, 512 / Math.max(source.width, source.height))));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.className = 'sticker-editor-canvas';
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    if (source.close) source.close();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    throw new Error('Sticker editor is not supported by this browser.');
  }

  const note = document.createElement('p');
  note.className = 'sticker-editor-note';
  note.textContent = file.type === 'image/gif'
    ? 'Draw an area to keep. GIF edits are saved as a PNG; an unedited GIF stays animated.'
    : 'Draw an area to keep. The rest of the photo will not be sent.';
  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'sticker-canvas-wrap';
  canvasWrap.appendChild(canvas);

  const controls = document.createElement('div');
  controls.className = 'sticker-editor-controls';
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.maxLength = 60;
  textInput.placeholder = 'Write on your sticker';
  textInput.setAttribute('aria-label', 'Write on your sticker');

  const textColorLabel = document.createElement('label');
  textColorLabel.className = 'sticker-text-color-label';
  textColorLabel.textContent = 'Text color';
  const textColorInput = document.createElement('input');
  textColorInput.type = 'color';
  textColorInput.value = '#ffffff';
  textColorInput.setAttribute('aria-label', 'Text color');
  textColorLabel.appendChild(textColorInput);

  const selectionTools = document.createElement('div');
  selectionTools.className = 'sticker-selection-tools';
  const selectionHint = document.createElement('span');
  selectionHint.textContent = 'Draw a free line around the area to keep. Lift your finger to connect the ends.';
  const selectionModes = document.createElement('div');
  selectionModes.className = 'sticker-selection-modes';
  const selectionModeButtons = new Map();
  [['free', 'Free selection'], ['circle', 'Circle'], ['square', 'Square'], ['text', 'Move text']].forEach(([mode, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sticker-secondary-button';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(mode === 'free'));
    button.addEventListener('click', () => {
      selectionMode = mode;
      selectionHint.textContent = mode === 'text'
        ? 'Drag the text on the image to position it.'
        : mode === 'free'
          ? 'Draw a free line around the area to keep. Lift your finger to connect the ends.'
          : 'Draw an area to keep. Everything outside it will be transparent.';
      selectionModeButtons.forEach((modeButton, modeName) => {
        modeButton.classList.toggle('is-active', modeName === mode);
        modeButton.setAttribute('aria-pressed', String(modeName === mode));
      });
      canvas.classList.toggle('is-moving-text', mode === 'text');
    });
    selectionModeButtons.set(mode, button);
    if (mode === 'free') button.classList.add('is-active');
    selectionModes.appendChild(button);
  });
  const clearSelection = document.createElement('button');
  clearSelection.type = 'button';
  clearSelection.className = 'sticker-secondary-button';
  clearSelection.textContent = 'Clear selection';
  clearSelection.disabled = true;
  selectionTools.append(selectionHint, selectionModes, clearSelection);

  const undoButton = document.createElement('button');
  undoButton.type = 'button';
  undoButton.className = 'sticker-secondary-button sticker-undo-button';
  undoButton.textContent = 'Undo';
  undoButton.disabled = true;

  const emojiRow = document.createElement('div');
  emojiRow.className = 'sticker-emoji-controls';
  const emojiHint = document.createElement('span');
  emojiHint.textContent = 'Add emoji (up to 6):';
  const emojiPicker = document.createElement('div');
  emojiPicker.className = 'sticker-editor-emoji-picker';
  const selectedEmojis = document.createElement('div');
  selectedEmojis.className = 'sticker-selected-emojis';
  const emojis = [];
  function renderSelectedEmojis() {
    selectedEmojis.replaceChildren();
    emojis.forEach((emoji, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sticker-emoji-chip';
      chip.textContent = emoji;
      chip.title = 'Remove emoji';
      chip.setAttribute('aria-label', `Remove ${emoji}`);
      chip.addEventListener('click', () => {
        pushUndo();
        emojis.splice(index, 1);
        renderSelectedEmojis();
        render();
      });
      selectedEmojis.appendChild(chip);
    });
  }
  STICKER_EMOJIS.forEach(emoji => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = emoji;
    button.setAttribute('aria-label', `Add ${emoji}`);
    button.addEventListener('click', () => {
      if (emojis.length >= 6) return;
      pushUndo();
      emojis.push(emoji);
      renderSelectedEmojis();
      render();
    });
    emojiPicker.appendChild(button);
  });
  emojiRow.append(emojiHint, emojiPicker, selectedEmojis);

  const actions = document.createElement('div');
  actions.className = 'sticker-editor-actions';
  const backButton = document.createElement('button');
  backButton.type = 'button';
  backButton.className = 'sticker-secondary-button';
  backButton.textContent = 'Back';
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'sticker-save-button';
  saveButton.textContent = 'Save sticker';
  const editorStatus = document.createElement('p');
  editorStatus.className = 'sticker-status';
  editorStatus.setAttribute('role', 'status');
  actions.append(undoButton, backButton, saveButton);
  controls.append(textInput, textColorLabel, selectionTools, emojiRow, actions, editorStatus);
  editor.append(note, canvasWrap, controls);

  let selectionMode = 'free';
  let currentSelection = null;
  let activeSelection = null;
  let activeTextDrag = null;
  let textX = width / 2;
  let textY = height * 0.84;
  let textColor = textColorInput.value;
  const undoStack = [];
  let lastState = null;
  let disposed = false;
  const dispose = () => {
    disposed = true;
    if (source.close) source.close();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  };
  const edited = () => Boolean(currentSelection || textInput.value.trim() || emojis.length);

  function snapshot() {
    return {
      selection: currentSelection ? {
        ...currentSelection,
        start: { ...currentSelection.start },
        end: { ...currentSelection.end },
        points: currentSelection.points.map(point => ({ ...point }))
      } : null,
      text: textInput.value,
      textColor,
      textX,
      textY,
      emojis: [...emojis]
    };
  }

  function pushUndo(state = snapshot()) {
    state = lastState || state;
    undoStack.push(state);
    if (undoStack.length > 30) undoStack.shift();
    undoButton.disabled = false;
  }

  function restore(state) {
    currentSelection = state.selection;
    textInput.value = state.text;
    textColor = state.textColor;
    textColorInput.value = textColor;
    textX = state.textX;
    textY = state.textY;
    emojis.splice(0, emojis.length, ...state.emojis);
    renderSelectedEmojis();
    render();
  }

  function drawSticker(targetContext, showSelection = false) {
    targetContext.clearRect(0, 0, width, height);
    targetContext.globalCompositeOperation = 'source-over';
    targetContext.drawImage(source, 0, 0, width, height);
    const text = textInput.value.trim();
    if (text) {
      const fontSize = Math.max(20, Math.round(width / 13));
      targetContext.font = `800 ${fontSize}px system-ui, sans-serif`;
      targetContext.textAlign = 'center';
      targetContext.textBaseline = 'middle';
      targetContext.lineJoin = 'round';
      targetContext.lineWidth = Math.max(3, fontSize / 8);
      targetContext.strokeStyle = 'rgba(0,0,0,.8)';
      targetContext.fillStyle = textColor;
      targetContext.shadowColor = 'rgba(0,0,0,.7)';
      targetContext.shadowBlur = 5;
      const maxWidth = width - 24;
      let output = text;
      while (targetContext.measureText(output).width > maxWidth && output.length > 1) output = `${output.slice(0, -2)}…`;
      targetContext.strokeText(output, textX, textY, maxWidth);
      targetContext.fillText(output, textX, textY, maxWidth);
      targetContext.shadowBlur = 0;
      if (showSelection || activeTextDrag) {
        const textWidth = Math.min(maxWidth, targetContext.measureText(output).width) + 14;
        const textHeight = fontSize * 1.4;
        targetContext.save();
        targetContext.setLineDash([5, 4]);
        targetContext.lineWidth = Math.max(1, width / 300);
        targetContext.strokeStyle = 'rgba(255,255,255,.8)';
        targetContext.strokeRect(textX - textWidth / 2, textY - textHeight / 2, textWidth, textHeight);
        targetContext.restore();
      }
    }
    emojis.forEach((emoji, index) => {
      targetContext.font = `${Math.max(28, Math.round(Math.min(width, height) / 4))}px system-ui, sans-serif`;
      targetContext.textAlign = 'center';
      targetContext.textBaseline = 'middle';
      const positions = [[.78, .25], [.25, .25], [.75, .7], [.25, .72], [.5, .15], [.5, .78]];
      targetContext.fillText(emoji, width * positions[index][0], height * positions[index][1]);
    });
    if (currentSelection && !activeSelection) {
      targetContext.globalCompositeOperation = 'destination-in';
      targetContext.beginPath();
      traceStickerSelection(targetContext, currentSelection, width, height);
      targetContext.fill();
      targetContext.globalCompositeOperation = 'source-over';
    }
    const previewSelection = activeSelection || currentSelection;
    if (showSelection && previewSelection) {
      targetContext.save();
      targetContext.beginPath();
      const drawingFreeLine = Boolean(activeSelection && activeSelection.mode === 'free');
      traceStickerSelection(targetContext, previewSelection, width, height, !drawingFreeLine);
      if (!drawingFreeLine) {
        targetContext.fillStyle = 'rgba(255, 60, 170, .22)';
        targetContext.fill();
      }
      targetContext.setLineDash([6, 4]);
      targetContext.lineWidth = Math.max(2, width / 180);
      targetContext.strokeStyle = '#ff3caa';
      targetContext.stroke();
      targetContext.restore();
    }
  }

  function render() {
    if (disposed) return;
    drawSticker(context, true);
    clearSelection.disabled = !currentSelection && !activeSelection;
    undoButton.disabled = undoStack.length === 0;
    lastState = snapshot();
  }
  render();

  const selectionPoint = event => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width, (event.clientX - rect.left) * width / rect.width)),
      y: Math.max(0, Math.min(height, (event.clientY - rect.top) * height / rect.height))
    };
  };
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = selectionPoint(event);
    if (selectionMode === 'text') {
      if (!textInput.value.trim()) {
        editorStatus.textContent = 'Write text first, then drag it to position it.';
        return;
      }
      canvas.setPointerCapture(event.pointerId);
      pushUndo();
      activeTextDrag = { start: point, textX, textY };
      render();
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    activeSelection = { mode: selectionMode, start: point, end: point, points: [point] };
    render();
  });
  canvas.addEventListener('pointermove', event => {
    if (activeTextDrag) {
      const point = selectionPoint(event);
      textX = Math.max(0, Math.min(width, activeTextDrag.textX + point.x - activeTextDrag.start.x));
      textY = Math.max(0, Math.min(height, activeTextDrag.textY + point.y - activeTextDrag.start.y));
      render();
      return;
    }
    if (!activeSelection) return;
    const point = selectionPoint(event);
    activeSelection.end = point;
    if (activeSelection.mode === 'free') {
      const last = activeSelection.points[activeSelection.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) >= 2) activeSelection.points.push(point);
    }
    render();
  });
  const finishSelection = event => {
    if (activeTextDrag) {
      if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      activeTextDrag = null;
      render();
      return;
    }
    if (!activeSelection) return;
    if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const selection = activeSelection;
    if (event && selection.mode === 'free') {
      const point = selectionPoint(event);
      const last = selection.points[selection.points.length - 1];
      if (point.x !== last.x || point.y !== last.y) selection.points.push(point);
      selection.end = point;
    }
    activeSelection = null;
    if (selection.mode === 'free' && selection.points.length < 3) {
      render();
      return;
    }
    if (selection.mode !== 'free' && Math.hypot(selection.end.x - selection.start.x, selection.end.y - selection.start.y) < 3) {
      render();
      return;
    }
    pushUndo();
    currentSelection = selection;
    render();
  };
  canvas.addEventListener('pointerup', finishSelection);
  canvas.addEventListener('pointercancel', event => {
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (activeTextDrag) {
      textX = activeTextDrag.textX;
      textY = activeTextDrag.textY;
      activeTextDrag = null;
    }
    activeSelection = null;
    render();
  });
  clearSelection.addEventListener('click', () => {
    if (!currentSelection) return;
    pushUndo();
    currentSelection = null;
    render();
  });
  textInput.addEventListener('input', () => {
    pushUndo();
    editorStatus.textContent = '';
    render();
  });
  textColorInput.addEventListener('input', () => {
    pushUndo();
    textColor = textColorInput.value;
    render();
  });
  undoButton.addEventListener('click', () => {
    const previous = undoStack.pop();
    if (previous) restore(previous);
  });
  backButton.addEventListener('click', () => {
    dispose();
    editor.hidden = true;
    picker.hidden = false;
  });
  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true;
    editorStatus.textContent = 'Saving sticker…';
    try {
      let blob;
      if (!edited()) blob = file;
      else {
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = width;
        exportCanvas.height = height;
        const exportContext = exportCanvas.getContext('2d');
        if (!exportContext) throw new Error('Sticker export is not supported by this browser.');
        drawSticker(exportContext);
        blob = await canvasToBlob(currentSelection ? cropStickerCanvas(exportCanvas, exportContext) : exportCanvas);
      }
      if (blob.size > 10 * 1024 * 1024) throw new Error('The finished sticker must be 10 MB or smaller.');
      await onSave(blob);
      dispose();
    } catch (err) {
      console.error('Could not save sticker:', err);
      editorStatus.textContent = err.message || 'Could not save this sticker.';
      saveButton.disabled = false;
    }
  });
  return dispose;
}

function cropStickerCanvas(canvas, context) {
  const { width, height } = canvas;
  const pixels = context.getImageData(0, 0, width, height).data;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pixels[(y * width + x) * 4 + 3]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left) throw new Error('The selected area is empty. Choose another area.');
  const cropped = document.createElement('canvas');
  cropped.width = right - left + 1;
  cropped.height = bottom - top + 1;
  const croppedContext = cropped.getContext('2d');
  if (!croppedContext) throw new Error('Sticker export is not supported by this browser.');
  croppedContext.drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
  return cropped;
}

function traceStickerSelection(context, selection, width, height, closeFreePath = true) {
  const { start, end, mode } = selection;
  if (mode === 'free') {
    const points = selection.points;
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) {
      context.lineTo(points[index].x, points[index].y);
    }
    if (closeFreePath) context.closePath();
    return;
  }
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const boxWidth = Math.abs(end.x - start.x);
  const boxHeight = Math.abs(end.y - start.y);
  if (mode === 'circle') {
    const centerX = left + boxWidth / 2;
    const centerY = top + boxHeight / 2;
    const radius = Math.min(
      Math.max(boxWidth, boxHeight) / 2,
      centerX,
      width - centerX,
      centerY,
      height - centerY
    );
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  } else {
    const directionX = Math.sign(end.x - start.x) || 1;
    const directionY = Math.sign(end.y - start.y) || 1;
    const side = Math.min(
      Math.max(boxWidth, boxHeight),
      directionX > 0 ? width - start.x : start.x,
      directionY > 0 ? height - start.y : start.y
    );
    context.rect(
      directionX > 0 ? start.x : start.x - side,
      directionY > 0 ? start.y : start.y - side,
      side,
      side
    );
  }
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not export the sticker image.')), 'image/png');
  });
}

async function makeEmojiSticker(emoji) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Sticker creation is not supported by this browser.');
  context.font = '190px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(emoji, 128, 132);
  return canvasToBlob(canvas);
}

function openStickerDatabase() {
  if (!window.indexedDB) return Promise.reject(new Error('Saved stickers are not supported by this browser.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vynzo-stickers', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('stickers')) {
        const store = database.createObjectStore('stickers', { keyPath: 'id' });
        store.createIndex('user_id', 'user_id', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open your saved sticker tray.'));
  });
}

async function getSavedStickers(userId) {
  const database = await openStickerDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction('stickers', 'readonly').objectStore('stickers').index('user_id').getAll(userId);
    request.onsuccess = () => {
      database.close();
      resolve(request.result.sort((a, b) => b.created_at - a.created_at));
    };
    request.onerror = () => {
      database.close();
      reject(new Error('Could not read your saved stickers.'));
    };
  });
}

async function saveSticker(userId, blob, name) {
  const database = await openStickerDatabase();
  const stickers = await getSavedStickers(userId);
  const transaction = database.transaction('stickers', 'readwrite');
  const store = transaction.objectStore('stickers');
  if (stickers.length >= 50) store.delete(stickers[stickers.length - 1].id);
  store.put({ id: crypto.randomUUID(), user_id: userId, name, blob, created_at: Date.now() });
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(new Error('Could not save the sticker.'));
    transaction.onabort = () => reject(new Error('Could not save the sticker.'));
  });
  database.close();
}

async function deleteSavedSticker(userId, stickerId) {
  const database = await openStickerDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction('stickers', 'readwrite');
    const store = transaction.objectStore('stickers');
    const request = store.get(stickerId);
    request.onsuccess = () => {
      if (!request.result || request.result.user_id !== userId) {
        transaction.abort();
        return;
      }
      store.delete(stickerId);
    };
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(new Error('Could not delete the sticker.'));
    transaction.onabort = () => reject(new Error('Sticker not found or could not be deleted.'));
  }).finally(() => database.close());
}

async function sendSticker(sticker, conversationId, currentUser, status) {
  if (!conversationId) throw new Error('Select a conversation before sending a sticker.');
  if (!supabase) throw new Error('Supabase is not configured for sticker uploads.');
  status.hidden = true;
  let pending;
  const reply = replyingTo;
  try {
    const file = sticker.file instanceof File
      ? sticker.file
      : new File([sticker.file], 'sticker.png', { type: sticker.file.type || 'image/png' });
    pending = beginPendingMessage(conversationId, currentUser, { content: STICKER_MESSAGE_CONTENT, file, reply });
    const result = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: await prepareMessageBody(conversationId, {
        content: STICKER_MESSAGE_CONTENT,
        file,
        replyId: reply?.id
      })
    });
    if (currentConversationId === conversationId) {
      const container = document.getElementById('chat-messages-container');
      if (container) appendMessage(container, result.message, currentUser);
      if (replyingTo === reply) {
        replyingTo = null;
        document.getElementById('reply-bar')?.replaceChildren();
        const replyBar = document.getElementById('reply-bar');
        if (replyBar) replyBar.hidden = true;
      }
    }
    notifyPeer(conversationId);
    refreshConversations().catch(err => console.error('Could not refresh conversation preview:', err));
  } catch (err) {
    status.textContent = err.message || 'Could not send this sticker.';
    status.hidden = false;
    throw err;
  } finally {
    endPendingMessage(pending);
  }
}

async function openViewOnce(conversationId, messageId) {
  const blob = await apiBlobRequest(`/messages/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/view-once`, { method: 'POST' });
  const url = URL.createObjectURL(blob);
  const guardOwner = Symbol('view-once');
  setScreenGuard(guardOwner, true).catch(error => console.error('Could not protect view-once media:', error));

  const isVideo = blob.type.startsWith('video/');
  const overlay = document.createElement('div');
  overlay.className = 'view-once-viewer';
  overlay.innerHTML = `
    <div class="view-once-stage">${isVideo
      ? '<video playsinline autoplay controls controlsList="nodownload noplaybackrate noremoteplayback" disablePictureInPicture disableRemotePlayback draggable="false"></video>'
      : '<img alt="View-once photo" draggable="false">'}<div class="view-once-mark"></div></div>
    <p class="view-once-note">View once · this ${isVideo ? 'video' : 'photo'} disappears when you close it</p>
    <button type="button" class="view-once-close">Close</button>`;
  const img = overlay.querySelector('img, video');
  img.src = url;
  const me = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  overlay.querySelector('.view-once-mark').textContent = Array(40).fill(`@${me.username || 'vynzo'}`).join('   ');

  const hide = () => { overlay.classList.add('hidden-content'); if (isVideo) img.pause(); };
  const show = () => { if (document.visibilityState === 'visible') overlay.classList.remove('hidden-content'); };
  const block = e => e.preventDefault();
  const onKey = e => {
    if (e.key === 'PrintScreen' || e.key === 'Meta' || (e.ctrlKey && ['p', 's'].includes(e.key.toLowerCase()))) {
      e.preventDefault();
      hide();
      navigator.clipboard?.writeText?.('').catch(() => {});
    }
    if (e.key === 'Escape') close();
  };
  function close() {
    window.removeEventListener('blur', hide);
    window.removeEventListener('focus', show);
    document.removeEventListener('visibilitychange', hide);
    document.removeEventListener('keydown', onKey, true);
    img.removeAttribute('src');
    URL.revokeObjectURL(url);
    overlay.remove();
    setScreenGuard(guardOwner, false).catch(error => console.error('Could not release view-once protection:', error));
  }
  overlay.addEventListener('contextmenu', block);
  overlay.addEventListener('dragstart', block);
  overlay.querySelector('.view-once-close').addEventListener('click', close);
  window.addEventListener('blur', hide);
  window.addEventListener('focus', show);
  document.addEventListener('visibilitychange', hide);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
}

function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.preload = 'metadata';
    video.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(video.duration); };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read this video.')); };
    video.src = url;
  });
}

function avatarMarkup(url, name, className) {
  const initial = escapeHtml((name || '?').replace(/^@/, '').charAt(0).toUpperCase() || '?');
  if (!url) return `<span class="${className}">${initial}</span>`;
  const src = /^https?:/i.test(url) ? url : `${API_ORIGIN}${url}`;
  return `<span class="${className}"><img src="${escapeHtml(src)}" alt="" data-initial="${initial}"></span>`;
}

document.addEventListener('error', (event) => {
  const img = event.target;
  const latest = latestMessageMediaSources.get(img);
  if (latest && img.getAttribute('src') !== latest) {
    img.src = latest;
    return;
  }
  if (!(img instanceof HTMLImageElement) || !img.dataset.initial) return;
  img.parentElement.textContent = img.dataset.initial;
}, true);

function getConversationName(conversation) {
  return conversation.group_name
    || conversation.other_display_name
    || (conversation.other_username ? `@${conversation.other_username}` : 'Direct Message');
}

function showChatError(message) {
  const chatArea = document.getElementById('chat-area');
  if (!chatArea) return;

  const status = document.createElement('p');
  status.className = 'chat-empty-state';
  status.textContent = message;
  chatArea.replaceChildren(status);
}

function showConversationError(message, onRetry, keepSaved = false) {
  const container = document.getElementById('conversations-list');
  if (!container) return;

  const status = document.createElement('p');
  status.className = 'conversations-error';
  status.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Try again';
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    retry.textContent = 'Retrying...';
    await onRetry();
  });
  container.querySelectorAll('.conversations-error, .conversations-retry').forEach(node => node.remove());
  retry.className = 'conversations-retry';
  if (keepSaved) container.append(status, retry);
  else container.replaceChildren(status, retry);
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

// Custom voice-message player: no native menu, so no download option.
(() => {
  const fmt = s => (isFinite(s) && s >= 0) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';
  let current = null;
  let context = null;
  let warnedAboutVolume = false;
  function audioFor(player) {
    if (player._audio) return player._audio;
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.crossOrigin = 'anonymous';
    audio.src = player.dataset.src;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      if (!context) context = new AudioContext();
      const source = context.createMediaElementSource(audio);
      const gain = context.createGain();
      gain.gain.value = 1.8;
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.knee.value = 12;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.2;
      source.connect(gain).connect(compressor).connect(context.destination);
    } else if (!warnedAboutVolume) {
      warnedAboutVolume = true;
      console.warn('Voice volume enhancement is unavailable; using normal playback volume.');
    }
    const btn = player.querySelector('.voice-play');
    const seek = player.querySelector('.voice-seek');
    const time = player.querySelector('.voice-time');
    let seeking = false;
    const update = () => {
      const d = isFinite(audio.duration) ? audio.duration : 0;
      if (!seeking) seek.value = d ? (audio.currentTime / d) * 100 : 0;
      time.textContent = audio.paused && !audio.currentTime && d ? fmt(d) : fmt(audio.currentTime);
    };
    audio.addEventListener('loadedmetadata', () => {
      if (audio.duration === Infinity) {
        audio.currentTime = 1e101;
        audio.addEventListener('timeupdate', function fix() {
          audio.removeEventListener('timeupdate', fix);
          audio.currentTime = 0;
        });
      }
      update();
    });
    audio.addEventListener('timeupdate', update);
    audio.addEventListener('play', () => { btn.textContent = '⏸'; });
    audio.addEventListener('pause', () => { btn.textContent = '▶'; });
    audio.addEventListener('ended', () => { btn.textContent = '▶'; audio.currentTime = 0; update(); });
    audio.addEventListener('error', () => {
      if (audio.src !== player.dataset.src) {
        audio.src = player.dataset.src;
        return;
      }
      time.textContent = 'Unavailable';
    });
    seek.addEventListener('input', () => {
      seeking = true;
      if (isFinite(audio.duration)) audio.currentTime = (seek.value / 100) * audio.duration;
    });
    seek.addEventListener('change', () => { seeking = false; });
    player._audio = audio;
    return audio;
  }
  document.addEventListener('click', async event => {
    const btn = event.target.closest('.voice-play');
    if (!btn) return;
    const player = btn.closest('.voice-player');
    try {
      const audio = audioFor(player);
      if (audio.paused) {
        if (current && current !== audio) current.pause();
        current = audio;
        if (context?.state === 'suspended') await context.resume();
        if (current !== audio) return;
        await audio.play();
      } else {
        audio.pause();
      }
    } catch (error) {
      console.error('Could not play voice message:', error);
      player.querySelector('.voice-time').textContent = 'Tap to retry';
      btn.textContent = '▶';
    }
  });
  document.addEventListener('contextmenu', event => {
    if (event.target.closest('.voice-player')) event.preventDefault();
  });
})();