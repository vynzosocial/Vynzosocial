const db = require('../database/db');

// Mirrors an app user into Supabase Auth (auth.users / auth.identities) so the
// Authentication dashboard stays in step. No-op unless the backend runs on Supabase.
async function syncAuthUser(userId) {
  if (process.env.DB_TARGET !== 'supabase') return;
  try {
    await db.query(
      `INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         phone, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
         confirmation_token, recovery_token, email_change_token_new, email_change)
       SELECT '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email, password_hash, now(),
         CASE WHEN phone IS NULL THEN NULL ELSE ltrim(phone, '+') END,
         CASE WHEN phone IS NULL THEN NULL ELSE now() END,
         CASE WHEN email IS NULL THEN '{"provider":"phone","providers":["phone"]}'::jsonb
              ELSE '{"provider":"email","providers":["email"]}'::jsonb END,
         jsonb_build_object(
           'vynzo_id', private_user.vynzo_id,
           'username', u.username,
           'display_name', u.display_name,
           'bio', u.bio,
           'avatar_url', u.avatar_url
         ),
         u.created_at, now(), '', '', '', ''
       FROM public.users u
       JOIN vynzo_private.user_identifiers private_user ON private_user.user_id = u.id
       WHERE u.id = $1
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         encrypted_password = EXCLUDED.encrypted_password,
         raw_user_meta_data = EXCLUDED.raw_user_meta_data,
         updated_at = now()`,
      [userId]
    );
    await db.query(
      `INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       SELECT id::text, id,
         CASE WHEN email IS NULL THEN jsonb_build_object('sub', id::text, 'phone', ltrim(phone, '+'), 'phone_verified', true)
              ELSE jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true) END,
         CASE WHEN email IS NULL THEN 'phone' ELSE 'email' END, now(), created_at, now()
       FROM public.users u
       WHERE u.id = $1
         AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id AND i.provider IN ('email', 'phone'))`,
      [userId]
    );
  } catch (err) {
    console.error('Supabase auth sync failed:', err.message);
  }
}

module.exports = { syncAuthUser };
