import './supabase-client.js';
import { API_BASE_URL, API_ORIGIN } from './config.js';
import { supabase } from './supabase-client.js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';

export async function apiRequest(endpoint, options = {}) {
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
    || (apiPath.startsWith('/messages/') && !apiPath.includes('/view-once'));
  const useSupabaseLiveApi = apiPath === '/live'
    || apiPath === '/live/start'
    || /^\/live\/[^/]+\/(title|end)$/.test(apiPath);
  const useSupabaseApi = Boolean(supabase)
    && (apiPath.startsWith('/posts/')
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
    const { data } = await supabase.auth.getSession();
    if (data?.session?.access_token) token = data.session.access_token;
  }
  const headers = {
    ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(useSupabaseApi ? { 'apikey': SUPABASE_PUBLISHABLE_KEY } : {}),
    ...options.headers
  };

  let response;
  try {
    const requestUrl = useSupabaseApi
      ? `${SUPABASE_URL}/functions/v1/vynzo-api/api${endpoint}`
      : `${API_BASE_URL}${endpoint}`;
    response = await fetch(requestUrl, {
      ...options,
      headers
    });
  } catch (err) {
    if (err instanceof TypeError) {
      const serviceUrl = useSupabaseApi ? `${SUPABASE_URL}/functions/v1/vynzo-api` : API_ORIGIN;
      const serviceName = useSupabaseApi ? 'Supabase Edge Function' : 'Vynzo API';
      throw new Error(`Cannot reach the ${serviceName} at ${serviceUrl}. Check the service deployment and network connection, then try again.`);
    }
    throw err;
  }

  let data;
  try {
    data = await response.json();
  } catch {
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
