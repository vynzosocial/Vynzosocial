// All data goes through Supabase (see api.js). A separate backend is used only
// when one is explicitly set with localStorage "vynzo_backend_url".
const configuredBackendOrigin = localStorage.getItem('vynzo_backend_url')?.trim().replace(/\/+$/, '') || '';
const isRenderOrigin = /onrender\.com/i.test(configuredBackendOrigin);
if (isRenderOrigin) localStorage.removeItem('vynzo_backend_url');

export const API_ORIGIN = isRenderOrigin ? '' : configuredBackendOrigin;
export const API_BASE_URL = API_ORIGIN ? `${API_ORIGIN}/api` : '';
