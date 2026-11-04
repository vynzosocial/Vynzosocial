import { apiRequest } from './api.js?v=sb6';
import { createRealtimeSocket } from './realtime.js?v=sb4';
import { initCalls } from './calls.js?v=sb4';

const ASKED_KEY = 'vynzo_notify_prompt_dismissed';
const lastSeen = new Map();
let unread = 0;
let baseTitle = '';
let started = false;
let audioContext = null;

const pagesBase = () => (window.location.pathname.includes('/pages/') ? '' : 'pages/');
const messagesUrl = conversationId => `${pagesBase()}messages.html?conversationId=${encodeURIComponent(conversationId)}`;

function conversationName(conversation) {
  return conversation.is_group
    ? conversation.group_name || 'Group chat'
    : conversation.other_display_name || conversation.other_username || 'New message';
}

function previewText(message) {
  if (message.view_once) return '📷 View-once photo';
  if (message.content) return message.content.length > 120 ? `${message.content.slice(0, 117)}…` : message.content;
  return message.media_url ? '📎 Photo / video' : 'New message';
}

function beep() {
  try {
    audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, audioContext.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.35);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.4);
  } catch { /* sound is optional */ }
}

function bumpTitle() {
  if (!document.hidden) return;
  unread += 1;
  document.title = `(${unread}) ${baseTitle}`;
}

function showToast(title, body, onClick) {
  const toast = document.createElement('button');
  toast.type = 'button';
  toast.style.cssText = 'position:fixed;top:16px;right:16px;z-index:10001;max-width:320px;text-align:left;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:rgba(20,20,28,.96);color:#fff;font:inherit;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.4)';
  const heading = document.createElement('strong');
  heading.textContent = title;
  heading.style.display = 'block';
  const text = document.createElement('span');
  text.textContent = body;
  text.style.cssText = 'display:block;opacity:.85;font-size:13px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  toast.append(heading, text);
  toast.addEventListener('click', () => { toast.remove(); onClick?.(); });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

function notify({ title, body, tag, url, requireInteraction = false }) {
  beep();
  bumpTitle();
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const item = new Notification(title, { body, tag, requireInteraction });
      item.onclick = () => {
        window.focus();
        if (url) window.location.href = url;
        item.close();
      };
      return;
    } catch { /* fall back to the in-page toast */ }
  }
  showToast(title, body, () => { if (url) window.location.href = url; });
}

async function loadConversations() {
  const data = await apiRequest('/messages');
  return data.conversations || [];
}

async function checkConversation(conversationId, me) {
  const conversations = await loadConversations();
  const conversation = conversations.find(item => item.id === conversationId);
  const last = conversation?.last_message;
  if (!last) return;
  const previous = lastSeen.get(conversationId);
  lastSeen.set(conversationId, last.id);
  if (previous === last.id || last.sender_id === me.id) return;
  const viewing = window.__vynzoOpenConversation === conversationId && !document.hidden;
  if (viewing) return;
  notify({
    title: conversationName(conversation),
    body: previewText(last),
    tag: `msg-${conversationId}`,
    url: messagesUrl(conversationId)
  });
}

function offerPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  if (localStorage.getItem(ASKED_KEY)) return;
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10001;display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:999px;background:rgba(20,20,28,.96);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:14px;max-width:calc(100vw - 24px)';
  const label = document.createElement('span');
  label.textContent = '🔔 Get notified about new messages and calls?';
  const enable = document.createElement('button');
  enable.type = 'button';
  enable.textContent = 'Enable';
  const later = document.createElement('button');
  later.type = 'button';
  later.textContent = 'Not now';
  [enable, later].forEach(button => { button.style.cssText = 'padding:6px 12px;border-radius:999px;border:0;font:inherit;cursor:pointer'; });
  enable.addEventListener('click', () => {
    Notification.requestPermission().finally(() => bar.remove());
  });
  later.addEventListener('click', () => {
    localStorage.setItem(ASKED_KEY, '1');
    bar.remove();
  });
  bar.append(label, enable, later);
  document.body.appendChild(bar);
}

export async function initNotifications() {
  if (started) return;
  const token = localStorage.getItem('vynzo_token');
  const me = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  if (!token || !me.id) return;
  started = true;
  baseTitle = document.title;

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      unread = 0;
      document.title = baseTitle;
    }
  });
  offerPermission();
  initCalls();

  // Baseline so messages that already exist never trigger a notification.
  try {
    (await loadConversations()).forEach(item => {
      if (item.last_message) lastSeen.set(item.id, item.last_message.id);
    });
  } catch { /* retried on the next message */ }

  const socket = createRealtimeSocket();
  socket.on('conversation_changed', event => {
    if (!event?.conversation_id) return;
    checkConversation(event.conversation_id, me).catch(() => {});
  });
  socket.on('call_incoming', data => {
    const from = data?.from || {};
    const name = from.display_name || from.username || 'Someone';
    if (document.hidden) {
      notify({
        title: `Incoming ${data.video ? 'video' : 'voice'} call`,
        body: name,
        tag: `call-${data.callId}`,
        url: window.location.href,
        requireInteraction: true
      });
    }
  });
  socket.on('call_ended', data => {
    if (data?.reason !== 'missed') return;
    notify({ title: 'Missed call', body: 'You missed a call on Vynzo.', tag: `missed-${data.callId}`, url: `${pagesBase()}messages.html` });
  });
  socket.connect?.();
}

initNotifications();
