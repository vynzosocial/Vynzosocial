const SHARE_PATHS = new Set(['/pages/shared-media.html', '/pages/live.html', '/pages/blogs.html']);

export function shareLoginUrl(location) {
  const login = new URL('/pages/login.html', location.origin);
  login.searchParams.set('return', `${location.pathname}${location.search}${location.hash}`);
  return login.href;
}

export function shareLoginDestination(location) {
  const requested = new URLSearchParams(location.search).get('return');
  if (!requested || !requested.startsWith('/') || requested.startsWith('//')) return '../index.html';
  const url = new URL(requested, location.origin);
  if (url.origin !== location.origin || !SHARE_PATHS.has(url.pathname)) return '../index.html';
  return url.href;
}
