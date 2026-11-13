const { isTrustedUrl, canRequestPermission } = require('./policy.cjs');

function configurePermissions(browserSession, { message, log }) {
  const grants = new Set();
  const automatic = new Set(['fullscreen', 'clipboard-sanitized-write']);
  browserSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (!contents || !details.isMainFrame || !canRequestPermission(permission, origin, contents.getURL())) return false;
    if (automatic.has(permission)) return true;
    const key = permission === 'media' ? `media:${details.mediaType}` : permission;
    return grants.has(key);
  });
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!contents || !details.isMainFrame
      || !canRequestPermission(permission, details.requestingUrl, contents.getURL())) {
      callback(false);
      return;
    }
    if (automatic.has(permission)) {
      callback(true);
      return;
    }
    const types = permission === 'media' ? details.mediaTypes || [] : [];
    if (permission === 'media' && (types.length === 0 || types.some(type => !['audio', 'video'].includes(type)))) {
      log('Blocked unsupported media permission request');
      callback(false);
      return;
    }
    const keys = permission === 'media' ? types.map(type => `media:${type}`) : [permission];
    if (keys.every(key => grants.has(key))) {
      callback(true);
      return;
    }
    const capability = permission === 'notifications' ? 'show desktop notifications'
      : permission === 'speaker-selection' ? 'select an audio output device'
        : `use your ${types.map(type => type === 'audio' ? 'microphone' : 'camera').join(' and ')}`;
    void message({
      type: 'question',
      title: 'VynzoSocial permission',
      message: `Allow VynzoSocial to ${capability}?`,
      detail: 'Only www.vynzosocial.com can request this permission. Permission lasts until you close the app. You can also block access in Windows Settings.',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }).then(({ response }) => {
      const allowed = response === 0 && !contents.isDestroyed() && isTrustedUrl(contents.getURL());
      if (allowed) keys.forEach(key => grants.add(key));
      callback(allowed);
    }).catch(error => {
      log('Could not request permission', error);
      callback(false);
    });
  });
}

module.exports = { configurePermissions };
