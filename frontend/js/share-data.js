const MARKER = 'vynzo-share=';

export function shareMessage(text, url, preview) {
  if (!preview) return [text, url].filter(Boolean).join('\n');
  const link = new URL(url);
  link.hash = MARKER + encodeURIComponent(JSON.stringify(preview));
  return [text, link.toString()].filter(Boolean).join('\n');
}

export function parseSharedMessage(content) {
  if (typeof content !== 'string') return null;
  const split = content.lastIndexOf('\n');
  if (split < 0) return null;
  const text = content.slice(0, split);
  let url;
  try { url = new URL(content.slice(split + 1)); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  let preview;
  if (url.hash.startsWith(`#${MARKER}`)) {
    try { preview = JSON.parse(decodeURIComponent(url.hash.slice(MARKER.length + 1))); } catch { return null; }
    url.hash = '';
  } else if (url.origin === 'https://www.vynzosocial.com' && url.pathname === '/pages/live.html' && text.startsWith('🔴 Join my live')) {
    preview = { type: 'live' };
  } else if (/^(🖼 Image|🎬 Video|🖼 Story|🎬 Story) by @/.test(text)) {
    preview = { type: text.startsWith('🎬') ? 'video' : 'image' };
  } else return null;
  if (!preview || !['live', 'image', 'video'].includes(preview.type)) return null;
  if (preview.type === 'live' && (url.origin !== 'https://www.vynzosocial.com' || url.pathname !== '/pages/live.html')) return null;
  if (preview.r2 && (!['post', 'story'].includes(preview.kind) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(preview.id || ''))) return null;
  return { text, url: url.toString(), preview };
}
