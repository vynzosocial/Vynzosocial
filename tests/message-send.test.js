const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const source = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'vynzo-api', 'index.ts'), 'utf8');
function declaration(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/\n(?:async )?function /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
const extensions = source.match(/const messageMediaExtensions:[\s\S]*?\n\}/)[0];
const executable = stripTypeScriptTypes(`${extensions}\n${declaration('getMessageBlockReason')}\n${declaration('handleMessages')}`);

function setup(options = {}) {
  const uploads = [], inserts = [], removed = [], queries = [];
  const admin = {
    from(table) {
      const filters = {};
      let payload;
      const result = () => {
        queries.push({ table, filters: { ...filters } });
        if (table === 'conversations') return options.conversation || { data: { is_group: false }, error: null };
        if (table === 'users' && filters.id === 'self') {
          return options.sender || { data: { username: 'sender', display_name: 'Sender' }, error: null };
        }
        if (table === 'users') return { data: { id: 'peer', message_privacy: options.privacy || 'everyone' }, error: null };
        if (table === 'follows') return { data: options.friends ? { follower_id: filters.follower_id } : null, error: null };
        if (table === 'messages' && payload) {
          if (options.insertError) return { data: null, error: { message: 'Save failed' } };
          inserts.push(payload);
          return { data: { ...payload, id: 'saved', created_at: '2026-11-13T19:00:00Z' }, error: null };
        }
        throw new Error(`Unexpected query: ${table}`);
      };
      return {
        select() { return this; },
        eq(key, value) { filters[key] = value; return this; },
        insert(value) { payload = value; return this; },
        single: result, maybeSingle: result
      };
    },
    storage: { from: () => ({
      async upload(key, file, metadata) { uploads.push({ key, file, metadata }); return { error: null }; },
      getPublicUrl: key => ({ data: { publicUrl: `https://storage.example.test/${key}` } }),
      async remove(keys) { removed.push(...keys); return { error: null }; }
    }) }
  };
  const context = {
    admin, Request, Response, FormData, File, URL, crypto: require('node:crypto').webcrypto,
    console, scheduleMessagePush() {},
    throwOnError(error) { if (error) throw new Error(error.message); },
    jsonResponse: (status, body) => new Response(JSON.stringify(body), { status }),
    getConversationMembership: async () => options.denied ? null : [{ user_id: 'self' }, { user_id: 'peer' }],
    restrictedAccountIds: async () => new Set(options.inactive ? ['peer'] : [])
  };
  vm.runInNewContext(executable, context);
  return {
    uploads, inserts, removed, queries,
    async send(type = 'audio/webm') {
      const body = new FormData();
      body.append('content', 'caption');
      body.append('media', new File(['recorded bytes'], 'attachment', { type }));
      return context.handleMessages(new Request('https://api.example.test/api/messages/chat/messages', {
        method: 'POST', body
      }), 'self', {});
    }
  };
}

for (const [mime, extension] of [['image/jpeg', 'jpg'], ['audio/webm;codecs=opus', 'weba'], ['audio/mp4', 'm4a'], ['audio/ogg', 'ogg']]) {
  test(`one multipart request stores ${mime} with its correct media type`, async () => {
    const state = setup();
    const response = await state.send(mime);
    assert.equal(response.status, 201);
    assert.equal(state.uploads.length, 1);
    assert.match(state.uploads[0].key, new RegExp(`^self/messages/chat/[^/]+\\.${extension}$`));
    assert.equal(state.uploads[0].metadata.contentType, mime.split(';')[0]);
    assert.equal(state.inserts.length, 1);
    assert.equal((await response.json()).message.content, 'caption');
  });
}

test('multipart sends keep membership, privacy and account restrictions before any upload', async () => {
  for (const options of [{ denied: true }, { privacy: 'nobody' }, { privacy: 'friends' }, { inactive: true }]) {
    const state = setup(options);
    assert.equal((await state.send()).status, 403);
    assert.equal(state.uploads.length, 0);
    assert.equal(state.inserts.length, 0);
  }
  assert.equal((await setup({ privacy: 'friends', friends: true }).send()).status, 201);
});

test('unsupported and inherited-object MIME names are rejected before uploading', async () => {
  for (const mime of ['application/octet-stream', '__proto__', 'constructor']) {
    const state = setup();
    assert.equal((await state.send(mime)).status, 400);
    assert.equal(state.uploads.length, 0);
  }
});

test('failed saves remove uploaded bytes and sender lookup errors cannot leave an upload', async () => {
  const failed = setup({ insertError: true });
  await assert.rejects(failed.send(), /Save failed/);
  assert.deepEqual(failed.removed, [failed.uploads[0].key]);
  const sender = setup({ sender: { data: null, error: { message: 'Profile unavailable' } } });
  await assert.rejects(sender.send(), /Profile unavailable/);
  assert.equal(sender.uploads.length, 0);
});

test('conversation and sender lookups start together rather than waiting on each other', async () => {
  let releaseConversation, releaseSender;
  const state = setup({
    conversation: new Promise(resolve => { releaseConversation = resolve; }),
    sender: new Promise(resolve => { releaseSender = resolve; })
  });
  const sending = state.send();
  for (let n = 0; n < 6; n++) await Promise.resolve();
  assert.deepEqual(state.queries.map(query => query.table), ['conversations', 'users']);
  releaseConversation({ data: { is_group: false }, error: null });
  releaseSender({ data: { username: 'sender' }, error: null });
  assert.equal((await sending).status, 201);
});
