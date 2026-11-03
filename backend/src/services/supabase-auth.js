class SupabaseAuthError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'SupabaseAuthError';
    this.status = status;
    this.code = code;
  }
}

function getAuthConfig(admin = false) {
  const baseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = admin
    ? process.env.SUPABASE_SERVICE_ROLE_KEY
    : process.env.SUPABASE_ANON_KEY;
  if (!baseUrl || !key) {
    throw new Error(`SUPABASE_URL and ${admin ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_ANON_KEY'} are required for Supabase Auth.`);
  }
  return { baseUrl, key };
}

function validateAuthConfig() {
  getAuthConfig();
  getAuthConfig(true);
}

async function authRequest(path, { method = 'POST', body, admin = false } = {}) {
  const { baseUrl, key } = getAuthConfig(admin);
  let response;
  try {
    response = await fetch(`${baseUrl}/auth/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch (err) {
    const networkError = new Error('Unable to reach Supabase Auth.');
    networkError.cause = err;
    throw networkError;
  }

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Supabase Auth returned invalid JSON (HTTP ${response.status}).`);
    }
  }
  if (!response.ok) {
    throw new SupabaseAuthError(
      data.msg || data.message || data.error_description || data.error || 'Supabase Auth request failed.',
      response.status,
      data.code || data.error_code
    );
  }
  return data;
}

function signUpWithEmail(email, password) {
  return authRequest('signup', { body: { email, password } });
}

function signInWithEmail(email, password) {
  return authRequest('token?grant_type=password', { body: { email, password } });
}

function deleteAuthUser(userId) {
  return authRequest(`admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE', admin: true });
}

async function getUserWithAccessToken(accessToken) {
  const { baseUrl, key } = getAuthConfig();
  const authorization = ['Bearer', accessToken].join(' ');
  let response;
  try {
    response = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: {
        apikey: key,
        Authorization: authorization
      }
    });
  } catch (err) {
    const networkError = new Error('Unable to verify the Supabase session.');
    networkError.cause = err;
    throw networkError;
  }

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Supabase Auth returned invalid JSON (HTTP ${response.status}).`);
    }
  }
  if (!response.ok) {
    throw new SupabaseAuthError(
      data.msg || data.message || data.error_description || data.error || 'Supabase session is invalid.',
      response.status,
      data.code || data.error_code
    );
  }
  return data;
}

module.exports = {
  SupabaseAuthError,
  signUpWithEmail,
  signInWithEmail,
  deleteAuthUser,
  getUserWithAccessToken,
  validateAuthConfig
};
