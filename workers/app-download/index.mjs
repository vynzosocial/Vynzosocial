const FILES = new Set(['vynzo-android-1.0.apk', 'vynzo-android-1.1.apk', 'vynzo-android-1.2.apk']);

export default {
  async fetch(request, env) {
    const file = new URL(request.url).pathname.slice(1);
    if (!FILES.has(file)) {
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' }
      });
    }

    const object = request.method === 'HEAD'
      ? await env.DOWNLOADS.head(file)
      : await env.DOWNLOADS.get(file);
    if (!object) return new Response('Download unavailable', { status: 404 });

    const headers = new Headers({
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${file}"`,
      'Content-Length': String(object.size),
      'Cache-Control': 'public, max-age=3600',
      'ETag': object.httpEtag,
      'X-Content-Type-Options': 'nosniff'
    });
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  }
};
