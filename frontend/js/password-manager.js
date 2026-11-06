function nativeManager() {
  const capacitor = window.Capacitor;
  return capacitor?.isNativePlatform() && capacitor.isPluginAvailable('PasswordManager')
    ? capacitor.Plugins.PasswordManager : null;
}

function browserManagerAvailable() {
  return !window.Capacitor?.isNativePlatform()
    && typeof window.PasswordCredential === 'function' && Boolean(navigator.credentials);
}

export function canSelectSavedLogin() {
  return Boolean(nativeManager() || browserManagerAvailable());
}

export async function selectSavedLogin() {
  const native = nativeManager();
  if (native) return native.select();
  if (!browserManagerAvailable()) throw new Error('Your password manager is not available here.');
  const credential = await navigator.credentials.get({ password: true, mediation: 'required' });
  if (!credential) return null;
  return { username: credential.id, password: credential.password };
}

export async function offerToSaveLogin(username, password) {
  const native = nativeManager();
  if (native) {
    await native.save({ username, password });
    return;
  }
  if (!window.Capacitor?.isNativePlatform() && browserManagerAvailable()) {
    await navigator.credentials.store(new window.PasswordCredential({ id: username, password }));
    return;
  }
  throw new Error('Password manager integration is not available on this device. Use your browser or phone autofill settings.');
}
