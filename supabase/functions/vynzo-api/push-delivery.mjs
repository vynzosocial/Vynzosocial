import { FcmError } from './fcm-sender.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALLATION_ID = /^[A-Za-z0-9_-]{11,128}$/;
const MAX_PARALLEL = 8;
const CALL_RING_MS = 45_000;

export function messagePush(conversationId) {
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) {
    throw new Error('Invalid notification conversation.');
  }
  return { data: { type: 'message', id: conversationId }, ttlSeconds: 86400 };
}

export function callPush(callId, video, expiresAt, now = Date.now()) {
  if (typeof callId !== 'string' || !UUID.test(callId) || typeof video !== 'boolean' ||
      !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(now) || expiresAt <= now ||
      expiresAt - now > CALL_RING_MS) {
    throw new Error('Invalid notification call invitation.');
  }
  return {
    data: { type: video ? 'video_call' : 'voice_call', id: callId, expires_at: String(expiresAt) },
    ttlSeconds: Math.floor((expiresAt - now) / 1000)
  };
}

export function callEndPush(callId) {
  if (typeof callId !== 'string' || !UUID.test(callId)) {
    throw new Error('Invalid notification call.');
  }
  return { data: { type: 'call_end', id: callId }, ttlSeconds: 60 };
}

export async function deliverPush({ installations, message, send, removeUnregistered, onFailure = () => {} }) {
  if (!Array.isArray(installations) || typeof send !== 'function' ||
      typeof removeUnregistered !== 'function' || typeof onFailure !== 'function' || !message ||
      !installations.every(item => typeof item === 'string' && INSTALLATION_ID.test(item))) {
    throw new Error('Invalid push delivery request.');
  }
  const unique = [...new Set(installations)];
  const result = { sent: 0, unregistered: 0, failed: 0, cleanupFailed: 0 };
  let next = 0;
  async function worker() {
    while (next < unique.length) {
      const installationId = unique[next++];
      try {
        await send({ ...message, installationId });
        result.sent++;
      } catch (error) {
        if (!(error instanceof FcmError) || error.code !== 'UNREGISTERED') {
          result.failed++;
          onFailure('delivery', error);
          continue;
        }
        try {
          await removeUnregistered(installationId);
          result.unregistered++;
        } catch (error) {
          result.cleanupFailed++;
          onFailure('cleanup', error);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, unique.length) }, worker));
  return result;
}
