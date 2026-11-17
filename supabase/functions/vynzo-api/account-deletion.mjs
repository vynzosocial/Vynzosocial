import { usableActivationEmail } from './account-reactivation.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^\d{4}$/;
const CODE_LIFETIME_MS = 10 * 60 * 1000;

function generateCode() {
  const limit = Math.floor(0x100000000 / 10000) * 10000;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value); while (value[0] >= limit);
  return String(value[0] % 10000).padStart(4, '0');
}

async function hashCode(userId, code, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${userId}:${code}`));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function requestAccountDeletion({
  user,
  password,
  verifyPassword,
  repository,
  sendEmail,
  secret,
  now = Date.now(),
  createCode = generateCode
}) {
  if (!user || typeof user.id !== 'string' || !UUID.test(user.id)) throw new Error('Invalid authenticated account.');
  if (!usableActivationEmail(user)) return { status: 'verified_email_required' };
  if (typeof password !== 'string' || !password) return { status: 'password_required' };
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Account deletion code protection is not configured.');
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid account deletion time.');

  const verified = await verifyPassword(user.email, password);
  if (!verified || verified.id !== user.id) return { status: 'invalid_password' };

  const code = createCode();
  if (typeof code !== 'string' || !CODE.test(code)) throw new Error('Invalid account deletion code.');
  const expiresAt = new Date(now + CODE_LIFETIME_MS).toISOString();
  const stored = await repository.issueCode(user.id, await hashCode(user.id, code, secret), expiresAt);
  if (stored !== true) return { status: 'account_unavailable' };
  await sendEmail({ email: user.email.trim(), code, expiresAt });
  return { status: 'code_sent' };
}

export async function completeAccountDeletion({
  userId,
  code,
  secret,
  repository,
  deleteMedia,
  deleteStorage,
  deleteProfile,
  deleteAuthUser
}) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new Error('Invalid authenticated account.');
  if (typeof code !== 'string' || !CODE.test(code)) return { status: 'invalid_code' };
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Account deletion code protection is not configured.');

  const started = await repository.beginDeletion(userId, await hashCode(userId, code, secret));
  if (started !== true) return { status: 'invalid_code' };

  await deleteMedia(userId);
  await deleteStorage(userId);
  await repository.recordTombstone(userId);
  await deleteProfile(userId);
  await deleteAuthUser(userId);
  return { status: 'deleted' };
}
