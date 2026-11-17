const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const PACKAGE_NAME = 'com.vynzosocial.app';
const encoder = new TextEncoder();

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value) {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

function decodePrivateKey(pem) {
  if (typeof pem !== 'string' || !/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/.test(pem)) {
    throw new Error('Invalid Firebase service account private key.');
  }
  const contents = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const decoded = atob(contents);
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

export class FcmError extends Error {
  constructor(message, status, code = null) {
    super(message);
    this.name = 'FcmError';
    this.status = status;
    this.code = code;
  }
}

export function createFcmSender({ serviceAccount, fetchImpl = fetch, cryptoImpl = crypto, now = () => Date.now() }) {
  const projectId = serviceAccount?.project_id;
  const clientEmail = serviceAccount?.client_email;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId || '') ||
      typeof clientEmail !== 'string' || !clientEmail.endsWith('.iam.gserviceaccount.com')) {
    throw new Error('Invalid Firebase service account configuration.');
  }
  const keyBytes = decodePrivateKey(serviceAccount.private_key);
  let cachedToken = null;
  let tokenRequest = null;

  async function getAccessToken() {
    if (cachedToken && cachedToken.expiresAt > now() + 60_000) return cachedToken.value;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
      const issuedAt = Math.floor(now() / 1000);
      const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
      const claims = encodeJson({
        iss: clientEmail, scope: FCM_SCOPE, aud: TOKEN_URL,
        iat: issuedAt, exp: issuedAt + 3600
      });
      const unsigned = `${header}.${claims}`;
      const key = await cryptoImpl.subtle.importKey(
        'pkcs8', keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
      );
      const signature = await cryptoImpl.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${base64Url(new Uint8Array(signature))}`
      });
      const response = await fetchImpl(TOKEN_URL, { method: 'POST', body });
      if (!response.ok) throw new FcmError('Firebase authorization failed.', response.status);
      const result = await response.json();
      if (typeof result.access_token !== 'string' || !result.access_token ||
          !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
        throw new FcmError('Firebase returned an invalid authorization response.', 502);
      }
      cachedToken = { value: result.access_token, expiresAt: now() + result.expires_in * 1000 };
      return cachedToken.value;
    })();
    try {
      return await tokenRequest;
    } finally {
      tokenRequest = null;
    }
  }

  async function send({ installationId, data, ttlSeconds }) {
    if (typeof installationId !== 'string' || !/^[A-Za-z0-9_-]{11,128}$/.test(installationId) ||
        !data || typeof data !== 'object' || Array.isArray(data) ||
        !Object.entries(data).every(([key, value]) => key && typeof value === 'string' &&
          key !== 'from' && key !== 'message_type' && !key.startsWith('google.') && !key.startsWith('gcm.')) ||
        !Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > 2_419_200) {
      throw new Error('Invalid Firebase message.');
    }
    const accessToken = await getAccessToken();
    const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          fid: installationId, data,
          android: { priority: 'high', ttl: `${ttlSeconds}s`, restricted_package_name: PACKAGE_NAME }
        }
      })
    });
    if (!response.ok) {
      let code = null;
      try {
        const result = await response.json();
        code = result?.error?.details?.find(item =>
          item?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError'
        )?.errorCode || null;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (response.status === 401) cachedToken = null;
      throw new FcmError('Firebase could not deliver the message.', response.status, code);
    }
    const result = await response.json();
    if (typeof result.name !== 'string' || !result.name) {
      throw new FcmError('Firebase returned an invalid delivery response.', 502);
    }
    return result.name;
  }

  return { send };
}
