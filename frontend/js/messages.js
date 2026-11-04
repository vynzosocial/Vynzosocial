import { apiRequest, apiBlobRequest } from './api.js?v=sb3';
import { API_ORIGIN } from './config.js?v=sb3';
import { createRealtimeSocket } from './realtime.js?v=sb3';
import { attachEmojiPicker } from './emoji-picker.js?v=scope4';
import { initCalls, startCall } from './calls.js?v=sb3';

let socket = null;
let currentConversationMeta = null;
let currentConversationId = null;
let conversationRefreshInterval = null;
let readReceiptsEnabled = true;
const MAX_VIDEO_SECONDS = 60;

export async function initMessaging() {
  const container = document.getElementById('conversations-list');
  if (!container) return;

  const currentUser = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  if (!currentUser.id) {
    container.innerHTML = '<p style="padding:16px; color:var(--text-muted);">Please login to view messages.</p>';
    return;
  }

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
  }

  if (!conversationRefreshInterval) {
    conversationRefreshInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshConversations().catch(err => {
          console.error('Failed to refresh conversations:', err);
        });
        refreshCurrentConversation().catch(err => {
          console.error('Failed to refresh messages:', err);
        });
      }
    }, 5000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        refreshConversations().catch(err => {
          console.error('Failed to refresh conversations:', err);
        });
        refreshCurrentConversation().catch(err => {
          console.error('Failed to refresh messages:', err);
        });
      }
    });
  }
}

async function refreshCurrentConversation() {
  const conversationId = currentConversationId;
  const container = document.getElementById('chat-messages-container');
  if (!conversationId || !container) return;

  const data = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/messages`);
  if (currentConversationId !== conversationId) return;

  const currentUser = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  const existingIds = new Set(
    [...container.querySelectorAll('.message-bubble')].map(bubble => bubble.dataset.messageId)
  );
  const hasNewIncoming = data.messages.some(message =>
    message.sender_id !== currentUser.id && !existingIds.has(message.id)
  );
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  readReceiptsEnabled = data.read_receipts !== false;

  const fragment = document.createDocumentFragment();
  for (const message of data.messages) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = messageMarkup(message, currentUser);
    fragment.appendChild(wrapper.firstElementChild);
  }
  container.replaceChildren(fragment);
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
  if (hasNewIncoming && document.visibilityState === 'visible') markConversationRead(conversationId);
}

async function refreshConversations() {
  const data = await apiRequest('/messages');
  const currentUser = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  renderConversations(data.conversations, currentUser);
  return data.conversations;
}

function renderConversations(conversations, currentUser) {
  const container = document.getElementById('conversations-list');
  if (!container) return;

  if (conversations.length === 0) {
    container.innerHTML = '<p style="padding:16px; color:var(--text-muted);">No messages yet.</p>';
    return;
  }

  container.innerHTML = '';
  conversations.forEach(conv => {
    const item = document.createElement('div');
    item.className = 'conversation-item';
    item.dataset.conversationId = conv.id;
    const conversationName = getConversationName(conv);
    item.innerHTML = `
      ${avatarMarkup(conv.other_avatar_url, conversationName, 'author-avatar')}
      <div>
        <div style="font-weight:600;">${escapeHtml(conversationName)}</div>
        <div style="font-size:12px; color:var(--text-muted);">${escapeHtml(conv.last_message ? (conv.last_message.content || (conv.last_message.view_once ? '📷 View-once photo' : conv.last_message.media_url ? '📎 Photo / video' : 'No messages')) : 'No messages')}</div>
      </div>
    `;
    item.classList.toggle('active', conv.id === currentConversationId);

    item.addEventListener('click', () => {
      selectConversation(conv, currentUser);
    });

    container.appendChild(item);
  });
}

function selectConversation(conversation, currentUser) {
  currentConversationMeta = conversation;
  document.querySelectorAll('.conversation-item').forEach(item => {
    item.classList.toggle('active', item.dataset.conversationId === conversation.id);
  });
  return loadConversation(conversation.id, currentUser, getConversationName(conversation), conversation.other_avatar_url);
}

async function loadConversation(conversationId, currentUser, conversationName = 'Conversation', avatarUrl = '') {
  currentConversationId = conversationId;
  if (socket.connected) joinConversation(conversationId);

  const chatArea = document.getElementById('chat-area');
  try {
    const data = await apiRequest(`/messages/${conversationId}/messages`);
    readReceiptsEnabled = data.read_receipts !== false;
    renderChatWindow(chatArea, data.messages, currentUser, conversationName, avatarUrl);
    markConversationRead(conversationId);
  } catch (err) {
    console.error('Failed to load messages:', err);
    showChatError(err.message || 'Could not load this conversation. Please try again.');
  }
}

function notifyPeer(conversationId) {
  const peerId = currentConversationMeta?.other_user_id;
  if (peerId && socket) socket.emit('notify_peer', { userId: peerId, conversation_id: conversationId });
}

function markConversationRead(conversationId) {
  apiRequest(`/messages/${encodeURIComponent(conversationId)}/read`, { method: 'POST' }).then(() => notifyPeer(conversationId)).catch(err => {
    console.error('Could not mark conversation as read:', err);
  });
}

function renderChatWindow(chatArea, messages, currentUser, conversationName, avatarUrl = '') {
  chatArea.innerHTML = `
    <div class="chat-header">
      ${avatarMarkup(avatarUrl, conversationName, 'chat-header-avatar')}
      <div>
        <strong>${escapeHtml(conversationName)}</strong>
        <span class="chat-header-subtitle">A little more connection</span>
      </div>
      ${currentConversationMeta && !currentConversationMeta.is_group ? `
        <div class="chat-call-actions">
          <button type="button" class="chat-call-btn" id="voice-call-btn" aria-label="Voice call" title="Voice call">📞</button>
          <button type="button" class="chat-call-btn" id="video-call-btn" aria-label="Video call" title="Video call">🎥</button>
          <button type="button" class="chat-call-btn" id="clear-chat-btn" aria-label="Clear chat" title="Clear chat">🗑</button>
        </div>
      ` : `
        <div class="chat-call-actions">
          <button type="button" class="chat-call-btn" id="clear-chat-btn" aria-label="Clear chat" title="Clear chat">🗑</button>
        </div>
      `}
    </div>
    <div class="chat-messages" id="chat-messages-container">
      ${messages.map(m => messageMarkup(m, currentUser)).join('')}
    </div>
    <form class="chat-input-form" id="chat-form">
      <div class="chat-attachment-preview" id="chat-attachment-preview" hidden></div>
      <button class="attach-btn" type="button" id="attach-btn" aria-label="Attach photo or video" title="Photo or video (video up to 60 seconds)">📎</button>
      <input type="file" id="chat-file-input" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" hidden>
      <input type="text" class="chat-input" id="chat-input-field" placeholder="Type a message..." autocomplete="off">
      <button type="submit" class="send-btn"><span>Send</span><span aria-hidden="true">➤</span></button>
    </form>
    <p class="chat-send-status" id="chat-send-status" role="status" aria-live="polite" hidden></p>
  `;

  const msgContainer = document.getElementById('chat-messages-container');
  msgContainer.scrollTop = msgContainer.scrollHeight;

  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input-field');
  const status = document.getElementById('chat-send-status');
  const fileInput = document.getElementById('chat-file-input');
  const preview = document.getElementById('chat-attachment-preview');
  let attachment = null;
  let viewOnce = false;
  attachEmojiPicker(form, input);

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
    attachment = null;
    viewOnce = false;
    fileInput.value = '';
    preview.replaceChildren();
    preview.hidden = true;
  };


  msgContainer.addEventListener('click', async event => {
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
      open.replaceWith(Object.assign(document.createElement('span'), { className: 'view-once-chip opened', textContent: '📷 Photo · Opened' }));
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
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    status.hidden = true;
    try {
      if (file.type.startsWith('video/')) {
        const duration = await getVideoDuration(file);
        if (duration > MAX_VIDEO_SECONDS + 0.5) {
          throw new Error(`Videos can be at most ${MAX_VIDEO_SECONDS} seconds. This one is ${Math.round(duration)} seconds.`);
        }
      } else if (file.size > 50 * 1024 * 1024) {
        throw new Error('File is too large (max 50MB).');
      }
      attachment = file;
      preview.replaceChildren();
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
      if (!file.type.startsWith('video/') && file.size <= 10 * 1024 * 1024) {
        const label = document.createElement('label');
        label.className = 'view-once-toggle';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.addEventListener('change', () => { viewOnce = box.checked; });
        label.append(box, document.createTextNode(' 👁 View once'));
        preview.append(label);
      }
      preview.hidden = false;
    } catch (err) {
      clearAttachment();
      status.textContent = err.message || 'Could not use this file.';
      status.hidden = false;
    }
  });

  document.getElementById('clear-chat-btn').addEventListener('click', async () => {
    const conversationId = currentConversationId;
    if (!window.confirm('Clear this chat? Messages will be removed for you only; the other person keeps their copy.')) return;
    status.hidden = true;
    try {
      await apiRequest(`/messages/${encodeURIComponent(conversationId)}/messages`, { method: 'DELETE' });
      if (currentConversationId === conversationId) msgContainer.replaceChildren();
      refreshConversations().catch(err => {
        console.error('Could not refresh conversation preview:', err);
      });
    } catch (err) {
      console.error('Could not clear chat:', err);
      status.textContent = err.message || 'Could not clear this chat. Please try again.';
      status.hidden = false;
    }
  });

  input.addEventListener('input', () => {
    status.hidden = true;
  });

  msgContainer.addEventListener('click', async event => {
    const button = event.target.closest('.message-delete-button');
    if (!button) return;

    const bubble = button.closest('.message-bubble');
    const messageId = bubble.dataset.messageId;
    const conversationId = currentConversationId;
    if (!window.confirm('Delete this message for everyone?')) return;

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
    const content = input.value.trim();
    if (!content && !attachment) return;

    const conversationId = currentConversationId;
    const sendButton = form.querySelector('.send-btn');
    sendButton.disabled = true;
    status.hidden = true;
    try {
      if (attachment && viewOnce) {
        const photoBody = new FormData();
        photoBody.append('photo', attachment);
        const sent = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/view-once`, { method: 'POST', body: photoBody });
        if (currentConversationId === conversationId) appendMessage(msgContainer, sent.message, currentUser);
        attachment = null;
        viewOnce = false;
        if (content) {
          const text = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/messages`, {
            method: 'POST',
            body: JSON.stringify({ content })
          });
          if (currentConversationId === conversationId) appendMessage(msgContainer, text.message, currentUser);
        }
        if (currentConversationId === conversationId) {
          input.value = '';
          clearAttachment();
        }
        notifyPeer(conversationId);
        refreshConversations().catch(() => {});
        return;
      }
      let body;
      if (attachment) {
        body = new FormData();
        body.append('media', attachment);
        body.append('content', content);
      } else {
        body = JSON.stringify({ content });
      }
      const result = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        body
      });
      if (currentConversationId === conversationId) {
        appendMessage(msgContainer, result.message, currentUser);
        input.value = '';
        clearAttachment();
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
      sendButton.disabled = false;
    }
  });

  // Listen for live incoming messages if not already attached
  socket.off('receive_message');
  socket.on('receive_message', (msg) => {
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
      if (new Date(bubble.dataset.createdAt).getTime() > readAt) return;
      bubble.querySelector('.message-delete-button')?.remove();
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
    msgContainer.querySelector(`[data-message-id="${event.message_id}"]`)?.closest('.message-row')?.remove();
    refreshConversations().catch(err => {
      console.error('Could not refresh conversation preview:', err);
    });
  });
}

function joinConversation(conversationId) {
  socket.timeout(5000).emit('join_conversation', conversationId, (err, response) => {
    if (err || !response || !response.ok) {
      console.error('Could not join conversation:', err || response?.error);
    }
  });
}

function appendMessage(container, message, currentUser) {
  if (container.querySelector(`[data-message-id="${message.id}"]`)) return;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = messageMarkup(message, currentUser);
  const bubble = wrapper.firstElementChild;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function messageMarkup(message, currentUser) {
  const isOutgoing = message.sender_id === currentUser.id;
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
      <div class="message-bubble ${isOutgoing ? 'outgoing' : 'incoming'}" data-message-id="${escapeHtml(message.id)}" data-created-at="${escapeHtml(String(message.created_at || ''))}">
        ${mediaMarkup(message)}
        ${message.view_once ? viewOnceMarkup(message, isOutgoing) : ''}
        ${message.content ? `<span class="message-content">${escapeHtml(message.content)}</span>` : ''}
        ${isOutgoing && message.can_unsend !== false ? '<button class="message-delete-button" type="button" aria-label="Delete message" title="Delete for everyone (only until it is seen)">×</button>' : ''}
        ${isOutgoing && readReceiptsEnabled ? `<span class="message-status ${message.seen ? 'seen' : ''}">${message.seen ? 'Seen' : 'Sent'}</span>` : ''}
      </div>
    </div>
  `;
}

function viewOnceMarkup(message, isOutgoing) {
  if (message.viewed_at) return '<span class="view-once-chip opened">📷 Photo · Opened</span>';
  if (isOutgoing) return '<span class="view-once-chip">📷 Photo · view once</span>';
  return '<button type="button" class="view-once-chip view-once-open">📷 Photo · tap to view once</button>';
}

function mediaMarkup(message) {
  if (message.view_once) return '';
  if (!message.media_url) return '';
  const src = /^https?:/i.test(message.media_url) ? message.media_url : `${API_ORIGIN}${message.media_url}`;
  if (/\.(mp4|webm|mov)$/i.test(message.media_url)) {
    return `<video class="message-media" src="${escapeHtml(src)}" controls preload="metadata" playsinline></video>`;
  }
  return `<a href="${escapeHtml(src)}" target="_blank" rel="noopener"><img class="message-media" src="${escapeHtml(src)}" alt="Shared photo"></a>`;
}

async function openViewOnce(conversationId, messageId) {
  const blob = await apiBlobRequest(`/messages/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/view-once`, { method: 'POST' });
  const url = URL.createObjectURL(blob);
  const guard = window.Capacitor?.Plugins?.ScreenGuard;
  guard?.setSecure?.({ enabled: true }).catch?.(() => {});

  const overlay = document.createElement('div');
  overlay.className = 'view-once-viewer';
  overlay.innerHTML = `
    <div class="view-once-stage"><img alt="View-once photo" draggable="false"><div class="view-once-mark"></div></div>
    <p class="view-once-note">View once · this photo disappears when you close it</p>
    <button type="button" class="view-once-close">Close</button>`;
  const img = overlay.querySelector('img');
  img.src = url;
  const me = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  overlay.querySelector('.view-once-mark').textContent = Array(40).fill(`@${me.username || 'vynzo'}`).join('   ');

  const hide = () => overlay.classList.add('hidden-content');
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
    guard?.setSecure?.({ enabled: false }).catch?.(() => {});
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

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}