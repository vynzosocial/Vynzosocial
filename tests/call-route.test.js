const test = require('node:test');
const assert = require('node:assert/strict');

test('preserves legacy routing unless a ready coordinator can reach an enrolled offline recipient', async () => {
  const { shouldUseCoordinator } = await import('../frontend/js/call-route.mjs');
  let checks = 0;
  const input = {
    onlineSupports: false, ready: true, pushEnabled: true,
    async checkPushAvailability() { checks++; return true; }
  };
  assert.equal(await shouldUseCoordinator(input), true);
  assert.equal(checks, 1);
  assert.equal(await shouldUseCoordinator({ ...input, checkPushAvailability: async () => false }), false);
  assert.equal(await shouldUseCoordinator({ ...input, pushEnabled: false }), false);
  assert.equal(await shouldUseCoordinator({ ...input, ready: false }), false);
  assert.equal(await shouldUseCoordinator({ ...input, onlineSupports: true }), true);
  assert.equal(checks, 1);
  await assert.rejects(shouldUseCoordinator({
    ...input, async checkPushAvailability() { throw new Error('offline'); }
  }), /offline/);
});
