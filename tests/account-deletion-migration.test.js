const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261111075932_account_deletion_otp.sql'),
  'utf8'
);

test('deletion OTP storage is private, expires, and caps attempts', () => {
  assert.match(migration, /account_deletion_challenges[\s\S]*REFERENCES auth\.users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON public\.account_deletion_challenges FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /attempt_count >= 5/);
  assert.match(migration, /expires_at <= pg_catalog\.clock_timestamp\(\)/);
});

test('successful verification atomically marks deletion and remains retryable', () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /INSERT INTO public\.account_lifecycle \(user_id, state\)[\s\S]*'deleting'/);
  assert.match(migration, /challenge\.verified_at IS NOT NULL[\s\S]*account_deletion_tombstones/);
});

test('deleted-account tombstones block old JWTs from lifecycle, realtime, and activity access', () => {
  assert.match(migration, /CREATE TABLE public\.account_deletion_tombstones/);
  assert.match(migration, /GRANT USAGE ON SCHEMA private TO service_role/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION private\.is_deleted_account\(p_user_id uuid\)[\s\S]*?SECURITY DEFINER[\s\S]*?auth\.uid\(\)/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION private\.is_deleted_account\(uuid\) TO authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION private\.is_deleted_account\(uuid\) TO service_role/);
  assert.match(migration, /private\.is_deleted_account\(current_user_id\)/);
  assert.match(migration, /private\.is_deleted_account\(target_user_id\)/);
  assert.match(migration, /private\.is_deleted_account\(session\.host_id\)/);
  assert.match(migration, /private\.is_deleted_account\(me\)/);
});
