const test = require('node:test');
const assert = require('node:assert/strict');

const ID = '75bb349d-14a4-4a14-85c3-c36710292d43';

test('message notifications never contain message content', async () => {
  const { messagePush } = await import('../supabase/functions/vynzo-api/push-delivery.mjs');
  assert.deepEqual(messagePush(ID), { data: { type: 'message', id: ID }, ttlSeconds: 86400 });
  assert.throws(() => messagePush('invalid'), /Invalid notification conversation/);
});

test('call payloads expire within the invitation window', async () => {
  const { callPush, callEndPush } = await import('../supabase/functions/vynzo-api/push-delivery.mjs');
  assert.deepEqual(callPush(ID, true, 146_000, 101_000), {
    data: { type: 'video_call', id: ID, expires_at: '146000' }, ttlSeconds: 45
  });
  assert.equal(callPush(ID, false, 101_500, 101_000).ttlSeconds, 0);
  assert.deepEqual(callEndPush(ID), { data: { type: 'call_end', id: ID }, ttlSeconds: 60 });
  assert.throws(() => callPush(ID, false, 146_001, 101_000), /Invalid notification/);
  assert.throws(() => callPush(ID, false, 101_000, 101_000), /Invalid notification/);
  assert.throws(() => callPush(ID, 'false', 102_000, 101_000), /Invalid notification/);
});

test('live push targets only eligible devices and carries no broadcast details', async () => {
  const { livePush } = await import('../supabase/functions/vynzo-api/push-delivery.mjs');
  const { sendRecipientPush } = await import('../supabase/functions/vynzo-api/message-push.mjs');
  const message = livePush(ID, 1000);
  const sent = [];
  const deliver = userId => sendRecipientPush({
    recipientIds: ['friend'], message,
    async getInstallations() { return [{ installationId: 'installation-1', userId }]; },
    async send(push) { sent.push(push); },
    async removeUnregistered() { assert.fail('Unexpected cleanup'); }
  });
  await assert.rejects(deliver('uninvited'), /not a recipient/);
  assert.deepEqual(sent, []);
  await deliver('friend');
  assert.deepEqual(sent, [{
    installationId: 'installation-1',
    data: { type: 'live_started', id: ID, expires_at: '91000', user_id: 'friend' },
    ttlSeconds: 90
  }]);
});

test('delivery deduplicates installations and reports failures and stale registrations', async () => {
  const { deliverPush, messagePush } = await import('../supabase/functions/vynzo-api/push-delivery.mjs');
  const { FcmError } = await import('../supabase/functions/vynzo-api/fcm-sender.mjs');
  const removed = [];
  const failures = [];
  const result = await deliverPush({
    installations: ['installation-1', 'installation-2', 'installation-3', 'installation-4', 'installation-1'],
    message: messagePush(ID),
    async send({ installationId, data }) {
      assert.equal(data.type, 'message');
      if (installationId === 'installation-2' || installationId === 'installation-4') {
        throw new FcmError('Unregistered', 404, 'UNREGISTERED');
      }
      if (installationId === 'installation-3') throw new FcmError('Unavailable', 503);
    },
    async removeUnregistered(installationId) {
      if (installationId === 'installation-4') throw new Error('Database unavailable');
      removed.push(installationId);
    },
    onFailure(stage, error) { failures.push([stage, error.message]); }
  });
  assert.deepEqual(result, { sent: 1, unregistered: 1, failed: 1, cleanupFailed: 1 });
  assert.deepEqual(removed, ['installation-2']);
  assert.deepEqual(failures.sort(), [['cleanup', 'Database unavailable'], ['delivery', 'Unavailable']]);
  await assert.rejects(deliverPush({
    installations: ['bad'], message: messagePush(ID), send() {}, removeUnregistered() {}
  }), /Invalid push delivery request/);
});

test('delivery limits concurrent sends', async () => {
  const { deliverPush, messagePush } = await import('../supabase/functions/vynzo-api/push-delivery.mjs');
  let active = 0;
  let max = 0;
  const result = await deliverPush({
    installations: Array.from({ length: 20 }, (_, i) => `installation-${i}`),
    message: messagePush(ID),
    async send() {
      active++;
      max = Math.max(active, max);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
    },
    async removeUnregistered() { throw new Error('Unexpected cleanup'); }
  });
  assert.equal(result.sent, 20);
  assert.equal(max, 8);
});
