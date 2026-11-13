const test = require('node:test');
const assert = require('node:assert/strict');
const { configurePermissions } = require('../lib/permissions.cjs');

const site = 'https://www.vynzosocial.com/pages/live.html';
function setup(response = 0) {
  let check;
  let request;
  let prompts = 0;
  let url = site;
  const contents = { getURL: () => url, isDestroyed: () => false };
  configurePermissions({
    setPermissionCheckHandler(handler) { check = handler; },
    setPermissionRequestHandler(handler) { request = handler; }
  }, {
    message: async () => { prompts++; return { response }; },
    log() {}
  });
  return {
    check: (permission, details = {}) => check(contents, permission, site, { isMainFrame: true, ...details }),
    request: (permission, details = {}) => new Promise(resolve => request(contents, permission, resolve, { isMainFrame: true, requestingUrl: site, ...details })),
    prompts: () => prompts,
    navigate: value => { url = value; }
  };
}

test('camera and microphone checks cannot bypass explicit consent', async () => {
  const instance = setup();
  assert.equal(instance.check('media', { mediaType: 'audio' }), false);
  assert.equal(instance.check('media', { mediaType: 'video' }), false);
  assert.equal(await instance.request('media', { mediaTypes: ['audio'] }), true);
  assert.equal(instance.prompts(), 1);
  assert.equal(instance.check('media', { mediaType: 'audio' }), true);
  assert.equal(instance.check('media', { mediaType: 'video' }), false);
  assert.equal(await instance.request('media', { mediaTypes: ['audio', 'video'] }), true);
  assert.equal(instance.prompts(), 2);
  assert.equal(instance.check('media', { mediaType: 'video' }), true);
});

test('blocking permission leaves notifications and media unapproved', async () => {
  const instance = setup(1);
  assert.equal(await instance.request('notifications'), false);
  assert.equal(instance.check('notifications'), false);
  assert.equal(await instance.request('media', { mediaTypes: ['video'] }), false);
  assert.equal(instance.check('media', { mediaType: 'video' }), false);
});

test('cross-origin frames and unsupported capture never open a permission prompt', async () => {
  const instance = setup();
  assert.equal(await instance.request('media', { mediaTypes: ['audio'], requestingUrl: 'https://example.com' }), false);
  assert.equal(await instance.request('media', { mediaTypes: ['audio'], isMainFrame: false }), false);
  assert.equal(await instance.request('display-capture', { mediaTypes: ['video'] }), false);
  assert.equal(await instance.request('media', { mediaTypes: [] }), false);
  assert.equal(instance.prompts(), 0);
});

test('audio output selection requires consent and grants do not extend to foreign pages', async () => {
  const instance = setup();
  assert.equal(instance.check('speaker-selection'), false);
  assert.equal(await instance.request('speaker-selection'), true);
  assert.equal(instance.check('speaker-selection'), true);
  instance.navigate('https://example.com');
  assert.equal(instance.check('speaker-selection'), false);
});
