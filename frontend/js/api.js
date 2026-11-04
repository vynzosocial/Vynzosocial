import './supabase-client.js';
import { API_BASE_URL, API_ORIGIN } from './config.js?v=sb4';
import { supabase } from './supabase-client.js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';

const API_TIMEOUT_MESSAGE = 'The request took too long. Check your connection and try again.';

export async function apiRequest(endpoint, options = {}) {
  const requestDeadline = Date.now() + 12000;
  const apiPath = endpoint.split('?')[0];
  const useSupabaseUserApi = apiPath === '/users/me/profile'
    || apiPath === '/users/me/privacy'
    || apiPath === '/users/me/avatar'
    || apiPath === '/users/friends'
    || apiPath === '/users/follow-requests'
    || apiPath.startsWith('/users/connections')
    || apiPath.startsWith('/users/search')
    || /^\/users\/[^/]+\/profile$/.test(apiPath)
    || /^\/users\/[^/]+\/follow$/.test(apiPath);
  const useSupabaseMessageApi = apiPath === '/messages'
    || apiPath.startsWith('/messages/');
  const useSupabaseLiveApi = apiPath === '/live'
    || apiPath === '/live/start'
    || /^\/live\/[^/]+\/(title|end|heartbeat)$/.test(apiPath);
  const useSupabaseApi = Boolean(supabase)
    && (apiPath.startsWith('/posts/')
      || apiPath === '/blogs'
      || apiPath.startsWith('/blogs/')
      || apiPath === '/stories'
      || apiPath.startsWith('/stories/')
      || useSupabaseMessageApi
      || useSupabaseLiveApi
      || useSupabaseUserApi
      || apiPath.startsWith('/moderation/'))
    && !apiPath.endsWith('/moderate');
  if (!API_ORIGIN && !useSupabaseApi) {
    throw new Error(supabase
      ? 'This feature is not available on Supabase yet.'
      : 'Supabase is not configured for this site. Set the VYNZO_SUPABASE_PUBLISHABLE_KEY build secret and redeploy.');
  }

  let token = localStorage.getItem('vynzo_token');
  if (supabase) {
    const { data } = await withTimeout(supabase.auth.getSession(), requestDeadline);
    if (data?.session?.access_token) token = data.session.access_token;
  }
  const headers = {
    ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(useSupabaseApi ? { 'apikey': SUPABASE_PUBLISHABLE_KEY } : {}),
    ...options.headers
  };

  let response;
  const requestController = new AbortController();
  const timeoutId = window.setTimeout(
    () => requestController.abort(),
    Math.max(0, requestDeadline - Date.now())
  );
  const callerSignal = options.signal;
  const abortFromCaller = () => requestController.abort();
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  try {
    const requestUrl = useSupabaseApi
      ? `${SUPABASE_URL}/functions/v1/vynzo-api/api${endpoint}`
      : `${API_BASE_URL}${endpoint}`;
    response = await fetch(requestUrl, {
      cache: 'no-store',
      ...options,
      signal: requestController.signal,
      headers
    });
  } catch (err) {
    if (requestController.signal.aborted && !callerSignal?.aborted) {
      throw new Error('The request took too long. Check your connection and try again.');
    }
    if (err instanceof TypeError) {
      const serviceUrl = useSupabaseApi ? `${SUPABASE_URL}/functions/v1/vynzo-api` : API_ORIGIN;
      const serviceName = useSupabaseApi ? 'Supabase Edge Function' : 'Vynzo API';
      throw new Error(`Cannot reach the ${serviceName} at ${serviceUrl}. Check the service deployment and network connection, then try again.`);
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }

  let data;
  try {
    data = await withTimeout(response.json(), requestDeadline);
  } catch (err) {
    if (err instanceof Error && err.message === API_TIMEOUT_MESSAGE) throw err;
    const serviceName = useSupabaseApi ? 'Supabase' : 'Vynzo API';
    throw new Error(`${serviceName} returned an invalid response (HTTP ${response.status}). Check the service logs and try again.`);
  }

  if (!response.ok) {
    if (useSupabaseApi && response.status === 401) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      if (!refreshed?.session && !options._retried) {
        await supabase.auth.signOut().catch(() => {});
        localStorage.removeItem('vynzo_token');
        localStorage.removeItem('vynzo_user');
        if (!window.location.pathname.endsWith('login.html')) {
          window.location.href = window.location.pathname.includes('/pages/') ? './login.html' : './pages/login.html';
        }
      } else if (refreshed?.session && !options._retried) {
        return apiRequest(endpoint, { ...options, _retried: true });
      }
    }
    throw new Error(data.error || 'Something went wrong');
  }
  return data;
}

function withTimeout(promise, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(API_TIMEOUT_MESSAGE));

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(API_TIMEOUT_MESSAGE)), remaining);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

// For endpoints that answer with a file instead of JSON (for example view-once photos).
export async function apiBlobRequest(endpoint, options = {}) {
  if (!supabase) throw new Error('Supabase is not configured for this site.');
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || localStorage.getItem('vynzo_token');
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/vynzo-api/api${endpoint}`, {
      cache: 'no-store',
      ...options,
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers
      }
    });
  } catch {
    throw new Error('Cannot reach Supabase. Check your connection and try again.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'This photo is no longer available.');
  }
  return response.blob();
}
