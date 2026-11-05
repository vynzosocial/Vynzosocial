import { supabase } from './supabase-client.js';

const POLL_MS = 60000;
const KIND_LABEL = {
  image: 'liked your photo',
  video: 'liked your video',
  story: 'liked your story',
  blog: 'liked your blog',
  follow: 'started following you'
};

const me = (() => {
  try { return JSON.parse(localStorage.getItem('vynzo_user') || '{}'); } catch { return {}; }
})();
const seenKey = `vynzo_activity_seen_${me.id || 'anon'}`;

let items = [];
let filter = 'all';
let button;
let panel;
let list;
let badge;

const seenAt = () => Number(localStorage.getItem(seenKey) || 0);
const isNew = item => Date.parse(item.created_at) > seenAt();

function timeAgo(value) {
  const seconds = Math.max(1, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return 'just now';
  const units = [['d', 86400], ['h', 3600], ['m', 60]];
  for (const [label, size] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${label} ago`;
  }
  return 'just now';
}

function avatar(item) {
  const span = document.createElement('span');
  span.className = 'activity-avatar';
  const name = item.display_name || item.username || 'U';
  span.textContent = name.charAt(0).toUpperCase();
  if (item.avatar_url) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = item.avatar_url;
    img.addEventListener('error', () => img.remove());
    span.appendChild(img);
  }
  return span;
}

function preview(item) {
  if (item.kind === 'follow') return null;
  const box = document.createElement('span');
  box.className = `activity-preview activity-preview-${item.kind}`;
  if (item.preview && (item.kind === 'image' || item.kind === 'story' || item.kind === 'blog')) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = item.preview;
    img.addEventListener('error', () => img.remove());
    box.appendChild(img);
  } else {
    box.textContent = item.kind === 'video' ? '\u25B6' : '\u2665';
  }
  return box;
}

function render() {
  const visible = items.filter(item => filter === 'all'
    || (filter === 'follow' ? item.kind === 'follow' : item.kind !== 'follow'));
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'activity-empty';
    empty.textContent = filter === 'follow' ? 'No new followers yet.' : 'No activity yet. Likes on your photos, videos, stories and blogs will show here.';
    list.appendChild(empty);
    return;
  }
  visible.forEach(item => {
    const row = document.createElement(item.actor_id ? 'button' : 'div');
    row.className = `activity-item${item.fresh ? ' is-new' : ''}${item.actor_id ? ' is-link' : ''}`;
    if (item.actor_id) {
      row.type = 'button';
      row.setAttribute('aria-label', `View ${item.display_name || item.username || 'user'}'s profile`);
      row.addEventListener('click', async event => {
        event.stopPropagation();
        try {
          const { openUserProfile } = await import('./users.js?v=likes1');
          setOpen(false);
          openUserProfile(item.actor_id);
        } catch (err) {
          console.error('Could not open profile:', err);
        }
      });
    }
    const text = document.createElement('span');
    text.className = 'activity-text';
    const strong = document.createElement('strong');
    strong.textContent = item.display_name || item.username || 'Someone';
    const action = document.createElement('span');
    action.textContent = ` ${KIND_LABEL[item.kind] || 'interacted with you'}`;
    const meta = document.createElement('small');
    meta.textContent = [item.title, timeAgo(item.created_at)].filter(Boolean).join(' \u00B7 ');
    text.append(strong, action, meta);
    row.append(avatar(item), text);
    const thumb = preview(item);
    if (thumb) row.appendChild(thumb);
    list.appendChild(row);
  });
}

function updateGlow() {
  const fresh = items.filter(isNew).length;
  button.classList.toggle('has-activity', fresh > 0);
  badge.hidden = fresh === 0;
  badge.textContent = fresh > 99 ? '99+' : String(fresh);
}

async function load() {
  try {
    const { data, error } = await supabase.rpc('get_my_activity', { p_limit: 60 });
    if (error) throw error;
    items = Array.isArray(data) ? data : [];
    if (!panel.hidden) items.forEach(item => { item.fresh = item.fresh || isNew(item); });
    updateGlow();
    if (!panel.hidden) render();
  } catch {
    if (!panel.hidden) {
      list.replaceChildren();
      const err = document.createElement('p');
      err.className = 'activity-empty';
      err.textContent = 'Unable to load activity right now.';
      list.appendChild(err);
    }
  }
}

function markSeen() {
  const newest = items.reduce((max, item) => Math.max(max, Date.parse(item.created_at) || 0), Date.now());
  localStorage.setItem(seenKey, String(Math.max(newest, Date.now())));
  updateGlow();
}

function placePanel() {
  const rect = button.getBoundingClientRect();
  const width = Math.min(380, window.innerWidth - 20);
  panel.style.top = `${Math.round(rect.bottom + 8)}px`;
  panel.style.width = `${width}px`;
  panel.style.left = `${Math.max(10, Math.min(window.innerWidth - width - 10, rect.right - width))}px`;
  panel.style.maxHeight = `${Math.max(200, window.innerHeight - rect.bottom - 24)}px`;
}

function setOpen(open) {
  panel.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (!open) return;
  placePanel();
  items.forEach(item => { item.fresh = isNew(item); });
  render();
  markSeen();
  load().then(() => markSeen());
}

function build() {
  const topBar = document.querySelector('.top-bar');
  const anchor = document.getElementById('theme-toggle');
  if (!topBar) return false;

  const wrap = document.createElement('div');
  wrap.className = 'activity-wrap';
  wrap.innerHTML = `
    <button type="button" id="activity-btn" class="activity-btn" aria-label="Activity and new followers" aria-haspopup="true" aria-expanded="false" aria-controls="activity-panel">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7.5-4.6-9.3-9.2C1.5 8.4 3.600 5 7 5c2 0 3.400 1 5 3 1.600-2 3-3 5-3 3.400 0 5.500 3.400 4.300 6.800C19.500 16.400 12 21 12 21z"/></svg>
      <span>Activity</span><b class="activity-badge" hidden>0</b>
    </button>
    <section id="activity-panel" class="activity-panel" aria-label="Activity and new followers" hidden>
      <header class="activity-head">
        <strong>Activity</strong>
        <div class="activity-tabs" role="tablist">
          <button type="button" role="tab" class="is-active" data-filter="all">All</button>
          <button type="button" role="tab" data-filter="like">Likes</button>
          <button type="button" role="tab" data-filter="follow">New followers</button>
        </div>
      </header>
      <div class="activity-list" aria-live="polite"></div>
    </section>`;
  topBar.insertBefore(wrap, anchor || null);
  button = wrap.querySelector('#activity-btn');
  panel = wrap.querySelector('#activity-panel');
  list = wrap.querySelector('.activity-list');
  badge = wrap.querySelector('.activity-badge');
  document.body.appendChild(panel);

  button.addEventListener('click', event => {
    event.stopPropagation();
    setOpen(panel.hidden);
  });
  panel.addEventListener('click', event => {
    event.stopPropagation();
    const tab = event.target.closest('[data-filter]');
    if (!tab) return;
    filter = tab.dataset.filter;
    panel.querySelectorAll('[data-filter]').forEach(el => el.classList.toggle('is-active', el === tab));
    render();
  });
  document.addEventListener('click', () => { if (!panel.hidden) setOpen(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) setOpen(false); });
  return true;
}

function init() {
  if (!supabase || !me.id || !localStorage.getItem('vynzo_token')) return;
  if (!build()) return;
  load();
  setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
