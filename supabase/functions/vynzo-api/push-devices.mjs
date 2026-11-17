const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALLATION_ID = /^[A-Za-z0-9_-]{11,128}$/;
const DEVICE_SECRET = /^[A-Za-z0-9_-]{43}$/;

export async function deviceSecretHash(secret, cryptoImpl = crypto) {
  if (typeof secret !== 'string' || !DEVICE_SECRET.test(secret)) {
    throw new Error('Invalid notification device secret.');
  }
  const hash = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function validDeviceRegistration(body) {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body) &&
    typeof body.deviceId === 'string' && UUID.test(body.deviceId) &&
    typeof body.deviceSecret === 'string' && DEVICE_SECRET.test(body.deviceSecret) &&
    typeof body.installationId === 'string' && INSTALLATION_ID.test(body.installationId));
}

export function validDeviceRemoval(body) {
  return Boolean(body && typeof body === 'object' && !Array.isArray(body) &&
    typeof body.deviceId === 'string' && UUID.test(body.deviceId) &&
    typeof body.deviceSecret === 'string' && DEVICE_SECRET.test(body.deviceSecret));
}
