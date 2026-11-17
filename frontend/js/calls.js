import { API_ORIGIN } from './config.js?v=sb4';
import { createRealtimeSocket, setGroupCallsReady, supportsGroupCalls, coordinatorReady } from './realtime.js?v=sb15';
import { apiRequest } from './api.js?v=sb6';
import { PUSH_NOTIFICATIONS_ENABLED } from './push-config.mjs';
import { shouldUseCoordinator } from './call-route.mjs';
import { createAudioDevices } from './audio-devices.js?v=1';
import { createGroupCallUI } from './group-call-ui.js';
import { supabase, syncLegacySession } from './supabase-client.js';
import { setScreenGuard } from './screen-guard.js';
import { setCallParticipantName } from './call-participant-name.js';
import { createCameraSwitcher } from './camera-devices.js';

const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: ['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443','turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' }] };

let socket = null;
let call = null; // { callId, peer, video, isCaller, pc, localStream, pendingIce, timerId, seconds }
let incoming = null;
let overlay = null;
let ringtone = null;
let initialised = false;
let initialising = null;
let groupCalls = null;
const audioDevices = createAudioDevices({
  getTrack: () => call?.localStream.getAudioTracks()[0],
  getOutputs: () => overlay ? [overlay.querySelector('#call-remote')].filter(Boolean) : [],
  onError: showToast,
  async replaceTrack(oldTrack, newTrack) {
    const active = call;
    if (!active || active.localStream.getAudioTracks()[0] !== oldTrack) throw new Error('Call changed while switching microphone.');
    const sender = active.pc?.getSenders().find(item => item.track === oldTrack);
    if (active.pc && !sender) throw new Error('Microphone sender not found.');
    if (sender) await sender.replaceTrack(newTrack);
    if (call !== active || active.localStream.getAudioTracks()[0] !== oldTrack) {
      if (sender && call === active) await sender.replaceTrack(oldTrack);
      throw new Error('Call changed while switching microphone.');
    }
    newTrack.enabled = oldTrack.enabled;
    active.localStream.removeTrack(oldTrack);
    active.localStream.addTrack(newTrack);
  }
});
const cameraSwitcher = createCameraSwitcher({
  getStream: () => call?.localStream,
  constraints: { width: { ideal: 1280 }, height: { ideal: 720 } },
  onError: showToast,
  async replaceTrack(oldTrack, newTrack) {
    const active = call;
    const sender = active?.pc?.getSenders().find(item => item.track === oldTrack);
    if (active?.pc && !sender) throw new Error('Camera sender not found.');
    if (sender) await sender.replaceTrack(newTrack);
  },
  onChanged: () => {
    const local = overlay?.querySelector('#call-local');
    if (local) local.srcObject = call.localStream;
  }
});

function ensureStyles() {
  if (document.getElementById('vynzo-calls-css')) return;
  const link = document.createElement('link');
  link.id = 'vynzo-calls-css';
  link.rel = 'stylesheet';
  link.href = new URL('../css/calls.css?v=voice-grid4', import.meta.url).href;
  document.head.appendChild(link);
}

export async function initCalls() {
  if (initialised) return;
  if (initialising) return initialising;
  initialising = initialiseCalls().catch(error => {
    console.error('Could not initialize calls:', error);
    showToast(error.message || 'Could not initialize calls. Please reload and try again.');
  }).finally(() => { initialising = null; });
  return initialising;
}

async function initialiseCalls() {
  if (!supabase) return;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) return;
  syncLegacySession(data.session);

  ensureStyles();
  socket = createRealtimeSocket();
  socket.on('connect_error', error => console.error('Direct call connection failed:', error));
  socket.on('call_incoming', handleIncoming);
  socket.on('call_accepted', handleAccepted);
  socket.on('call_signal', handleSignal);
  socket.on('call_ended', handleEnded);
  groupCalls = createGroupCallUI({
    rtcConfig, isBusy: () => Boolean(call || incoming), showToast, ensureStyles,
    startRingtone, stopRingtone,
    setVideoProtection: enabled => updateCallProtection('group-call', enabled),
    onAvailability: ready => setGroupCallsReady(ready).catch(error => console.error('Could not update call availability:', error))
  });
  initialised = true;
}

export async function openCallNotification(callId) {
  if (!supabase) throw new Error('Calls are unavailable.');
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) {
    showToast('Please log in to join the call.');
    return;
  }
  syncLegacySession(data.session);
  await initCalls();
  if (!groupCalls) {
    showToast('Calls are not available right now.');
    return;
  }
  await groupCalls.openNotification(callId);
}

export async function startCall({ conversationId, calleeId, name, avatarUrl, video }) {
  await initCalls();
  if (!socket) return showToast('Calls are not available right now.');
  if (call || incoming || groupCalls?.busy()) return showToast('You are already in a call.');
  let useCoordinator;
  try {
    useCoordinator = await shouldUseCoordinator({
      onlineSupports: supportsGroupCalls(calleeId),
      ready: coordinatorReady(),
      pushEnabled: PUSH_NOTIFICATIONS_ENABLED,
      async checkPushAvailability() {
        const eligibility = await apiRequest('/calls/authorize-invite', {
          method: 'POST', body: JSON.stringify({ targetId: calleeId, ...(conversationId ? { conversationId } : {}) })
        });
        return eligibility.pushAvailable;
      }
    });
  } catch (error) {
    showToast(error.message || 'Could not check call availability.');
    return;
  }
  if (call || incoming || groupCalls?.busy()) return showToast('You are already in a call.');
  if (useCoordinator) {
    try {
      await groupCalls.start({ targetId: calleeId, conversationId, video });
    } catch (error) {
      showToast(error.message || 'Could not start the call.');
    }
    return;
  }

  let localStream;
  try {
    localStream = await getMedia(video);
  } catch (err) {
    return showToast(mediaErrorMessage(err, video));
  }

  socket.timeout(8000).emit('call_invite', { conversationId, calleeId, video }, (err, response) => {
    if (err || !response || !response.ok) {
      stopStream(localStream);
      showToast((response && response.error) || 'Could not reach the server. Try again.');
      return;
    }
    call = {
      callId: response.callId,
      peer: { name, avatarUrl },
      video,
      isCaller: true,
      pc: null,
      localStream,
      pendingIce: [],
      timerId: null,
      seconds: 0
    };
    renderCall('Calling…');
  });
}

async function getMedia(video) {
  return navigator.mediaDevices.getUserMedia({
    audio: audioDevices.audioConstraints({ echoCancellation: true, noiseSuppression: true }),
    video: video ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false
  });
}

function mediaErrorMessage(err, video) {
  if (!navigator.mediaDevices) return 'This device cannot access the microphone or camera here.';
  if (err && err.name === 'NotAllowedError') {
    return `Allow ${video ? 'camera and microphone' : 'microphone'} access to make calls.`;
  }
  return `Could not open the ${video ? 'camera' : 'microphone'}.`;
}

function stopStream(stream) {
  if (stream) stream.getTracks().forEach(track => track.stop());
}

function handleIncoming(data) {
  if (call || incoming || groupCalls?.busy()) {
    socket.emit('call_end', { callId: data.callId });
    return;
  }
  incoming = data;
  startRingtone();
  if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
  renderIncoming();
}

async function acceptIncoming() {
  const data = incoming;
  if (!data) return;
  stopRingtone();

  let localStream;
  try {
    localStream = await getMedia(data.video);
  } catch (err) {
    showToast(mediaErrorMessage(err, data.video));
    socket.emit('call_end', { callId: data.callId });
    incoming = null;
    closeOverlay();
    return;
  }

  const from = data.from || {};
  call = {
    callId: data.callId,
    peer: { name: from.display_name || from.username || 'Friend', avatarUrl: from.avatar_url, platform: from.platform },
    video: data.video,
    isCaller: false,
    pc: null,
    localStream,
    pendingIce: [],
    timerId: null,
    seconds: 0
  };
  incoming = null;
  createPeerConnection();
  renderCall('Connecting…');
  socket.emit('call_accept', { callId: data.callId });
}

function declineIncoming() {
  if (!incoming) return;
  socket.emit('call_end', { callId: incoming.callId });
  incoming = null;
  stopRingtone();
  closeOverlay();
}

function createPeerConnection() {
  const pc = new RTCPeerConnection(rtcConfig);
  call.pc = pc;
  call.localStream.getTracks().forEach(track => pc.addTrack(track, call.localStream));

  pc.ontrack = (event) => {
    const remote = overlay && overlay.querySelector('#call-remote');
    if (remote && remote.srcObject !== event.streams[0]) {
      remote.srcObject = event.streams[0];
      audioDevices.applyOutput(remote).then(() => {
        if (overlay?.querySelector('#call-remote') === remote) return remote.play();
      }).catch(err => {
        console.error('Unable to play call audio:', err);
        showToast('Unable to play call audio. Check your browser audio permissions.');
      });
    }
  };
  pc.onicecandidate = (event) => {
    if (event.candidate && call) {
      socket.emit('call_signal', { callId: call.callId, signal: { candidate: event.candidate } });
    }
  };
  pc.onconnectionstatechange = () => {
    if (!call || call.pc !== pc) return;
    if (pc.connectionState === 'connected') onConnected();
    if (pc.connectionState === 'failed') endCall('Connection lost');
  };
  return pc;
}

async function handleAccepted(data) {
  if (!call || call.callId !== data.callId || !call.isCaller) return;
  call.peer.platform = data.platform;
  const peerName = overlay?.querySelector('#call-peer-name');
  if (peerName) {
    setCallParticipantName(peerName, call.peer.name, data.platform);
  }
  setStatus('Connecting…');
  const pc = createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call_signal', { callId: call.callId, signal: { description: pc.localDescription } });
}

async function handleSignal(data) {
  if (!call || call.callId !== data.callId || !call.pc) return;
  const { description, candidate } = data.signal || {};
  const pc = call.pc;
  try {
    if (description) {
      await pc.setRemoteDescription(description);
      call.pendingIce.splice(0).forEach(item => pc.addIceCandidate(item).catch(() => {}));
      if (description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call_signal', { callId: call.callId, signal: { description: pc.localDescription } });
      }
    } else if (candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else call.pendingIce.push(candidate);
    }
  } catch (err) {
    console.error('Call signalling error:', err);
  }
}

function handleEnded(data) {
  if (incoming && incoming.callId === data.callId) {
    incoming = null;
    stopRingtone();
    closeOverlay();
    if (data.reason === 'missed') showToast('Missed call');
    return;
  }
  if (!call || call.callId !== data.callId) return;
  const messages = {
    declined: 'Call declined',
    no_answer: 'No answer',
    ended: 'Call ended'
  };
  cleanupCall(messages[data.reason] || 'Call ended');
}

function endCall(message = 'Call ended') {
  if (call) socket.emit('call_end', { callId: call.callId });
  cleanupCall(message);
}

function cleanupCall(message) {
  if (!call) return;
  audioDevices.reset();
  window.clearInterval(call.timerId);
  if (call.pc) call.pc.close();
  stopStream(call.localStream);
  call = null;
  updateCallProtection('legacy-call', false);
  closeOverlay();
  showToast(message);
}

function onConnected() {
  if (!call || call.timerId) return;
  setStatus('00:00');
  call.timerId = window.setInterval(() => {
    call.seconds += 1;
    const minutes = String(Math.floor(call.seconds / 60)).padStart(2, '0');
    const seconds = String(call.seconds % 60).padStart(2, '0');
    setStatus(`${minutes}:${seconds}`);
  }, 1000);
}

function setStatus(text) {
  const el = overlay && overlay.querySelector('#call-status');
  if (el) el.textContent = text;
}

function avatarHtml(url, name) {
  if (url) {
    const src = /^https?:/i.test(url) ? url : `${API_ORIGIN}${url}`;
    return `<img class="call-avatar" src="${escapeAttr(src)}" alt="">`;
  }
  return `<span class="call-avatar call-avatar-fallback">${escapeHtml((name || '?').charAt(0).toUpperCase())}</span>`;
}

function mountOverlay(html) {
  closeOverlay();
  ensureStyles();
  overlay = document.createElement('div');
  overlay.className = 'call-overlay';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
}

function closeOverlay() {
  if (overlay) overlay.remove();
  overlay = null;
}

function renderIncoming() {
  const from = incoming.from || {};
  const name = from.display_name || from.username || 'Friend';
  mountOverlay(`
    <div class="call-panel call-incoming">
      ${avatarHtml(from.avatar_url, name)}
      <h2 id="call-incoming-name"></h2>
      <p>Incoming ${incoming.video ? 'video' : 'voice'} call…</p>
      <div class="call-actions">
        <button type="button" class="call-btn call-decline" id="call-decline" aria-label="Decline">✕<span>Decline</span></button>
        <button type="button" class="call-btn call-accept" id="call-accept" aria-label="Accept">${incoming.video ? '🎥' : '📞'}<span>Accept</span></button>
      </div>
    </div>
  `);
  setCallParticipantName(overlay.querySelector('#call-incoming-name'), name, from.platform);
  overlay.querySelector('#call-accept').addEventListener('click', acceptIncoming);
  overlay.querySelector('#call-decline').addEventListener('click', declineIncoming);
}

function renderCall(status) {
  mountOverlay(`
    <div class="call-panel call-active ${call.video ? 'is-video is-screen-guard-pending' : 'is-voice'}">
      <video id="call-remote" class="call-remote" autoplay playsinline></video>
      <div class="call-voice-info">
        ${avatarHtml(call.peer.avatarUrl, call.peer.name)}
      </div>
      <header class="call-header">
        <h2 id="call-peer-name"></h2>
        <p id="call-status">${escapeHtml(status)}</p>
      </header>
      ${call.video ? '<video id="call-local" class="call-local" autoplay playsinline muted></video>' : ''}
      ${call.video ? '<button type="button" class="call-swap-video call-legacy-swap" id="call-swap" aria-label="Swap large and small video">Swap</button>' : ''}
      <div class="call-actions">
        <button type="button" class="call-btn call-toggle" id="call-mute" aria-label="Mute microphone">🎤<span>Mute</span></button>
        ${call.video ? '<button type="button" class="call-btn call-toggle" id="call-camera" aria-label="Turn camera off">📷<span>Camera</span></button>' : ''}
        ${call.video ? '<button type="button" class="call-btn call-toggle" id="call-switch-camera" aria-label="Switch camera">Switch camera</button>' : ''}
        ${call.video ? '<button type="button" class="call-btn call-toggle" id="call-mirror" aria-label="Mirror your video preview" aria-pressed="true">Mirror</button>' : ''}
        <button type="button" class="call-btn call-toggle" id="call-audio" aria-label="Audio devices">🎧<span>Audio</span></button>
        <button type="button" class="call-btn call-decline" id="call-end" aria-label="End call">✕<span>End</span></button>
      </div>
    </div>
  `);
  setCallParticipantName(overlay.querySelector('#call-peer-name'), call.peer.name, call.peer.platform);
  if (call.video) {
    const panel = overlay.querySelector('.call-active');
    updateCallProtection('legacy-call', true).finally(() => panel.classList.remove('is-screen-guard-pending'));
  }

  const local = overlay.querySelector('#call-local');
  if (local) local.srcObject = call.localStream;
  const swap = overlay.querySelector('#call-swap');
  if (swap) swap.addEventListener('click', () => {
    overlay.querySelector('.call-active').classList.toggle('is-swapped');
  });
  const mirror = overlay.querySelector('#call-mirror');
  if (mirror) mirror.addEventListener('click', () => {
    const disabled = local.classList.toggle('is-unmirrored');
    mirror.setAttribute('aria-pressed', String(!disabled));
  });
  audioDevices.applyOutput(overlay.querySelector('#call-remote'));

  overlay.querySelector('#call-end').addEventListener('click', () => endCall('Call ended'));
  overlay.querySelector('#call-audio').addEventListener('click', () => audioDevices.open());
  overlay.querySelector('#call-mute').addEventListener('click', (event) => {
    toggleTrack('audio', event.currentTarget);
  });
  const cameraButton = overlay.querySelector('#call-camera');
  if (cameraButton) {
    cameraButton.addEventListener('click', (event) => toggleTrack('video', event.currentTarget));
  }
  overlay.querySelector('#call-switch-camera')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await cameraSwitcher.switchCamera(); }
    finally { button.disabled = false; }
  });
}

function updateCallProtection(owner, enabled) {
  return setScreenGuard(owner, enabled).then(protectedScreen => {
    if (enabled && !protectedScreen) showToast('Screenshots and recording cannot be blocked in a browser.');
  }).catch(error => {
    console.error('Could not update video call screen protection:', error);
    if (enabled) showToast('Screen capture protection is unavailable on this device.');
  });
}

function toggleTrack(kind, button) {
  if (!call) return;
  const tracks = kind === 'audio' ? call.localStream.getAudioTracks() : call.localStream.getVideoTracks();
  const enabled = !tracks.every(track => track.enabled);
  tracks.forEach(track => { track.enabled = enabled; });
  button.classList.toggle('is-off', !enabled);
}

function startRingtone() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const beep = () => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 480;
      gain.gain.value = 0.08;
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.6);
    };
    beep();
    ringtone = { context, id: window.setInterval(beep, 2000) };
  } catch (err) {
    ringtone = null;
  }
}

function stopRingtone() {
  if (!ringtone) return;
  window.clearInterval(ringtone.id);
  ringtone.context.close().catch(() => {});
  ringtone = null;
}

function showToast(message) {
  ensureStyles();
  const toast = document.createElement('div');
  toast.className = 'call-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3500);
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
