const MAX_PARTICIPANTS = 8;
const MAX_VOICE_PARTICIPANTS = 6;
const RING_TIMEOUT = 45_000;
const HEARTBEAT_TIMEOUT = 60_000;
const MAX_SIGNAL_BYTES = 16_384;
const MAX_QUEUED_EVENTS = 256;
const EVENT_RETENTION = 2 * 60_000;

export class CallError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export class CallRegistry {
  constructor({ now = () => Date.now(), randomUUID = () => crypto.randomUUID(), onPushEvent = () => {} } = {}) {
    this.now = now;
    this.randomUUID = randomUUID;
    this.onPushEvent = onPushEvent;
    this.epoch = this.randomUUID();
    this.rooms = new Map();
    this.memberships = new Map();
    this.queues = new Map();
    this.queueUpdated = new Map();
    this.nextEvent = 0;
  }

  create(user, video, deviceId = null) {
    this.sweep();
    this.requireAvailable(user.id);
    const id = this.randomUUID();
    if (this.rooms.has(id)) throw new CallError('Could not create a unique call.', 503);
    const room = {
      id, video: Boolean(video),
      members: new Map([[user.id, { user, active: true, touched: this.now(), deviceId }]])
    };
    this.rooms.set(id, room);
    this.memberships.set(user.id, id);
    return this.snapshot(room);
  }

  invite(actorId, roomId, target) {
    this.sweep();
    const room = this.activeRoom(actorId, roomId);
    if (!target || target.id === actorId) throw new CallError('Invalid invitee.');
    this.requireAvailable(target.id);
    const limit = room.video ? MAX_PARTICIPANTS : MAX_VOICE_PARTICIPANTS;
    if (room.members.size >= limit) {
      throw new CallError(room.video ? 'This call is full.' : 'This voice call is full (maximum 6 people).', 409);
    }
    const inviter = room.members.get(actorId).user;
    room.members.set(target.id, { user: target, active: false, touched: this.now() });
    this.memberships.set(target.id, room.id);
    this.emit(target.id, { type: 'incoming', callId: room.id, video: room.video, from: inviter });
    this.notifyPush({ type: 'invite', userId: target.id, callId: room.id, video: room.video, expiresAt: room.members.get(target.id).touched + RING_TIMEOUT });
    return this.snapshot(room);
  }

  accept(userId, roomId, deviceId = null) {
    this.sweep();
    const room = this.room(roomId);
    const member = room.members.get(userId);
    if (!member || member.active) throw new CallError('This invitation is unavailable.', 404);
    member.active = true;
    room.hadMultipleParticipants = true;
    member.deviceId = deviceId;
    member.touched = this.now();
    this.notifyPush({ type: 'end', userId, callId: room.id });
    const others = [...room.members.values()].filter(item => item.active && item.user.id !== userId);
    for (const other of others) this.emit(other.user.id, { type: 'joined', callId: room.id, user: member.user });
    return this.snapshot(room);
  }

  decline(userId, roomId) {
    this.sweep();
    const room = this.room(roomId);
    const member = room.members.get(userId);
    if (!member || member.active) throw new CallError('This invitation is unavailable.', 404);
    this.remove(room, userId, 'declined');
  }

  leave(userId, roomId) {
    this.sweep();
    const room = this.activeRoom(userId, roomId);
    this.remove(room, userId, 'left');
  }

  signal(userId, roomId, targetId, signal) {
    this.sweep();
    const room = this.activeRoom(userId, roomId);
    if (targetId === userId || !room.members.get(targetId)?.active) {
      throw new CallError('Call participant is unavailable.', 404);
    }
    if (!signal || typeof signal !== 'object' || Array.isArray(signal) ||
        new TextEncoder().encode(JSON.stringify(signal)).length > MAX_SIGNAL_BYTES) {
      throw new CallError('Invalid call signal.');
    }
    this.emit(targetId, { type: 'signal', callId: room.id, from: userId, signal });
  }

  poll(userId, after = 0) {
    this.sweep();
    if (!Number.isSafeInteger(after) || after < 0 || after > this.nextEvent) throw new CallError('Invalid event cursor.');
    const roomId = this.memberships.get(userId);
    const room = roomId && this.rooms.get(roomId);
    const member = room?.members.get(userId);
    if (member?.active) member.touched = this.now();
    const events = (this.queues.get(userId) || []).filter(event => event.sequence > after);
    if (events.length) this.queues.set(userId, events);
    else {
      this.queues.delete(userId);
      this.queueUpdated.delete(userId);
    }
    return { epoch: this.epoch, events: [...events], call: room ? this.snapshot(room) : null };
  }

  room(id) {
    const room = this.rooms.get(id);
    if (!room) throw new CallError('Call is no longer available.', 404);
    return room;
  }

  activeRoom(userId, id) {
    const room = this.room(id);
    if (!room.members.get(userId)?.active) throw new CallError('Not a call participant.', 403);
    return room;
  }

  requireAvailable(userId) {
    if (!userId || this.memberships.has(userId)) throw new CallError('This person is already in a call.', 409);
  }

  snapshot(room) {
    return {
      callId: room.id, video: room.video,
      participants: [...room.members.values()].filter(member => member.active).map(member => member.user),
      pending: [...room.members.values()].filter(member => !member.active).map(member => member.user)
    };
  }

  emit(userId, event) {
    const queue = this.queues.get(userId) || [];
    if (queue.length >= MAX_QUEUED_EVENTS) {
      this.queues.set(userId, [{ type: 'overflow', sequence: ++this.nextEvent }]);
      this.queueUpdated.set(userId, this.now());
      return;
    }
    queue.push({ ...event, sequence: ++this.nextEvent });
    this.queues.set(userId, queue);
    this.queueUpdated.set(userId, this.now());
  }

  notifyPush(event) {
    try {
      this.onPushEvent(event);
    } catch (error) {
      console.error('Could not queue call notification:', error);
    }
  }

  remove(room, userId, reason) {
    const member = room.members.get(userId);
    if (!member) return;
    room.members.delete(userId);
    if (!member.active) this.notifyPush({ type: 'end', userId, callId: room.id });
    this.memberships.delete(userId);
    this.queues.delete(userId);
    this.queueUpdated.delete(userId);
    for (const remaining of room.members.values()) {
      if (remaining.active) this.emit(remaining.user.id, {
        type: member.active ? 'left' : 'invitation_ended', callId: room.id, userId, reason
      });
    }
    if (room.hadMultipleParticipants && room.members.size === 1 &&
        [...room.members.values()].every(item => item.active)) {
      const last = room.members.values().next().value;
      this.memberships.delete(last.user.id);
      this.emit(last.user.id, { type: 'ended', callId: room.id, reason: 'last_participant' });
      this.rooms.delete(room.id);
      return;
    }
    if (![...room.members.values()].some(item => item.active)) {
      for (const pending of room.members.values()) {
        this.notifyPush({ type: 'end', userId: pending.user.id, callId: room.id });
        this.memberships.delete(pending.user.id);
        this.queues.delete(pending.user.id);
        this.queueUpdated.delete(pending.user.id);
        this.emit(pending.user.id, { type: 'ended', callId: room.id });
      }
      this.rooms.delete(room.id);
    }
  }

  removeInactive(room, userIds) {
    const inactive = new Set(userIds);
    for (const [recipientId, queue] of this.queues) {
      const filtered = queue.filter(event =>
        !(event.type === 'signal' && inactive.has(event.from)) &&
        !(event.type === 'joined' && inactive.has(event.user?.id)) &&
        !(event.type === 'incoming' && inactive.has(event.from?.id))
      );
      if (filtered.length) this.queues.set(recipientId, filtered);
      else {
        this.queues.delete(recipientId);
        this.queueUpdated.delete(recipientId);
      }
    }
    for (const userId of inactive) {
      if (!this.rooms.has(room.id)) break;
      this.remove(room, userId, 'unavailable');
    }
  }

  sweep() {
    const now = this.now();
    for (const [userId, updated] of this.queueUpdated) {
      if (!this.memberships.has(userId) && now - updated >= EVENT_RETENTION) {
        this.queues.delete(userId);
        this.queueUpdated.delete(userId);
      }
    }
    for (const room of this.rooms.values()) {
      for (const member of [...room.members.values()]) {
        if (!this.rooms.has(room.id)) break;
        if (now - member.touched >= (member.active ? HEARTBEAT_TIMEOUT : RING_TIMEOUT)) {
          this.remove(room, member.user.id, member.active ? 'disconnected' : 'missed');
        }
      }
    }
  }
}
