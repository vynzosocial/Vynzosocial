import { apiRequest } from './api.js?v=sb6';
import { createRealtimeSocket } from './realtime.js?v=sb15';
import { syncNativeUnreadNotifications } from './native-push.mjs';

const POLL_MS = 30000;
let links = [];
let badges = [];
let timer = null;
let started = false;
let requestVersion = 0;
let badgeUpdates = Promise.resolve();

function ensureBadges() {
  if (!document.getElementById('vynzo-inbox-css')) {
    const stylesheet = document.createElement('link');
    stylesheet.id = 'vynzo-inbox-css';
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('../css/inbox-count.css?v=2', import.meta.url).href;
    document.head.appendChild(stylesheet);
  }
  links = [...document.querySelectorAll('a[href$="messages.html"]')];
  badges = links.map(link => {
    const badge = document.createElement('span');
    badge.className = 'inbox-count';
    badge.hidden = true;
    badge.setAttribute('role', 'status');
    badge.setAttribute('data-no-i18n', '');
    link.classList.add('has-inbox-count');
    link.appendChild(badge);
    return badge;
  });
}

function show(total) {
  badges.forEach((badge, index) => {
    badge.hidden = total <= 0;
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.setAttribute('aria-label', `${total} unread ${total === 1 ? 'message' : 'messages'}`);
    links[index].classList.toggle('has-unread', total > 0);
  });
}

export async function refreshInboxCount() {
  const request = ++requestVersion;
  const token = localStorage.getItem('vynzo_token');
  if (!token) {
    show(0);
    badgeUpdates = badgeUpdates.then(async () => {
      if (!localStorage.getItem('vynzo_token') && navigator.clearAppBadge) await navigator.clearAppBadge();
    }).catch(error => console.error('Could not clear app badge:', error));
    await badgeUpdates;
    return;
  }
  const before = Date.now();
  try {
    const userId = JSON.parse(localStorage.getItem('vynzo_user') || '{}').id;
    const data = await apiRequest('/messages');
    if (request !== requestVersion || token !== localStorage.getItem('vynzo_token')) return;
    const conversations = Array.isArray(data) ? data : data.conversations;
    if (!Array.isArray(conversations)) throw new Error('Invalid inbox response.');
    let total = 0;
    const readConversationIds = [];
    for (const conversation of conversations) {
      const count = Number(conversation.unread_count ?? 0);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid unread message count.');
      total += count;
      if (count === 0) readConversationIds.push(conversation.id);
    }
    show(total);
    badgeUpdates = badgeUpdates.then(async () => {
      if (token !== localStorage.getItem('vynzo_token')) return;
      try {
        if (total > 0 && navigator.setAppBadge) await navigator.setAppBadge(total);
        else if (total === 0 && navigator.clearAppBadge) await navigator.clearAppBadge();
      } catch (error) {
        console.error('Could not update app badge:', error);
      }
      if (token === localStorage.getItem('vynzo_token')) {
        await syncNativeUnreadNotifications({ userId, readConversationIds, before });
      }
    }).catch(error => console.error('Could not clear read message notifications:', error));
    await badgeUpdates;
  } catch (error) {
    console.error('Could not refresh inbox unread count:', error);
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => { if (!document.hidden) refreshInboxCount(); schedule(); }, POLL_MS);
}

export function initInboxCount() {
  if (started || !localStorage.getItem('vynzo_token')) return;
  started = true;
  ensureBadges();
  refreshInboxCount();
  schedule();
  document.addEventListener('vynzo:messages-read', refreshInboxCount);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshInboxCount(); });
  window.addEventListener('pageshow', refreshInboxCount);
  window.addEventListener('focus', refreshInboxCount);
  window.addEventListener('storage', event => {
    if (event.key === 'vynzo_token' || event.key === 'vynzo_user') refreshInboxCount();
  });
  const socket = createRealtimeSocket();
  socket.on('conversation_changed', refreshInboxCount);
  socket.on('connect', refreshInboxCount);
  socket.on('connect_error', error => console.error('Inbox realtime connection failed:', error));
}
