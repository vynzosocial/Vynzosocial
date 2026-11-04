import { apiRequest } from './api.js?v=sb6';
import { API_ORIGIN } from './config.js?v=sb4';
import { t, getLang, applyLang, toggleLang } from './blogs-i18n.js?v=8';

if (!localStorage.getItem('vynzo_token')) location.href = '../index.html';

const view = document.getElementById('blogs-view');
const state = { meta: null, user: (() => { try { return JSON.parse(localStorage.getItem('vynzo_user')) || {}; } catch { return {}; } })() };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mediaUrl = u => (u ? (u.startsWith('/uploads/') ? API_ORIGIN + u : u) : '');
const fmtDate = d => (d ? new Date(d).toLocaleDateString(getLang() === 'ar' ? 'ar' : undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const avatar = (url, name) => url
  ? `<img class="bl-avatar" src="${esc(mediaUrl(url))}" alt="">`
  : `<span class="bl-avatar bl-avatar-fallback">${esc((name || '?')[0].toUpperCase())}</span>`;
const dirOf = lang => (lang === 'ar' ? 'rtl' : 'ltr');

function toast(msg, bad) {
  const n = document.createElement('div');
  n.className = 'bl-toast' + (bad ? ' bad' : '');
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 3200);
}

async function api(path, opts) {
  try { return await apiRequest('/blogs' + path, opts); }
  catch (err) { toast(err.message || t('error'), true); throw err; }
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

function ask(title, fields, confirmLabel) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'bl-modal';
    wrap.innerHTML = `<form class="bl-modal-card"><h3>${esc(title)}</h3>${fields}
      <div class="bl-row"><button type="button" class="bl-btn bl-ghost" data-x>${t('cancel')}</button>
      <button class="bl-btn">${esc(confirmLabel)}</button></div></form>`;
    document.body.appendChild(wrap);
    const done = v => { wrap.remove(); resolve(v); };
    wrap.querySelector('[data-x]').onclick = () => done(null);
    wrap.querySelector('form').onsubmit = e => {
      e.preventDefault();
      done(Object.fromEntries(new FormData(e.target).entries()));
    };
  });
}

function reportDialog(type, id) {
  const opts = state.meta.report_reasons.map(r => `<option value="${r}">${t('r_' + r)}</option>`).join('');
  ask(t('reportTitle'),
    `<select name="reason" class="bl-input">${opts}</select><textarea name="details" maxlength="1000" class="bl-input" placeholder="${t('reportDetails')}"></textarea>`,
    t('report')).then(async v => {
    if (!v) return;
    try { const r = await post('/report', { target_type: type, target_id: id, ...v }); toast(r.message || t('reportSent')); } catch { /* shown */ }
  });
}

/* ---------- Cards and feed ---------- */
function card(a, opts = {}) {
  const cover = a.cover_url ? `<img class="bl-cover" src="${esc(mediaUrl(a.cover_url))}" alt="" loading="lazy" decoding="async">` : '<div class="bl-cover bl-cover-empty">&#128221;</div>';
  const status = opts.status ? `<span class="bl-status s-${a.status}">${t('status_' + a.status)}</span>` : '';
  return `<article class="bl-card" data-id="${a.id}" dir="${dirOf(a.language)}">
    ${cover}
    <div class="bl-card-body">
      <div class="bl-meta">${status}<span class="bl-chip">${t('c_' + a.category)}</span><span>${a.read_minutes} ${t('readMin')}</span></div>
      <h3>${esc(a.title || '...')}</h3>
      <p>${esc(a.excerpt)}</p>
      <div class="bl-foot">
        <a class="bl-author" href="#/u/${a.author_id}">${avatar(a.author_avatar_url, a.author_username)}<span>${esc(a.author_display_name || a.author_username)}</span></a>
        <span class="bl-stats">&#10084; ${a.likes_count} &middot; &#128172; ${a.comments_count} &middot; &#128065; ${a.views_count}</span>
      </div>
      ${opts.actions || ''}
    </div></article>`;
}

function listHtml(list, opts) {
  return list.length ? `<div class="bl-grid">${list.map(a => card(a, opts)).join('')}</div>` : `<p class="bl-empty">${t('empty')}</p>`;
}

function bindCards(root) {
  root.querySelectorAll('.bl-card').forEach(c => {
    c.addEventListener('click', e => {
      if (e.target.closest('a,button')) return;
      const a = c.dataset.id;
      location.hash = c.dataset.own === '1' ? `#/write/${a}` : `#/a/${a}`;
    });
    const title = c.querySelector('h3');
    title.style.cursor = 'pointer';
  });
}

async function renderFeed() {
  const q = { q: '', category: '', sort: 'latest', offset: 0 };
  view.innerHTML = `
    <div class="bl-search"><input id="bl-q" class="bl-input" type="search" maxlength="80" placeholder="${t('search')}">
      <div class="bl-seg"><button data-sort="latest" class="on">${t('latest')}</button><button data-sort="trending">${t('trending')}</button></div></div>
    <div class="bl-chips" id="bl-cats"></div>
    <div class="bl-tags" id="bl-tags"></div>
    <div id="bl-list"></div>
    <div class="bl-row bl-center"><button id="bl-more" class="bl-btn bl-ghost" hidden>${t('loadMore')}</button></div>`;
  const cats = view.querySelector('#bl-cats');
  cats.innerHTML = `<button data-c="" class="on">${t('all')}</button>` + state.meta.categories.map(c => `<button data-c="${c}">${t('c_' + c)}</button>`).join('');
  const list = view.querySelector('#bl-list');
  const more = view.querySelector('#bl-more');

  async function load(reset) {
    if (reset) { q.offset = 0; list.innerHTML = `<p class="bl-empty">${t('loading')}</p>`; }
    const p = new URLSearchParams({ limit: 12, offset: q.offset });
    if (q.q) p.set('q', q.q);
    if (q.category) p.set('category', q.category);
    if (q.sort === 'trending') p.set('sort', 'trending');
    const { articles } = await api('?' + p);
    if (reset) list.innerHTML = '';
    if (reset && !articles.length) list.innerHTML = `<p class="bl-empty">${t('empty')}</p>`;
    let grid = list.querySelector('.bl-grid');
    if (!grid && articles.length) { grid = document.createElement('div'); grid.className = 'bl-grid'; list.appendChild(grid); }
    grid?.insertAdjacentHTML('beforeend', articles.map(a => card(a)).join(''));
    bindCards(list);
    more.hidden = articles.length < 12;
    q.offset += articles.length;
  }

  let timer;
  view.querySelector('#bl-q').oninput = e => { clearTimeout(timer); timer = setTimeout(() => { q.q = e.target.value.trim(); load(true); }, 350); };
  view.querySelector('.bl-seg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    view.querySelectorAll('.bl-seg button').forEach(x => x.classList.toggle('on', x === b));
    q.sort = b.dataset.sort; load(true);
  };
  cats.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    cats.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    q.category = b.dataset.c; load(true);
  };
  more.onclick = () => load(false);
  api('/tags/trending').then(({ tags }) => {
    const box = view.querySelector('#bl-tags');
    if (!box || !tags.length) return;
    box.innerHTML = `<strong>${t('trendingTags')}</strong>` + tags.map(x => `<button data-tag="${esc(x.tag)}">#${esc(x.tag)}</button>`).join('');
    box.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      const input = view.querySelector('#bl-q'); input.value = '#' + b.dataset.tag; q.q = input.value; load(true);
    };
  }).catch(() => {});
  await load(true);
}

async function renderBookmarks() {
  view.innerHTML = `<p class="bl-empty">${t('loading')}</p>`;
  const { articles } = await api('/bookmarks');
  view.innerHTML = listHtml(articles);
  bindCards(view);
}

/* ---------- Reader ---------- */
function fixMedia(root) {
  root.querySelectorAll('img, video').forEach(el => {
    const src = el.getAttribute('src') || '';
    if (src.startsWith('/uploads/')) el.src = API_ORIGIN + src;
    if (el.tagName === 'IMG') { el.loading = 'lazy'; el.decoding = 'async'; }
    if (el.tagName === 'VIDEO') el.preload = 'metadata';
  });
}

async function renderArticle(id) {
  view.innerHTML = `<p class="bl-empty">${t('loading')}</p>`;
  const { article: a } = await api('/' + id);
  const dir = dirOf(a.language);
  view.innerHTML = `
    <button class="bl-btn bl-ghost" id="bl-back">&larr; ${t('back')}</button>
    <article class="bl-article" dir="${dir}">
      ${a.status !== 'published' ? `<div class="bl-notice">${t('status_' + a.status)}</div>` : ''}
      ${a.cover_url ? `<img class="bl-hero" src="${esc(mediaUrl(a.cover_url))}" alt="">` : ''}
      <div class="bl-meta"><span class="bl-chip">${t('c_' + a.category)}</span><span>${fmtDate(a.published_at || a.created_at)}</span><span>${a.read_minutes} ${t('readMin')}</span><span>&#128065; ${a.views_count} ${t('views')}</span></div>
      <h1>${esc(a.title)}</h1>
      <a class="bl-author" href="#/u/${a.author_id}">${avatar(a.author_avatar_url, a.author_username)}<span>${esc(a.author_display_name || a.author_username)}</span></a>
      <div class="bl-body" id="bl-body"></div>
      <div class="bl-tags">${(a.tags || []).map(x => `<a href="#/" data-tag="${esc(x)}">#${esc(x)}</a>`).join('')}</div>
      <div class="bl-actions" id="bl-actions"></div>
    </article>
    <section class="bl-comments" id="bl-comments"></section>`;
  const body = view.querySelector('#bl-body');
  body.innerHTML = a.content_html;
  body.querySelectorAll('a').forEach(l => { l.rel = 'noopener noreferrer nofollow ugc'; l.target = '_blank'; });
  fixMedia(body);
  view.querySelector('#bl-back').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/'));
  view.querySelectorAll('.bl-tags a[data-tag]').forEach(l => l.addEventListener('click', e => {
    e.preventDefault(); location.hash = '#/'; setTimeout(() => { const i = document.getElementById('bl-q'); if (i) { i.value = '#' + l.dataset.tag; i.dispatchEvent(new Event('input')); } }, 80);
  }));

  if (a.status !== 'published') return;
  const actions = view.querySelector('#bl-actions');
  const draw = () => {
    actions.innerHTML = `
      <button class="bl-btn bl-ghost ${a.is_liked ? 'on' : ''}" data-a="like">&#10084; <span>${a.likes_count}</span></button>
      <button class="bl-btn bl-ghost ${a.is_bookmarked ? 'on' : ''}" data-a="bookmark">&#128278; ${a.is_bookmarked ? t('saved') : t('save')}</button>
      <button class="bl-btn bl-ghost" data-a="share">&#128279; ${t('share')} (${a.shares_count})</button>
      ${a.is_owner ? `<button class="bl-btn bl-ghost" data-a="edit">&#9998; ${t('edit')}</button>` : `<button class="bl-btn bl-ghost" data-a="report">&#9873; ${t('report')}</button>`}`;
  };
  draw();
  actions.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const act = b.dataset.a;
    try {
      if (act === 'like') { const r = await post(`/${a.id}/like`); a.is_liked = r.liked; a.likes_count = r.count; draw(); }
      if (act === 'bookmark') { const r = await post(`/${a.id}/bookmark`); a.is_bookmarked = r.bookmarked; draw(); }
      if (act === 'share') {
        const url = `${location.origin}${location.pathname}#/a/${a.id}`;
        if (navigator.share) { try { await navigator.share({ title: a.title, url }); } catch { /* cancelled */ } }
        else { await navigator.clipboard?.writeText(url); toast(t('copied')); }
        const r = await post(`/${a.id}/share`); a.shares_count = r.shares_count; draw();
      }
      if (act === 'edit') location.hash = '#/write/' + a.id;
      if (act === 'report') reportDialog('article', a.id);
    } catch { /* shown */ }
  };

  const authorCard = document.createElement('div');
  authorCard.className = 'bl-author-card';
  view.querySelector('.bl-article').insertBefore(authorCard, view.querySelector('#bl-actions'));
  api('/authors/' + a.author_id).then(({ author }) => drawAuthor(authorCard, author)).catch(() => {});
  renderComments(a);
}

function drawAuthor(box, au) {
  const own = au.id === state.user.id;
  box.innerHTML = `${avatar(au.avatar_url, au.username)}
    <div><strong>${esc(au.display_name || au.username)}</strong> <small>@${esc(au.username)}</small>
    <div class="bl-stats">${au.followers_count} ${t('followers')} &middot; ${au.articles_count} ${t('articles')} &middot; ${au.total_views} ${t('totalViews')}</div>
    ${au.bio ? `<p>${esc(au.bio)}</p>` : ''}</div>
    ${own ? '' : `<button class="bl-btn ${au.is_following ? 'bl-ghost' : ''}">${au.is_following ? t('following') : t('follow')}</button>`}`;
  const btn = box.querySelector('button');
  if (btn) btn.onclick = async () => {
    try { const r = await post(`/authors/${au.id}/follow`); au.is_following = r.following || r.pending; au.followers_count += r.following ? 1 : (au.is_following ? 0 : -1); drawAuthor(box, au); } catch { /* shown */ }
  };
}

async function renderComments(a) {
  const box = view.querySelector('#bl-comments');
  const { comments, article_author_id } = await api(`/${a.id}/comments`);
  const draw = list => {
    box.innerHTML = `<h3>${t('comments')} (${a.comments_count})</h3>
      <form class="bl-comment-form"><textarea maxlength="1500" required class="bl-input" placeholder="${t('addComment')}"></textarea><button class="bl-btn">${t('send')}</button></form>
      <div>${list.map(c => `<div class="bl-comment" data-id="${c.id}">${avatar(c.avatar_url, c.username)}
        <div><strong>${esc(c.display_name || c.username)}</strong> <small>${fmtDate(c.created_at)}</small>
        ${c.status === 'held' ? `<em class="bl-held">${t('held')}</em>` : ''}
        <p dir="auto">${esc(c.body)}</p>
        <div class="bl-comment-actions">${c.user_id === state.user.id || state.user.id === article_author_id ? `<button data-d="${c.id}">${t('delete')}</button>` : `<button data-r="${c.id}">${t('report')}</button>`}</div></div></div>`).join('')}</div>`;
    box.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const ta = e.target.querySelector('textarea');
      try {
        const r = await post(`/${a.id}/comments`, { body: ta.value });
        if (r.held) toast(t('held'));
        a.comments_count += r.held ? 0 : 1;
        list.push(r.comment); draw(list);
      } catch { /* shown */ }
    };
    box.onclick = async e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.r) return reportDialog('comment', b.dataset.r);
      if (b.dataset.d && confirm(t('confirmDelete'))) {
        try {
          await api('/comments/' + b.dataset.d, { method: 'DELETE' });
          const i = list.findIndex(c => c.id === b.dataset.d);
          if (i > -1) { if (list[i].status === 'visible') a.comments_count = Math.max(0, a.comments_count - 1); list.splice(i, 1); }
          draw(list);
        } catch { /* shown */ }
      }
    };
  };
  draw(comments);
}

/* ---------- Author profile ---------- */
async function renderAuthor(id) {
  view.innerHTML = `<p class="bl-empty">${t('loading')}</p>`;
  const [{ author }, { articles }] = await Promise.all([api('/authors/' + id), api('?author=' + id + '&limit=30')]);
  view.innerHTML = `<button class="bl-btn bl-ghost" id="bl-back">&larr; ${t('back')}</button><div class="bl-author-card big"></div>${listHtml(articles)}`;
  view.querySelector('#bl-back').onclick = () => history.back();
  drawAuthor(view.querySelector('.bl-author-card'), author);
  bindCards(view);
}

/* ---------- My articles ---------- */
let mineTimer = null;
async function renderMine() {
  view.innerHTML = `<p class="bl-empty">${t('loading')}</p>`;
  const data = await api('/mine');
  const banned = data.banned_until && new Date(data.banned_until) > new Date();
  const items = data.articles.map(a => {
    const buttons = [];
    if (a.status !== 'removed') buttons.push(`<button class="bl-btn bl-ghost" data-edit="${a.id}">${t('edit')}</button>`);
    if (a.status === 'published' || a.status === 'in_review') buttons.push(`<button class="bl-btn bl-ghost" data-unpub="${a.id}">${t('unpublish')}</button>`);
    if (['rejected', 'removed'].includes(a.status) && a.appeal_status !== 'open') buttons.push(`<button class="bl-btn bl-ghost" data-appeal="${a.id}">${t('appeal')}</button>`);
    buttons.push(`<button class="bl-btn bl-danger" data-del="${a.id}">${t('delete')}</button>`);
    const note = a.rejection_reason ? `<p class="bl-reject">${t('reason')}: ${esc(a.rejection_reason)}</p>` : '';
    const appeal = a.appeal_status ? `<p class="bl-reject">${t('appealStatus')}: ${esc(a.appeal_status)}</p>` : '';
    return card(a, { status: true, actions: `${note}${appeal}<div class="bl-row">${buttons.join('')}</div>` }).replace('class="bl-card"', `class="bl-card" data-own="${a.status === 'published' ? 0 : 1}"`);
  });
  view.innerHTML = `${data.strikes ? `<div class="bl-notice warn">${t('strikes')}: ${data.strikes}${banned ? ` &middot; ${t('bannedUntil')} ${fmtDate(data.banned_until)}` : ''}</div>` : ''}
    ${items.length ? `<div class="bl-grid">${items.join('')}</div>` : `<p class="bl-empty">${t('empty')}</p>`}`;
  bindCards(view);
  clearTimeout(mineTimer);
  if (data.articles.some(a => ['pending', 'in_review'].includes(a.status))) {
    mineTimer = setTimeout(() => { if (location.hash.startsWith('#/mine')) renderMine().catch(() => {}); }, 10000);
  }
  view.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    try {
      if (d.edit) location.hash = '#/write/' + d.edit;
      if (d.unpub) { await post(`/${d.unpub}/unpublish`); renderMine(); }
      if (d.del && confirm(t('confirmDelete'))) { await api('/' + d.del, { method: 'DELETE' }); renderMine(); }
      if (d.appeal) {
        const v = await ask(t('appeal'), `<textarea name="message" required minlength="10" maxlength="2000" class="bl-input" placeholder="${t('appealPh')}"></textarea>`, t('send'));
        if (v) { const r = await post(`/${d.appeal}/appeal`, v); toast(r.message || t('appealSent')); renderMine(); }
      }
    } catch { /* shown */ }
  };
}

/* ---------- Editor ---------- */
function toStoredHtml(root) {
  const clone = root.cloneNode(true);
  clone.querySelectorAll('img, video').forEach(el => {
    const s = el.getAttribute('src') || '';
    if (s.startsWith(API_ORIGIN + '/uploads/')) el.setAttribute('src', s.slice(API_ORIGIN.length));
  });
  clone.querySelectorAll('[data-sel]').forEach(el => el.removeAttribute('data-sel'));
  return clone.innerHTML;
}

const PENDING_UPLOAD_KEY = 'vynzo_blog_pending_upload';
let unloading = false;
window.addEventListener('pagehide', () => { unloading = true; });

// Uploads an image or video. The marker lets the editor recover the file if the page reloads before the reply arrives.
// Shrinks large photos to max 1600px WebP before upload so articles load fast. Falls back to the original file.
async function shrinkImage(file) {
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type) || file.size < 200 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/webp', 0.78));
    if (!blob || blob.type !== 'image/webp' || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.webp', { type: 'image/webp' });
  } catch { return file; }
}

async function uploadMedia(file, target) {
  sessionStorage.setItem(PENDING_UPLOAD_KEY, JSON.stringify({ target, at: Date.now() }));
  if (target !== 'video') file = await shrinkImage(file);
  const fd = new FormData();
  fd.append('image', file);
  try {
    const r = await api('/media', { method: 'POST', body: fd });
    sessionStorage.removeItem(PENDING_UPLOAD_KEY);
    return r;
  } catch (err) {
    if (!unloading) sessionStorage.removeItem(PENDING_UPLOAD_KEY);
    throw err;
  }
}
const uploadImage = async file => (await uploadMedia(file, 'image')).url;

async function renderEditor(id) {
  let a = { title: '', content_html: '', category: 'general', tags: [], cover_url: null };
  if (id) ({ article: a } = await api('/' + id));
  let currentId = id || null;
  let cover = a.cover_url;
  const dir = a.language === 'ar' ? 'rtl' : 'auto';
  view.innerHTML = `
    <h2>${id ? t('editArticle') : t('newArticle')}</h2>
    ${a.rejection_reason ? `<div class="bl-notice warn">${t('reason')}: ${esc(a.rejection_reason)}</div>` : ''}
    ${a.status === 'published' ? `<div class="bl-notice">${t('liveEditNote')}</div>` : ''}
    <div class="bl-notice">${t('policyNote')}</div>
    <label class="bl-label">${t('titleLbl')}</label>
    <input id="ed-title" class="bl-input" maxlength="200" dir="auto" placeholder="${t('titlePh')}" value="${esc(a.title)}">
    <div class="bl-two">
      <div><label class="bl-label">${t('category')}</label>
        <select id="ed-cat" class="bl-input">${state.meta.categories.map(c => `<option value="${c}" ${c === a.category ? 'selected' : ''}>${t('c_' + c)}</option>`).join('')}</select></div>
      <div><label class="bl-label">${t('tags')}</label>
        <input id="ed-tags" class="bl-input" dir="auto" value="${esc((a.tags || []).join(', '))}"></div>
    </div>
    <label class="bl-label">${t('cover')}</label>
    <div class="bl-row"><img id="ed-cover-img" class="bl-cover-preview" ${cover ? `src="${esc(mediaUrl(cover))}"` : 'hidden'} alt="">
      <button type="button" class="bl-btn bl-ghost" id="ed-cover-btn">${t('setCover')}</button>
      <button type="button" class="bl-btn bl-ghost" id="ed-cover-rm">${t('removeCover')}</button>
      <input type="file" id="ed-cover-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden></div>
    <label class="bl-label">${t('body')}</label>
    <div class="bl-toolbar" id="ed-bar">
      <button type="button" data-cmd="formatBlock" data-val="h2">H2</button>
      <button type="button" data-cmd="formatBlock" data-val="h3">H3</button>
      <button type="button" data-cmd="formatBlock" data-val="p">P</button>
      <button type="button" data-cmd="bold"><b>B</b></button>
      <button type="button" data-cmd="italic"><i>I</i></button>
      <button type="button" data-cmd="underline"><u>U</u></button>
      <button type="button" data-cmd="insertUnorderedList">&bull; List</button>
      <button type="button" data-cmd="insertOrderedList">1. List</button>
      <button type="button" data-cmd="formatBlock" data-val="blockquote">&ldquo; &rdquo;</button>
      <button type="button" data-ta="left" title="Align text left">&#8676;</button>
      <button type="button" data-ta="center" title="Center text">&#8596;</button>
      <button type="button" data-ta="right" title="Align text right">&#8677;</button>
      <button type="button" data-ta="justify" title="Justify text">&#9776;</button>
      <button type="button" data-act="link">&#128279; ${t('insertLink')}</button>
      <button type="button" data-act="image">&#128247; ${t('insertImage')}</button>
      <button type="button" data-act="video">&#127916; ${t('insertVideo')}</button>
      <button type="button" data-act="videofile">&#11014; ${t('uploadVideo')}</button>
      <input type="file" id="ed-img-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
      <input type="file" id="ed-vid-file" accept="video/mp4,video/webm,video/quicktime" hidden>
    </div>
    <div id="ed-body" class="bl-editor bl-body" contenteditable="true" dir="${dir}"></div>
    <div class="bl-row">
      <button class="bl-btn bl-ghost" id="ed-save">${t('saveDraft')}</button>
      <button class="bl-btn" id="ed-submit">${t(a.status === 'published' ? 'updateArticle' : 'submit')}</button>
    </div>`;
  const body = view.querySelector('#ed-body');
  body.innerHTML = a.content_html || '<p><br></p>';
  fixMedia(body);

  const draftKey = 'vynzo_blog_draft_' + (id || 'new');
  const readDraft = () => { try { return JSON.parse(sessionStorage.getItem(draftKey) || 'null'); } catch { return null; } };
  const draft = readDraft();
  if (draft) {
    view.querySelector('#ed-title').value = draft.title || '';
    view.querySelector('#ed-cat').value = draft.category || a.category;
    view.querySelector('#ed-tags').value = draft.tags || '';
    body.innerHTML = draft.html || '<p><br></p>';
    fixMedia(body);
    cover = draft.cover || null;
    const restoredCover = view.querySelector('#ed-cover-img');
    if (cover) { restoredCover.src = mediaUrl(cover); restoredCover.hidden = false; }
    else restoredCover.hidden = true;
  }
  const snapshot = () => {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({
        title: view.querySelector('#ed-title').value,
        category: view.querySelector('#ed-cat').value,
        tags: view.querySelector('#ed-tags').value,
        html: toStoredHtml(body),
        cover
      }));
    } catch { /* storage unavailable */ }
  };
  let draftTimer = null;
  const stashDraft = () => { clearTimeout(draftTimer); draftTimer = setTimeout(snapshot, 200); };
  view.querySelectorAll('#ed-title, #ed-cat, #ed-tags, #ed-body').forEach(el => {
    el.addEventListener('input', stashDraft);
    el.addEventListener('change', stashDraft);
  });
  window.onpagehide = snapshot;

  let saved = null;
  const insertAtCaret = html => { body.focus(); document.execCommand('insertHTML', false, html); };

  view.querySelector('#ed-bar').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  view.querySelector('#ed-bar').onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    body.focus();
    if (b.dataset.cmd) return document.execCommand(b.dataset.cmd, false, b.dataset.val || null);
    if (b.dataset.ta) {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const blocks = new Set();
      const blockOf = n => { for (; n && n !== body; n = n.parentNode) if (n.nodeType === 1 && /^(P|H2|H3|H4|BLOCKQUOTE|LI)$/.test(n.tagName)) return n; return null; };
      blocks.add(blockOf(range.startContainer)); blocks.add(blockOf(range.endContainer));
      body.querySelectorAll('p, h2, h3, h4, blockquote, li').forEach(el => { if (range.intersectsNode(el)) blocks.add(el); });
      if (!blocks.has(null) || blocks.size > 1) {
        blocks.delete(null);
        blocks.forEach(el => el.setAttribute('data-ta', b.dataset.ta));
      } else {
        document.execCommand('formatBlock', false, 'p');
        const el = blockOf(window.getSelection().anchorNode);
        if (el) el.setAttribute('data-ta', b.dataset.ta);
      }
      return snapshot();
    }
    if (b.dataset.act === 'link') {
      const url = prompt(t('linkPrompt'));
      if (url && /^https?:\/\//i.test(url)) document.execCommand('createLink', false, url);
    }
    if (b.dataset.act === 'image') view.querySelector('#ed-img-file').click();
    if (b.dataset.act === 'videofile') view.querySelector('#ed-vid-file').click();
    if (b.dataset.act === 'video') {
      const url = prompt(t('videoPrompt'));
      if (!url) return;
      try { const r = await post('/embed', { url }); insertAtCaret(`<iframe src="${esc(r.url)}"></iframe><p><br></p>`); snapshot(); toast(t('videoAdded')); } catch { /* shown */ }
    }
  };
  view.querySelector('#ed-img-file').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    toast(t('uploading'));
    try { const url = await uploadImage(f); insertAtCaret(`<img src="${esc(mediaUrl(url))}" alt=""><p><br></p>`); snapshot(); toast(t('imageUploaded')); } catch { /* shown */ }
  };
  const videoHtml = url => `<video src="${esc(mediaUrl(url))}" controls preload="metadata" playsinline></video><p><br></p>`;
  view.querySelector('#ed-vid-file').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    toast(t('uploading'));
    try { const r = await uploadMedia(f, 'video'); insertAtCaret(videoHtml(r.url)); snapshot(); toast(t('videoUploaded')); } catch { /* shown */ }
  };
  // Size / position controls for the selected image or video.
  const mediaBar = document.createElement('div');
  mediaBar.className = 'bl-mediabar';
  mediaBar.hidden = true;
  mediaBar.innerHTML = `
    <span>Size</span>
    ${[25, 33, 50, 75, 100].map(w => `<button type="button" data-w="${w}">${w}%</button>`).join('')}
    <span>Position</span>
    <button type="button" data-align="left">&#11013; Left</button>
    <button type="button" data-align="center">&#9726; Center</button>
    <button type="button" data-align="right">Right &#10145;</button>
    <button type="button" data-del="1">&#128465; Remove</button>`;
  body.before(mediaBar);
  let selectedMedia = null;
  const markBar = () => {
    mediaBar.querySelectorAll('button').forEach(b => {
      const on = selectedMedia && ((b.dataset.w && (selectedMedia.dataset.w || '100') === b.dataset.w)
        || (b.dataset.align && (selectedMedia.dataset.align || 'center') === b.dataset.align));
      b.classList.toggle('on', !!on);
    });
  };
  const selectMedia = el => {
    if (selectedMedia) selectedMedia.removeAttribute('data-sel');
    selectedMedia = el;
    if (el) el.setAttribute('data-sel', '1');
    mediaBar.hidden = !el;
    markBar();
  };
  body.addEventListener('click', e => selectMedia(e.target.closest('img, video, iframe') && body.contains(e.target) ? e.target.closest('img, video, iframe') : null));
  mediaBar.addEventListener('mousedown', e => e.preventDefault());
  mediaBar.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !selectedMedia) return;
    if (b.dataset.w) selectedMedia.setAttribute('data-w', b.dataset.w);
    if (b.dataset.align) selectedMedia.setAttribute('data-align', b.dataset.align);
    if (b.dataset.del) { const el = selectedMedia; selectMedia(null); el.remove(); }
    markBar();
    snapshot();
  });

  const coverImg = view.querySelector('#ed-cover-img');
  view.querySelector('#ed-cover-btn').onclick = () => view.querySelector('#ed-cover-file').click();
  view.querySelector('#ed-cover-file').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    toast(t('uploading'));
    try { cover = (await uploadMedia(f, 'cover')).url; coverImg.src = mediaUrl(cover); coverImg.hidden = false; snapshot(); toast(t('coverUploaded')); } catch { /* shown */ }
  };
  view.querySelector('#ed-cover-rm').onclick = () => { cover = null; coverImg.hidden = true; snapshot(); };

  // A page reload during an upload loses the server reply; fetch the finished file instead.
  (async () => {
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(PENDING_UPLOAD_KEY) || 'null'); } catch { /* ignore */ }
    if (!pending || Date.now() - pending.at > 120000) { sessionStorage.removeItem(PENDING_UPLOAD_KEY); return; }
    toast(t('uploading'));
    for (let i = 0; i < 20; i++) {
      const { upload } = await apiRequest('/blogs/media/last').catch(() => ({}));
      if (upload && upload.at >= pending.at - 2000) {
        sessionStorage.removeItem(PENDING_UPLOAD_KEY);
        if (pending.target === 'cover') { cover = upload.url; coverImg.src = mediaUrl(cover); coverImg.hidden = false; toast(t('coverUploaded')); }
        else if (upload.type === 'video') { body.insertAdjacentHTML('beforeend', videoHtml(upload.url)); toast(t('videoUploaded')); }
        else { body.insertAdjacentHTML('beforeend', `<img src="${API_ORIGIN}${upload.url}" alt=""><p><br></p>`); toast(t('imageUploaded')); }
        snapshot();
        return;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    sessionStorage.removeItem(PENDING_UPLOAD_KEY);
  })();

  const payload = () => ({
    title: view.querySelector('#ed-title').value,
    content_html: toStoredHtml(body),
    category: view.querySelector('#ed-cat').value,
    tags: view.querySelector('#ed-tags').value,
    cover_url: cover
  });
  async function save() {
    const r = currentId
      ? await api('/' + currentId, { method: 'PUT', body: JSON.stringify(payload()) })
      : await post('', payload());
    currentId = r.article.id;
    saved = r.article;
    sessionStorage.removeItem(draftKey);
    return r.article;
  }
  view.querySelector('#ed-save').onclick = async () => { try { await save(); toast(t('draftSaved')); } catch { /* shown */ } };
  view.querySelector('#ed-submit').onclick = async e => {
    e.target.disabled = true;
    try {
      await save();
      const r = await post(`/${currentId}/publish`);
      toast(t('status_' + r.status), r.status === 'rejected');
      location.hash = '#/mine';
    } catch { /* shown */ }
    e.target.disabled = false;
  };
}

/* ---------- Router ---------- */
async function route() {
  const [page, arg] = (location.hash.replace(/^#\/?/, '') || '').split('/');
  view.onclick = null;
  document.querySelectorAll('#blogs-tabs a[data-tab]').forEach(a => {
    const key = page === 'saved' ? 'saved' : page === 'mine' ? 'mine' : page === 'write' ? 'write' : 'feed';
    a.classList.toggle('active', a.dataset.tab === key);
  });
  window.scrollTo(0, 0);
  try {
    if (page === 'a' && arg) await renderArticle(arg);
    else if (page === 'u' && arg) await renderAuthor(arg);
    else if (page === 'mine') await renderMine();
    else if (page === 'saved') await renderBookmarks();
    else if (page === 'write') await renderEditor(arg);
    else await renderFeed();
  } catch (err) {
    view.innerHTML = `<p class="bl-empty">${esc(err.message || t('error'))}</p>`;
  }
}

async function init() {
  applyLang();
  const langBtn = document.getElementById('lang-btn');
  langBtn.textContent = t('langBtn');
  langBtn.onclick = () => { toggleLang(); langBtn.textContent = t('langBtn'); route(); };
  try { state.meta = await apiRequest('/blogs/meta'); }
  catch (err) { view.innerHTML = `<p class="bl-empty">${esc(err.message)}</p>`; return; }
  apiRequest('/blogs/admin/stats').then(() => { document.getElementById('admin-link').hidden = false; }).catch(() => {});
  window.addEventListener('hashchange', route);
  route();
}

init();
