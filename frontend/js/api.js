import { API_BASE_URL, API_ORIGIN } from './config.js';

export async function apiRequest(endpoint, options = {}) {
  if (!API_ORIGIN) {
    throw new Error('Login is unavailable because this site has no public API configured. The site owner must deploy the Vynzo backend and configure its HTTPS URL.');
  }

  const token = localStorage.getItem('vynzo_token');
  const headers = {
    ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...options.headers
  };

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers
    });
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`Cannot reach the Vynzo API at ${API_ORIGIN}. Check that the backend is deployed and running, then try again.`);
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
