const { SITE_URL, isTrustedUrl } = require('./policy.cjs');

const ROUTES = Object.freeze({
  home: { path: '/', title: 'Home' },
  messages: { path: '/pages/messages.html', title: 'Messages' },
  live: { path: '/pages/live.html', title: 'Live studio' },
  blogs: { path: '/pages/blogs.html', title: 'Blogs' },
  people: { path: '/pages/users.html', title: 'People' },
  settings: { path: '/pages/settings.html', title: 'Settings' },
  about: { path: '/pages/about.html', title: 'About' }
});
const TITLE_HEIGHT = 52;
const RAIL_WIDTH = 88;
const ACTIONS = new Set(['back', 'forward', 'reload', 'menu', 'update']);

function routeUrl(section) {
  if (typeof section !== 'string' || !Object.hasOwn(ROUTES, section)) {
    throw new Error('Unknown desktop navigation section.');
  }
  return new URL(ROUTES[section].path, SITE_URL).href;
}

function sectionForUrl(value) {
  if (!isTrustedUrl(value)) return null;
  const pathname = new URL(value).pathname.replace(/\.html$/, '');
  if (pathname === '/index' || pathname === '/') return 'home';
  return Object.keys(ROUTES).find(key => ROUTES[key].path.replace(/\.html$/, '') === pathname) || null;
}

function viewBounds(width, height) {
  return {
    x: RAIL_WIDTH,
    y: TITLE_HEIGHT,
    width: Math.max(0, width - RAIL_WIDTH),
    height: Math.max(0, height - TITLE_HEIGHT)
  };
}

function validateAction(type, section) {
  if (type === 'navigate') return routeUrl(section);
  if (!ACTIONS.has(type)) throw new Error('Unsupported desktop action.');
  return null;
}

function isShellSender(event, contents, shellUrl) {
  return event.sender === contents
    && event.senderFrame === contents.mainFrame
    && event.senderFrame?.url === shellUrl;
}

module.exports = { ROUTES, TITLE_HEIGHT, routeUrl, sectionForUrl, viewBounds, validateAction, isShellSender };
