export function createPushLifecycle({ plugin, request, onOpen, reportError }) {
  let generation = 0;
  let queue = Promise.resolve();
  let currentSession = null;

  function serialize(operation) {
    const result = queue.then(operation);
    queue = result.catch(error => reportError(error));
    return result;
  }

  async function sync(session, expected) {
    if (expected !== generation) return;
    if (!session?.user?.id || !session.access_token) {
      await plugin.setOwner({ userId: null });
      return;
    }
    const device = await plugin.getRegistration();
    if (!device.enabled || device.ownerId !== session.user.id) {
      await plugin.setOwner({ userId: null });
    }
    if (!device.enabled) return;
    if (!device.installationId) {
      await plugin.register();
      return;
    }
    await request('POST', session.access_token, device);
    if (expected !== generation) return;
    if (device.ownerId !== session.user.id) await plugin.setOwner({ userId: session.user.id });
  }

  function setSession(session) {
    currentSession = session;
    const expected = ++generation;
    return serialize(() => sync(session, expected));
  }

  function unregister(session) {
    currentSession = null;
    ++generation;
    return serialize(async () => {
      await plugin.setOwner({ userId: null });
      if (!session?.access_token) return;
      const device = await plugin.getRegistration();
      await request('DELETE', session.access_token, device);
    });
  }

  async function start() {
    await plugin.addListener('registration', () => {
      setSession(currentSession).catch(() => {});
    });
    await plugin.addListener('notificationOpen', onOpen);
  }

  async function enable() {
    await plugin.register();
    await setSession(currentSession);
  }
  return { start, setSession, unregister, enable };
}
