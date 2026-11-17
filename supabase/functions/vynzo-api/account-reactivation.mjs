const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_LIFETIME_SECONDS = 30 * 60;
const encoder = new TextEncoder();

function base64Url(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function digestToken(token) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return base64Url(new Uint8Array(hash));
}

export function usableActivationEmail(user) {
  if (!user || typeof user.email !== 'string' || typeof user.email_confirmed_at !== 'string') return false;
  const email = user.email.trim();
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1 || email.indexOf('@') !== at || email.length > 254 || /[\s\r\n]/.test(email) ||
      email.slice(at + 1).toLowerCase() === 'phone.vynzosocial.com') return false;
  return Number.isFinite(Date.parse(user.email_confirmed_at));
}

// The repository must atomically replace any prior token for this deactivated account.
export async function issueReactivation({ user, repository, sendEmail, now = Date.now() }) {
  if (!user || typeof user.id !== 'string' || !UUID.test(user.id) || !usableActivationEmail(user)) {
    throw new Error('A verified recovery email is required.');
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid activation time.');
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await digestToken(token);
  const expiresAt = new Date(now + TOKEN_LIFETIME_SECONDS * 1000).toISOString();
  const stored = await repository.replaceTokenForDeactivatedAccount(user.id, tokenHash, expiresAt);
  if (stored !== true) throw new Error('Account is not available for reactivation.');
  await sendEmail({ email: user.email.trim(), token, expiresAt });
}

// The repository must consume the token and activate the account in one transaction.
export async function redeemReactivation({ token, repository, now = Date.now() }) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return false;
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid activation time.');
  return (await repository.consumeTokenAndActivate(await digestToken(token), new Date(now).toISOString())) === true;
}
