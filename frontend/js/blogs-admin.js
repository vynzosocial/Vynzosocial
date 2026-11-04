import { apiRequest } from './api.js?v=sb5';
import { API_ORIGIN } from './config.js?v=sb4';

if (!localStorage.getItem('vynzo_token')) location.href = '../index.html';

const tabsEl = document.getElementById('tabs');
const panel = document.getElementById('panel');
let tab = 'queue';
let stats = {};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = d => (d ? new Date(d).toLocaleString() : '');
const api = (p, o) => apiRequest('/blogs/admin' + p, o);
const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b || {}) });

function toast(msg, bad) {
  const n = document.createElement('div');
  n.className = 'bl-toast' + (bad ? ' bad' : '');
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 3000);
}
const run = async fn => { try { await fn(); } catch (e) { toast(e.message, true); } };

function preview(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  d.querySelectorAll('img').forEach(i => { const s = i.getAttribute('src') || ''; if (s.startsWith('/uploads/')) i.src = API_ORIGIN + s; });
  return d.innerHTML;
}

function drawTabs() {
  const defs = [['queue', 'Review queue', (stats.in_review || 0) + (stats.held_comments || 0)],
    ['reports', 'Reports', stats.open_reports], ['appeals', 'Appeals', stats.open_appeals],
    ['logs', 'Logs'], ['users', 'Users']];
  tabsEl.innerHTML = defs.map(([k, label, n]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${label}${n ? `<b>${n}</b>` : ''}</button>`).join('');
}
tabsEl.onclick = e => { const b = e.target.closest('button'); if (b) { tab = b.dataset.t; show(); } };

async function refreshStats() {
  const r = await api('/stats');
  stats = r.stats;
  document.getElementById('mode-line').textContent =
    `Moderation mode: ${r.moderation.mode}${r.moderation.ai ? ' + AI check' : ' (no AI key: every clean article waits for admin approval)'} | published: ${stats.published}`;
}

async function show() {
  drawTabs();
  panel.innerHTML = '<p class="bl-empty">Loading...</p>';
  await run(async () => {
    if (tab === 'queue') await showQueue();
    if (tab === 'reports') await showReports();
    if (tab === 'appeals') await showAppeals();
    if (tab === 'logs') await showLogs();
    if (tab === 'users') await showUsers('');
  });
}

async function showQueue() {
  const { articles, comments } = await api('/queue');
  const arts = articles.map(a => `<div class="bl-item" data-id="${a.id}">
    <h3>${esc(a.title)}</h3>
    <small>by @${esc(a.author_username)} | strikes: ${a.author_strikes} | open reports: ${a.open_reports} | ${esc(a.category)} | ${when(a.updated_at)}</small>
    <details><summary>Read article</summary><div class="bl-body">${preview(a.content_html)}</div></details>
    <pre>${esc(JSON.stringify(a.moderation || {}, null, 1))}</pre>
    <input class="bl-input" data-reason placeholder="Reason (required to reject or remove)">
    <div class="bl-row"><button class="bl-btn" data-act="approve">Approve</button>
    <button class="bl-btn bl-ghost" data-act="reject">Reject</button>
    <button class="bl-btn bl-danger" data-act="remove">Remove</button></div></div>`).join('');
  const cms = comments.map(c => `<div class="bl-item" data-cid="${c.id}"><small>Held comment by @${esc(c.username)} | ${when(c.created_at)}</small>
    <p dir="auto">${esc(c.body)}</p>
    <div class="bl-row"><button class="bl-btn" data-cact="approve">Approve</button><button class="bl-btn bl-danger" data-cact="remove">Remove</button></div></div>`).join('');
  panel.innerHTML = (arts || cms) ? `${arts}${cms ? '<h3>Held comments</h3>' + cms : ''}` : '<p class="bl-empty">Queue is empty.</p>';
  panel.onclick = e => run(async () => {
    const b = e.target.closest('button'); if (!b) return;
    const item = b.closest('.bl-item');
    if (b.dataset.act) {
      await post(`/articles/${item.dataset.id}/${b.dataset.act}`, { reason: item.querySelector('[data-reason]').value });
    } else if (b.dataset.cact) await post(`/comments/${item.dataset.cid}/${b.dataset.cact}`);
    else return;
    toast('Done'); await refreshStats(); show();
  });
}

async function showReports() {
  const { reports } = await api('/reports');
  panel.innerHTML = reports.length ? reports.map(r => `<div class="bl-item" data-type="${r.target_type}" data-id="${r.target_id}">
    <h3>${esc(r.target_type === 'article' ? r.article_title : r.comment_body.slice(0, 120))}</h3>
    <small>${r.reports} report(s) | ${esc(r.reasons.join(', '))} | status: ${esc(r.target_type === 'article' ? r.article_status : r.comment_status)} | ${when(r.last_report)}</small>
    <input class="bl-input" data-reason placeholder="Reason (required to remove)">
    <div class="bl-row">
      ${r.target_type === 'article' ? '<button class="bl-btn bl-danger" data-act="remove">Remove article</button>' : '<button class="bl-btn bl-danger" data-cact="remove">Remove comment</button>'}
      <button class="bl-btn bl-ghost" data-dismiss>Dismiss</button></div></div>`).join('') : '<p class="bl-empty">No open reports.</p>';
  panel.onclick = e => run(async () => {
    const b = e.target.closest('button'); if (!b) return;
    const item = b.closest('.bl-item');
    if (b.dataset.act) await post(`/articles/${item.dataset.id}/remove`, { reason: item.querySelector('[data-reason]').value });
    else if (b.dataset.cact) await post(`/comments/${item.dataset.id}/remove`);
    else if ('dismiss' in b.dataset) await post(`/reports/${item.dataset.type}/${item.dataset.id}/dismiss`);
    else return;
    toast('Done'); await refreshStats(); show();
  });
}

async function showAppeals() {
  const { appeals } = await api('/appeals');
  panel.innerHTML = appeals.length ? appeals.map(a => `<div class="bl-item" data-id="${a.id}">
    <h3>${esc(a.title)}</h3>
    <small>by @${esc(a.username)} | strikes: ${a.blog_strikes} | article: ${esc(a.article_status)} | ${when(a.created_at)}</small>
    <p><b>Author's appeal:</b> ${esc(a.message)}</p>
    <p><b>Decision reason:</b> ${esc(a.rejection_reason || '-')}</p>
    <details><summary>Read article</summary><div class="bl-body">${preview(a.content_html)}</div></details>
    <input class="bl-input" data-note placeholder="Note to author (required to deny)">
    <div class="bl-row"><button class="bl-btn" data-accept="1">Accept (back to review)</button><button class="bl-btn bl-danger" data-accept="0">Deny</button></div></div>`).join('') : '<p class="bl-empty">No open appeals.</p>';
  panel.onclick = e => run(async () => {
    const b = e.target.closest('button'); if (!b) return;
    const item = b.closest('.bl-item');
    await post(`/appeals/${item.dataset.id}/resolve`, { accept: b.dataset.accept === '1', note: item.querySelector('[data-note]').value });
    toast('Done'); await refreshStats(); show();
  });
}

async function showLogs() {
  const { logs } = await api('/logs');
  panel.onclick = null;
  panel.innerHTML = logs.length ? logs.map(l => `<div class="bl-item"><b>${esc(l.action)}</b> <small>${when(l.created_at)}</small><br>
    <small>actor: ${esc(l.actor_username || 'system')} | user: ${esc(l.subject_username || '-')} | article: ${esc(l.article_title || '-')}</small>
    ${l.reason ? `<p>${esc(l.reason)}</p>` : ''}</div>`).join('') : '<p class="bl-empty">No logs yet.</p>';
}

async function showUsers(q) {
  const { users } = await api('/users?q=' + encodeURIComponent(q));
  panel.innerHTML = `<input id="u-q" class="bl-input" placeholder="Search username..." value="${esc(q)}">` + (users.length ? users.map(u => {
    const susp = u.suspended_until && new Date(u.suspended_until) > new Date();
    return `<div class="bl-item" data-id="${u.id}"><h3>@${esc(u.username)} ${u.is_admin ? '(admin)' : ''}</h3>
    <small>strikes: ${u.blog_strikes} | blog ban until: ${u.blog_banned_until ? when(u.blog_banned_until) : '-'} | ${susp ? 'SUSPENDED until ' + when(u.suspended_until) + ' (' + esc(u.suspension_reason || '') + ')' : 'active'}</small>
    ${u.is_admin ? '' : `<input class="bl-input" data-reason placeholder="Suspension reason">
    <div class="bl-row"><select class="bl-input" data-days style="width:auto"><option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="0">Permanent</option></select>
    <button class="bl-btn bl-danger" data-s="suspend">Suspend account</button>
    <button class="bl-btn bl-ghost" data-s="lift">Lift suspension / ban</button></div>`}</div>`;
  }).join('') : '<p class="bl-empty">No flagged users. Search by username to find someone.</p>');
  let timer;
  panel.querySelector('#u-q').oninput = e => { clearTimeout(timer); timer = setTimeout(() => run(() => showUsers(e.target.value.trim())), 350); };
  panel.querySelector('#u-q').focus();
  panel.onclick = e => run(async () => {
    const b = e.target.closest('button'); if (!b || !b.dataset.s) return;
    const item = b.closest('.bl-item');
    await post(`/users/${item.dataset.id}/suspend`, {
      lift: b.dataset.s === 'lift', days: Number(item.querySelector('[data-days]').value), reason: item.querySelector('[data-reason]').value
    });
    toast('Done'); showUsers(panel.querySelector('#u-q').value.trim());
  });
}

(async () => {
  try { await refreshStats(); }
  catch { panel.innerHTML = '<p class="bl-empty">Administrator access required.</p>'; return; }
  show();
})();
