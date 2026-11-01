// Backend address. Inside the Android app, "localhost" would be the phone itself,
// so the app talks to the PC running the backend instead.
const APP_BACKEND_ORIGIN = 'http://192.168.1.38:5000';
// In a browser, use the same host the page was opened from, so a phone opening the PC's address
// reaches the PC's backend instead of its own "localhost".
const BROWSER_BACKEND_ORIGIN = `http://${window.location.hostname || 'localhost'}:5000`;

const isNativeApp = Boolean(window.Capacitor?.isNativePlatform?.());

export const API_ORIGIN = localStorage.getItem('vynzo_backend_url')
  || (isNativeApp ? APP_BACKEND_ORIGIN : BROWSER_BACKEND_ORIGIN);
export const API_BASE_URL = `${API_ORIGIN}/api`;
