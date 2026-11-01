const sanitizeHtml = require('sanitize-html');

const EMBED_HOSTS = ['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com'];
const IMAGE_PATH = /^\/uploads\/[A-Za-z0-9._-]+$/;
const VIDEO_PATH = /^\/uploads\/[A-Za-z0-9._-]+\.(mp4|webm|mov|m4v)$/i;

// Converts a pasted YouTube/Vimeo link into a safe embed URL, or returns null.
function toEmbedUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^m\./, 'www.');
  let match;
  if (host === 'youtu.be' && (match = url.pathname.match(/^\/([\w-]{11})$/))) {
    return `https://www.youtube-nocookie.com/embed/${match[1]}`;
  }
  if ((host === 'www.youtube.com' || host === 'www.youtube-nocookie.com')) {
    if (url.pathname === '/watch' && /^[\w-]{11}$/.test(url.searchParams.get('v') || '')) {
      return `https://www.youtube-nocookie.com/embed/${url.searchParams.get('v')}`;
    }
    if ((match = url.pathname.match(/^\/embed\/([\w-]{11})$/))) {
      return `https://www.youtube-nocookie.com/embed/${match[1]}`;
    }
  }
  if ((host === 'vimeo.com' || host === 'player.vimeo.com')
    && (match = url.pathname.match(/^\/(?:video\/)?(\d{5,12})$/))) {
    return `https://player.vimeo.com/video/${match[1]}`;
  }
  return null;
}

function cleanHtml(dirty) {
  return sanitizeHtml(String(dirty || ''), {
    allowedTags: ['h2', 'h3', 'h4', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li',
      'blockquote', 'a', 'img', 'hr', 'code', 'pre', 'iframe', 'video'],
    allowedAttributes: {
      a: ['href', 'rel', 'target'],
      img: ['src', 'alt'],
      video: ['src', 'controls', 'preload', 'playsinline'],
      iframe: ['src', 'allowfullscreen', 'sandbox', 'loading', 'title']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    allowedIframeHostnames: EMBED_HOSTS,
    transformTags: {
      a: (tag, attribs) => ({
        tagName: 'a',
        attribs: { href: attribs.href || '', rel: 'noopener noreferrer nofollow ugc', target: '_blank' }
      }),
      img: (tag, attribs) => ({
        tagName: 'img',
        attribs: { src: attribs.src || '', alt: String(attribs.alt || '').slice(0, 200) }
      }),
      video: (tag, attribs) => ({
        tagName: 'video',
        attribs: { src: attribs.src || '', controls: 'controls', preload: 'metadata', playsinline: 'playsinline' }
      }),
      iframe: (tag, attribs) => {
        const safe = toEmbedUrl(attribs.src);
        return {
          tagName: 'iframe',
          attribs: safe
            ? { src: safe, sandbox: 'allow-scripts allow-same-origin allow-presentation', allowfullscreen: 'true', loading: 'lazy', title: 'Embedded video' }
            : {}
        };
      },
      b: 'strong',
      i: 'em'
    },
    exclusiveFilter: frame => {
      if (frame.tag === 'img') return !IMAGE_PATH.test(frame.attribs.src || '');
      if (frame.tag === 'video') return !VIDEO_PATH.test(frame.attribs.src || '');
      if (frame.tag === 'iframe') return !frame.attribs.src;
      if (frame.tag === 'a') return !frame.attribs.href;
      return false;
    }
  }).trim();
}

function htmlToText(html) {
  return sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extractImagePaths(html) {
  return [...String(html || '').matchAll(/<img[^>]+src="(\/uploads\/[A-Za-z0-9._-]+)"/g)].map(m => m[1]);
}

function extractHashtags(text) {
  const tags = new Set();
  for (const m of String(text || '').matchAll(/(?:^|\s)#([\p{L}\p{N}_]{2,30})/gu)) {
    tags.add(m[1].toLowerCase());
  }
  return [...tags];
}

module.exports = { cleanHtml, htmlToText, toEmbedUrl, extractImagePaths, extractHashtags };
