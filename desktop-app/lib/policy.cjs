const SITE_URL = 'https://www.vynzosocial.com/';
const SITE_ORIGIN = new URL(SITE_URL).origin;
const PERMISSIONS = new Set(['media', 'notifications', 'speaker-selection', 'fullscreen', 'clipboard-sanitized-write']);

function parseWebUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function isTrustedUrl(value) {
  return parseWebUrl(value)?.origin === SITE_ORIGIN;
}

function isExternalUrl(value) {
  const url = parseWebUrl(value);
  return Boolean(url && url.origin !== SITE_ORIGIN);
}

function canRequestPermission(permission, origin, topLevelUrl) {
  return PERMISSIONS.has(permission) && isTrustedUrl(origin) && isTrustedUrl(topLevelUrl);
}

function validateUpdateUrl(value) {
  const url = parseWebUrl(value);
  if (!url || url.protocol !== 'https:' || url.search || url.hash) {
    throw new Error('The desktop update URL must be an HTTPS directory URL without credentials, a query, or a fragment.');
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

module.exports = { SITE_URL, isTrustedUrl, isExternalUrl, canRequestPermission, validateUpdateUrl };
