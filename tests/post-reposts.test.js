const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'supabase', 'functions', 'vynzo-api', 'index.ts'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261110164218_profile_media_reposts.sql'), 'utf8');

function slice(start, end) {
  const first = api.indexOf(start);
  const last = api.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Could not find ${start}`);
  return api.slice(first, last);
}

function postActions({ post, method = 'POST', action = 'repost', body = {}, error = null }) {
  const writes = [];
  const remove = slice("  if (action === 'repost' && method === 'DELETE')", "\n  if (!action && method === 'DELETE')");
  const checks = slice('  const context = await getPostContext(postId, viewerId)', "\n  if (action === 'privacy'");
  const sandbox = {
    method, action, viewerId: 'viewer', postId: 'post', request: { json: async () => body }, headers: {},
    getPostContext: async () => post ? { post } : null,
    jsonResponse: (status, data) => ({ status, data }),
    throwOnError: err => { if (err) throw new Error(err.message); },
    admin: { from: table => ({
      delete: () => ({ eq: (key, value) => ({ eq: async (key2, value2) => {
        writes.push({ table, operation: 'delete', key, value, key2, value2 });
        return { error };
      } }) }),
      upsert: async (row, options) => { writes.push({ table, operation: 'upsert', row, options }); return { error }; },
      update: row => ({ eq: () => ({ eq: async () => { writes.push({ table, operation: 'update', row }); return { error }; } }) })
    }) }
  };
  vm.runInNewContext(`async function run() { ${remove}\n${checks}\n} this.run = run;`, sandbox);
  return { run: sandbox.run, writes };
}

test('only accessible, allowed images and videos can be reposted, without duplicates', async () => {
  for (const media_type of ['image', 'video']) {
    const handler = postActions({ post: { user_id: 'author', media_type, allow_repost: true } });
    assert.equal((await handler.run()).status, 200);
    assert.equal(handler.writes[0].table, 'post_reposts');
    assert.equal(handler.writes[0].row.user_id, 'viewer');
    assert.equal(handler.writes[0].row.post_id, 'post');
    assert.equal(handler.writes[0].options.ignoreDuplicates, true);
  }
  for (const post of [
    null,
    { user_id: 'author', media_type: 'image', allow_repost: false },
    { user_id: 'viewer', media_type: 'image', allow_repost: true },
    { user_id: 'author', media_type: 'text', allow_repost: true }
  ]) {
    const handler = postActions({ post });
    assert.equal((await handler.run()).status, 403);
    assert.equal(handler.writes.length, 0);
  }
});

test('only an original owner can change repost permission and removal affects only the reposter', async () => {
  const other = postActions({ post: { user_id: 'author' }, action: 'repost-permission', method: 'PATCH', body: { allowRepost: false } });
  assert.equal((await other.run()).status, 403);
  const owner = postActions({ post: { user_id: 'viewer' }, action: 'repost-permission', method: 'PATCH', body: { allowRepost: false } });
  assert.equal((await owner.run()).status, 200);
  assert.equal(owner.writes[0].row.allow_repost, false);
  const invalid = postActions({ post: { user_id: 'viewer' }, action: 'repost-permission', method: 'PATCH', body: { allowRepost: 'false' } });
  assert.equal((await invalid.run()).status, 400);
  const remove = postActions({ post: null, action: 'repost', method: 'DELETE' });
  assert.equal((await remove.run()).status, 200);
  assert.equal(remove.writes[0].value, 'viewer');
  assert.equal(remove.writes[0].value2, 'post');
  const failed = postActions({ post: { user_id: 'author', media_type: 'image', allow_repost: true }, error: { message: 'database unavailable' } });
  await assert.rejects(failed.run(), /database unavailable/);
});

function profilePosts({ privateProfile = false, originals, owners, friends = [], blocked = [], inactive = [] }) {
  const rows = {
    posts: originals,
    post_reposts: [{ post_id: 'image', created_at: '2026-01-02' }, { post_id: 'video', created_at: '2026-01-01' }],
    users: owners,
    likes: []
  };
  function from(table) {
    let data = rows[table].slice();
    const query = {
      select() { return this; },
      eq(key, value) { data = data.filter(row => row[key] === value || (table === 'post_reposts' && key === 'user_id' && value === 'reposter')); return this; },
      in(key, values) { data = data.filter(row => values.includes(row[key])); return this; },
      order() { return this; },
      limit() { return this; },
      then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject); }
    };
    return query;
  }
  const block = slice('    let visiblePosts: Record<string, unknown>[] = []', '\n    const { data: liveRaw')
    .replace('let visiblePosts: Record<string, unknown>[]', 'let visiblePosts');
  const sandbox = {
    admin: { from }, viewerId: 'viewer', targetId: 'reposter', isOwner: false,
    isFriend: false, canViewPosts: !privateProfile,
    throwOnError: err => { if (err) throw new Error(err.message); },
    getAcceptedConnections: async () => new Set(friends),
    getBlockedIds: async () => new Set(blocked),
    restrictedAccountIds: async () => new Set(inactive),
    canViewPost: (post, owner, viewerId, accepted) =>
      post.user_id === viewerId || (owner.posts_privacy !== 'only_me' &&
        (owner.posts_privacy !== 'friends' || accepted.has(post.user_id)) &&
        (post.privacy === 'everyone' || (post.privacy === 'friends' && accepted.has(post.user_id)))),
    mediaPlaybackUrl: async url => url,
    parseR2MediaUrl: () => null,
    legacyMediaGatewayEnabled: () => false
  };
  vm.runInNewContext(`async function run() { ${block}\nreturn visiblePosts; } this.run = run;`, sandbox);
  return sandbox.run();
}

test('profile reposts retain original attribution and enforce both profiles and original permission', async () => {
  const originals = [
    { id: 'image', user_id: 'author', media_type: 'image', media_url: '/image', privacy: 'everyone', allow_repost: true },
    { id: 'video', user_id: 'author', media_type: 'video', media_url: '/video', privacy: 'everyone', allow_repost: true }
  ];
  const owners = [{ id: 'author', username: 'original', avatar_url: '/avatar', posts_privacy: 'everyone', is_private: false }];
  const visible = await profilePosts({ originals, owners });
  assert.deepEqual(Array.from(visible, post => post.media_type), ['image', 'video']);
  assert.equal(visible[0].author_username, 'original');
  assert.equal(visible[0].is_repost, true);
  assert.equal((await profilePosts({ originals, owners, privateProfile: true })).length, 0);
  assert.equal((await profilePosts({ originals, owners, blocked: ['author'] })).length, 0);
  assert.equal((await profilePosts({ originals, owners, inactive: ['author'] })).length, 0);
  assert.equal((await profilePosts({ originals, owners: [{ ...owners[0], is_private: true }] })).length, 0);
  assert.equal((await profilePosts({ originals, owners: [{ ...owners[0], is_private: true }], friends: ['author'] })).length, 2);
  assert.equal((await profilePosts({ originals: [{ ...originals[0], allow_repost: false }], owners })).length, 0);
  assert.equal((await profilePosts({ originals: [{ ...originals[0], privacy: 'only_me' }], owners })).length, 0);
  assert.equal((await profilePosts({ originals: [], owners })).length, 0);
});

test('migration defaults existing posts to allowed and restricts direct table access', () => {
  assert.match(migration, /allow_repost boolean NOT NULL DEFAULT true/i);
  assert.match(migration, /PRIMARY KEY \(user_id, post_id\)/i);
  assert.match(migration, /post_id uuid NOT NULL REFERENCES public\.posts\(id\) ON DELETE CASCADE/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /REVOKE ALL ON public\.post_reposts FROM PUBLIC, anon, authenticated/i);
});

test('video review sends the repost choice before publication', async () => {
  const source = fs.readFileSync(path.join(root, 'frontend', 'js', 'video-create.js'), 'utf8');
  const review = source.slice(source.indexOf('export function reviewVideo('), source.indexOf('/** Receives videos shared'))
    .replace('export function reviewVideo(', 'function reviewVideo(');
  const makeElement = tag => ({
    tag, children: [], events: {},
    append(...children) { this.children.push(...children); },
    setAttribute() {},
    addEventListener(name, callback) { this.events[name] = callback; }
  });
  const dialog = { dialog: makeElement('dialog'), close() {} };
  let published;
  const sandbox = {
    openDialog: () => dialog,
    el: makeElement,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    document: {
      getElementById: () => ({ checked: false }),
      createTextNode: text => ({ text })
    },
    window: { confirm: () => true }
  };
  vm.runInNewContext(`${review}\nthis.reviewVideo = reviewVideo;`, sandbox);
  sandbox.reviewVideo({ name: 'video.mp4' }, {
    captionInput: { value: '' },
    onPost: async (file, options) => { published = { file, options }; return true; }
  });
  const label = dialog.dialog.children[2];
  label.children[0].checked = true;
  const actions = dialog.dialog.children[4];
  await actions.children[1].events.click();
  assert.equal(published.file.name, 'video.mp4');
  assert.equal(published.options.allowRepost, false);
});
