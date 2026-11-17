const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261111002944_account_lifecycle.sql'),
  'utf8'
);

test('Realtime topic authorization rejects inactive users and inactive recipients', () => {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION private.can_access_user_topic');
  const end = migration.indexOf('CREATE OR REPLACE FUNCTION private.can_access_live_topic', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const functionSql = migration.slice(start, end);

  assert.match(functionSql, /p_topic IS DISTINCT FROM \(SELECT realtime\.topic\(\)\)/);
  assert.match(functionSql, /WHERE user_id = current_user_id/);
  assert.match(functionSql, /WHERE user_id = target_user_id/);
  assert.match(migration, /WHERE restricted\.user_id = session\.host_id/);
  assert.match(migration, /can_access_user_topic\(realtime\.topic\(\), false\)/);
  assert.match(migration, /can_access_user_topic\(realtime\.topic\(\), true\)/);
});

test('view-once claims serialize with account deactivation and recheck both accounts', () => {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.begin_account_deactivation');
  const end = migration.indexOf('ALTER FUNCTION public.get_my_activity', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const transitionSql = migration.slice(start, end);

  assert.match(transitionSql, /pg_advisory_xact_lock/);
  assert.match(transitionSql, /ON CONFLICT \(user_id\) DO NOTHING/);
  assert.match(transitionSql, /CREATE OR REPLACE FUNCTION public\.claim_view_once_message/);
  assert.match(transitionSql, /user_id IN \(v_sender_id, p_viewer_id\)/);
  assert.match(transitionSql, /message\.viewed_at IS NULL/);
  assert.match(transitionSql, /GRANT EXECUTE ON FUNCTION public\.claim_view_once_message\(uuid, uuid, uuid\) TO service_role/);
});
