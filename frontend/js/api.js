import './supabase-client.js';
import { API_BASE_URL, API_ORIGIN } from './config.js';
import { supabase } from './supabase-client.js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';

export async function apiRequest(endpoint, options = {}) {
  const apiPath = endpoint.split('?')[0];
  const useSupabaseUserApi = apiPath === '/users/me/profile'
    || apiPath === '/users/me/privacy'
    || apiPath === '/users/me/avatar'
    || /^\/users\/[^/]+\/follow$/.test(apiPath);
  const useSupabaseApi = Boolean(supabase)
    && (apiPath.startsWith('/posts/')
      || apiPath === '/stories'
      || apiPath.startsWith('/stories/')
      || useSupabaseUserApi
      || apiPath.startsWith('/moderation/'))
    && !apiPath.endsWith('/moderate');
  if (!API_ORIGIN && !useSupabaseApi) {
    throw new Error('Login is unavailable because this site has no public API configured. The site owner must deploy the Vynzo backend and configure its HTTPS URL.');
  }

  const token = localStorage.getItem('vynzo_token');
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
      throw new Error(`Cannot reach the Vynzo API at ${serviceUrl}. Check that the service is deployed and running, then try again.`);
    }
    throw err;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`The Vynzo API returned an invalid response (HTTP ${response.status}). Please try again later.`);
  }

  if (!response.ok) {
    throw new Error(data.error || 'Something went wrong');
  }
  return data;
}
