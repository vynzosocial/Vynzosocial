import { CallError, CallRegistry } from './call-registry.mjs';
import { createCallPushSender } from './push-notifications.mjs';

const SUPABASE_ORIGIN = 'https://qyfphwrmwvnwsklfsbbo.supabase.co';
const ORIGINS = new Set(['https://www.vynzosocial.com', 'https://vynzosocial.com', 'https://localhost', 'capacitor://localhost']);
const MAX_BODY_BYTES = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function response(status, data, headers) {
  return Response.json(data, { status, headers: { ...headers, 'Cache-Control': 'no-store' } });
}

async function readBody(request) {
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new CallError('Call request is too large.', 413);
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new CallError('Call request is too large.', 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class CallCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.registry = new CallRegistry({ onPushEvent: event => this.queuePush(event) });
  }

  queuePush(event) {
    if (this.env.CALL_PUSH_ENABLED !== 'true') return;
    const task = (async () => {
      const send = createCallPushSender({
        url: `${SUPABASE_ORIGIN}/functions/v1/vynzo-api/api/calls/push`,
        secret: this.env.CALL_PUSH_SECRET,
        publishableKey: this.env.VYNZO_SUPABASE_PUBLISHABLE_KEY
      });
      await send(event);
    })().catch(error => console.error('Call notification delivery failed:', error));
    this.state.waitUntil(task);
  }

  async fetch(request) {
    const origin = request.headers.get('Origin');
    const headers = { Vary: 'Origin' };
    if (origin && !ORIGINS.has(origin)) return response(403, { error: 'Origin not allowed.' }, headers);
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'authorization, content-type';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' }, headers);
    const authorization = request.headers.get('Authorization');
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return response(401, { error: 'Please log in to use calls.' }, headers);
    try {
      const auth = await fetch(`${SUPABASE_ORIGIN}/auth/v1/user`, {
        headers: { Authorization: authorization, apikey: this.env.VYNZO_SUPABASE_PUBLISHABLE_KEY }
      });
      if (auth.status === 401 || auth.status === 403) return response(401, { error: 'Please log in again to use calls.' }, headers);
      if (!auth.ok) throw new Error(`Call authentication failed (HTTP ${auth.status}).`);
      const identity = await auth.json();
      if (!identity?.id) throw new Error('Call authentication returned an invalid identity.');
      if (this.env.ACCOUNT_LIFECYCLE_ENABLED === 'true') {
        const verification = await fetch(`${SUPABASE_ORIGIN}/functions/v1/vynzo-api/api/calls/session`, {
          headers: { Authorization: authorization, apikey: this.env.VYNZO_SUPABASE_PUBLISHABLE_KEY }
        });
        if (verification.status === 401 || verification.status === 403) {
          return response(401, { error: 'Please log in again to use calls.' }, headers);
        }
        if (!verification.ok) throw new Error(`Call session verification failed (HTTP ${verification.status}).`);
        const account = await verification.json();
        if (account?.userId !== identity.id) throw new Error('Call session identity mismatch.');
      }
      const text = await readBody(request);
      let body;
      try {
        body = JSON.parse(text);
      } catch (error) {
        if (error instanceof SyntaxError) return response(400, { error: 'Invalid call request.' }, headers);
        throw error;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return response(400, { error: 'Invalid call request.' }, headers);
      if (typeof body.deviceId !== 'string' || !UUID.test(body.deviceId)) return response(400, { error: 'Invalid call device.' }, headers);
      this.registry.sweep();
      if (this.env.ACCOUNT_LIFECYCLE_ENABLED === 'true') await this.removeInactiveParticipants(identity.id);
      const currentRoom = this.registry.rooms.get(this.registry.memberships.get(identity.id));
      const currentMember = currentRoom?.members.get(identity.id);
      if (currentMember?.active && currentMember.deviceId !== body.deviceId) {
        if (body.action === 'poll') {
          return response(200, { epoch: this.registry.epoch, reset: false, events: [], call: null }, headers);
        }
        return response(409, { error: 'This call is active on another device or tab.' }, headers);
      }
      let result;
      switch (body.action) {
        case 'poll': {
          const reset = Boolean(body.epoch && body.epoch !== this.registry.epoch);
          result = { ...this.registry.poll(identity.id, reset ? 0 : (body.after ?? 0)), reset };
          break;
        }
        case 'create': {
          if (typeof body.video !== 'boolean') throw new CallError('Invalid call type.');
          const parties = await this.authorizeInvite(authorization, body.targetId, body.conversationId);
          if (parties.actor.id !== identity.id) throw new Error('Call identity mismatch.');
          this.registry.sweep();
          this.registry.requireAvailable(parties.target.id);
          result = this.registry.create(parties.actor, body.video, body.deviceId);
          try {
            result = this.registry.invite(identity.id, result.callId, parties.target);
          } catch (error) {
            this.registry.leave(identity.id, result.callId);
            throw error;
          }
          break;
        }
        case 'invite': {
          this.registry.activeRoom(identity.id, body.callId);
          const parties = await this.authorizeInvite(authorization, body.targetId);
          if (parties.actor.id !== identity.id) throw new Error('Call identity mismatch.');
          if (this.registry.activeRoom(identity.id, body.callId).members.get(identity.id).deviceId !== body.deviceId) {
            throw new CallError('This call is active on another device or tab.', 409);
          }
          result = this.registry.invite(identity.id, body.callId, parties.target);
          break;
        }
        case 'accept':
          result = this.registry.accept(identity.id, body.callId, body.deviceId);
          break;
        case 'decline':
          this.registry.decline(identity.id, body.callId);
          result = { ok: true };
          break;
        case 'leave':
          this.registry.leave(identity.id, body.callId);
          result = { ok: true };
          break;
        case 'signal':
          this.registry.signal(identity.id, body.callId, body.targetId, body.signal);
          result = { ok: true };
          break;
        default:
          return response(400, { error: 'Unknown call action.' }, headers);
      }
      return response(200, result, headers);
    } catch (error) {
      if (error instanceof CallError) return response(error.status, { error: error.message }, headers);
      console.error('Call coordinator error:', error);
      return response(503, { error: 'Calls are temporarily unavailable.' }, headers);
    }
  }

  async removeInactiveParticipants(userId) {
    const roomId = this.registry.memberships.get(userId);
    const room = roomId && this.registry.rooms.get(roomId);
    if (!room) return;
    const ids = [...room.members.keys()];
    const secret = this.env.CALL_LIFECYCLE_SECRET;
    if (typeof secret !== 'string' || secret.length < 32) throw new Error('Call participant verification is not configured.');
    const result = await fetch(`${SUPABASE_ORIGIN}/functions/v1/vynzo-api/api/calls/participant-status`, {
      method: 'POST',
      headers: { apikey: this.env.VYNZO_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json', 'X-Call-Lifecycle': secret },
      body: JSON.stringify({ userIds: ids })
    });
    if (!result.ok) throw new Error(`Call participant verification failed (HTTP ${result.status}).`);
    const status = await result.json();
    if (!Array.isArray(status?.inactiveIds) || new Set(status.inactiveIds).size !== status.inactiveIds.length ||
        status.inactiveIds.some(id => typeof id !== 'string' || !ids.includes(id))) {
      throw new Error('Call participant verification returned invalid participants.');
    }
    if (this.registry.rooms.get(roomId) !== room || this.registry.memberships.get(userId) !== roomId ||
        room.members.size !== ids.length || ids.some(id => !room.members.has(id))) {
      throw new Error('Call participants changed during verification.');
    }
    this.registry.removeInactive(room, status.inactiveIds);
    if (status.inactiveIds.includes(userId)) throw new CallError('Please log in again to use calls.', 401);
  }

  async authorizeInvite(authorization, targetId, conversationId) {
    const result = await fetch(`${SUPABASE_ORIGIN}/functions/v1/vynzo-api/api/calls/authorize-invite`, {
      method: 'POST',
      headers: { Authorization: authorization, apikey: this.env.VYNZO_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId, ...(conversationId ? { conversationId } : {}) })
    });
    if (result.status === 404 || result.status === 403) throw new CallError('This person is unavailable for calls.', 404);
    if (result.status === 400) throw new CallError('Invalid call invitation.');
    if (result.status === 401) throw new CallError('Please log in again to use calls.', 401);
    if (!result.ok) throw new Error(`Call authorization failed (HTTP ${result.status}).`);
    const parties = await result.json();
    if (!parties?.actor?.id || !parties?.target?.id || parties.target.id !== targetId) {
      throw new Error('Call authorization returned invalid participants.');
    }
    return parties;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/call') return response(404, { error: 'Not found.' }, {});
    const coordinator = env.CALL_COORDINATOR.get(env.CALL_COORDINATOR.idFromName('calls'));
    return coordinator.fetch(request);
  }
};
