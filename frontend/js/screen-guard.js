const owners = new Set();
let sequence = Promise.resolve();

export function setScreenGuard(owner, enabled) {
  if (enabled) owners.add(owner);
  else owners.delete(owner);
  const secure = owners.size > 0;
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.()) return Promise.resolve(false);
  const guard = capacitor.Plugins?.ScreenGuard;
  if (!guard?.setSecure) return Promise.reject(new Error('Screen protection is not available in this app version.'));
  sequence = sequence.catch(error => {
    console.error('Previous screen protection update failed:', error);
  }).then(() => guard.setSecure({ enabled: secure }));
  return sequence.then(() => true);
}
