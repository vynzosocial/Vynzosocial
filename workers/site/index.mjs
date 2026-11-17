const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_API = 'https://qyfphwrmwvnwsklfsbbo.supabase.co/functions/v1/vynzo-api/api/media/public-preview';
const BLOG_PREVIEW_API = 'https://qyfphwrmwvnwsklfsbbo.supabase.co/functions/v1/blog-preview';
const PUBLIC_MEDIA_API = 'https://qyfphwrmwvnwsklfsbbo.supabase.co/functions/v1/public-share-media';
const SITE_ORIGIN = 'https://www.vynzosocial.com';

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

async function blogPreview(id, image, env, full = false, asset = null, range = null) {
  const target = new URL(BLOG_PREVIEW_API);
  target.searchParams.set('id', id);
  if (image) target.searchParams.set('image', '1');
  if (full) target.searchParams.set('full', '1');
  if (asset !== null) target.searchParams.set('asset', asset);
  return fetch(target, { headers: {
    ...(range ? { Range: range } : {}),
    apikey: env.VYNZO_SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${env.VYNZO_SUPABASE_PUBLISHABLE_KEY}`
  } });
}

function mediaParams(url) {
  const kind = url.searchParams.get('kind');
  const id = url.searchParams.get('id');
  return ['post', 'story'].includes(kind) && UUID.test(id || '') ? { kind, id } : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/shared-public-media') {
      const corsHeaders = { 'Cache-Control': 'no-store', 'Vary': 'Origin' };
      const origin = request.headers.get('Origin');
      if (['https://www.vynzosocial.com', 'https://vynzosocial.com', 'https://localhost', 'capacitor://localhost'].includes(origin)) corsHeaders['Access-Control-Allow-Origin'] = origin;
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range' } });
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...corsHeaders, Allow: 'GET, HEAD, OPTIONS' } });
      const params = mediaParams(url);
      const type = url.searchParams.get('type');
      if (!params || !['image', 'video'].includes(type)) return new Response('Not found', { status: 404, headers: corsHeaders });
      const target = new URL(PUBLIC_MEDIA_API);
      for (const [key, value] of Object.entries({ ...params, type })) target.searchParams.set(key, value);
      let response;
      try {
        response = await fetch(target, { headers: {
          apikey: env.VYNZO_SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${env.VYNZO_SUPABASE_PUBLISHABLE_KEY}`,
          ...(request.headers.has('Range') ? { Range: request.headers.get('Range') } : {})
        } });
      } catch (error) {
        console.error('Public media service unavailable:', error);
        return new Response('Media unavailable', { status: 503, headers: corsHeaders });
      }
      if (![200, 206, 404, 416].includes(response.status)) return new Response('Media unavailable', { status: 503, headers: corsHeaders });
      const headers = new Headers({ ...corsHeaders, 'X-Content-Type-Options': 'nosniff' });
      for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
    }
    if (url.pathname === '/share-blog-media') {
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
      const id = url.searchParams.get('id') || '';
      const asset = url.searchParams.get('asset') || '';
      if (!UUID.test(id) || !asset) return new Response('Not found', { status: 404, headers });
      let response;
      try {
        response = await blogPreview(id, true, env, false, asset, request.headers.get('Range'));
      } catch (error) {
        console.error('Blog media service unavailable:', error);
        return new Response('Media unavailable', { status: 503, headers });
      }
      if (![200, 206, 404, 416].includes(response.status)) return new Response('Media unavailable', { status: 503, headers });
      const resultHeaders = new Headers(headers);
      if ([200, 206].includes(response.status) &&
          !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'].includes(response.headers.get('Content-Type'))) {
        return new Response('Invalid media', { status: 502, headers });
      }
      for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
        const value = response.headers.get(name);
        if (value) resultHeaders.set(name, value);
      }
      return new Response(request.method === 'HEAD' || response.status === 416 ? null : response.body, { status: response.status, headers: resultHeaders });
    }
    if (url.pathname === '/share-blog' || url.pathname === '/share-blog-cover') {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
      const id = url.searchParams.get('id') || '';
      if (!UUID.test(id)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
      const image = url.pathname === '/share-blog-cover';
      let response;
      try {
        response = await blogPreview(id, image, env, !image);
      } catch (error) {
        console.error('Blog preview service unavailable:', error);
        return new Response('Preview unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
      if (image) {
        if (response.status === 404) return new Response(null, { status: 302, headers: { Location: `${SITE_ORIGIN}/assets/logo.png`, 'Cache-Control': 'no-store' } });
        if (!response.ok) return new Response('Preview unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
        const type = response.headers.get('Content-Type');
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) return new Response('Invalid preview', { status: 502, headers: { 'Cache-Control': 'no-store' } });
        return new Response(request.method === 'HEAD' ? null : response.body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (!response.ok && response.status !== 404) return new Response('Preview unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
      let metadata = null;
      if (response.ok) {
        try {
          metadata = await response.json();
        } catch (error) {
          console.error('Invalid blog preview response:', error);
          return new Response('Preview unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } });
        }
        if (typeof metadata.title !== 'string' || typeof metadata.hasCover !== 'boolean' || typeof metadata.content !== 'string' || !['en', 'ar'].includes(metadata.language)) return new Response('Invalid preview', { status: 502, headers: { 'Cache-Control': 'no-store' } });
      }
      const title = metadata ? metadata.title : 'Shared on Vynzo';
      const cover = metadata?.hasCover ? `${SITE_ORIGIN}/share-blog-cover?id=${id}` : `${SITE_ORIGIN}/assets/logo.png`;
      const destination = `${SITE_ORIGIN}/pages/blogs.html#/a/${id}`;
      const article = metadata ? `<h1>${escapeHtml(title)}</h1>${metadata.hasCover ? `<img class="cover" src="${escapeHtml(cover)}" alt="">` : ''}<iframe title="Blog article" sandbox srcdoc="${escapeHtml(`<!doctype html><html lang="${metadata.language}" dir="${metadata.language === 'ar' ? 'rtl' : 'ltr'}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:18px/1.7 system-ui,sans-serif;color:#f5f2fa;background:#171421;overflow-wrap:anywhere}img,video,iframe{max-width:100%}a{color:#e4b7ff}</style></head><body>${metadata.content}</body></html>`)}"></iframe>` : '<h1>Shared on Vynzo</h1><p>This blog is unavailable or requires an account.</p>';
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><meta property="og:type" content="article"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:image" content="${escapeHtml(cover)}"><meta property="og:url" content="${SITE_ORIGIN}/share-blog?id=${id}"><style>body{background:#100e18;color:#fff;font:16px system-ui,sans-serif;margin:0}main{max-width:850px;margin:auto;padding:24px}h1{overflow-wrap:anywhere}.cover{width:100%;max-height:420px;object-fit:contain}iframe{width:100%;height:75vh;border:0}a{color:#e4b7ff}</style></head><body><main>${article}<p><a href="${destination}">Open in Vynzo</a></p></main></body></html>`;
      return new Response(request.method === 'HEAD' ? null : html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (url.pathname === '/media-stage') {
      if (!['OPTIONS', 'PUT'].includes(request.method)) {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'OPTIONS, PUT', 'Cache-Control': 'no-store' } });
      }
      if (!env.MEDIA_UPLOAD) {
        console.error('Media upload service binding is missing.');
        return new Response('Media upload unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
      const target = new URL('https://media.internal/stage');
      return env.MEDIA_UPLOAD.fetch(new Request(target, request));
    }
    if (url.pathname === '/share-preview') {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
      const params = mediaParams(url);
      if (!params) return new Response('Not found', { status: 404 });
      const target = new URL(PREVIEW_API);
      target.searchParams.set('kind', params.kind);
      target.searchParams.set('id', params.id);
      let response;
      try {
        response = await fetch(target, { headers: {
          apikey: env.VYNZO_SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${env.VYNZO_SUPABASE_PUBLISHABLE_KEY}`
        } });
      } catch (error) {
        console.error('Share preview service unavailable:', error);
        return new Response('Preview unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
      if (response.status === 404) {
        return new Response(null, { status: 302, headers: {
          Location: new URL('/assets/logo.png', SITE_ORIGIN).href,
          'Cache-Control': 'no-store'
        } });
      }
      if (!response.ok) return new Response('Preview unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
      const type = response.headers.get('Content-Type');
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) {
        return new Response('Invalid preview', { status: 502, headers: { 'Cache-Control': 'no-store' } });
      }
      return new Response(request.method === 'HEAD' ? null : response.body, { headers: {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      } });
    }
    const response = await env.ASSETS.fetch(request);
    if (request.method !== 'GET' || !['/pages/shared-media', '/pages/shared-media.html'].includes(url.pathname) || !mediaParams(url) || !response.ok) return response;
    const preview = new URL('/share-preview', SITE_ORIGIN);
    preview.searchParams.set('kind', url.searchParams.get('kind'));
    preview.searchParams.set('id', url.searchParams.get('id'));
    const html = await response.text();
    if (!html.includes('content="https://www.vynzosocial.com/assets/logo.png"')) {
      console.error('Shared-media preview image tag is missing.');
      return new Response('Shared page unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.set('Cache-Control', 'no-store');
    return new Response(html.replace(
      'content="https://www.vynzosocial.com/assets/logo.png"',
      `content="${preview.href.replace(/&/g, '&amp;')}"`
    ).replace('<meta property="og:image:type" content="image/png">', '')
      .replace('<meta property="og:image:width" content="768">', '')
      .replace('<meta property="og:image:height" content="768">', ''), {
      status: response.status, headers
    });
  }
};
