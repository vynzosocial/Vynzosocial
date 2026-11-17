import { apiRequest } from './api.js?v=sb7';
import { createAudioDevices } from './audio-devices.js?v=1';
import { GroupCallService } from './group-call-service.js';
import { API_ORIGIN } from './config.js?v=sb4';
import { setCallParticipantName } from './call-participant-name.js';
import { createCameraSwitcher } from './camera-devices.js';

export function createGroupCallUI({ rtcConfig, isBusy, showToast, ensureStyles, startRingtone, stopRingtone, onAvailability, setVideoProtection = () => {} }) {
  let overlay = null;
  let incoming = null;
  let opening = false;
  let notificationCallId = null;
  let localVideoIsMain = false;
  let localPreviewMirrored = false;
  let protectedVideoCall = false;
  let actionsResizeObserver = null;
  const service = new GroupCallService({
    rtcConfig, onAvailability,
    onError(error) {
      console.error('Group call error:', error);
      if (service.call || incoming) showToast(error.message || 'Group call failed.');
    },
    onIncoming(event) {
      if ((opening && notificationCallId === event.callId) || service.call?.callId === event.callId) return;
      if (incoming || isBusy() || service.call || opening) {
        service.decline(event.callId).catch(error => console.error('Could not decline busy call:', error));
        return;
      }
      incoming = event;
      startRingtone();
      renderIncoming();
    },
    onInvitationEnded() {
      if (!incoming) return;
      incoming = null;
      stopRingtone();
      close();
      showToast('Call invitation ended.');
    },
    onChange(call, reason) {
      if (!call) {
        audioDevices.reset();
        close();
        if (reason) showToast(reason);
      } else if (overlay?.querySelector('.group-call-grid')) {
        updateParticipants(call);
      }
    },
    onTrack(id, event) {
      const video = overlay?.querySelector(`[data-peer="${id}"] video`);
      if (!video) return;
      video.srcObject = event.streams[0] || new MediaStream([event.track]);
      audioDevices.applyOutput(video).then(() => video.play()).catch(error => {
        console.error('Could not play group call media:', error);
        showToast('Could not play call audio or video.');
      });
    },
    onPeerState(id, state) {
      if (state === 'failed') showToast('A participant connection was lost.');
      if (state === 'closed') overlay?.querySelector(`[data-peer="${id}"]`)?.remove();
    }
  });
  const audioDevices = createAudioDevices({
    getTrack: () => service.call?.stream.getAudioTracks()[0],
    getOutputs: () => overlay ? [...overlay.querySelectorAll('.group-call-grid video')] : [],
    onError: showToast,
    async replaceTrack(oldTrack, newTrack) {
      const active = service.call;
      const mesh = service.mesh;
      if (!active || active.stream.getAudioTracks()[0] !== oldTrack) throw new Error('Call changed while switching microphone.');
      await mesh.replaceAudioTrack(oldTrack, newTrack);
      if (service.call !== active) throw new Error('Call changed while switching microphone.');
      newTrack.enabled = oldTrack.enabled;
    }
  });
  const cameraSwitcher = createCameraSwitcher({
    getStream: () => service.call?.stream,
    constraints: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 } },
    onError: showToast,
    replaceTrack: (oldTrack, newTrack) => service.mesh.replaceVideoTrack(oldTrack, newTrack),
    onChanged: () => {
      const local = overlay?.querySelector(`[data-peer="${service.userId}"] video`);
      if (local) local.srcObject = service.call.stream;
    }
  });

  function close() {
    actionsResizeObserver?.disconnect();
    actionsResizeObserver = null;
    if (protectedVideoCall) setVideoProtection(false);
    protectedVideoCall = false;
    overlay?.remove();
    overlay = null;
    localVideoIsMain = false;
    localPreviewMirrored = false;
  }

  function mount(panel) {
    close();
    ensureStyles();
    overlay = document.createElement('div');
    overlay.className = 'call-overlay';
    overlay.append(panel);
    overlay.addEventListener('click', event => {
      const friends = overlay?.querySelector('.group-call-friends');
      const invite = overlay?.querySelector('.call-invite');
      if (friends && !friends.contains(event.target) && !invite?.contains(event.target)) friends.remove();
    });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') overlay?.querySelector('.group-call-friends')?.remove();
    });
    document.body.append(overlay);
  }

  function button(label, handler, className = 'call-toggle') {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `call-btn ${className}`;
    element.textContent = label;
    element.addEventListener('click', handler);
    return element;
  }

  function avatar(user) {
    const name = user.display_name || user.username || 'Participant';
    const container = document.createElement('div');
    container.className = 'group-call-avatar';
    const initial = document.createElement('span');
    initial.textContent = name.trim().charAt(0).toUpperCase() || '?';
    container.append(initial);
    if (user.avatar_url) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = /^https?:/i.test(user.avatar_url) ? user.avatar_url : `${API_ORIGIN}${user.avatar_url}`;
      image.addEventListener('error', () => image.remove());
      container.append(image);
    }
    return container;
  }

  async function getMedia(video) {
    return navigator.mediaDevices.getUserMedia({
      audio: audioDevices.audioConstraints({ echoCancellation: true, noiseSuppression: true }),
      video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 } } : false
    });
  }

  async function start({ targetId, conversationId, video }) {
    if (opening || service.call || incoming || isBusy()) throw new Error('You are already in a call.');
    opening = true;
    let stream;
    try {
      stream = await getMedia(video);
      if (isBusy() || incoming) throw new Error('You are already in a call.');
      await service.create({ targetId, conversationId, video, stream });
      renderCall();
    } catch (error) {
      if (service.call) service.leave().catch(failure => console.error('Could not leave call:', failure));
      if (stream) stream.getTracks().forEach(track => track.stop());
      throw error;
    } finally {
      opening = false;
    }
  }

  async function openNotification(callId) {
    if (service.call?.callId === callId || (opening && notificationCallId === callId)) return;
    if (opening || service.call || isBusy() || (incoming && incoming.callId !== callId)) {
      showToast('You are already in a call.');
      return;
    }
    opening = true;
    notificationCallId = callId;
    let stream;
    try {
      const invitation = await service.pendingInvitation(callId);
      stream = await getMedia(invitation.video);
      if (isBusy()) throw new Error('You are already in a call.');
      await service.accept(callId, stream);
      incoming = null;
      stopRingtone();
      renderCall();
    } catch (error) {
      if (service.call) service.leave().catch(failure => console.error('Could not leave call:', failure));
      stream?.getTracks().forEach(track => track.stop());
      if (incoming?.callId === callId) {
        incoming = null;
        stopRingtone();
        close();
      }
      showToast(error.message || 'Could not join the call.');
    } finally {
      notificationCallId = null;
      opening = false;
    }
  }

  function renderIncoming() {
    const panel = document.createElement('div');
    panel.className = 'call-panel call-incoming group-call-incoming';
    const name = document.createElement('h2');
    setCallParticipantName(name, incoming.from?.display_name || incoming.from?.username || 'Friend', incoming.from?.platform);
    const description = document.createElement('p');
    description.textContent = `Incoming ${incoming.video ? 'video' : 'voice'} call`;
    const actions = document.createElement('div');
    actions.className = 'call-actions';
    actions.append(button('Decline', async () => {
      const invitation = incoming;
      incoming = null;
      stopRingtone();
      close();
      try { await service.decline(invitation.callId); } catch (error) { showToast(error.message); }
    }, 'call-decline'));
    actions.append(button('Accept', async () => {
      const invitation = incoming;
      if (!invitation || opening) return;
      opening = true;
      let stream;
      try {
        stream = await getMedia(invitation.video);
        if (incoming !== invitation || isBusy()) throw new Error('Call is no longer available.');
        await service.accept(invitation.callId, stream);
        incoming = null;
        stopRingtone();
        renderCall();
      } catch (error) {
        if (service.call) service.leave().catch(failure => console.error('Could not leave call:', failure));
        stream?.getTracks().forEach(track => track.stop());
        incoming = null;
        stopRingtone();
        close();
        showToast(error.message || 'Could not join the call.');
        service.decline(invitation.callId).catch(failure => console.error('Could not decline invitation:', failure));
      } finally {
        opening = false;
      }
    }, 'call-accept'));
    panel.append(avatar(incoming.from || {}), name, description, actions);
    mount(panel);
  }

  function renderCall() {
    const panel = document.createElement('div');
    panel.className = 'call-panel call-active group-call-panel';
    if (service.call.video) panel.classList.add('is-screen-guard-pending');
    else panel.classList.add('is-voice-call');
    const header = document.createElement('header');
    header.className = 'group-call-header';
    header.textContent = service.call.video ? 'Video call' : 'Voice call';
    const grid = document.createElement('div');
    grid.className = 'group-call-grid';
    const actions = document.createElement('div');
    actions.className = 'call-actions';
    actions.append(button('Mute', event => toggleTrack('audio', event.currentTarget)));
    if (service.call.video) {
      actions.append(button('Camera', event => toggleTrack('video', event.currentTarget)));
      actions.append(button('Switch camera', async event => {
        const element = event.currentTarget;
        element.disabled = true;
        try { await cameraSwitcher.switchCamera(); }
        finally { element.disabled = false; }
      }));
      const mirror = button('Mirror', event => {
        localPreviewMirrored = !localPreviewMirrored;
        event.currentTarget.setAttribute('aria-pressed', String(localPreviewMirrored));
        updateParticipants(service.call);
      });
      mirror.setAttribute('aria-label', 'Mirror your video preview');
      mirror.setAttribute('aria-pressed', 'false');
      actions.append(mirror);
    }
    actions.append(button('Audio', () => audioDevices.open()));
    actions.append(button('Invite', showFriends, 'call-toggle call-invite'));
    actions.append(button('Leave', () => service.leave().catch(error => showToast(error.message)), 'call-decline'));
    panel.append(header, grid, actions);
    mount(panel);
    if (service.call.video) {
      const fitActions = () => panel.style.setProperty('--call-actions-height', `${actions.getBoundingClientRect().height}px`);
      fitActions();
      if (typeof ResizeObserver !== 'undefined') {
        actionsResizeObserver = new ResizeObserver(fitActions);
        actionsResizeObserver.observe(actions);
      }
      protectedVideoCall = true;
      Promise.resolve(setVideoProtection(true)).catch(error => {
        console.error('Could not protect video call:', error);
        showToast('Screen capture protection is unavailable on this device.');
      }).finally(() => panel.classList.remove('is-screen-guard-pending'));
    }
    updateParticipants(service.call);
  }

  function updateParticipants(call) {
    const grid = overlay?.querySelector('.group-call-grid');
    if (!grid) return;
    if (!call.video) {
      const count = call.participants.length;
      const columns = count <= 1 ? 1 : count <= 4 ? 2 : 3;
      grid.dataset.voiceColumns = String(columns);
      grid.dataset.voiceRows = String(count > columns ? 2 : 1);
    }
    const ids = new Set(call.participants.map(user => user.id));
    for (const tile of grid.querySelectorAll('[data-peer]')) if (!ids.has(tile.dataset.peer)) tile.remove();
    for (const user of call.participants) {
      const existing = grid.querySelector(`[data-peer="${user.id}"]`);
      if (existing) {
        const label = existing.querySelector('.group-call-name');
        setCallParticipantName(label, user.display_name || user.username || 'Participant', user.platform);
        continue;
      }
      const tile = document.createElement('div');
      tile.className = 'group-call-tile';
      if (!call.video) tile.classList.add('is-voice');
      tile.dataset.peer = user.id;
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      if (user.id === service.userId) {
        video.muted = true;
        video.srcObject = call.stream;
      } else audioDevices.applyOutput(video);
      const label = document.createElement('span');
      label.className = 'group-call-name';
      setCallParticipantName(label, user.display_name || user.username || 'Participant', user.platform);
      const swap = document.createElement('button');
      swap.type = 'button';
      swap.className = 'call-swap-video';
      swap.textContent = 'Swap';
      swap.setAttribute('aria-label', 'Swap large and small video');
      swap.addEventListener('click', () => {
        localVideoIsMain = !localVideoIsMain;
        updateParticipants(service.call);
      });
      tile.append(video, avatar(user), label, swap);
      grid.append(tile);
    }
    const isOneToOne = call.video && call.participants.length === 2
      && ids.has(service.userId);
    grid.classList.toggle('is-one-to-one', isOneToOne);
    overlay.querySelector('.group-call-panel').classList.toggle('is-one-to-one', isOneToOne);
    for (const tile of grid.querySelectorAll('[data-peer]')) {
      const isLocal = tile.dataset.peer === service.userId;
      const isSmall = isOneToOne && (isLocal !== localVideoIsMain);
      tile.classList.toggle('is-call-inset', isSmall);
      tile.classList.toggle('is-preview-mirrored', isLocal && localPreviewMirrored);
      tile.querySelector('.call-swap-video').hidden = !isSmall;
    }
  }

  function toggleTrack(kind, element) {
    const tracks = kind === 'audio' ? service.call?.stream.getAudioTracks() : service.call?.stream.getVideoTracks();
    if (!tracks?.length) return;
    const enabled = !tracks.every(track => track.enabled);
    tracks.forEach(track => { track.enabled = enabled; });
    element.classList.toggle('is-off', !enabled);
  }

  async function showFriends() {
    if (!service.call || !overlay) return;
    const existing = overlay.querySelector('.group-call-friends');
    if (existing) { existing.remove(); return; }
    if (!service.call.video && service.call.participants.length + (service.call.pending?.length || 0) >= 6) {
      showToast('This voice call is full (maximum 6 people).');
      return;
    }
    const panel = document.createElement('section');
    panel.className = 'group-call-friends';
    panel.textContent = 'Loading friends...';
    overlay.append(panel);
    try {
      const { friends } = await apiRequest('/users/friends');
      if (overlay?.querySelector('.group-call-friends') !== panel) return;
      panel.replaceChildren();
      if (!friends.length) panel.textContent = 'No friends available to invite.';
      for (const friend of friends) {
        const row = document.createElement('button');
        row.type = 'button';
        row.textContent = friend.display_name || friend.username || 'Friend';
        row.addEventListener('click', async () => {
          row.disabled = true;
          try {
            await service.invite(friend.id);
            panel.remove();
          } catch (error) {
            row.disabled = false;
            showToast(error.message || 'Could not invite this friend.');
          }
        });
        panel.append(row);
      }
    } catch (error) {
      console.error('Could not load call friends:', error);
      if (overlay?.querySelector('.group-call-friends') !== panel) return;
      panel.textContent = 'Could not load friends.';
      showToast(error.message || 'Could not load friends.');
    }
  }

  service.startPolling();
  return { start, openNotification, busy: () => Boolean(service.call || incoming || opening) };
}
