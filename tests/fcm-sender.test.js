const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto, generateKeyPairSync, verify } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const modulePath = pathToFileURL(path.resolve(__dirname, '../supabase/functions/vynzo-api/fcm-sender.mjs')).href;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  project_id: 'test-vynzo',
  client_email: 'sender@test-vynzo.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
};

test('signs authorization and sends a restricted, short-lived Android message', async () => {
  const { createFcmSender } = await import(modulePath);
  let authCount = 0;
  let sendCount = 0;
  const sender = createFcmSender({
    serviceAccount, cryptoImpl: webcrypto, now: () => 1_700_000_000_000,
    fetchImpl: async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        authCount++;
        const assertion = options.body.get('assertion');
        const [header, payload, signature] = assertion.split('.');
        assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
        const claims = JSON.parse(Buffer.from(payload, 'base64url'));
        assert.equal(claims.iss, serviceAccount.client_email);
        assert.equal(claims.aud, url);
        assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
        assert.equal(claims.exp - claims.iat, 3600);
        assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
        return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
      }
      sendCount++;
      assert.equal(url, 'https://fcm.googleapis.com/v1/projects/test-vynzo/messages:send');
      assert.equal(options.headers.Authorization, 'Bearer test-access-token');
      assert.deepEqual(JSON.parse(options.body), {
        message: {
          fid: 'test-device-fid',
          data: { type: 'message' },
          android: { priority: 'high', ttl: '45s', restricted_package_name: 'com.vynzosocial.app' }
        }
      });
      return Response.json({ name: 'projects/test-vynzo/messages/123' });
    }
  });
  const message = { installationId: 'test-device-fid', data: { type: 'message' }, ttlSeconds: 45 };
  await Promise.all([sender.send(message), sender.send(message)]);
  assert.equal(authCount, 1);
  assert.equal(sendCount, 2);
});

test('rejects invalid input and exposes unregistered tokens without echoing them', async () => {
  const { createFcmSender, FcmError } = await import(modulePath);
  const sender = createFcmSender({
    serviceAccount, cryptoImpl: webcrypto,
    fetchImpl: async url => url === 'https://oauth2.googleapis.com/token'
      ? Response.json({ access_token: 'access', expires_in: 3600 })
      : Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, { status: 404 })
  });
  await assert.rejects(sender.send({ installationId: 'private-token', data: { 'google.test': 'x' }, ttlSeconds: 45 }), /Invalid Firebase message/);
  await assert.rejects(sender.send({ installationId: 'private-token', data: { type: 'message' }, ttlSeconds: 45 }), error => {
    assert.ok(error instanceof FcmError);
    assert.equal(error.code, 'UNREGISTERED');
    assert.equal(error.status, 404);
    assert.doesNotMatch(error.message, /private-token/);
    return true;
  });
});
