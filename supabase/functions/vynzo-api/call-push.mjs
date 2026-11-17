import { verifyCallPush } from '../_shared/call-push-auth.mjs';
import { callPush, callEndPush, deliverPush } from './push-delivery.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1024;

async function readBody(request) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function handleCallPush({ request, secret, getInstallations, send, removeUnregistered, onFailure, now = Date.now() }) {
  if (!secret) throw new Error('Call push secret is not configured.');
  const body = await readBody(request);
  if (body === null) return { status: 413, error: 'Request too large.' };
  if (!await verifyCallPush(secret, request.headers.get('X-Call-Timestamp'), body,
    request.headers.get('X-Call-Signature'), now)) {
    return { status: 401, error: 'Invalid call push authorization.' };
  }
  let event;
  try {
    event = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { status: 400, error: 'Invalid call push request.' };
  }
  if (!event || !['invite', 'end'].includes(event.type) ||
      typeof event.userId !== 'string' || !UUID.test(event.userId) ||
      typeof event.callId !== 'string' || !UUID.test(event.callId)) {
    return { status: 400, error: 'Invalid call push request.' };
  }
  if (event.type === 'invite' &&
      (typeof event.video !== 'boolean' || !Number.isSafeInteger(event.expiresAt) ||
       event.expiresAt > now + 45_000)) {
    return { status: 400, error: 'Invalid call invitation.' };
  }
  if (event.type === 'invite' && event.expiresAt <= now) return { status: 200, expired: true };
  const message = event.type === 'invite'
    ? callPush(event.callId, event.video, event.expiresAt, now)
    : callEndPush(event.callId);
  const installations = await getInstallations(event.userId);
  const result = await deliverPush({
    installations, message,
    send: payload => send({ ...payload, data: { ...payload.data, user_id: event.userId } }),
    removeUnregistered, onFailure
  });
  if (result.failed || result.cleanupFailed) return { status: 503, error: 'Call push delivery failed.' };
  return { status: 200, delivered: result.sent };
}
