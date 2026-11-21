const STORAGE_KEY = 'vynzo_page_memory_v2';
const OLD_STORAGE_KEY = 'vynzo_page_memory_v1';
const MAX_BYTES = 750000;
const MAX_AGE = 15 * 60 * 1000;
const LIST_MAX_AGE = 24 * 60 * 60 * 1000;

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
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(OLD_STORAGE_KEY);
  } catch (error) {
    console.warn('Could not clear saved page information:', error);
  }
}

function readStore(account) {
  const store = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (!store) return { account, entries: {} };
  if (store.account !== account) {
    localStorage.removeItem(STORAGE_KEY);
    return { account, entries: {} };
  }
  const now = Date.now();
  let expired = false;
  for (const [key, entry] of Object.entries(store.entries)) {
    const maxAge = key === 'conversations' || key.startsWith('find:') ? LIST_MAX_AGE : MAX_AGE;
    if (!entry || entry.savedAt > now || now - entry.savedAt >= maxAge) {
      delete store.entries[key];
      expired = true;
    }
  }
  if (expired) localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
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

export function removePageMemory(prefix) {
  const account = pageMemoryAccount();
  if (!account) return;
  try {
    const store = readStore(account);
    for (const key of Object.keys(store.entries)) {
      if (key.startsWith(prefix)) delete store.entries[key];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    console.warn('Could not remove saved page information:', error);
    clearPageMemory();
  }
}

export function writePageMemory(key, value, account = pageMemoryAccount()) {
  if (!account || account !== pageMemoryAccount()) return;
  try {
    const store = readStore(account);
    delete store.entries[key];
    store.entries[key] = { savedAt: Date.now(), value };
    if (JSON.stringify({ account, entries: { [key]: store.entries[key] } }).length * 2 > MAX_BYTES) {
      console.warn('Page information is too large to save on this device:', key);
      return;
    }
    let serialized = JSON.stringify(store);
    while (serialized.length * 2 > MAX_BYTES && Object.keys(store.entries).length) {
      const keys = Object.keys(store.entries);
      const oldest = keys.find(entry => entry !== 'conversations' && !entry.startsWith('find:')) || keys[0];
      delete store.entries[oldest];
      serialized = JSON.stringify(store);
    }
    if (!store.entries[key]) console.warn('Page information could not fit in device memory:', key);
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch (error) {
    console.warn('Could not save page information on this device:', error);
  }
}
