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

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Something went wrong');
  }
  return data;
}