const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/vynzo-api/index.ts'), 'utf8');
const handler = source.slice(
  source.indexOf("  if (route === '/users/connections'"),
  source.indexOf("  if (route === '/users/follow-requests'")
);

async function connections(type) {
  const filters = [];
  const relationships = new Map([
    ['friend', { following: true, followsMe: true }],
    ['one-way', { following: true, followsMe: false }],
    ['follower', { following: false, followsMe: true }],
    ['pending', { following: false, followsMe: false }],
    ['inactive', { following: true, followsMe: false }]
  ]);
  const query = {
    select(value) { filters.push(['select', value]); return this; },
    eq(...args) { filters.push(args); return this; },
    async limit() {
      return {
        data: [...relationships.keys()]
          .filter(id => type === 'following' ? relationships.get(id).following : relationships.get(id).followsMe)
          .map(id => ({ following_id: id, follower_id: id })),
        error: null
      };
    }
  };
  const context = {
    route: '/users/connections', method: 'GET', viewerId: 'viewer',
    url: new URL(`https://example.test/users/connections?type=${type}`),
    admin: { from: () => query },
    throwOnError(error) { if (error) throw error; },
    getFollowStatus: async () => relationships,
    getUserSummaries: async () => new Map([...relationships.keys()].map(id => [id, { id, username: id }])),
    restrictedAccountIds: async () => new Set(['inactive']),
    jsonResponse: (_status, body) => body,
    headers: {}
  };
  const result = await vm.runInNewContext(`(async () => { ${handler} })()`, context);
  return { users: Array.from(result.users), filters };
}

test('following group contains both mutual friends and accepted outgoing-only follows', async () => {
  const { users, filters } = await connections('following');
  assert.deepEqual(users.map(user => user.id), ['friend', 'one-way']);
  const friend = users.find(user => user.id === 'friend');
  const following = users.find(user => user.id === 'one-way');
  assert.equal(friend.is_friend, true);
  assert.equal(friend.follows_me, true);
  assert.equal(following.is_following, true);
  assert.equal(following.follows_me, false);
  assert.equal(following.is_friend, false);
  assert.equal(following.follow_requested, false);
  assert.deepEqual(filters, [
    ['select', 'follower_id,following_id'], ['follower_id', 'viewer'], ['status', 'accepted']
  ]);
});

test('friends remain mutual follows and followers preserve existing behavior', async () => {
  const friends = await connections('friends');
  assert.deepEqual(friends.users.map(user => user.id), ['friend']);
  assert.equal(friends.users.find(user => user.id === 'friend').is_friend, true);
  assert.deepEqual(friends.filters, [
    ['select', 'follower_id,following_id'], ['following_id', 'viewer'], ['status', 'accepted']
  ]);
  const followers = await connections('followers');
  assert.deepEqual(followers.users.map(user => user.id), ['follower', 'friend']);
  assert.equal(followers.users.find(user => user.id === 'follower').is_friend, false);
});

test('Find people exposes exactly the two requested groups', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/pages/users.html'), 'utf8');
  assert.doesNotMatch(html, /data-type="friends"/);
  assert.match(html, /data-type="following">Friends<\/button>/);
  assert.doesNotMatch(html, /Friends &amp; Following includes everyone you follow/);
  assert.match(html, /data-type="followers"[^>]*>Followers/);
  assert.equal((html.match(/role="tab"/g) || []).length, 2);
});

test('Settings renders total following, total followers, and mutual friends independently', async () => {
  const settings = fs.readFileSync(path.join(__dirname, '../frontend/js/settings-page.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../frontend/pages/settings.html'), 'utf8');
  const elements = new Map();
  const profile = { id: 'viewer', username: 'sample', following_count: 2, followers_count: 1, friends_count: 1 };
  const context = {
    apiRequest: async () => ({ profile }),
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    } },
    localStorage: { setItem() {} },
    formatStat: String,
    renderPhoto() {},
    setupPrivacyToggle() {},
    setupMessagePrivacy() {},
    setupPostsPrivacy() {},
    setupFollowingPrivacy() {},
    setupReadReceipts() {},
    setupCallSetting() {}
  };
  const code = settings.slice(settings.indexOf('async function loadProfile('), settings.indexOf('\nconst CALL_HINTS'));
  await vm.runInNewContext(`${code}\nloadProfile({ id: 'viewer' });`, context);
  for (const [id, value] of [['stat-following', '2'], ['stat-followers', '1'], ['stat-friends', '1']]) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.equal(elements.get(id).textContent, value);
  }
});
