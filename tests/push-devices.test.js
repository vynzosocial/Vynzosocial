const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto, createHash } = require('node:crypto');

const deviceId = '75bb349d-14a4-4a14-85c3-c36710292d43';
const deviceSecret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test('notification device registration validates identifiers and secret', async () => {
  const { validDeviceRegistration, validDeviceRemoval } = await import('../supabase/functions/vynzo-api/push-devices.mjs');
  const valid = { deviceId, deviceSecret, installationId: 'installation-12345' };
  assert.equal(validDeviceRegistration(valid), true);
  assert.equal(validDeviceRemoval(valid), true);
  for (const body of [null, [], {}, { ...valid, deviceId: 'bad' },
    { ...valid, deviceSecret: 'short' }, { ...valid, installationId: 'bad' }]) {
    assert.equal(validDeviceRegistration(body), false);
  }
  assert.equal(validDeviceRemoval({ ...valid, deviceSecret: 'bad' }), false);
});

test('notification device secret is hashed before database use', async () => {
  const { deviceSecretHash } = await import('../supabase/functions/vynzo-api/push-devices.mjs');
  assert.equal(await deviceSecretHash(deviceSecret, webcrypto), createHash('sha256').update(deviceSecret).digest('hex'));
  await assert.rejects(deviceSecretHash('short', webcrypto), /Invalid notification device secret/);
});
