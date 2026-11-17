export class CallMesh {
  constructor({ stream, rtcConfig, sendSignal, onTrack, onState, onError }) {
    this.stream = stream;
    this.rtcConfig = rtcConfig;
    this.sendSignal = sendSignal;
    this.onTrack = onTrack;
    this.onState = onState;
    this.onError = onError;
    this.peers = new Map();
  }

  addPeer(id) {
    if (this.peers.has(id)) return this.peers.get(id);
    const pc = new RTCPeerConnection(this.rtcConfig);
    const peer = { pc, pendingIce: [], work: Promise.resolve() };
    this.peers.set(id, peer);
    this.stream.getTracks().forEach(track => pc.addTrack(track, this.stream));
    pc.ontrack = event => this.onTrack(id, event);
    pc.onicecandidate = event => {
      if (event.candidate) this.sendSignal(id, { candidate: event.candidate }).catch(this.onError);
    };
    pc.onconnectionstatechange = () => this.onState(id, pc.connectionState);
    return peer;
  }

  queue(id, work) {
    const peer = this.addPeer(id);
    const next = peer.work.then(() => {
      if (this.peers.get(id) !== peer) return;
      return work(peer);
    });
    peer.work = next.catch(error => this.onError(error));
    return next;
  }

  offer(id) {
    return this.queue(id, async ({ pc }) => {
      await pc.setLocalDescription(await pc.createOffer());
      await this.sendSignal(id, { description: pc.localDescription });
    });
  }

  receive(id, signal) {
    return this.queue(id, async peer => {
      const { pc } = peer;
      if (signal.description) {
        await pc.setRemoteDescription(signal.description);
        for (const candidate of peer.pendingIce.splice(0)) await pc.addIceCandidate(candidate);
        if (signal.description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          await this.sendSignal(id, { description: pc.localDescription });
        }
      } else if (signal.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
        else peer.pendingIce.push(signal.candidate);
      } else {
        throw new Error('Invalid call signal.');
      }
    });
  }

  async replaceAudioTrack(oldTrack, newTrack) {
    await this.replaceTrack(oldTrack, newTrack, 'Microphone');
    this.stream.removeTrack(oldTrack);
    this.stream.addTrack(newTrack);
  }

  async replaceVideoTrack(oldTrack, newTrack) {
    await this.replaceTrack(oldTrack, newTrack, 'Camera');
  }

  async replaceTrack(oldTrack, newTrack, label) {
    try {
      for (;;) {
        const senders = [...this.peers.values()].map(({ pc }) => pc.getSenders().find(sender =>
          sender.track === oldTrack || sender.track === newTrack));
        if (senders.some(sender => !sender)) throw new Error(`${label} sender not found.`);
        const pending = senders.filter(sender => sender.track === oldTrack);
        if (!pending.length) break;
        for (const sender of pending) await sender.replaceTrack(newTrack);
      }
    } catch (error) {
      const replaced = [...this.peers.values()].flatMap(({ pc }) => pc.getSenders().filter(sender => sender.track === newTrack));
      const failures = await Promise.allSettled(replaced.map(sender => sender.replaceTrack(oldTrack)));
      if (failures.some(result => result.status === 'rejected')) {
        throw new AggregateError([error, ...failures.filter(result => result.status === 'rejected').map(result => result.reason)], `${label} change and rollback failed.`);
      }
      throw error;
    }
  }

  removePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
  }

  close() {
    for (const id of this.peers.keys()) this.removePeer(id);
  }
}
