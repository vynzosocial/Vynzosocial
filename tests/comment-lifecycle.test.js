const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/vynzo-api/index.ts'), 'utf8');

function handler(kind, inactive = [], blocked = [], failure = null) {
  const start = source.indexOf("  if (action === 'comments' && method === 'GET')", source.indexOf(`async function handle${kind}`));
  const end = source.indexOf("\n  if (action === 'comments' && method === 'POST')", start);
  assert.ok(start >= 0 && end > start);
  const data = [
    { id: 'one', user_id: 'active', content: 'visible' },
    { id: 'two', user_id: 'inactive', content: 'private' },
    { id: 'three', user_id: 'blocked', content: 'blocked' }
  ];
  const sandbox = {
    action: 'comments', method: 'GET', storyId: 'item', postId: 'item', viewerId: 'viewer', headers: {},
    admin: { from(table) {
      const result = table === 'users'
        ? [{ id: 'active', username: 'active' }, { id: 'inactive', username: 'inactive' }, { id: 'blocked', username: 'blocked' }]
        : data;
      return {
        select() { return this; }, eq() { return this; }, order() { return this; }, in() { return this; },
        then(resolve, reject) { return Promise.resolve({ data: result, error: null }).then(resolve, reject); }
      };
    } },
    throwOnError(error) { if (error) throw error; },
    getBlockedIds: async () => new Set(blocked),
    restrictedAccountIds: async ids => {
      assert.deepEqual(Array.from(ids), ['active', 'inactive', 'blocked']);
      if (failure) throw failure;
      return new Set(inactive);
    },
    jsonResponse: (status, body) => ({ status, body })
  };
  vm.runInNewContext(`async function run() { ${source.slice(start, end)} } this.run = run;`, sandbox);
  return sandbox.run();
}

for (const kind of ['Stories', 'Posts']) {
  test(`${kind} comments hide inactive authors without removing comments`, async () => {
    const active = await handler(kind);
    assert.deepEqual(Array.from(active.body.comments, row => row.content), ['visible', 'private', 'blocked']);
    const restricted = await handler(kind, ['inactive'], ['blocked']);
    assert.deepEqual(Array.from(restricted.body.comments, row => row.content), ['visible']);
    await assert.rejects(handler(kind, [], [], new Error('database unavailable')), /database unavailable/);
  });
}
