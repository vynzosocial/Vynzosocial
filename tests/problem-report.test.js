const assert = require('node:assert/strict');
const test = require('node:test');

let handle;
test.before(async () => { ({ handleProblemReport: handle } = await import('../supabase/functions/report-problem/handler.mjs')); });

function setup() {
  const sent = [];
  let allowed = true;
  const deps = {
    authenticate: async req => req.headers.get('authorization') === 'Bearer valid' ? { id: 'user-id' } : null,
    consumeLimit: async () => allowed,
    sendMail: async mail => { sent.push(mail); },
    logError() {}
  };
  return { deps, sent, deny: () => { allowed = false; } };
}

function request(form, token = 'valid') {
  return new Request('https://example.test/report', { method: 'POST', headers: { Origin: 'https://localhost', Authorization: `Bearer ${token}` }, body: form });
}

test('sends an authenticated problem with its image attached', async () => {
  const { deps, sent } = setup();
  const form = new FormData();
  form.append('description', '  App cannot open  ');
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 4]);
  form.append('image', new File([image], 'private.png', { type: 'image/png' }));
  const response = await handle(request(form), deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.equal(sent[0].description, 'App cannot open');
  assert.equal(sent[0].userId, 'user-id');
  assert.equal(sent[0].attachment.filename, 'problem-report.png');
  assert.deepEqual(sent[0].attachment.content, image);
});

test('sends without an attachment and rejects unauthorized or excessive reports', async () => {
  const state = setup();
  const form = new FormData();
  form.append('description', 'Help');
  assert.equal((await handle(request(form, 'invalid'), state.deps)).status, 401);
  state.deny();
  assert.equal((await handle(request(form), state.deps)).status, 429);
  assert.equal(state.sent.length, 0);
  const other = setup();
  assert.equal((await handle(request(form), other.deps)).status, 200);
  assert.equal(other.sent[0].attachment, undefined);
});

test('rejects invalid fields, unsupported and oversized images', async () => {
  const state = setup();
  const empty = new FormData();
  empty.append('description', '   ');
  assert.equal((await handle(request(empty), state.deps)).status, 400);
  const bad = new FormData();
  bad.append('description', 'Help');
  bad.append('image', new File(['not an image'], 'file.png', { type: 'image/png' }));
  assert.equal((await handle(request(bad), state.deps)).status, 400);
  const big = new FormData();
  big.append('description', 'Help');
  big.append('image', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }));
  assert.equal((await handle(request(big), state.deps)).status, 400);
  assert.equal(state.sent.length, 0);
});

test('fails explicitly when mail delivery fails and rejects foreign origins', async () => {
  const state = setup();
  state.deps.sendMail = async () => { throw new Error('SMTP failed'); };
  const form = new FormData();
  form.append('description', 'Help');
  const response = await handle(request(form), state.deps);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /Could not send/);
  assert.equal((await handle(new Request('https://example.test', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), state.deps)).status, 403);
});
