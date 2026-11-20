const STORAGE_KEY = 'vynzo_page_memory_v1';
const MAX_BYTES = 750000;
const MAX_AGE = 2 * 60 * 1000;

export function pageMemoryAccount() {
  if (!globalThis.Capacitor?.isNativePlatform?.()) return null;
  try {
    if (!localStorage.getItem('vynzo_token')) return null;
    return JSON.parse(localStorage.getItem('vynzo_user') || '{}').id || null;
  } catch (error) {
    console.warn('Could not read the page-memory account:', error);
    return null;
  }
}

export function clearPageMemory() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Could not clear saved page information:', error);
  }
}

function readStore(account) {
  const store = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
  if (!store || store.account !== account) return { account, entries: {} };
  const now = Date.now();
  for (const [key, entry] of Object.entries(store.entries)) {
    if (!entry || entry.savedAt > now || now - entry.savedAt >= MAX_AGE) delete store.entries[key];
  }
  return store;
}

export function readPageMemory(key) {
  const account = pageMemoryAccount();
  if (!account) return null;
  try {
    return readStore(account).entries[key]?.value ?? null;
  } catch (error) {
    console.warn('Could not restore saved page information:', error);
    clearPageMemory();
    return null;
  }
}

export function writePageMemory(key, value, account = pageMemoryAccount()) {
  if (!account || account !== pageMemoryAccount()) return;
  try {
    const store = readStore(account);
    delete store.entries[key];
    store.entries[key] = { savedAt: Date.now(), value };
    let serialized = JSON.stringify(store);
    while (serialized.length * 2 > MAX_BYTES && Object.keys(store.entries).length) {
      delete store.entries[Object.keys(store.entries)[0]];
      serialized = JSON.stringify(store);
    }
    sessionStorage.setItem(STORAGE_KEY, serialized);
  } catch (error) {
    console.warn('Could not save page information on this device:', error);
  }
}
