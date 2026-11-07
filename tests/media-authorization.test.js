const assert = require('node:assert/strict');
const test = require('node:test');

const userId = 'c86cf40c-d629-4d7a-919f-4d2055498f90';
const viewerId = '69de86de-e2b4-40ed-bff9-27747d20b60c';
const uploadId = '83ea2611-2df6-49fc-bcbd-f686b1fc2e19';
const claims = { kind: 'post', userId, viewerId, uploadId, itemId: uploadId, variant: 'playback' };
const item = { user_id: userId, media_type: 'video', media_url: `r2://post/${userId}/${uploadId}` };
let authorizeMediaClaims;
test.before(async () => { ({ authorizeMediaClaims } = await import('../supabase/functions/vynzo-api/media-authorization.mjs')); });

test('delegates post visibility to the existing viewer-specific privacy check', async () => {
  let seen;
  const check = async (...args) => { seen = args; return { post: item }; };
  const result = await authorizeMediaClaims(claims, check, () => assert.fail('story check used'));
  assert.deepEqual(seen, [uploadId, viewerId]);
  assert.deepEqual(result, { valid: true, allowed: true, objectVariant: 'playback' });
  assert.deepEqual(await authorizeMediaClaims(claims, async () => null, () => {}), { valid: true, allowed: false });
});

test('rejects original download for other viewers and references that do not match the row', async () => {
  const check = async () => ({ post: item });
  assert.equal((await authorizeMediaClaims({ ...claims, variant: 'original' }, check, () => {})).allowed, false);
  assert.equal((await authorizeMediaClaims({ ...claims, userId: viewerId }, check, () => {})).allowed, false);
  assert.equal((await authorizeMediaClaims({ ...claims, variant: 'original', viewerId: userId }, check, () => {})).allowed, true);
  assert.deepEqual(await authorizeMediaClaims({ ...claims, uploadId: '../other' }, check, () => {}), { valid: false, allowed: false });
});

test('uses story privacy and maps image playback to the original object', async () => {
  const story = { ...item, media_type: 'image', media_url: `r2://story/${userId}/${uploadId}` };
  const storyClaims = { ...claims, kind: 'story' };
  const result = await authorizeMediaClaims(storyClaims, () => assert.fail('post check used'), async () => ({ story }));
  assert.deepEqual(result, { valid: true, allowed: true, objectVariant: 'original' });
  assert.equal((await authorizeMediaClaims(storyClaims, () => {}, async () => null)).allowed, false);
});
