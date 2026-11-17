const encoder = new TextEncoder();
const MAX_SKEW_MS = 30_000;

async function keyFor(secret, usage) {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/i.test(secret)) {
    throw new Error('Call push secret must be a 32-byte hexadecimal value.');
  }
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signCallPush(secret, timestamp, body) {
  const key = await keyFor(secret, 'sign');
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyCallPush(secret, timestamp, body, signature, now = Date.now()) {
  if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) ||
      Math.abs(now - Number(timestamp)) > MAX_SKEW_MS ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const key = await keyFor(secret, 'verify');
  const bytes = Uint8Array.from(signature.match(/../g), part => parseInt(part, 16));
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(`${timestamp}.${body}`));
}
