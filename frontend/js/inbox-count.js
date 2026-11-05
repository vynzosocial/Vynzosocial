import { apiRequest } from './api.js?v=sb6';
import { createRealtimeSocket } from './realtime.js?v=sb9';

const POLL_MS = 30000;
const links = [...document.querySelectorAll('a[href$="messages.html"]')];
let badges = [];
let timer = null;

function ensureBadges() {
  if (badges.length) return;
  badges = links.map(link => {
    const badge = document.createElement('span');
    badge.className = 'inbox-count';
    badge.hidden = true;
    badge.setAttribute('role', 'status');
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

async function refresh() {
  try {
    const data = await apiRequest('/messages');
    const conversations = Array.isArray(data) ? data : (data.conversations || []);
    show(conversations.reduce((sum, conv) => sum + (Number(conv.unread_count) || 0), 0));
  } catch { /* keep the last known count */ }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => { if (!document.hidden) refresh(); schedule(); }, POLL_MS);
}

function init() {
  const me = (() => { try { return JSON.parse(localStorage.getItem('vynzo_user') || '{}'); } catch { return {}; } })();
  if (!links.length || !me.id || !localStorage.getItem('vynzo_token')) return;
  ensureBadges();
  refresh();
  schedule();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  try {
    createRealtimeSocket().on('conversation_changed', () => setTimeout(refresh, 400));
  } catch { /* polling still keeps the count current */ }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
