import { apiRequest, apiBlobRequest } from './api.js?v=sb6';
import { API_ORIGIN } from './config.js?v=sb4';
import { supabase } from './supabase-client.js';
import { createRealtimeSocket } from './realtime.js?v=sb9';
import { attachEmojiPicker } from './emoji-picker.js?v=scope4';
import { initCalls, startCall } from './calls.js?v=sb5';

let socket = null;
let currentConversationMeta = null;
let currentConversationId = null;
let conversationMembers = [];
let replyingTo = null;
let conversationRefreshInterval = null;
let backgroundRefreshInProgress = false;
let readReceiptsEnabled = true;
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

  const unreadOf = conv => (conv.id === currentConversationId ? 0 : (conv.unread_count || 0));
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

  container.innerHTML = '';
  conversations.forEach(conv => {
    const item = document.createElement('div');
    item.className = 'conversation-item';
    item.dataset.conversationId = conv.id;
    const conversationName = getConversationName(conv);
    const unread = unreadOf(conv);
    item.innerHTML = `
      ${avatarMarkup(conv.other_avatar_url, conversationName, 'author-avatar')}
      <div>
        <div style="font-weight:${unread ? 800 : 600};">${escapeHtml(conversationName)}</div>
        <div style="font-size:12px; color:var(--text-muted);">${escapeHtml(conv.last_message ? messagePreview(conv.last_message) : 'No messages')}</div>
      </div>
      ${unread ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
    `;
    item.classList.toggle('active', conv.id === currentConversationId);

    item.addEventListener('click', () => {
      selectConversation(conv, currentUser);
    });

    container.appendChild(item);
  });
}

const mobileChatQuery = window.matchMedia('(max-width: 700px)');

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

window.addEventListener('popstate', () => {
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
  const peerId = currentConversationMeta?.other_user_id;
  if (peerId && socket) socket.emit('notify_peer', { userId: peerId, conversation_id: conversationId });
}

function markConversationRead(conversationId) {
  apiRequest(`/messages/${encodeURIComponent(conversationId)}/read`, { method: 'POST' }).then(() => { notifyPeer(conversationId); refreshConversations().catch(() => {}); }).catch(err => {
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
  const voiceButton = document.getElementById('voice-btn');
  let recorder = null;
  let recordTimer = null;
  let recordStarted = 0;
  const stopTracks = stream => stream.getTracks().forEach(track => track.stop());

  function showAudioPreview(file) {
    attachment = file;
    viewOnce = false;
    preview.replaceChildren();
    const audio = document.createElement('audio');
    audio.src = URL.createObjectURL(file);
    audio.controls = true;
    audio.controlsList = 'nodownload noplaybackrate';
    audio.addEventListener('contextmenu', e => e.preventDefault());
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove voice message');
    remove.addEventListener('click', clearAttachment);
    preview.append(audio, remove);
    preview.hidden = false;
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      status.textContent = 'Microphone access was denied. Allow the microphone to record voice messages.';
      status.hidden = false;
      return;
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg']
      .find(type => MediaRecorder.isTypeSupported(type));
    const chunks = [];
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
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
      if (!blob.size || seconds < 0.7) return;
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
    const content = input.value.trim();
    if (!content && !attachment) return;
    if (attachment) {
      const isVoice = attachment.type.startsWith('audio/');
      const kind = isVoice ? 'voice message' : attachment.type.startsWith('video/') ? 'video' : 'photo';
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
  const isSticker = message.content === STICKER_MESSAGE_CONTENT;
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
        ${message.content && !isSticker ? `<span class="message-content">${escapeHtml(message.content)}</span>` : ''}
        ${message.edited_at ? '<span class="message-edited">(edited)</span>' : ''}
        <button class="message-reply-button" type="button" aria-label="Reply to this message" title="Reply">↩</button>
        ${isOutgoing && message.content && !isSticker && !message.view_once && message.can_unsend !== false ? '<button class="message-edit-button" type="button" aria-label="Edit message" title="Edit message">✎</button>' : ''}
        ${isOutgoing ? `<button class="message-delete-button" type="button" aria-label="Delete message" title="${message.can_unsend === false && !message.view_once ? 'Delete for me (already seen)' : 'Delete for everyone (only until it is seen)'}">×</button>` : ''}
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
  if (message.content === STICKER_MESSAGE_CONTENT) return '✨ Sticker';
  const text = message.content || (message.media_url ? (VOICE_PATTERN.test(message.media_url) ? '🎤 Voice message' : '📎 Photo / video') : '');
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

function messagePreview(message) {
  if (message.content === STICKER_MESSAGE_CONTENT) return '✨ Sticker';
  return message.content || (message.view_once ? '📷 View-once photo' : message.media_url ? (VOICE_PATTERN.test(message.media_url) ? '🎤 Voice message' : '📎 Photo / video') : 'No messages');
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
  if (VOICE_PATTERN.test(message.media_url)) {
    return `<div class="voice-player" data-src="${escapeHtml(src)}"><button type="button" class="voice-play" aria-label="Play voice message">▶</button><input class="voice-seek" type="range" min="0" max="100" value="0" step="0.1" aria-label="Seek"><span class="voice-time">0:00</span></div>`;
  }
  if (/\.(mp4|webm|mov)$/i.test(message.media_url)) {
    return `<video class="message-media" src="${escapeHtml(src)}" controls preload="metadata" playsinline></video>`;
  }
  const isSticker = message.content === STICKER_MESSAGE_CONTENT;
  return `<a${isSticker ? ' class="sticker-media-link"' : ''} href="${escapeHtml(src)}" target="_blank" rel="noopener"><img class="message-media${isSticker ? ' sticker-media' : ''}" src="${escapeHtml(src)}" alt="${isSticker ? 'Sticker' : 'Shared photo'}"></a>`;
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
  const createButton = document.createElement('button');
  createButton.type = 'button';
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
  fileInput.accept = 'image/jpeg,image/png,image/gif';
  fileInput.hidden = true;
  const grid = document.createElement('div');
  grid.className = 'sticker-grid';
  const status = document.createElement('p');
  status.className = 'sticker-status';
  status.setAttribute('role', 'status');
  picker.append(pickerActions, fileInput, grid, status);

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

  const send = async sticker => {
    status.textContent = '';
    createButton.disabled = true;
    for (const button of grid.querySelectorAll('button')) button.disabled = true;
    try {
      await onSelect(sticker);
      close();
    } catch (err) {
      console.error('Could not send sticker:', err);
      status.textContent = err.message || 'Could not send the sticker. Please try again.';
      createButton.disabled = false;
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
  createButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/gif'].includes(file.type)) {
      status.textContent = 'Choose a JPG, PNG, or GIF image.';
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      status.textContent = 'Sticker images must be 10 MB or smaller.';
      return;
    }
    try {
      disposeEditor?.();
      disposeEditor = await showStickerEditor(editor, picker, file, async blob => {
        await saveSticker(userId, blob, file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Custom sticker');
        editor.hidden = true;
        picker.hidden = false;
        disposeEditor = null;
        status.textContent = 'Sticker saved. Tap it to send.';
        await renderGrid();
      });
    } catch (err) {
      console.error('Could not open sticker editor:', err);
      status.textContent = err.message || 'Could not open this image.';
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
  if (!context) throw new Error('Sticker editor is not supported by this browser.');

  const note = document.createElement('p');
  note.className = 'sticker-editor-note';
  note.textContent = file.type === 'image/gif'
    ? 'GIF preview shows its first frame. If you edit it, the saved sticker will be a PNG.'
    : 'Edit your image, then save it to your sticker tray.';
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

  const selectionTools = document.createElement('div');
  selectionTools.className = 'sticker-selection-tools';
  const selectionHint = document.createElement('span');
  selectionHint.textContent = 'Draw an area to keep. Everything outside it will be transparent.';
  const selectionModes = document.createElement('div');
  selectionModes.className = 'sticker-selection-modes';
  const selectionModeButtons = new Map();
  [['free', 'Free selection'], ['circle', 'Circle'], ['square', 'Square']].forEach(([mode, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sticker-secondary-button';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(mode === 'free'));
    button.addEventListener('click', () => {
      selectionMode = mode;
      selectionModeButtons.forEach((modeButton, modeName) => {
        modeButton.classList.toggle('is-active', modeName === mode);
        modeButton.setAttribute('aria-pressed', String(modeName === mode));
      });
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

  const emojiRow = document.createElement('div');
  emojiRow.className = 'sticker-emoji-controls';
  const emojiHint = document.createElement('span');
  emojiHint.textContent = 'Add emoji (up to 6):';
  const emojiPicker = document.createElement('div');
  emojiPicker.className = 'sticker-editor-emoji-picker';
  const selectedEmojis = document.createElement('div');
  selectedEmojis.className = 'sticker-selected-emojis';
  const emojis = [];
  STICKER_EMOJIS.forEach(emoji => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = emoji;
    button.setAttribute('aria-label', `Add ${emoji}`);
    button.addEventListener('click', () => {
      if (emojis.length >= 6) return;
      emojis.push(emoji);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sticker-emoji-chip';
      chip.textContent = emoji;
      chip.title = 'Remove emoji';
      chip.setAttribute('aria-label', `Remove ${emoji}`);
      chip.addEventListener('click', () => {
        const index = [...selectedEmojis.children].indexOf(chip);
        if (index >= 0) emojis.splice(index, 1);
        chip.remove();
        render();
      });
      selectedEmojis.appendChild(chip);
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
  actions.append(backButton, saveButton);
  controls.append(textInput, selectionTools, emojiRow, actions, editorStatus);
  editor.append(note, canvasWrap, controls);

  let selectionMode = 'free';
  let currentSelection = null;
  let activeSelection = null;
  let disposed = false;
  const dispose = () => {
    disposed = true;
    if (source.close) source.close();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  };
  const edited = () => Boolean(currentSelection || textInput.value.trim() || emojis.length);

  function drawSticker(targetContext, showSelection = false) {
    targetContext.clearRect(0, 0, width, height);
    targetContext.globalCompositeOperation = 'source-over';
    targetContext.drawImage(source, 0, 0, width, height);
    const text = textInput.value.trim();
    if (text) {
      const fontSize = Math.max(20, Math.round(width / 13));
      targetContext.font = `800 ${fontSize}px system-ui, sans-serif`;
      targetContext.textAlign = 'center';
      targetContext.textBaseline = 'bottom';
      targetContext.lineJoin = 'round';
      targetContext.lineWidth = Math.max(3, fontSize / 8);
      targetContext.strokeStyle = 'rgba(0,0,0,.8)';
      targetContext.fillStyle = '#fff';
      targetContext.shadowColor = 'rgba(0,0,0,.7)';
      targetContext.shadowBlur = 5;
      const maxWidth = width - 24;
      let output = text;
      while (targetContext.measureText(output).width > maxWidth && output.length > 1) output = `${output.slice(0, -2)}…`;
      targetContext.strokeText(output, width / 2, height - 12, maxWidth);
      targetContext.fillText(output, width / 2, height - 12, maxWidth);
      targetContext.shadowBlur = 0;
    }
    emojis.forEach((emoji, index) => {
      targetContext.font = `${Math.max(28, Math.round(Math.min(width, height) / 4))}px system-ui, sans-serif`;
      targetContext.textAlign = 'center';
      targetContext.textBaseline = 'middle';
      const positions = [[.78, .25], [.25, .25], [.75, .7], [.25, .72], [.5, .15], [.5, .78]];
      targetContext.fillText(emoji, width * positions[index][0], height * positions[index][1]);
    });
    const previewSelection = activeSelection || currentSelection;
    if (previewSelection) {
      targetContext.globalCompositeOperation = 'destination-in';
      targetContext.beginPath();
      traceStickerSelection(targetContext, previewSelection, width, height);
      targetContext.fill();
      targetContext.globalCompositeOperation = 'source-over';
    }
    if (showSelection && previewSelection) {
      targetContext.save();
      targetContext.beginPath();
      traceStickerSelection(targetContext, previewSelection, width, height);
      targetContext.fillStyle = 'rgba(255, 60, 170, .22)';
      targetContext.fill();
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
    canvas.setPointerCapture(event.pointerId);
    const point = selectionPoint(event);
    activeSelection = { mode: selectionMode, start: point, end: point, points: [point] };
    currentSelection = null;
    render();
  });
  canvas.addEventListener('pointermove', event => {
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
    if (!activeSelection) return;
    if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const selection = activeSelection;
    if (event && selection.mode === 'free') {
      const point = selectionPoint(event);
      const last = selection.points[selection.points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) >= 2) selection.points.push(point);
      selection.end = point;
    }
    activeSelection = null;
    if (selection.mode === 'free' && selection.points.length < 3) {
      currentSelection = null;
      render();
      return;
    }
    if (selection.mode !== 'free' && Math.hypot(selection.end.x - selection.start.x, selection.end.y - selection.start.y) < 3) {
      currentSelection = null;
      render();
      return;
    }
    currentSelection = selection;
    render();
  };
  canvas.addEventListener('pointerup', finishSelection);
  canvas.addEventListener('pointercancel', finishSelection);
  clearSelection.addEventListener('click', () => {
    currentSelection = null;
    render();
  });
  textInput.addEventListener('input', render);
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
        blob = await canvasToBlob(exportCanvas);
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

function traceStickerSelection(context, selection, width, height) {
  const { start, end, mode } = selection;
  if (mode === 'free') {
    const points = selection.points;
    context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) {
      context.lineTo(points[index].x, points[index].y);
    }
    context.closePath();
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
  try {
    const file = sticker.file instanceof File
      ? sticker.file
      : new File([sticker.file], 'sticker.png', { type: sticker.file.type || 'image/png' });
    const upload = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/upload-url`, {
      method: 'POST',
      body: JSON.stringify({ content_type: file.type })
    });
    const { error: uploadError } = await supabase.storage.from('uploads')
      .uploadToSignedUrl(upload.path, upload.token, file, { contentType: file.type });
    if (uploadError) throw new Error(`Sticker upload failed: ${uploadError.message || 'please try again.'}`);
    const result = await apiRequest(`/messages/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: STICKER_MESSAGE_CONTENT,
        media_path: upload.path,
        reply_to_id: replyingTo?.id || null
      })
    });
    if (currentConversationId === conversationId) {
      const container = document.getElementById('chat-messages-container');
      if (container) appendMessage(container, result.message, currentUser);
      replyingTo = null;
      document.getElementById('reply-bar')?.replaceChildren();
      const replyBar = document.getElementById('reply-bar');
      if (replyBar) replyBar.hidden = true;
    }
    notifyPeer(conversationId);
    refreshConversations().catch(err => console.error('Could not refresh conversation preview:', err));
  } catch (err) {
    status.textContent = err.message || 'Could not send this sticker.';
    status.hidden = false;
    throw err;
  }
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

// Custom voice-message player: no native menu, so no download option.
(() => {
  const fmt = s => (isFinite(s) && s >= 0) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';
  let current = null;
  function audioFor(player) {
    if (player._audio) return player._audio;
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = player.dataset.src;
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
    audio.addEventListener('error', () => { time.textContent = 'Unavailable'; });
    seek.addEventListener('input', () => {
      seeking = true;
      if (isFinite(audio.duration)) audio.currentTime = (seek.value / 100) * audio.duration;
    });
    seek.addEventListener('change', () => { seeking = false; });
    player._audio = audio;
    return audio;
  }
  document.addEventListener('click', event => {
    const btn = event.target.closest('.voice-play');
    if (!btn) return;
    const audio = audioFor(btn.closest('.voice-player'));
    if (audio.paused) {
      if (current && current !== audio) current.pause();
      current = audio;
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  });
  document.addEventListener('contextmenu', event => {
    if (event.target.closest('.voice-player')) event.preventDefault();
  });
})();