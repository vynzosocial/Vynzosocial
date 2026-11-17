import { supabase } from './supabase-client.js';
import { CallMesh } from './call-mesh.js';

const ENDPOINT = 'https://vynzo-calls.vynzolive.workers.dev/call';
const POLL_INTERVAL = 3000;
const CONNECTING_POLL_INTERVAL = 750;
const CONNECTING_POLL_WINDOW = 30000;
const REQUEST_TIMEOUT = 10000;

export class GroupCallService {
  constructor({ rtcConfig, onIncoming, onInvitationEnded = () => {}, onChange, onTrack, onPeerState, onError, onAvailability = () => {} }) {
    this.rtcConfig = rtcConfig;
    this.onIncoming = onIncoming;
    this.onInvitationEnded = onInvitationEnded;
    this.onChange = onChange;
    this.onTrack = onTrack;
    this.onPeerState = onPeerState;
    this.onError = onError;
    this.onAvailability = onAvailability;
    this.call = null;
    this.mesh = null;
    this.epoch = null;
    this.cursor = 0;
    this.running = false;
    this.timer = null;
    this.polling = false;
    this.pollAgain = false;
    this.fastPollUntil = 0;
    this.joining = null;
    this.userId = null;
    this.invitationId = null;
    this.deviceId = crypto.randomUUID();
    this.peerPlatforms = new Map();
    this.peerStates = new Map();
  }

  async request(body) {
    if (!supabase) throw new Error('Please log in to use calls.');
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    const session = data?.session;
    if (!session?.access_token || !session.user?.id) throw new Error('Please log in again to use calls.');
    this.userId = session.user.id;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const result = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, deviceId: this.deviceId }),
        signal: controller.signal
      });
      const data = await result.json();
      if (!result.ok) throw new Error(data.error || `Call service failed (HTTP ${result.status}).`);
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('The call service timed out.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  startPolling() {
    if (this.running) return;
    this.running = true;
    this.poll();
  }

  stopPolling() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.pollAgain = false;
  }

  pollSoon() {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.polling) this.pollAgain = true;
    else this.timer = setTimeout(() => this.poll(), 0);
  }

  pollDelay() {
    if (!this.call || Date.now() >= this.fastPollUntil) return POLL_INTERVAL;
    const peers = this.call.participants.filter(user => user.id !== this.userId);
    if (this.call.pending?.length || !peers.length || peers.some(user => this.peerStates.get(user.id) !== 'connected')) {
      return CONNECTING_POLL_INTERVAL;
    }
    return POLL_INTERVAL;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    this.timer = null;
    const polledCallId = this.call?.callId;
    let failed = false;
    try {
      const result = await this.request({ action: 'poll', epoch: this.epoch, after: this.cursor });
      const joining = this.joining;
      if (joining) await joining;
      this.onAvailability(true);
      if (result.reset) {
        this.cursor = 0;
        if (this.call && this.call.callId === polledCallId) this.closeLocally('The call service restarted.');
      }
      this.epoch = result.epoch;
      if (this.invitationId && (result.call?.callId !== this.invitationId ||
          !result.call.pending.some(user => user.id === this.userId))) {
        this.invitationId = null;
        this.onInvitationEnded();
      }
      if (this.call && this.call.callId === polledCallId && !result.call) this.closeLocally('Call ended.');
      const joinedDuringPoll = !polledCallId && joining &&
        result.call?.participants.some(user => user.id === this.userId);
      if (this.call && (this.call.callId === polledCallId || joinedDuringPoll) && result.call?.callId === this.call.callId) {
        Object.assign(this.call, result.call);
        this.applyPlatforms();
        this.onChange(this.call);
      }
      for (const event of result.events) {
        if (event.sequence <= this.cursor) continue;
        const validInvitation = event.type !== 'incoming' ||
          (result.call?.callId === event.callId && result.call.pending.some(user => user.id === this.userId));
        if (validInvitation) await this.handleEvent(event);
        this.cursor = event.sequence;
      }
    } catch (error) {
      failed = true;
      this.onAvailability(false);
      this.onError(error);
    } finally {
      this.polling = false;
      if (this.running) {
        const delay = failed ? 15000 : this.pollAgain ? 0 : this.pollDelay();
        this.pollAgain = false;
        this.timer = setTimeout(() => this.poll(), delay);
      }
    }
  }

  async create({ targetId, conversationId, video, stream }) {
    if (this.call) throw new Error('You are already in a call.');
    const result = await this.request({ action: 'create', targetId, conversationId, video });
    this.startCall(result, stream);
    return this.call;
  }

  async accept(callId, stream) {
    if (this.call || this.joining) throw new Error('You are already in a call.');
    let finishJoining;
    const joining = new Promise(resolve => { finishJoining = resolve; });
    this.joining = joining;
    try {
      const result = await this.request({ action: 'accept', callId });
      this.invitationId = null;
      this.startCall(result, stream);
      for (const participant of result.participants) {
        if (participant.id !== this.userId) this.mesh.addPeer(participant.id);
      }
      return this.call;
    } finally {
      this.joining = null;
      // Let the caller mount the call UI before a waiting poll delivers media.
      setTimeout(finishJoining, 0);
    }
  }

  async pendingInvitation(callId) {
    const result = await this.request({ action: 'poll', epoch: this.epoch, after: 0 });
    const call = result.call;
    if (!call || call.callId !== callId || !Array.isArray(call.pending) ||
        !call.pending.some(user => user.id === this.userId)) {
      throw new Error('This call invitation has ended.');
    }
    return call;
  }

  startCall(snapshot, stream) {
    this.peerPlatforms.clear();
    this.peerStates.clear();
    this.fastPollUntil = Date.now() + CONNECTING_POLL_WINDOW;
    this.call = { ...snapshot, stream };
    this.applyPlatforms();
    const callId = snapshot.callId;
    this.mesh = new CallMesh({
      stream, rtcConfig: this.rtcConfig,
      sendSignal: (targetId, signal) => this.request({ action: 'signal', callId, targetId, signal: { ...signal, platform: globalThis.Capacitor?.isNativePlatform?.() ? 'app' : 'web' } }),
      onTrack: this.onTrack,
      onState: (id, state) => {
        const previous = this.peerStates.get(id);
        this.peerStates.set(id, state);
        this.onPeerState(id, state);
        if (state !== previous && state !== 'connected' && state !== 'closed') {
          this.fastPollUntil = Date.now() + CONNECTING_POLL_WINDOW;
          this.pollSoon();
        }
      },
      onError: this.onError
    });
    this.onChange(this.call);
    this.pollSoon();
  }

  applyPlatforms() {
    for (const user of this.call.participants) {
      user.platform = user.id === this.userId
        ? (globalThis.Capacitor?.isNativePlatform?.() ? 'app' : 'web')
        : this.peerPlatforms.get(user.id);
    }
  }

  invite(targetId) {
    if (!this.call) throw new Error('You are not in a call.');
    return this.request({ action: 'invite', callId: this.call.callId, targetId });
  }

  decline(callId) {
    if (this.invitationId === callId) this.invitationId = null;
    return this.request({ action: 'decline', callId });
  }

  async leave() {
    if (!this.call) return;
    const callId = this.call.callId;
    this.closeLocally('You left the call.');
    await this.request({ action: 'leave', callId });
  }

  closeLocally(reason) {
    if (!this.call) return;
    this.mesh.close();
    this.call.stream.getTracks().forEach(track => track.stop());
    this.mesh = null;
    this.call = null;
    this.peerPlatforms.clear();
    this.peerStates.clear();
    this.onChange(null, reason);
  }

  async handleEvent(event) {
    if (event.type === 'incoming') {
      if (!this.call) {
        this.invitationId = event.callId;
        this.onIncoming(event);
      }
      return;
    }
    if (event.type === 'ended' && event.callId === this.invitationId) {
      this.invitationId = null;
      this.onInvitationEnded();
      return;
    }
    if (event.type === 'overflow') {
      this.closeLocally('Call signaling was interrupted.');
      this.onError(new Error('Call signaling was interrupted. Start the call again.'));
      return;
    }
    if (!this.call || event.callId !== this.call.callId) return;
    if (event.type === 'joined' && this.call.participants.some(user => user.id === event.user.id)) {
      this.fastPollUntil = Date.now() + CONNECTING_POLL_WINDOW;
      await this.mesh.offer(event.user.id);
    } else if (event.type === 'signal' && this.call.participants.some(user => user.id === event.from)) {
      if (event.signal?.platform === 'web' || event.signal?.platform === 'app') {
        this.peerPlatforms.set(event.from, event.signal.platform);
        this.applyPlatforms();
        this.onChange(this.call);
      }
      await this.mesh.receive(event.from, event.signal);
    }
    else if (event.type === 'left') {
      this.peerPlatforms.delete(event.userId);
      this.peerStates.delete(event.userId);
      this.mesh.removePeer(event.userId);
      this.onPeerState(event.userId, 'closed');
    } else if (event.type === 'ended') this.closeLocally('Call ended.');
  }
}
