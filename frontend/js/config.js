// Backend address. Inside the Android app, "localhost" would be the phone itself,
// so the app talks to the PC running the backend instead.
const APP_BACKEND_ORIGIN = 'http://192.168.1.38:5000';
// In a browser, use the same host the page was opened from, so a phone opening the PC's address
// reaches the PC's backend instead of its own "localhost".
const isGitHubPages = /(^|\.)github\.io$/i.test(window.location.hostname);
const BROWSER_BACKEND_ORIGIN = isGitHubPages
  ? ''
  : `http://${window.location.hostname || 'localhost'}:5000`;

const isNativeApp = Boolean(window.Capacitor?.isNativePlatform?.());
const configuredBackendOrigin = localStorage.getItem('vynzo_backend_url')?.trim().replace(/\/+$/, '');

export const API_ORIGIN = configuredBackendOrigin
  || (isNativeApp ? APP_BACKEND_ORIGIN : BROWSER_BACKEND_ORIGIN);
export const API_BASE_URL = API_ORIGIN ? `${API_ORIGIN}/api` : '';
