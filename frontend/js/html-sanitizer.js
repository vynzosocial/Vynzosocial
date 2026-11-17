const ALLOWED_TAGS = new Set(['p', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'b', 'i', 'u', 'br', 'blockquote', 'img', 'code', 'pre', 'video', 'hr']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'form', 'textarea', 'select', 'title', 'head', 'link', 'meta', 'base', 'frame', 'frameset', 'applet']);
const VOID_TAGS = new Set(['br', 'img', 'hr']);
const ATTRS = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'width', 'height', 'data-w', 'data-align'],
  video: ['src', 'controls', 'preload', 'playsinline', 'data-w', 'data-align'],
};
const GLOBAL_ATTRS = ['dir', 'data-ta'];
const ENUM_ATTRS = {
  dir: ['ltr', 'rtl', 'auto'],
  'data-ta': ['left', 'center', 'right', 'justify'],
  'data-align': ['left', 'center', 'right'],
  'data-w': ['25', '33', '50', '75', '100'],
  preload: ['none', 'metadata', 'auto'],
};

function escapeText(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Accepts http(s) and relative URLs only. Rejects javascript:, data:, protocol-relative and scheme-obfuscated values.
function isSafeUrl(value) {
  const url = String(value ?? '').trim();
  if (!url || /[\u0000-\u001f\u007f]/.test(url)) return false;
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith('//') || url.startsWith('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  const firstColon = url.indexOf(':');
  const firstSeparator = url.search(/[/?#]/);
  return firstColon === -1 || (firstSeparator !== -1 && firstSeparator < firstColon);
}

function safeUrl(value) {
  return isSafeUrl(value) ? String(value).trim() : '';
}

function serializeAttributes(tag, attributes) {
  const allowed = new Set([...GLOBAL_ATTRS, ...(ATTRS[tag] || [])]);
  let out = '';
  let hasHref = false;
  for (const attribute of Array.from(attributes || [])) {
    const name = String(attribute.name).toLowerCase();
    if (!allowed.has(name) || name.startsWith('on')) continue;
    const value = String(attribute.value ?? '');
    if (name === 'src' || name === 'href') {
      if (!isSafeUrl(value)) continue;
      if (name === 'href') hasHref = true;
      out += ` ${name}="${escapeAttribute(value.trim())}"`;
    } else if (ENUM_ATTRS[name]) {
      if (ENUM_ATTRS[name].includes(value.trim().toLowerCase())) out += ` ${name}="${escapeAttribute(value.trim().toLowerCase())}"`;
    } else if (['controls', 'playsinline'].includes(name)) {
      out += ` ${name}`;
    } else if (name === 'width' || name === 'height') {
      if (/^\d{1,4}$/.test(value.trim())) out += ` ${name}="${value.trim()}"`;
    } else {
      out += ` ${name}="${escapeAttribute(value)}"`;
    }
  }
  if (tag === 'a' && hasHref) out += ' rel="noopener noreferrer"';
  return out;
}

function serializeNode(node) {
  if (node.nodeType === 3) return escapeText(node.nodeValue ?? node.textContent);
  if (node.nodeType !== 1) return '';
  const tag = String(node.nodeName || node.tagName).toLowerCase();
  if (DROP_WITH_CONTENT.has(tag)) return '';
  const children = Array.from(node.childNodes || []).map(serializeNode).join('');
  if (!ALLOWED_TAGS.has(tag)) return children;
  if (VOID_TAGS.has(tag)) return `<${tag}${serializeAttributes(tag, node.attributes)}>`;
  return `<${tag}${serializeAttributes(tag, node.attributes)}>${children}</${tag}>`;
}

function parseBody(html) {
  return new DOMParser().parseFromString(String(html ?? ''), 'text/html').body;
}

// Returns a sanitized HTML string built only from allow-listed tags and attributes.
function sanitizeHtml(html, parse = parseBody) {
  const body = parse(String(html ?? ''));
  return Array.from(body.childNodes || []).map(serializeNode).join('');
}

export { sanitizeHtml, isSafeUrl, safeUrl };
