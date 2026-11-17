const test = require('node:test');
const assert = require('node:assert/strict');

const conversationId = '75bb349d-14a4-4a14-85c3-c36710292d43';

test('message push targets current recipients, excludes sender, and contains no message content', async () => {
  const { sendMessagePush } = await import('../supabase/functions/vynzo-api/message-push.mjs');
  const sent = [];
  const result = await sendMessagePush({
    conversationId,
    senderId: 'sender',
    async getRecipients(id) {
      assert.equal(id, conversationId);
      return ['sender', 'recipient', 'recipient'];
    },
    async getInstallations(ids) {
      assert.deepEqual(ids, ['recipient']);
      return [{ installationId: 'installation-1', userId: 'recipient' }];
    },
    async send(message) { sent.push(message); },
    async removeUnregistered() { throw new Error('Unexpected cleanup'); }
  });
  assert.deepEqual(sent, [{
    installationId: 'installation-1',
    data: { type: 'message', id: conversationId, user_id: 'recipient' },
    ttlSeconds: 86400
  }]);
  assert.deepEqual(result, { sent: 1, unregistered: 0, failed: 0, cleanupFailed: 0 });
});

test('message push does not query devices for a conversation with no other recipients', async () => {
  const { sendMessagePush } = await import('../supabase/functions/vynzo-api/message-push.mjs');
  const result = await sendMessagePush({
    conversationId,
    senderId: 'sender',
    async getRecipients() { return ['sender']; },
    async getInstallations() { throw new Error('Unexpected device query'); },
    async send() { throw new Error('Unexpected delivery'); },
    async removeUnregistered() { throw new Error('Unexpected cleanup'); }
  });
  assert.equal(result.sent, 0);
});

test('message push propagates recipient lookup errors', async () => {
  const { sendMessagePush } = await import('../supabase/functions/vynzo-api/message-push.mjs');
  await assert.rejects(sendMessagePush({
    conversationId,
    senderId: 'sender',
    async getRecipients() { throw new Error('Database unavailable'); },
    async getInstallations() { return []; },
    async send() {},
    async removeUnregistered() {}
  }), /Database unavailable/);
});
