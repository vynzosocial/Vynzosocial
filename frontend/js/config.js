// Backend address. Inside the Android app, "localhost" would be the phone itself,
// so the app talks to the PC running the backend instead.
const APP_BACKEND_ORIGIN = 'http://192.168.1.38:5000';
const PRODUCTION_BACKEND_ORIGIN = 'https://vynzosocial.onrender.com';
const isLocalDevelopmentHost = /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/i
  .test(window.location.hostname);
const BROWSER_BACKEND_ORIGIN = isLocalDevelopmentHost
  ? `http://${window.location.hostname}:5000`
  : PRODUCTION_BACKEND_ORIGIN;

const isNativeApp = Boolean(window.Capacitor?.isNativePlatform?.());
const configuredBackendOrigin = localStorage.getItem('vynzo_backend_url')?.trim().replace(/\/+$/, '');
const isInvalidRenderAlias = configuredBackendOrigin?.toLowerCase() === 'https://vynzosocial-api.onrender.com';
if (isInvalidRenderAlias) localStorage.removeItem('vynzo_backend_url');
const backendOverride = isInvalidRenderAlias ? null : configuredBackendOrigin;

export const API_ORIGIN = backendOverride
  || (isNativeApp ? APP_BACKEND_ORIGIN : BROWSER_BACKEND_ORIGIN);
export const API_BASE_URL = API_ORIGIN ? `${API_ORIGIN}/api` : '';
