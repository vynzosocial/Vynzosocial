import { apiRequest } from './api.js?v=sb6';
import { API_ORIGIN } from './config.js?v=sb4';
import { createRealtimeSocket } from './realtime.js?v=sb9';
import { startLiveFrameGuard } from './content-guard.js?v=1';
import { createCameraFilter } from './live-camera-filter.js?v=5';

let stopLiveFrameGuard = null;
let socket = null;
let cameraStream = null;
let cameraMirrored = false;
let cameraFilter = null;
let cameraFilterName = 'none';
let cameraFilterSetup = null;
let cameraFilterGeneration = 0;
let imageStream = null;
let imageObjectUrl = null;
let imageAnimationFrame = null;
let localVideoTrack = null;
let localAudioTrack = null;
let peerConnections = {};
let pendingIceCandidates = {};
let peerSenders = {};
let remoteMediaStreams = {};
let peerNegotiationState = {};
let pendingNegotiations = {};
let activeBroadcastSessionId = null;
let activeRoomSessionId = null;
let selectedLiveSessionId = null;
let broadcastStartedAt = 0;
let missedStreamPolls = 0;
let liveStreamsRefreshInterval = null;
let renderedStreamIds = null;
const HD_VIDEO_CONSTRAINTS = { width: { ideal: 1920, min: 640 }, height: { ideal: 1080, min: 360 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' };
const HD_AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 };
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: ['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443','turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' }] };

const LIVE_TITLE_KEY = 'vynzo_live_title';
const LIVE_AUDIENCE_KEY = 'vynzo_live_selected_viewers';
const TITLE_EMOJIS = ['😀','😂','😍','🔥','🎉','🎶','🎮','💬','❤️','👏','✨','🌟','🙏','😎','🤝','📣'];

export function getSelectedLiveAudience() {
  try {
    const ids = JSON.parse(sessionStorage.getItem(LIVE_AUDIENCE_KEY) || '[]');
    return Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string'))] : [];
  } catch (err) {
    console.warn('Could not read the selected livestream audience:', err);
    return [];
  }
}

export function getSavedLiveTitle() {
  return localStorage.getItem(LIVE_TITLE_KEY) || '';
}

// Inline title field with an emoji bar. onCommit(title) runs on Enter or when the field loses focus.
export function createTitleEditor({ value = '', onCommit, autoSave = false } = {}) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;min-width:0';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;align-items:center';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 100;
  input.value = value;
  input.placeholder = 'Live title \u2728';
  input.style.cssText = 'flex:1;min-width:0;padding:8px 10px;border-radius:10px;border:1px solid #5b38ff;background:#120d22;color:#fff;font-size:14px';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = '\uD83D\uDE00';
  toggle.title = 'Add emoji';
  toggle.style.cssText = 'font-size:18px;background:#2a2045;border:0;border-radius:8px;padding:4px 8px;cursor:pointer';
  const emojis = document.createElement('div');
  emojis.hidden = true;
  emojis.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';
  const commit = () => {
    const title = input.value.trim();
    if (title) localStorage.setItem(LIVE_TITLE_KEY, title);
    if (onCommit) onCommit(title);
  };
  TITLE_EMOJIS.forEach((emoji) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.style.cssText = 'font-size:18px;background:#2a2045;border:0;border-radius:8px;padding:2px 6px;cursor:pointer';
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
      input.focus();
      input.setSelectionRange(start + emoji.length, start + emoji.length);
      if (autoSave) commit();
    });
    emojis.appendChild(b);
  });
  toggle.addEventListener('mousedown', e => e.preventDefault());
  toggle.addEventListener('click', () => { emojis.hidden = !emojis.hidden; input.focus(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); } });
  input.addEventListener(autoSave ? 'input' : 'blur', commit);
  row.append(input, toggle);
  wrap.append(row, emojis);
  return { element: wrap, input };
}

export async function initLiveStudio() {
  const container = document.getElementById('live-streams-list');
  if (!container) return;

  const setScreenSecure = enabled => window.Capacitor?.Plugins?.ScreenGuard?.setSecure({ enabled })?.catch?.(() => {});
  setScreenSecure(true);
  window.addEventListener('pagehide', () => setScreenSecure(false));

  const token = localStorage.getItem('vynzo_token');
  socket = createRealtimeSocket({
    auth: token ? { token } : {},
    autoConnect: false
  });
  socket.on('connect_error', (err) => {
    console.error('Live connection failed:', err.message);
    setLiveChatStatus('Chat server unavailable. Reconnecting...', false);
    showLiveError('Unable to connect to live chat. Please refresh and try again.');
  });
  socket.on('disconnect', () => {
    activeRoomSessionId = null;
    closeAllPeerConnections();
    setLiveChatStatus('Reconnecting to chat...', false);
  });
  socket.on('connect', () => {
    if (selectedLiveSessionId) joinLiveRoom(selectedLiveSessionId);
  });

  const streams = await refreshLiveStreams();
  clearInterval(liveStreamsRefreshInterval);
  liveStreamsRefreshInterval = setInterval(refreshLiveStreams, 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshLiveStreams();
  });

  const requestedSessionId = new URLSearchParams(window.location.search).get('sessionId');
  if (requestedSessionId && streams) {
    const requestedStream = streams.find(stream => String(stream.id) === requestedSessionId);
    if (requestedStream) {
      await joinLiveSession(requestedStream);
    } else {
      const mainView = document.getElementById('live-main-view');
      if (mainView) {
        mainView.textContent = 'This livestream is no longer active.';
      }
    }
  }
  if (!socket.connected && !socket.active) socket.connect();
}

async function refreshLiveStreams() {
  try {
    const data = await apiRequest('/live');
    renderActiveStreams(data.liveStreams);
    return data.liveStreams;
  } catch (err) {
    console.error('Failed to load live streams:', err);
    return null;
  }
}

function renderActiveStreams(streams) {
  const container = document.getElementById('live-streams-list');
  if (!container) return;

  const hostStartingUp = activeBroadcastSessionId && Date.now() - broadcastStartedAt < 15000;
  const isOwnBroadcast = Boolean(activeBroadcastSessionId) && activeBroadcastSessionId === selectedLiveSessionId;
  const selectedMissing = selectedLiveSessionId && !streams.some(stream => stream.id === selectedLiveSessionId);
  missedStreamPolls = selectedMissing ? missedStreamPolls + 1 : 0;
  // The host only ends a stream explicitly; viewers need two consecutive misses to avoid a flaky poll.
  if (selectedMissing && !hostStartingUp && !isOwnBroadcast && missedStreamPolls >= 2) {
    missedStreamPolls = 0;
    selectedLiveSessionId = null;
    activeRoomSessionId = null;
    closeAllPeerConnections();
    stopLocalMedia();
    const input = document.getElementById('live-chat-input');
    if (input) input.disabled = true;
    document.querySelectorAll('.live-media-button:not(#live-guest-exit-btn), #live-image-file').forEach(control => {
      control.disabled = true;
    });
    setLiveChatStatus('This livestream has ended. Select an active stream to join.', false);
    const goLive = document.getElementById('start-broadcast-btn');
    if (goLive && !activeBroadcastSessionId) goLive.style.display = '';
    document.querySelector('.live-container')?.classList.add('live-stage-ended');
    if (activeBroadcastSessionId) {
      activeBroadcastSessionId = null;
      const broadcastButton = document.getElementById('start-broadcast-btn');
      if (broadcastButton) broadcastButton.textContent = 'Go Live';
      window.location.href = '../index.html';
    } else {
      setTimeout(() => { window.location.href = '../index.html'; }, 1500);
    }
  }

  const streamIds = streams.map(stream => `${stream.id}:${stream.is_friend ? 1 : 0}`).sort().join(',');
  if (renderedStreamIds === streamIds) {
    streams.forEach(stream => {
      const count = container.querySelector(`[data-viewer-count="${stream.id}"]`);
      if (count) count.textContent = stream.viewer_count;
    });
    return;
  }

  renderedStreamIds = streamIds;
  const loggedIn = Boolean(localStorage.getItem('vynzo_token'));
  const avatarSrc = url => url ? (/^https?:/i.test(url) ? url : `${API_ORIGIN}${url}`) : '';
  const cardHtml = stream => `
    <div class="stream-card${stream.is_friend ? ' is-friend-live' : ''}" data-session-id="${stream.id}" style="display:flex;align-items:center;gap:10px;padding:12px 16px; border-bottom:1px solid var(--border-color); cursor:pointer;${stream.is_friend ? ' background:linear-gradient(90deg,rgba(255,200,60,.14),transparent); border-left:3px solid #ffc83c;' : ''}">
      ${stream.host_avatar_url ? `<img src="${escapeHtml(avatarSrc(stream.host_avatar_url))}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex:none;box-shadow:0 0 0 2px #e5334b;">` : ''}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(stream.title)}</div>
        <div style="font-size:12px; color:var(--text-muted);">@${escapeHtml(stream.host_username || 'user')} | Viewers: <span data-viewer-count="${stream.id}">${stream.viewer_count}</span></div>
      </div>
      <span style="flex:none;padding:5px 12px;border-radius:14px;background:#e5334b;color:#fff;font-size:12px;font-weight:700;">Join</span>
    </div>
  `;
  const friendStreams = streams.filter(stream => stream.is_friend);
  const otherStreams = streams.filter(stream => !stream.is_friend);
  const sectionTitle = text => `<div style="padding:10px 16px 4px; font-size:12px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted);">${text}</div>`;
  const friendsBlock = loggedIn
    ? sectionTitle('&#128101; Friends live now') + (friendStreams.length
      ? friendStreams.map(cardHtml).join('')
      : '<p style="padding:6px 16px 12px; color:var(--text-muted); font-size:13px;">None of your friends are live right now.</p>')
    : '';
  const everyone = streams.length
    ? (loggedIn ? sectionTitle('Everyone') : '') + otherStreams.map(cardHtml).join('')
    : '<p style="padding:16px; color:var(--text-muted);">No active livestreams right now. Start one!</p>';
  container.innerHTML = friendsBlock + everyone;

  container.querySelectorAll('.stream-card').forEach(card => {
    card.addEventListener('click', () => {
      const stream = streams.find(item => String(item.id) === card.dataset.sessionId);
      if (stream) joinLiveSession(stream);
    });
  });
}

async function joinLiveSession(stream) {
  const sessionId = String(stream.id);
  if (selectedLiveSessionId === sessionId && activeRoomSessionId === sessionId) return;
  if (selectedLiveSessionId && selectedLiveSessionId !== sessionId) {
    closeAllPeerConnections();
    await stopLocalMedia();
  }
  const currentUser = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  const isHost = currentUser.id === stream.host_id;
  if (isHost) {
    activeBroadcastSessionId = sessionId;
    const broadcastButton = document.getElementById('start-broadcast-btn');
    if (broadcastButton) {
      broadcastButton.textContent = 'Exit Live';
      broadcastButton.style.display = 'none';
      broadcastButton.setAttribute('aria-label', 'Exit live and return home');
    }
  }
  const goLiveButton = document.getElementById('start-broadcast-btn');
  document.querySelector('.live-container')?.classList.remove('live-stage-ended');
  if (goLiveButton && !activeBroadcastSessionId) goLiveButton.style.display = isHost ? '' : 'none';
  const mainView = document.getElementById('live-main-view');
  mainView.innerHTML = createLiveStage(
    'Say something in live chat...',
    isHost,
    stream.host_username,
    stream.title,
    { id: stream.host_id, name: stream.host_display_name || stream.host_username, avatar: stream.host_avatar_url }
  );
  if (!isHost) setupFriendButton(stream.host_id);
  liveHostInfo = { name: stream.host_display_name || stream.host_username || 'Host', avatar_url: stream.host_avatar_url || null };
  liveHostSocketId = null;
  attachLiveHeader(isHost);
  Object.keys(hostGuestMuted).forEach(key => delete hostGuestMuted[key]);

  attachLiveChatForm(sessionId);
  registerLiveListeners();
  attachLiveMediaControls();
  if (isHost) attachChatStyleControls(sessionId);
  ensureHostPlaceholder();
  document.querySelectorAll('.live-media-button:not(#live-guest-exit-btn), #live-image-file').forEach(control => {
    control.disabled = false;
  });
  joinLiveRoom(sessionId);
}

function joinLiveRoom(sessionId, attempt = 1) {
  selectedLiveSessionId = sessionId;
  const input = document.getElementById('live-chat-input');
  if (input) input.disabled = true;
  document.querySelectorAll('.live-chat-error').forEach(notice => notice.remove());
  setLiveChatStatus(attempt > 1 ? 'Reconnecting to chat...' : 'Connecting to chat...', false);

  const enterRoom = () => {
    socket.timeout(10000).emit('join_live_room', sessionId, (err, result) => {
      if (err) {
        if (selectedLiveSessionId !== sessionId) return;
        if (attempt < 3) {
          if (!socket.connected) socket.connect();
          setTimeout(() => {
            if (selectedLiveSessionId === sessionId && activeRoomSessionId !== sessionId) joinLiveRoom(sessionId, attempt + 1);
          }, 1000);
          return;
        }
        activeRoomSessionId = null;
        selectedLiveSessionId = null;
        if (input) input.disabled = true;
        setLiveChatStatus('Unable to confirm chat connection. Select the stream to retry.', false);
        showLiveError('Could not connect to live chat. Please select this stream to retry.');
        refreshLiveStreams();
        return;
      }
      if (!result || !result.ok) {
        activeRoomSessionId = null;
        selectedLiveSessionId = null;
        if (input) input.disabled = true;
        setLiveChatStatus('Chat unavailable', false);
        showLiveError(result?.error || 'Unable to join this livestream.');
        refreshLiveStreams();
        return;
      }

      activeRoomSessionId = sessionId;
      if (input) input.disabled = false;
      setLiveChatStatus('Connected', true);
      applyLiveLayout(result.layout, result.hostSocketId);
      refreshViewers();
      (result.messages || []).forEach(renderChatMessage);
    });
  };

  if (activeRoomSessionId && activeRoomSessionId !== sessionId) {
    socket.timeout(5000).emit('leave_live_room', activeRoomSessionId, (err) => {
      if (err) {
        showLiveError('Unable to leave the previous live chat.');
        return;
      }
      enterRoom();
    });
    activeRoomSessionId = null;
    return;
  }

  if (!socket.connected) {
    socket.connect();
    return;
  }
  enterRoom();
}

function setLiveChatStatus(message, connected) {
  const dot = document.getElementById('live-status-dot');
  if (!dot) return;
  dot.classList.toggle('is-on', Boolean(connected));
  dot.title = connected ? 'Live is on' : 'Live is off';
  dot.setAttribute('aria-label', dot.title);
}

let liveHostSocketId = null;
let liveHostInfo = null;

// Keeps the host visible with their profile photo while their camera is off.
function ensureHostPlaceholder() {
  if (!liveHostInfo || !document.getElementById('live-video-grid')) return;
  if (!isGuestRole()) {
    if (localVideoTrack) return;
    const tile = ensureVideoTile('self', true);
    if (tile) tile.video.srcObject = null;
    showStageGuestTile('self', liveHostInfo, true);
  } else if (liveHostSocketId) {
    showStageGuestTile(liveHostSocketId, liveHostInfo, false);
  }
}
let viewersTimer = null;

async function showProfile(userId) {
  if (!userId) return;
  try {
    const mod = await import('./users.js?v=report-reasons1');
    await mod.openUserProfile(userId);
  } catch (err) {
    console.error('Unable to open profile:', err);
  }
}

function applyLiveLayout(layout, hostSocketId) {
  if (hostSocketId !== undefined) liveHostSocketId = hostSocketId;
  ensureHostPlaceholder();
  updateVideoGridLayout();
}

function refreshViewers() {
  if (!socket || !socket.connected || !activeRoomSessionId) return;
  socket.timeout(5000).emit('live_viewers', (err, res) => {
    if (err || !res || !res.ok) return;
    const total = document.getElementById('live-viewers-total');
    const avatars = document.getElementById('live-viewers-avatars');
    const menu = document.getElementById('live-viewers-menu');
    if (!total || !avatars || !menu) return;
    const viewers = res.viewers || [];
    total.textContent = String(res.total ?? viewers.length);
    avatars.innerHTML = viewers.slice(0, 1)
      .map(v => liveAvatarHtml(v.avatar_url, v.display_name || v.username, 'live-avatar live-avatar-sm'))
      .join('');
    menu.replaceChildren(...viewers.map(v => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'live-viewer-row';
      row.setAttribute('role', 'menuitem');
      row.innerHTML = `${liveAvatarHtml(v.avatar_url, v.display_name || v.username)}<span>${escapeHtml(v.display_name || v.username)}<small>@${escapeHtml(v.username)}</small></span>`;
      row.addEventListener('click', () => {
        menu.hidden = true;
        showProfile(v.id);
      });
      return row;
    }));
    if (!viewers.length) {
      const empty = document.createElement('p');
      empty.className = 'live-viewers-empty';
      empty.textContent = 'No signed-in viewers yet.';
      menu.replaceChildren(empty);
    }
  });
}

function scheduleViewersRefresh() {
  clearTimeout(viewersTimer);
  viewersTimer = setTimeout(refreshViewers, 300);
}

function attachLiveHeader() {
  const chip = document.getElementById('live-host-chip');
  if (chip) {
    chip.addEventListener('click', () => showProfile(chip.dataset.userId));
  }

  const viewersBtn = document.getElementById('live-viewers-btn');
  const menu = document.getElementById('live-viewers-menu');
  if (viewersBtn && menu) {
    viewersBtn.addEventListener('click', event => {
      event.stopPropagation();
      menu.hidden = !menu.hidden;
      viewersBtn.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) refreshViewers();
    });
    menu.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => {
      menu.hidden = true;
      viewersBtn.setAttribute('aria-expanded', 'false');
    });
  }

  const hostExit = document.getElementById('live-host-exit-btn');
  if (hostExit) {
    hostExit.addEventListener('click', () => {
      if (confirm('End your live stream?')) exitBroadcasting();
    });
  }

  updateVideoGridLayout();
}

function showLiveError(message) {
  const chatBox = document.getElementById('live-chat-messages');
  if (!chatBox) return;
  const notice = document.createElement('p');
  notice.className = 'live-chat-error';
  notice.textContent = message;
  chatBox.appendChild(notice);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function setupFriendButton(hostId) {
  const button = document.getElementById('live-add-friend-btn');
  if (!button || !hostId) return;
  const paint = rel => {
    button.hidden = false;
    button.dataset.following = rel.is_following ? '1' : '';
    button.textContent = rel.is_friend ? 'Friends \u2713' : rel.is_following ? 'Added \u2713' : '+ Add friend';
  };
  try {
    const data = await apiRequest(`/users/${encodeURIComponent(hostId)}/profile`);
    if (data.profile?.is_owner) return;
    paint(data.profile);
  } catch (_) { return; }
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const rel = await apiRequest(`/users/${encodeURIComponent(hostId)}/follow`, {
        method: button.dataset.following ? 'DELETE' : 'POST'
      });
      paint(rel);
    } catch (err) {
      showLiveError(err.message || 'Could not update friendship.');
    } finally {
      button.disabled = false;
    }
  });
}

function liveAvatarHtml(avatarUrl, name, cls = 'live-avatar') {
  const initial = escapeHtml(String(name || 'U').trim().charAt(0).toUpperCase() || 'U');
  const img = avatarUrl ? `<img src="${escapeHtml(API_ORIGIN + avatarUrl)}" alt="" onerror="this.remove()">` : '';
  return `<span class="${cls}">${initial}${img}</span>`;
}

function createLiveStage(placeholder, isHost, hostUsername = '', title = '', hostInfo = {}) {
  const hostName = hostInfo.name || hostUsername || 'Host';
  return `
    <div class="live-stage">
      <header class="live-session-context">
        <span class="live-role-badge ${isHost ? 'is-host' : 'is-guest'}" style="display:none" aria-hidden="true"></span>
        <button type="button" class="live-host-chip" id="live-host-chip" data-user-id="${escapeHtml(hostInfo.id || '')}" aria-label="View ${escapeHtml(hostName)}'s profile">
          ${liveAvatarHtml(hostInfo.avatar, hostName, 'live-avatar live-avatar-host')}
          <span class="live-host-text"><strong>${escapeHtml(hostName)}${isHost ? '<span class="live-you-badge">You live</span>' : ''}</strong><small id="live-title-text">${escapeHtml(title)}</small></span>
        </button>
        ${isHost
          ? '<button type="button" class="live-media-button live-header-btn" id="live-edit-title-btn" aria-label="Edit title">&#9998;</button>'
          : '<button type="button" class="live-media-button live-header-btn" id="live-add-friend-btn" hidden>+ Add friend</button>'}
        <div class="live-viewers">
          <button type="button" class="live-viewers-btn" id="live-viewers-btn" aria-haspopup="true" aria-expanded="false" aria-label="People watching">
            <span class="live-viewers-avatars" id="live-viewers-avatars"></span>
            <b id="live-viewers-total">0</b><span aria-hidden="true">&#9662;</span>
          </button>
          <div class="live-viewers-menu" id="live-viewers-menu" role="menu" hidden></div>
        </div>
        <span class="live-status-dot" id="live-status-dot" role="status" aria-label="Live is off" title="Live is off"></span>
        <button type="button" class="live-exit-x" id="${isHost ? 'live-host-exit-btn' : 'live-guest-exit-btn'}" aria-label="Exit live">&#10005;</button>
      </header>
      <section class="live-chat-panel" aria-label="Live chat">
        <input type="hidden" id="live-chat-name">
        ${isHost ? `
          <div class="live-chat-style-controls" aria-label="Chat appearance controls">
            <label>Background <input id="chat-background-color" type="color" value="#1a1b22"></label>
            <label>Text <input id="chat-font-color" type="color" value="#ffffff"></label>
            <label class="live-chat-size-control">Size <input id="chat-font-size" type="range" min="12" max="24" value="13"><output id="chat-font-size-value">13px</output></label>
          </div>
        ` : ''}
        <div class="live-chat-box" id="live-chat-messages" aria-live="polite"></div>
        <form class="live-controls-bar" id="live-chat-form">
          <div class="live-chat-composer">
            <div class="live-chat-emoji-picker" id="live-chat-emoji-picker" role="group" aria-label="Choose an emoji" hidden>
              ${['😀', '😂', '😍', '🥰', '😎', '😭', '🔥', '❤️', '👏', '🎉', '👍', '🙏'].map(emoji => `
                <button type="button" class="live-chat-emoji" aria-label="${emoji}" data-emoji="${emoji}">${emoji}</button>
              `).join('')}
            </div>
            <div class="live-chat-input-row">
              <button type="button" class="live-chat-emoji-toggle" aria-label="Add emoji" aria-expanded="false" aria-controls="live-chat-emoji-picker">☺</button>
              <input type="text" class="chat-input" id="live-chat-input" placeholder="${placeholder}" maxlength="500" required autocomplete="off">
              <button type="submit" class="btn-live">Send</button>
            </div>
          </div>
        </form>
      </section>
      <div class="live-video-area">
        ${isHost ? `<div class="live-host-tools">
          <span id="live-host-guests" class="live-host-guests"></span>
        </div>` : ''}        <div class="live-media-controls" aria-label="Camera and image sharing">
          <div class="live-media-description">
            <strong></strong>
            <span id="live-media-status">${isHost ? 'Your camera is off. Choose an option to share with everyone.' : 'Tap "Request to Join" to ask the host to put you on camera. You can keep chatting meanwhile (up to 11 guests on camera).'}</span>
          </div>
          <div class="live-media-actions">
            <button type="button" class="live-media-button" id="live-enable-camera-btn">${isHost ? 'Open camera' : '🎤 Request to Join'}</button>
            <button type="button" class="live-media-button" id="live-mirror-camera-btn" aria-pressed="false" title="Mirror your preview; viewers see the normal camera view" hidden>Mirror camera</button>
            <label class="live-camera-filter" id="live-camera-filter-control" title="Effects are processed on your device and visible to live viewers" hidden>
              <span>Filter</span>
              <select id="live-camera-filter" aria-label="Camera filter or face effect">
                <option value="none">None</option>
                <option value="warm">Warm</option>
                <option value="cool">Cool</option>
                <option value="vivid">Vivid</option>
                <option value="mono">Black &amp; white</option>
                <option value="lipstick">Lipstick</option>
                <option value="blush">Blush</option>
                <option value="skin">Skin smoothing</option>
                <option value="eyeshadow">Eyeshadow</option>
                <option value="eyeliner">Eyeliner</option>
                <option value="lashes">Eyelashes</option>
                <option value="eyebrows">Eyebrows</option>
                <option value="eyes-blue">Blue eyes</option>
                <option value="eyes-green">Green eyes</option>
                <option value="eyes-violet">Violet eyes</option>
                <option value="glasses">Glasses</option>
                <option value="hat">Party hat</option>
                <option value="stars">Star stickers</option>
                <option value="party">Party look</option>
                <option value="background-blue">Blue background</option>
                <option value="background-purple">Purple background</option>
                <option value="background-dark">Dark background</option>
                <option value="background-image">Choose background image...</option>
              </select>
            </label>
            <input id="live-background-file" type="file" accept="image/jpeg,image/png,image/webp" hidden>
            <button type="button" class="live-media-button live-media-image-button" id="live-select-image-btn">${isHost ? 'Choose image' : 'Use image'}</button>
            <input id="live-image-file" type="file" accept="image/*" hidden>
            <button type="button" class="live-media-button live-media-off-button" id="live-turn-media-off-btn" hidden>${isHost ? 'Turn media off' : 'Leave stage'}</button>
            ${isHost ? '' : '<button type="button" class="live-media-button" id="live-self-mute-btn" hidden>&#128263; Mute me</button>'}
          </div>
        </div>
        <div class="live-video-grid" id="live-video-grid">
          <div class="live-video-empty" id="live-video-empty">
            <span aria-hidden="true">◉</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function attachLiveChatForm(sessionId) {
  const currentUser = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
  let guestName = localStorage.getItem('vynzo_chat_name');
  if (!currentUser.id && !guestName) {
    guestName = `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
    localStorage.setItem('vynzo_chat_name', guestName);
  }

  const nameInput = document.getElementById('live-chat-name');
  nameInput.value = currentUser.id
    ? (currentUser.display_name || currentUser.username || 'Member').slice(0, 24)
    : guestName;
  nameInput.readOnly = Boolean(currentUser.id);

  if (!currentUser.id) {
    nameInput.addEventListener('change', () => {
      const name = nameInput.value.trim().slice(0, 24);
      nameInput.value = name || guestName;
      guestName = nameInput.value;
      localStorage.setItem('vynzo_chat_name', guestName);
    });
  }

  const chatForm = document.getElementById('live-chat-form');
  const input = document.getElementById('live-chat-input');
  const emojiToggle = chatForm.querySelector('.live-chat-emoji-toggle');
  const emojiPicker = chatForm.querySelector('.live-chat-emoji-picker');

  emojiToggle.addEventListener('click', () => {
    const isExpanded = emojiToggle.getAttribute('aria-expanded') === 'true';
    emojiToggle.setAttribute('aria-expanded', String(!isExpanded));
    emojiPicker.hidden = isExpanded;
    if (!isExpanded) input.focus();
  });

  emojiPicker.addEventListener('click', (event) => {
    const emojiButton = event.target.closest('[data-emoji]');
    if (!emojiButton) return;

    const emoji = emojiButton.dataset.emoji;
    if (input.value.length + emoji.length > input.maxLength) return;

    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(emoji, start, end, 'end');
    input.focus();
    emojiPicker.hidden = true;
    emojiToggle.setAttribute('aria-expanded', 'false');
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !emojiPicker.hidden) {
      emojiPicker.hidden = true;
      emojiToggle.setAttribute('aria-expanded', 'false');
      emojiToggle.focus();
    }
  });

  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const content = input.value.trim();
    const username = nameInput.value.trim();
    if (!content || !username) return;
    if (!socket.connected || activeRoomSessionId !== sessionId) {
      showLiveError('You are not connected to this live chat yet. Your message is still in the box.');
      if (socket.connected) joinLiveRoom(sessionId);
      else socket.connect();
      return;
    }

    socket.timeout(5000).emit('live_chat_message', {
      sessionId,
      username,
      content
    }, (err, result) => {
      if (err || !result || !result.ok) {
        showLiveError(result?.error || 'Message was not sent. Please try again.');
        return;
      }
      input.value = '';
      emojiPicker.hidden = true;
      emojiToggle.setAttribute('aria-expanded', 'false');
    });
  });
}

function attachLiveMediaControls() {
  const cameraButton = document.getElementById('live-enable-camera-btn');
  const imageButton = document.getElementById('live-select-image-btn');
  const imageInput = document.getElementById('live-image-file');
  const offButton = document.getElementById('live-turn-media-off-btn');
  const mirrorButton = document.getElementById('live-mirror-camera-btn');
  const filterSelect = document.getElementById('live-camera-filter');
  const backgroundInput = document.getElementById('live-background-file');
  if (!cameraButton || !imageInput || !offButton) return;

  cameraButton.addEventListener('click', enableLocalCamera);
  if (filterSelect) filterSelect.addEventListener('change', () => {
    if (filterSelect.value === 'background-image') {
      filterSelect.value = cameraFilterName;
      backgroundInput?.click();
    } else applyLocalCameraFilter(filterSelect.value);
  });
  if (backgroundInput) backgroundInput.addEventListener('change', async () => {
    const file = backgroundInput.files?.[0];
    backgroundInput.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
      showLiveError('Choose a JPEG, PNG or WebP image smaller than 10 MB.');
      return;
    }
    const generation = cameraFilterGeneration;
    const source = cameraStream?.getVideoTracks()[0];
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
      image.src = url;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 32000000) {
        throw new Error('Image dimensions are too large.');
      }
      if (generation !== cameraFilterGeneration || !source || !cameraStream?.getVideoTracks().includes(source)) {
        showLiveError('Background selection was cancelled because your camera changed.');
        return;
      }
      await applyLocalCameraFilter('background-image', image);
    } catch (error) {
      console.error('Unable to open background image:', error);
      showLiveError('Could not open this background image. Choose a different image.');
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  if (mirrorButton) {
    mirrorButton.addEventListener('click', () => {
      cameraMirrored = !cameraMirrored;
      applyCameraMirror();
    });
  }
  if (imageButton) imageButton.addEventListener('click', () => imageInput.click());
  const titleButton = document.getElementById('live-edit-title-btn');
  const guestExit = document.getElementById('live-guest-exit-btn');
  if (guestExit) {
    guestExit.addEventListener('click', () => {
      try {
        if (socket && selectedLiveSessionId) socket.emit('leave_live_room', selectedLiveSessionId);
        activeRoomSessionId = null;
        selectedLiveSessionId = null;
        closeAllPeerConnections();
        stopLocalMedia().catch(() => {});
      } finally {
        window.location.replace('../index.html');
      }
    });
  }
  if (titleButton) {
    titleButton.addEventListener('click', () => {
      const textEl = document.getElementById('live-title-text');
      if (!textEl || document.getElementById('live-title-inline')) return;
      const current = textEl.textContent;
      const holder = document.createElement('div');
      holder.id = 'live-title-inline';
      holder.style.cssText = 'position:absolute;z-index:30;left:8px;right:8px;top:100%;margin-top:4px;padding:8px;background:#1d1631;border:1px solid #7a5cff;border-radius:12px';
      const finish = () => holder.remove();
      const { element, input } = createTitleEditor({
        value: current,
        onCommit: async (next) => {
          finish();
          if (!next || next === current) return;
          try {
            await apiRequest(`/live/${activeBroadcastSessionId}/title`, {
              method: 'PATCH',
              body: JSON.stringify({ title: next })
            });
            textEl.textContent = next;
            refreshLiveStreams();
          } catch (err) {
            showLiveError('Could not change the title: ' + err.message);
          }
        }
      });
      holder.appendChild(element);
      const host = titleButton.closest('.live-session-context') || titleButton.parentElement;
      host.style.position = 'relative';
      host.appendChild(holder);
      input.focus();
      input.select();
    });
  }
  imageInput.addEventListener('change', () => {
    const image = imageInput.files && imageInput.files[0];
    imageInput.value = '';
    if (image) useLocalImage(image);
  });
  offButton.addEventListener('click', stopLocalMedia);
  const selfMute = document.getElementById('live-self-mute-btn');
  if (selfMute) {
    selfMute.addEventListener('click', () => {
      guestMuted = !guestMuted;
      applyMute();
      socket.emit('live_self_mute', { muted: guestMuted });
    });
  }
}

async function enableLocalCamera() {
  const joiningStage = isGuestRole() && !guestOnStage;
  if (!(await requestGuestSlot())) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showLiveError('Camera access is not available in this browser.');
    return;
  }

  if (joiningStage) {
    // Guests join with the camera off; they open it afterwards.
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: HD_AUDIO_CONSTRAINTS });
      stopCameraFilter();
      stopImageSource();
      if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
      cameraStream = audioStream;
      localVideoTrack = null;
      localAudioTrack = audioStream.getAudioTracks()[0] || null;
      await publishLocalMedia();
    } catch (err) {
      console.warn('Microphone unavailable for guest:', err.message);
      showLiveError('The host accepted you, but microphone access was blocked. Allow the microphone in your browser settings to talk.');
    }
    const cameraBtn = document.getElementById('live-enable-camera-btn');
    if (cameraBtn) cameraBtn.textContent = '📷 Turn camera on';
    updateLocalMediaControls('You are on stage with your camera off. Tap "Turn camera on" when you are ready.');
    return;
  }

  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: HD_VIDEO_CONSTRAINTS, audio: HD_AUDIO_CONSTRAINTS });
    } catch (audioError) {
      console.warn('Microphone unavailable; trying camera without audio:', audioError.message);
      stream = await navigator.mediaDevices.getUserMedia({ video: HD_VIDEO_CONSTRAINTS });
      showLiveError('Camera is on, but microphone access is unavailable.');
    }
    stopCameraFilter();
    stopImageSource();
    if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = stream;
    localVideoTrack = stream.getVideoTracks()[0] || null;
    localAudioTrack = stream.getAudioTracks()[0] || null;
    await publishLocalMedia();
    updateLocalMediaControls(
      localAudioTrack
        ? 'Your camera and microphone are being shared with everyone.'
        : 'Your camera is being shared without microphone audio.'
    );
  } catch (err) {
    console.error('Unable to access the live camera:', err);
    showLiveError('Unable to open the camera. Check browser permissions, or choose an image instead.');
  }
}

async function useLocalImage(file) {
  if (!(await requestGuestSlot())) return;
  if (file.type && !file.type.startsWith('image/')) {
    showLiveError('Choose a valid image file.');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showLiveError('Choose an image smaller than 10 MB.');
    return;
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = objectUrl;
    });
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    showLiveError('This image could not be opened. Choose a different image.');
    return;
  }

  const scale = Math.min(1, 1280 / image.naturalWidth, 1280 / image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    URL.revokeObjectURL(objectUrl);
    showLiveError('Unable to prepare this image for livestreaming.');
    return;
  }

  const drawImageFrame = () => {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    imageAnimationFrame = requestAnimationFrame(drawImageFrame);
  };
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let nextImageStream;
  try {
    nextImageStream = canvas.captureStream(10);
    if (!nextImageStream.getVideoTracks()[0]) throw new Error('No image video track was created.');
  } catch (err) {
    if (nextImageStream) nextImageStream.getTracks().forEach(track => track.stop());
    URL.revokeObjectURL(objectUrl);
    console.error('Unable to prepare image video:', err);
    showLiveError('This browser cannot share images as live video.');
    return;
  }
  stopCameraFilter();
  stopImageSource();
  if (cameraStream) {
    cameraStream.getVideoTracks().forEach(track => {
      track.stop();
      cameraStream.removeTrack(track);
    });
    localAudioTrack = cameraStream.getAudioTracks()[0] || null;
    if (!localAudioTrack) cameraStream = null;
  }
  imageStream = nextImageStream;
  imageObjectUrl = objectUrl;
  imageAnimationFrame = requestAnimationFrame(drawImageFrame);
  localVideoTrack = imageStream.getVideoTracks()[0] || null;

  try {
    await publishLocalMedia();
    updateLocalMediaControls(
      localAudioTrack
        ? `Sharing ${file.name} with everyone. Your microphone is on.`
        : `Sharing ${file.name} with everyone.`
    );
  } catch (err) {
    console.error('Unable to share the selected image:', err);
    showLiveError('Unable to share this image. Please try again.');
  }
}

async function publishLocalMedia() {
  await Promise.all(Object.entries(peerSenders).map(async ([socketId, senders]) => {
    const connection = peerConnections[socketId];
    if (!connection || connection.connectionState === 'closed') return;
    await Promise.all([
      senders.video ? senders.video.replaceTrack(localVideoTrack) : Promise.resolve(),
      senders.audio ? senders.audio.replaceTrack(localAudioTrack) : Promise.resolve()
    ]);
  }));
  await Promise.all(Object.keys(peerConnections).map(requestPeerNegotiation));

  if (localVideoTrack) {
    const tile = ensureVideoTile('self', true);
    tile.video.srcObject = new MediaStream([localVideoTrack]);
    tile.status.hidden = true;
    tile.frame.classList.remove('camera-off');
    tile.video.play().catch((err) => {
      console.error('Unable to start local media preview:', err);
      showLiveError('Your media is being shared, but its preview could not start.');
    });
  } else if (guestOnStage && myStageInfo) {
    const tile = ensureVideoTile('self', true);
    tile.video.srcObject = null;
    showStageGuestTile('self', myStageInfo, true);
  } else {
    removeVideoTile('self');
    ensureHostPlaceholder();
  }
}

let guestOnStage = false;

function isGuestRole() {
  return !!document.querySelector('.live-role-badge.is-guest');
}

let guestRequestPending = false;

function requestGuestSlot() {
  if (!isGuestRole() || guestOnStage) return Promise.resolve(true);
  if (guestRequestPending) {
    showLiveError('Your request is already waiting for the host.');
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    // Listen before emitting: the host can accept before the server acknowledges the request.
    guestRequestPending = true;
    updateLocalMediaControls('Request sent. Waiting for the host to accept...');
    let timer = null;
    const finish = (approved, message) => {
      clearTimeout(timer);
      socket.off('live_guest_approved', onApproved);
      socket.off('live_guest_denied', onDenied);
      guestRequestPending = false;
      if (approved) guestOnStage = true;
      else {
        if (message !== 'NOEMIT') socket.emit('live_guest_leave');
        showLiveError(message === 'NOEMIT' ? 'Could not send your request. Please try again.' : message);
        updateLocalMediaControls('Tap "Request to Join" to ask the host again.');
      }
      resolve(approved);
    };
    const onApproved = () => finish(true);
    const onDenied = ({ reason } = {}) => finish(false, reason || 'The host declined your request.');
    socket.on('live_guest_approved', onApproved);
    socket.on('live_guest_denied', onDenied);
    timer = setTimeout(() => finish(false, 'The host did not respond. Try again.'), 90000);

    socket.timeout(30000).emit('live_guest_join', (err, result) => {
      if (!err && result && result.ok && result.approved) {
        finish(true);
      } else if (!err && (!result || !result.ok)) {
        showLiveError((result && result.error) || 'Could not send your request. Please try again.');
        finish(false, 'NOEMIT');
      }
      // On a slow acknowledgement, keep waiting: the request may already be with the host.
    });
  });
}

async function stopLocalMedia() {
  if (guestOnStage) {
    guestOnStage = false;
    if (socket) socket.emit('live_guest_leave');
  }
  stopCameraFilter();
  stopImageSource();
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  localVideoTrack = null;
  localAudioTrack = null;
  guestMuted = false;  try {
    await publishLocalMedia();
    const isGuest = !!document.querySelector('.live-role-badge.is-guest');
    const cameraBtn = document.getElementById('live-enable-camera-btn');
    if (isGuest && cameraBtn) cameraBtn.textContent = '🎤 Request to Join';
    updateLocalMediaControls(isGuest
      ? 'You are back in the chat. Tap "Request to Join" to ask the host again.'
      : 'Your camera is off. Choose an option to share with everyone.');
  } catch (err) {
    console.error('Unable to turn off live media:', err);
    showLiveError('Unable to stop sharing media with other participants.');
  }
}

function stopImageSource() {
  if (imageAnimationFrame !== null) {
    cancelAnimationFrame(imageAnimationFrame);
    imageAnimationFrame = null;
  }
  if (imageStream) {
    imageStream.getTracks().forEach(track => track.stop());
    imageStream = null;
  }
  if (imageObjectUrl) {
    URL.revokeObjectURL(imageObjectUrl);
    imageObjectUrl = null;
  }
}

function updateLocalMediaControls(message) {
  const status = document.getElementById('live-media-status');
  const offButton = document.getElementById('live-turn-media-off-btn');
  if (status) status.textContent = message;
  if (offButton) offButton.hidden = !localVideoTrack && !localAudioTrack;
  applyCameraMirror();
  applyMute();
  updateVideoGridLayout();
}

function applyCameraMirror() {
  const mirrorButton = document.getElementById('live-mirror-camera-btn');
  const hasCameraTrack = Boolean(
    cameraStream && localVideoTrack &&
    (cameraStream.getVideoTracks().includes(localVideoTrack) || cameraFilter?.track === localVideoTrack)
  );
  const filterControl = document.getElementById('live-camera-filter-control');
  if (filterControl) filterControl.hidden = !hasCameraTrack;
  document.querySelector('.live-media-controls')?.classList.toggle('has-camera-filter', hasCameraTrack);
  const preview = document.querySelector('.live-video-frame[data-peer-id="self"] .live-video-player');
  if (mirrorButton) {
    mirrorButton.hidden = !hasCameraTrack;
    mirrorButton.setAttribute('aria-pressed', String(cameraMirrored));
  }
  if (preview) preview.classList.toggle('is-mirrored', hasCameraTrack && cameraMirrored);
}

function stopCameraFilter() {
  cameraFilterGeneration++;
  if (cameraFilterSetup) cameraFilterSetup.abort();
  cameraFilterSetup = null;
  if (cameraFilter) cameraFilter.stop();
  cameraFilter = null;
  cameraFilterName = 'none';
  const select = document.getElementById('live-camera-filter');
  if (select) {
    select.value = 'none';
    select.disabled = false;
  }
}

async function applyLocalCameraFilter(name, backgroundImage) {
  const select = document.getElementById('live-camera-filter');
  const source = cameraStream?.getVideoTracks()[0];
  if (!source || source.readyState !== 'live') {
    if (select) select.value = 'none';
    showLiveError('Turn on your camera before choosing a filter.');
    return;
  }
  const generation = ++cameraFilterGeneration;
  if (cameraFilter && name !== 'none' && cameraFilter.supportsFilter(name)) {
    cameraFilter.setFilter(name);
    cameraFilterName = name;
    return;
  }
  const previous = cameraFilter;
  const previousName = cameraFilterName;
  const setup = new AbortController();
  cameraFilterSetup = setup;
  if (select) {
    select.value = previousName;
    select.disabled = true;
  }
  if (name.startsWith('background-')) {
    updateLocalMediaControls('Setting up the background. Your current video remains visible until it is ready.');
  }
  try {
    let next;
    next = name === 'none' ? null : await createCameraFilter(source, name, (error) => {
      if (!next || cameraFilter !== next) return;
      console.error('Live camera filter failed:', error);
      stopCameraFilter();
      const wasBackground = name.startsWith('background-');
      if (wasBackground) source.stop();
      localVideoTrack = !wasBackground && source.readyState === 'live' ? source : null;
      publishLocalMedia().catch(err => {
        console.error('Unable to restore the camera:', err);
        showLiveError('Unable to restore your camera. Turn media off and try again.');
      });
      showLiveError(wasBackground ? 'Background processing stopped. Video sharing was turned off; turn your camera on to try again.' : 'The camera filter stopped. Check your camera and try again.');
      updateLocalMediaControls(!wasBackground && source.readyState === 'live'
        ? 'Your camera is being shared without a filter.'
        : 'Your camera is off. Turn it on to share video.');
    }, setup.signal, backgroundImage);
    if (generation !== cameraFilterGeneration || !cameraStream?.getVideoTracks().includes(source)) {
      if (next) next.stop();
      return;
    }
    if (next?.track.readyState === 'ended') {
      next.stop();
      throw new Error('The camera filter stopped during setup.');
    }
    cameraFilter = next;
    cameraFilterName = name;
    localVideoTrack = next ? next.track : source;
    try {
      await publishLocalMedia();
    } catch (error) {
      try {
        if (generation === cameraFilterGeneration) {
          cameraFilter = previous;
          cameraFilterName = previousName;
          localVideoTrack = previous ? previous.track : source;
          await publishLocalMedia();
        }
      } finally {
        if (next) next.stop();
      }
      throw error;
    }
    if (generation !== cameraFilterGeneration) {
      if (previous) previous.stop();
      return;
    }
    if (previous) previous.stop();
    if (select) select.value = name;
    applyCameraMirror();
    if (name.startsWith('background-')) {
      updateLocalMediaControls('Background is visible to viewers. Edges may be imperfect; do not rely on it to hide private details.');
    }
  } catch (error) {
    if (generation !== cameraFilterGeneration) return;
    console.error('Unable to apply live camera filter:', error);
    if (select) select.value = previousName;
    showLiveError('Unable to change the camera filter. Please try again.');
    if (name.startsWith('background-')) {
      updateLocalMediaControls('The background could not be applied. Your previous video remains visible.');
    }
  } finally {
    if (cameraFilterSetup === setup) {
      cameraFilterSetup = null;
      if (select) select.disabled = false;
    }
  }
}

let guestMuted = false;
const hostGuestMuted = {};

function applyMute() {
  if (localAudioTrack && isGuestRole()) localAudioTrack.enabled = !guestMuted;
  const muteButton = document.getElementById('live-self-mute-btn');
  if (muteButton) {
    muteButton.hidden = !localAudioTrack;
    muteButton.innerHTML = guestMuted ? '&#128266; Unmute me' : '&#128263; Mute me';
  }
}

function renderHostGuests() {
  const panel = document.getElementById('live-host-guests');
  if (!panel) return;
  panel.replaceChildren(...Object.entries(hostGuestMuted).map(([socketId, info]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'live-media-button';
    button.style.cssText = 'padding:3px 10px';
    button.textContent = `${info.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A'} ${info.name} \u2014 ${info.muted ? 'Unmute' : 'Mute'}`;
    button.addEventListener('click', () => {
      socket.emit('live_mute_guest', { socketId, muted: !info.muted });
    });
    return button;
  }));
}

function ensureVideoTile(peerId, isLocal) {
  const existing = Array.from(document.querySelectorAll('.live-video-frame'))
    .find(frame => frame.dataset.peerId === peerId);
  if (existing) {
    return {
      frame: existing,
      video: existing.querySelector('video'),
      status: existing.querySelector('.live-video-status')
    };
  }

  const grid = document.getElementById('live-video-grid');
  if (!grid) return null;

  const frame = document.createElement('div');
  frame.className = 'live-video-frame';
  frame.dataset.peerId = peerId;
  const video = document.createElement('video');
  video.className = 'live-video-player';
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal;
  video.controls = !isLocal;
  const label = document.createElement('span');
  label.className = 'live-video-label';
  label.textContent = isLocal ? 'You' : '';
  label.hidden = !isLocal;
  const status = document.createElement('p');
  status.className = 'live-video-status';
  status.textContent = 'Camera is off or connecting...';
  const avatar = document.createElement('div');
  avatar.className = 'live-tile-avatar';
  frame.append(video, avatar, label, status);
  grid.appendChild(frame);
  setTileVisible(frame, isLocal);
  const knownInfo = isLocal ? null : (peerId === liveHostSocketId && liveHostInfo ? liveHostInfo : tileInfoCache[peerId]);
  if (knownInfo) showStageGuestTile(peerId, knownInfo, false);
  return { frame, video, status };
}

const tileInfoCache = {};
const stageGuestIds = new Set();

// Only the host and guests the host approved get a camera box; everyone else stays in the chat.
function canShowTile(peerId) {
  return peerId === 'self' || peerId === liveHostSocketId || stageGuestIds.has(peerId);
}
let myStageInfo = null;

// Shows a guest on stage right away (name + profile photo) even while their camera is off.
function showStageGuestTile(peerId, info, isLocal) {
  if (!isLocal && peerId !== 'self') tileInfoCache[peerId] = info;
  const tile = ensureVideoTile(peerId, isLocal);
  if (!tile) return;
  const { frame, status } = tile;
  frame.dataset.stageGuest = '1';
  const name = info.name || 'Guest';
  const labelEl = frame.querySelector('.live-video-label');
  labelEl.replaceChildren();
  labelEl.hidden = false;
  labelEl.style.cssText = 'display:inline-flex;align-items:center;gap:6px';
  const chip = document.createElement('span');
  chip.style.cssText = 'width:22px;height:22px;border-radius:50%;overflow:hidden;background:#5b38ff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex:none';
  const avatarUrl = info.avatar_url ? (/^https?:/i.test(info.avatar_url) ? info.avatar_url : `${API_ORIGIN}${info.avatar_url}`) : null;
  if (avatarUrl) {
    const chipImg = document.createElement('img');
    chipImg.alt = '';
    chipImg.src = avatarUrl;
    chipImg.style.cssText = 'width:100%;height:100%;object-fit:cover';
    chip.appendChild(chipImg);
  } else {
    chip.textContent = name.trim().charAt(0).toUpperCase() || '?';
  }
  const labelText = document.createElement('span');
  labelText.textContent = isLocal ? `${name} (You)` : name;
  labelEl.append(chip, labelText);
  const avatar = frame.querySelector('.live-tile-avatar');
  avatar.replaceChildren();
  if (info.avatar_url) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = /^https?:/i.test(info.avatar_url) ? info.avatar_url : `${API_ORIGIN}${info.avatar_url}`;
    avatar.appendChild(img);
  } else {
    avatar.textContent = name.trim().charAt(0).toUpperCase() || '?';
  }
  const nameEl = document.createElement('span');
  nameEl.className = 'live-tile-avatar-name';
  nameEl.textContent = name;
  avatar.appendChild(nameEl);
  if (!frame.querySelector('video')?.srcObject?.getVideoTracks().some(t => t.readyState === 'live' && !t.muted)) frame.classList.add('camera-off');
  status.hidden = true;
  setTileVisible(frame, true);
}

function removeVideoTile(peerId) {
  const frame = Array.from(document.querySelectorAll('.live-video-frame'))
    .find(tile => tile.dataset.peerId === peerId);
  if (frame) frame.remove();
  updateVideoGridLayout();
}

function showGuestRequest(socketId, name, avatarUrl) {
  let box = document.getElementById('live-guest-requests');
  if (!box) {
    box = document.createElement('div');
    box.id = 'live-guest-requests';
    box.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;width:min(92vw,360px)';
    document.body.appendChild(box);
  }
  if (box.querySelector(`[data-socket-id="${socketId}"]`)) return;
  const row = document.createElement('div');
  row.dataset.socketId = socketId;
  row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:12px;background:#1d1631;color:#fff;border:1px solid #7a5cff;box-shadow:0 6px 24px rgba(0,0,0,.5)';
  if (avatarUrl) {
    const photo = document.createElement('img');
    photo.alt = '';
    photo.src = /^https?:/i.test(avatarUrl) ? avatarUrl : `${API_ORIGIN}${avatarUrl}`;
    photo.style.cssText = 'width:34px;height:34px;border-radius:50%;object-fit:cover;flex:none';
    row.appendChild(photo);
  }
  const text = document.createElement('span');
  text.style.flex = '1';
  text.textContent = `${name} wants to join your live`;
  const decide = (accept) => {
    socket.emit('live_guest_decision', { socketId, accept });
    removeGuestRequest(socketId);
  };
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.textContent = 'Accept';
  accept.style.cssText = 'padding:6px 12px;border:0;border-radius:16px;background:#2fbf71;color:#fff;font-weight:700';
  accept.onclick = () => decide(true);
  const refuse = document.createElement('button');
  refuse.type = 'button';
  refuse.textContent = 'Refuse';
  refuse.style.cssText = 'padding:6px 12px;border:0;border-radius:16px;background:#e5334b;color:#fff;font-weight:700';
  refuse.onclick = () => decide(false);
  row.append(text, accept, refuse);
  box.appendChild(row);
}

function removeGuestRequest(socketId) {
  const box = document.getElementById('live-guest-requests');
  if (!box) return;
  const row = box.querySelector(`[data-socket-id="${socketId}"]`);
  if (row) row.remove();
  if (!box.children.length) box.remove();
}

function updateVideoGridLayout() {
  const grid = document.getElementById('live-video-grid');
  if (!grid) return;
  const isHostRole = !isGuestRole();
  const frames = Array.from(grid.querySelectorAll('.live-video-frame')).filter(f => !f.hidden);
  const hostFrame = frames.find(f => f.dataset.peerId === liveHostSocketId || (isHostRole && f.dataset.peerId === 'self'))
    || (isHostRole ? null : frames.find(f => f.dataset.peerId !== 'self' && !stageGuestIds.has(f.dataset.peerId)));
  frames.forEach(frame => {
    frame.style.gridRow = '';
    frame.style.gridColumn = '';
    frame.style.zIndex = '';
    frame.style.order = frame === hostFrame ? '-1' : '';
    frame.classList.remove('live-tile-off');
  });

  // Equal slots by tile count: 1, 2, 2x2, 3x3, then 4 across x 3 rows (12 tiles maximum, host included).
  const count = frames.length;
  const slots = count <= 1 ? 1 : count === 2 ? 2 : count <= 4 ? 4 : count <= 9 ? 9 : 12;
  const cols = slots === 1 ? 1 : slots === 2 ? 2 : slots === 4 ? 2 : slots === 9 ? 3 : 4;
  const rows = Math.ceil(slots / cols);
  grid.dataset.layout = count === 2 ? 'two' : 'equal';
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  grid.style.gridAutoRows = 'minmax(0, 1fr)';

  grid.querySelectorAll('.live-slot-empty').forEach(el => el.remove());
  for (let i = count; i < slots && count > 0; i++) {
    const empty = document.createElement('div');
    empty.className = 'live-slot-empty';
    empty.style.cssText = 'order:1000;border-radius:12px;border:1px dashed rgba(255,255,255,.18);background:rgba(255,255,255,.03);min-height:0';
    grid.appendChild(empty);
  }
  grid.closest('.live-stage')?.classList.toggle('live-multi', slots > 1);

  // Every tile is a 1:1 square sized to the largest square that fits its grid cell.
  const cs = getComputedStyle(grid);
  const gap = parseFloat(cs.columnGap) || 0;
  const rowGap = parseFloat(cs.rowGap) || 0;
  const innerW = grid.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const innerH = grid.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  const side = Math.floor(Math.min((innerW - gap * (cols - 1)) / cols, (innerH - rowGap * (rows - 1)) / rows));
  if (side > 0) {
    grid.style.gridTemplateColumns = `repeat(${cols}, ${side}px)`;
    grid.style.gridTemplateRows = `repeat(${rows}, ${side}px)`;
    grid.style.gridAutoRows = `${side}px`;
    grid.style.justifyContent = 'center';
    grid.style.alignContent = 'center';
    grid.querySelectorAll('.live-video-frame, .live-slot-empty').forEach(el => {
      el.style.width = `${side}px`;
      el.style.height = `${side}px`;
      el.style.aspectRatio = '1 / 1';
    });
  }
  const emptyState = document.getElementById('live-video-empty');
  if (emptyState) emptyState.hidden = count > 0;
}

function setTileVisible(frame, visible) {
  if (!frame) return;
  frame.hidden = !visible;
  frame.style.display = visible ? '' : 'none';
  updateVideoGridLayout();
}

function registerLiveListeners() {
  socket.off('live_chat_message');
  socket.on('live_chat_message', renderChatMessage);

  socket.off('live_chat_error');
  socket.on('live_chat_error', ({ error }) => showLiveError(error));

  socket.off('live_stream_ended');
  socket.on('live_stream_ended', () => {
    activeRoomSessionId = null;
    selectedLiveSessionId = null;
    closeAllPeerConnections();
    stopLocalMedia();
    const input = document.getElementById('live-chat-input');
    if (input) input.disabled = true;
    document.querySelectorAll('.live-media-button:not(#live-guest-exit-btn), #live-image-file').forEach(control => {
      control.disabled = true;
    });
    setLiveChatStatus('The host ended the livestream.', false);
    showLiveError('The host ended the livestream.');
    refreshLiveStreams();
    if (activeBroadcastSessionId) {
      activeBroadcastSessionId = null;
      window.location.href = '../index.html';
    } else {
      setTimeout(() => { window.location.href = '../index.html'; }, 1500);
    }
  });

  socket.off('live_guest_request');
  socket.on('live_guest_request', ({ socketId, name, avatar_url }) => showGuestRequest(socketId, name, avatar_url));

  socket.off('live_stage_guest');
  socket.on('live_stage_guest', ({ socketId, name }) => {
    hostGuestMuted[socketId] = { name, muted: false };
    renderHostGuests();
  });
  socket.off('live_stage_guest_left');
  socket.on('live_stage_guest_left', ({ socketId }) => {
    delete hostGuestMuted[socketId];
    renderHostGuests();
    if (socketId === socket.id) {
      myStageInfo = null;
      if (!localVideoTrack) removeVideoTile('self');
      return;
    }
    const frame = Array.from(document.querySelectorAll('.live-video-frame')).find(f => f.dataset.peerId === socketId);
    if (frame?.dataset.stageGuest) removeVideoTile(socketId);
    stageGuestIds.delete(socketId);
  });
  socket.off('live_member_joined');
  socket.on('live_member_joined', ({ name }) => renderSystemChatMessage(`\u2728 ${name || 'A viewer'} joined the live`));

  socket.off('live_guest_joined');
  socket.on('live_guest_joined', () => {});
  socket.off('live_stage_guest_info');
  socket.on('live_stage_guest_info', info => {
    stageGuestIds.add(info.socketId);
    if (info.socketId === socket.id) {
      myStageInfo = info;
      showStageGuestTile('self', info, true);
    } else {
      showStageGuestTile(info.socketId, info, false);
    }
  });
  socket.off('live_mute_state');
  socket.on('live_mute_state', ({ socketId, muted }) => {
    if (hostGuestMuted[socketId]) {
      hostGuestMuted[socketId].muted = muted;
      renderHostGuests();
    }
  });
  socket.off('live_force_mute');
  socket.on('live_force_mute', ({ muted }) => {
    guestMuted = Boolean(muted);
    applyMute();
    const status = document.getElementById('live-media-status');
    if (status) status.textContent = guestMuted ? 'The host muted your microphone. You can unmute yourself.' : 'The host unmuted your microphone.';
  });
  socket.off('live_guest_request_cancel');
  socket.on('live_guest_request_cancel', ({ socketId }) => removeGuestRequest(socketId));

  socket.off('live_guest_count');

  socket.off('live_layout');
  socket.on('live_layout', ({ layout, hostSocketId }) => applyLiveLayout(layout, hostSocketId));
  socket.off('live_viewers_changed');
  socket.on('live_viewers_changed', scheduleViewersRefresh);

  socket.off('viewer_left');
  socket.on('viewer_left', ({ socketId }) => closePeerConnection(socketId));

  socket.off('live_chat_style');
  socket.on('live_chat_style', applyChatStyle);

  socket.off('viewer_joined');
  socket.on('viewer_joined', async ({ socketId }) => {
    if (!socketId || peerConnections[socketId]) return;
    try {
      ensureVideoTile(socketId, false);
      createPeerConnection(socketId);
      await syncPeerSenders(socketId);
      await requestPeerNegotiation(socketId);
    } catch (err) {
      console.error('Unable to offer live video:', err);
      showLiveError('Unable to connect the camera to a viewer.');
    }
  });

  socket.off('webrtc_offer');
  socket.on('webrtc_offer', async ({ offer, senderSocketId }) => {
    try {
      ensureVideoTile(senderSocketId, false);
      const pc = peerConnections[senderSocketId] || createPeerConnection(senderSocketId, false);
      const state = peerNegotiationState[senderSocketId];
      const readyForOffer = !state.makingOffer &&
        (pc.signalingState === 'stable' || state.isSettingRemoteAnswerPending);
      const offerCollision = offer.type === 'offer' && !readyForOffer;
      state.ignoreOffer = !state.polite && offerCollision;
      if (state.ignoreOffer) return;

      if (offerCollision) {
        await pc.setLocalDescription({ type: 'rollback' });
      }
      await syncPeerSenders(senderSocketId);
      await setRemoteDescriptionAndFlush(pc, senderSocketId, new RTCSessionDescription(offer));
      if (offer.type === 'offer') {
        bindPeerSenders(senderSocketId, pc);
        pc.getTransceivers().forEach((transceiver) => {
          if (transceiver.direction === 'recvonly' || transceiver.direction === 'inactive') {
            transceiver.direction = 'sendrecv';
          }
        });
        await syncPeerSenders(senderSocketId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc_answer', {
          targetSocketId: senderSocketId,
          answer: pc.localDescription
        });
      }
      if (pendingNegotiations[senderSocketId]) {
        delete pendingNegotiations[senderSocketId];
        await requestPeerNegotiation(senderSocketId);
      }
    } catch (err) {
      console.error('Unable to answer live video offer:', err);
      showLiveError('Unable to connect to the livestream video.');
    }
  });

  socket.off('webrtc_answer');
  socket.on('webrtc_answer', async ({ answer, senderSocketId }) => {
    const pc = peerConnections[senderSocketId];
    if (pc) {
      try {
        const state = peerNegotiationState[senderSocketId];
        state.isSettingRemoteAnswerPending = true;
        await setRemoteDescriptionAndFlush(pc, senderSocketId, new RTCSessionDescription(answer));
        state.isSettingRemoteAnswerPending = false;
        if (pendingNegotiations[senderSocketId]) {
          delete pendingNegotiations[senderSocketId];
          await requestPeerNegotiation(senderSocketId);
        }
      } catch (err) {
        peerNegotiationState[senderSocketId].isSettingRemoteAnswerPending = false;
        console.error('Unable to apply live video answer:', err);
        showLiveError('Unable to connect the camera to a viewer.');
      }
    }
  });

  socket.off('ice_candidate');
  socket.on('ice_candidate', async ({ candidate, senderSocketId }) => {
    const pc = peerConnections[senderSocketId];
    if (!pc || !pc.remoteDescription) {
      if (!pendingIceCandidates[senderSocketId]) pendingIceCandidates[senderSocketId] = [];
      pendingIceCandidates[senderSocketId].push(candidate);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Unable to add live video ICE candidate:', err);
    }
  });
}

async function setRemoteDescriptionAndFlush(pc, socketId, description) {
  await pc.setRemoteDescription(description);
  const candidates = pendingIceCandidates[socketId] || [];
  delete pendingIceCandidates[socketId];
  for (const candidate of candidates) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
}

function renderSystemChatMessage(text) {
  const chatBox = document.getElementById('live-chat-messages');
  if (!chatBox) return;
  const div = document.createElement('div');
  div.className = 'live-chat-message live-chat-system';
  div.style.cssText = 'text-align:center;font-size:12px;font-weight:600;color:#ffd700;opacity:.95';
  div.textContent = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function renderChatMessage(msg) {
  const chatBox = document.getElementById('live-chat-messages');
  if (!chatBox) return;
  const div = document.createElement('div');
  div.className = 'live-chat-message';
  const name = msg.username || 'Guest';
  const avatar = document.createElement('span');
  avatar.className = 'live-chat-avatar';
  const showInitial = () => {
    avatar.replaceChildren();
    avatar.textContent = name.charAt(0).toUpperCase();
  };
  if (msg.avatar_url) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = /^https?:/i.test(msg.avatar_url) ? msg.avatar_url : `${API_ORIGIN}${msg.avatar_url}`;
    img.addEventListener('error', showInitial);
    avatar.appendChild(img);
  } else {
    showInitial();
  }
  const username = document.createElement('span');
  username.className = 'live-chat-user';
  username.textContent = name;
  const content = document.createElement('span');
  content.textContent = msg.content;
  div.append(avatar, username, content);
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function attachChatStyleControls(sessionId) {
  const backgroundInput = document.getElementById('chat-background-color');
  const fontColorInput = document.getElementById('chat-font-color');
  const fontSizeInput = document.getElementById('chat-font-size');
  const fontSizeOutput = document.getElementById('chat-font-size-value');
  if (!backgroundInput || !fontColorInput || !fontSizeInput || !fontSizeOutput) return;

  const updateStyle = () => {
    const style = {
      backgroundColor: backgroundInput.value,
      fontColor: fontColorInput.value,
      fontSize: Number(fontSizeInput.value)
    };
    fontSizeOutput.value = `${style.fontSize}px`;
    applyChatStyle(style);
    socket.emit('update_live_chat_style', { sessionId, ...style });
  };

  backgroundInput.addEventListener('input', updateStyle);
  fontColorInput.addEventListener('input', updateStyle);
  fontSizeInput.addEventListener('input', updateStyle);
}

function applyChatStyle(style) {
  const chatBox = document.getElementById('live-chat-messages');
  const fontSizeInput = document.getElementById('chat-font-size');
  const fontSizeOutput = document.getElementById('chat-font-size-value');
  if (!chatBox) return;

  if (/^#[0-9a-f]{6}$/i.test(style.backgroundColor)) {
    chatBox.style.setProperty('--live-chat-background', style.backgroundColor);
  }
  if (/^#[0-9a-f]{6}$/i.test(style.fontColor)) {
    chatBox.style.setProperty('--live-chat-font-color', style.fontColor);
  }
  const fontSize = Number(style.fontSize);
  if (Number.isInteger(fontSize) && fontSize >= 12 && fontSize <= 24) {
    chatBox.style.setProperty('--live-chat-font-size', `${fontSize}px`);
    if (fontSizeInput) fontSizeInput.value = String(fontSize);
    if (fontSizeOutput) fontSizeOutput.value = `${fontSize}px`;
  }

  const backgroundInput = document.getElementById('chat-background-color');
  const fontColorInput = document.getElementById('chat-font-color');
  if (backgroundInput && /^#[0-9a-f]{6}$/i.test(style.backgroundColor)) {
    backgroundInput.value = style.backgroundColor;
  }
  if (fontColorInput && /^#[0-9a-f]{6}$/i.test(style.fontColor)) {
    fontColorInput.value = style.fontColor;
  }
}

function createPeerConnection(socketId, addSendTransceivers = true) {
  if (peerConnections[socketId]) return peerConnections[socketId];
  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[socketId] = pc;
  peerNegotiationState[socketId] = {
    makingOffer: false,
    ignoreOffer: false,
    isSettingRemoteAnswerPending: false,
    polite: socket.id.localeCompare(socketId) > 0
  };
  peerSenders[socketId] = {};
  if (addSendTransceivers) {
    const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    peerSenders[socketId] = {
      video: videoTransceiver.sender,
      audio: audioTransceiver.sender
    };
  }
  remoteMediaStreams[socketId] = new MediaStream();

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice_candidate', { targetSocketId: socketId, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    const remoteStream = remoteMediaStreams[socketId];
    if (!remoteStream.getTracks().includes(event.track)) remoteStream.addTrack(event.track);
    if (event.track.kind !== 'video') return;

    const tile = ensureVideoTile(socketId, false);
    if (!tile) return;
    tile.video.srcObject = remoteStream;
    const showVideo = () => {
      if (!canShowTile(socketId)) return;
      tile.status.hidden = true;
      tile.frame.classList.remove('camera-off');
      setTileVisible(tile.frame, true);
      tile.video.play().catch((err) => {
        console.error('Unable to play participant video:', err);
        tile.status.textContent = 'Video ready — press play to view.';
        tile.status.hidden = false;
      });
    };
    event.track.onunmute = showVideo;
    event.track.onmute = () => {
      if (tile.frame.dataset.stageGuest) {
        tile.frame.classList.add('camera-off');
        return;
      }
      setTileVisible(tile.frame, false);
    };
    if (!event.track.muted) {
      showVideo();
    }
  };

  return pc;
}

async function requestPeerNegotiation(socketId) {
  const pc = peerConnections[socketId];
  const state = peerNegotiationState[socketId];
  if (!pc || !state || !socket.connected) return;
  if (!peerSenders[socketId]?.video) {
    pendingNegotiations[socketId] = true;
    return;
  }
  if (state.makingOffer || pc.signalingState !== 'stable') {
    pendingNegotiations[socketId] = true;
    return;
  }

  state.makingOffer = true;
  try {
    const offer = await pc.createOffer();
    if (pc.signalingState !== 'stable') {
      pendingNegotiations[socketId] = true;
      return;
    }
    await pc.setLocalDescription(offer);
    socket.emit('webrtc_offer', {
      targetSocketId: socketId,
      offer: pc.localDescription
    });
  } finally {
    state.makingOffer = false;
  }
}

// The upload budget is shared between everyone watching, so quality scales down smoothly as the audience grows.
const UPLOAD_BUDGET_KBPS = 9000;
const MAX_VIDEO_KBPS = 3500;
const MIN_VIDEO_KBPS = 350;

async function tuneSenderQuality() {
  const active = Object.values(peerSenders).filter(senders => senders.video && localVideoTrack);
  if (!active.length) return;
  const perViewer = Math.max(MIN_VIDEO_KBPS, Math.min(MAX_VIDEO_KBPS, Math.floor(UPLOAD_BUDGET_KBPS / active.length)));
  const scaleDown = perViewer >= 2000 ? 1 : perViewer >= 1000 ? 1.5 : perViewer >= 600 ? 2 : 3;
  if ('contentHint' in localVideoTrack) localVideoTrack.contentHint = 'motion';
  await Promise.all(active.map(async ({ video }) => {
    try {
      const params = video.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = perViewer * 1000;
      params.encodings[0].maxFramerate = perViewer >= 600 ? 30 : 24;
      params.encodings[0].scaleResolutionDownBy = scaleDown;
      params.encodings[0].networkPriority = 'high';
      params.degradationPreference = 'balanced';
      await video.setParameters(params);
    } catch (err) {
      console.warn('Could not tune video quality:', err.message);
    }
  }));
}

async function syncPeerSenders(socketId) {
  const senders = peerSenders[socketId];
  if (!senders) return;
  await Promise.all([
    senders.video ? senders.video.replaceTrack(localVideoTrack) : Promise.resolve(),
    senders.audio ? senders.audio.replaceTrack(localAudioTrack) : Promise.resolve()
  ]);
  await tuneSenderQuality();
}

function bindPeerSenders(socketId, pc) {
  const transceivers = pc.getTransceivers();
  peerSenders[socketId] = {
    video: transceivers.find(transceiver =>
      transceiver.receiver.track.kind === 'video' && transceiver.mid !== null
    )?.sender,
    audio: transceivers.find(transceiver =>
      transceiver.receiver.track.kind === 'audio' && transceiver.mid !== null
    )?.sender
  };
}

function closePeerConnection(socketId) {
  const connection = peerConnections[socketId];
  if (connection) connection.close();
  delete peerConnections[socketId];
  delete peerSenders[socketId];
  delete peerNegotiationState[socketId];
  delete pendingNegotiations[socketId];
  delete pendingIceCandidates[socketId];
  delete remoteMediaStreams[socketId];
  removeVideoTile(socketId);
  tuneSenderQuality().catch(() => {});
}

function closeAllPeerConnections() {
  Object.keys(peerConnections).forEach(closePeerConnection);
}

export async function startBroadcasting(title, category, visibility = 'public', audienceIds = []) {
  if (activeBroadcastSessionId) return;
  if (!localStorage.getItem('vynzo_token')) {
    alert('Please log in to your Vynzo account before starting a livestream.');
    return;
  }

  try {
    const res = await apiRequest('/live/start', {
      method: 'POST',
      body: JSON.stringify({ title, category, visibility, audience_ids: audienceIds })
    });

    const sessionId = res.session.id;
    activeBroadcastSessionId = sessionId;
    broadcastStartedAt = Date.now();
    const mainView = document.getElementById('live-main-view');
    const currentUser = JSON.parse(localStorage.getItem('vynzo_user') || '{}');
    mainView.innerHTML = createLiveStage(
      'Say something in live chat...',
      true,
      currentUser.username,
      title,
      { id: currentUser.id, name: currentUser.display_name || currentUser.username, avatar: currentUser.avatar_url }
    );
    attachLiveHeader(true);
    liveHostInfo = { name: currentUser.display_name || currentUser.username || 'Host', avatar_url: currentUser.avatar_url || null };
    liveHostSocketId = null;
    attachLiveChatForm(sessionId);
    registerLiveListeners();
    attachLiveMediaControls();
    attachChatStyleControls(sessionId);
    ensureHostPlaceholder();
    joinLiveRoom(sessionId);
    refreshLiveStreams();
    stopLiveFrameGuard = startLiveFrameGuard(
      () => activeBroadcastSessionId,
      () => {
        const video = document.querySelector('.live-video-frame[data-peer-id="self"] .live-video-player');
        return video?.srcObject?.getVideoTracks?.().includes(localVideoTrack) ? video : null;
      },
      () => {
        exitBroadcasting();
        alert('Your live stream was ended because it appears to violate the Vynzo community guidelines.');
      }
    );

    const broadcastButton = document.getElementById('start-broadcast-btn');
    broadcastButton.textContent = 'Exit Live';
    broadcastButton.style.display = 'none';
    broadcastButton.setAttribute('aria-label', 'Exit live and return home');
  } catch (err) {
    alert('Failed to start broadcast: ' + err.message);
  }
}

export async function exitBroadcasting() {
  if (!activeBroadcastSessionId) return;

  const sessionId = activeBroadcastSessionId;
  if (stopLiveFrameGuard) stopLiveFrameGuard();
  const broadcastButton = document.getElementById('start-broadcast-btn');
  broadcastButton.disabled = true;

  try {
    await apiRequest(`/live/${encodeURIComponent(sessionId)}/end`, { method: 'POST' });
  } catch (err) {
    broadcastButton.disabled = false;
    alert('Failed to end broadcast: ' + err.message);
    return;
  }

  if (socket) socket.emit('leave_live_room', sessionId);
  activeRoomSessionId = null;
  selectedLiveSessionId = null;
  closeAllPeerConnections();
  await stopLocalMedia();
  activeBroadcastSessionId = null;
  await refreshLiveStreams();
  window.location.href = '../index.html';
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}
window.addEventListener('resize', () => updateVideoGridLayout());
