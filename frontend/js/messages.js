import { apiRequest, apiBlobRequest } from './api.js?v=sb6';
import { API_ORIGIN } from './config.js?v=sb4';
import { supabase } from './supabase-client.js';
import { createRealtimeSocket } from './realtime.js?v=sb4';
import { attachEmojiPicker } from './emoji-picker.js?v=scope4';
import { initCalls, startCall } from './calls.js?v=sb4';

let socket = null;
let currentConversationMeta = null;
let currentConversationId = null;
let conversationMembers = [];
let replyingTo = null;
let conversationRefreshInterval = null;
let backgroundRefreshInProgress = false;
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
      showConversationError(err.message || 'Could not load your conversations.', retryConversationLoad);
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
    showConversationError(err.message || 'Could not load your conversations.', retryConversationLoad);
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
  conversationMembers = data.members || conversationMembers;

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
          <button type="button" class="chat-call-btn" id="hide-sender-btn" aria-label="Delete a person's messages" title="Delete a person's messages (for you)">🙈</button>
          <button type="button" class="chat-call-btn" id="clear-chat-btn" aria-label="Clear chat" title="Clear chat">🧹</button>
          <button type="button" class="chat-call-btn" id="delete-chat-btn" aria-label="Delete conversation" title="Delete conversation">🗑</button>
        </div>
      ` : `
        <div class="chat-call-actions">
          <button type="button" class="chat-call-btn" id="hide-sender-btn" aria-label="Delete a person's messages" title="Delete a person's messages (for you)">🙈</button>
          <button type="button" class="chat-call-btn" id="clear-chat-btn" aria-label="Clear chat" title="Clear chat">🧹</button>
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
      <input type="file" id="chat-camera-input" accept="image/*" capture="environment" hidden>
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
  const cameraInput = document.getElementById('chat-camera-input');
  document.getElementById('camera-btn').addEventListener('click', () => {
    if (window.matchMedia('(pointer: coarse)').matches || !navigator.mediaDevices?.getUserMedia) cameraInput.click();
    else openCameraCapture(file => useFile(file), message => {
      status.textContent = message;
      status.hidden = false;
    });
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
  async function useFile(file) {
    status.hidden = true;
    try {
      if (!file.type) {
        const guessed = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[(file.name.split('.').pop() || '').toLowerCase()];
        if (guessed) file = new File([file], file.name, { type: guessed });
      }
      if (file.type.startsWith('video/')) {
        const duration = await getVideoDuration(file).catch(() => null);
        if (duration && duration > MAX_VIDEO_SECONDS + 0.5) {
          throw new Error(`Videos can be at most ${MAX_VIDEO_SECONDS} seconds. This one is ${Math.round(duration)} seconds.`);
        }
        if (file.size > 50 * 1024 * 1024) throw new Error('This video is larger than 50 MB. Choose a shorter one.');
      } else if (file.size > 50 * 1024 * 1024) {
        throw new Error('File is too large (max 50MB).');
      }
      if (file.type.startsWith('image/') && file.type !== 'image/gif') file = await shrinkImage(file);
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
    } catch (err) {
      clearAttachment();
      status.textContent = err.message || 'Could not use this file.';
      status.hidden = false;
    }
  }

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
    if (attachment) {
      const kind = attachment.type.startsWith('video/') ? 'video' : 'photo';
      const mb = (attachment.size / (1024 * 1024)).toFixed(1);
      const target = currentConversationMeta ? getConversationName(currentConversationMeta) : 'this chat';
      if (!window.confirm(`Send this ${kind} (${mb} MB) to ${target}?${viewOnce ? '\nIt can be viewed only once.' : ''}`)) return;
    }

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
      const replyId = replyingTo?.id;
      if (attachment) {
        const upload = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/upload-url`, {
          method: 'POST',
          body: JSON.stringify({ content_type: attachment.type })
        });
        const { error: uploadError } = await supabase.storage.from('uploads')
          .uploadToSignedUrl(upload.path, upload.token, attachment, { contentType: attachment.type });
        if (uploadError) throw new Error(`Upload failed: ${uploadError.message || 'please check your connection and try again.'}`);
        body = JSON.stringify({ content, reply_to_id: replyId, media_path: upload.path });
      } else {
        body = JSON.stringify({ content, reply_to_id: replyId });
      }
      const result = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        body
      });
      if (currentConversationId === conversationId) {
        appendMessage(msgContainer, result.message, currentUser);
        input.value = '';
        clearAttachment();
        replyingTo = null;
        renderReplyBar();
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
    msgContainer.querySelector(`[data-message-id="${event.message_id}"]`)?.closest('.message-row')?.remove();
    refreshConversations().catch(err => {
      console.error('Could not refresh conversation preview:', err);
    });
  });
}

// Desktop camera: live preview in an overlay, returns the captured frame as a JPEG File.
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
  bar.style.cssText = 'display:flex;gap:12px';
  const shoot = document.createElement('button');
  shoot.type = 'button';
  shoot.textContent = '📸 Take photo';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  [shoot, cancel].forEach(b => { b.style.cssText = 'padding:10px 18px;border-radius:999px;border:0;font:inherit;cursor:pointer'; });
  const close = () => {
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
  bar.append(shoot, cancel);
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
      <div class="message-bubble ${isOutgoing ? 'outgoing' : 'incoming'}" data-message-id="${escapeHtml(message.id)}" data-reply-text="${escapeHtml(replyText(message))}" data-created-at="${escapeHtml(String(message.created_at || ''))}">
        ${replyQuoteMarkup(message.reply_to)}
        ${mediaMarkup(message)}
        ${message.view_once ? viewOnceMarkup(message, isOutgoing) : ''}
        ${message.content ? `<span class="message-content">${escapeHtml(message.content)}</span>` : ''}
        ${message.edited_at ? '<span class="message-edited">(edited)</span>' : ''}
        <button class="message-reply-button" type="button" aria-label="Reply to this message" title="Reply">↩</button>
        ${isOutgoing && message.content && !message.view_once && message.can_unsend !== false ? '<button class="message-edit-button" type="button" aria-label="Edit message" title="Edit message">✎</button>' : ''}
        ${isOutgoing && message.can_unsend !== false ? '<button class="message-delete-button" type="button" aria-label="Delete message" title="Delete for everyone (only until it is seen)">×</button>' : ''}
        ${isOutgoing && readReceiptsEnabled ? `<span class="message-status ${message.seen ? 'seen' : ''}">${message.seen ? 'Seen' : 'Sent'}</span>` : ''}
      </div>
    </div>
  `;
}

// Phone photos are often 5 MB+; resizing keeps uploads quick on mobile data.
async function shrinkImage(file) {
  if (file.size <= 300 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

function replyText(message) {
  if (message.view_once) return '📷 View-once photo';
  const text = message.content || (message.media_url ? '📎 Photo / video' : '');
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
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

function showConversationError(message, onRetry) {
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
  container.replaceChildren(status, retry);
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}