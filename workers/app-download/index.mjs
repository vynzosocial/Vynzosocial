import { parseRange } from '../shared/byte-range.mjs';

const FILES = new Set(['vynzo-android-1.0.apk', 'vynzo-android-1.1.apk', 'vynzo-android-1.2.apk', 'vynzo-android-1.3.apk', 'vynzo-android-1.4.apk', 'vynzo-android-1.5.apk', 'vynzo-android-1.6.apk']);
const WINDOWS_RELEASE = /^windows\/VynzoSocial-Setup-\d+\.\d+\.\d+-x64\.exe(?:\.blockmap)?$/;

export default {
  async fetch(request, env) {
    const file = new URL(request.url).pathname.slice(1);
    const manifest = file === 'windows/latest.yml';
    const windowsRelease = WINDOWS_RELEASE.test(file);
    if (!FILES.has(file) && !manifest && !windowsRelease) {
      return new Response('Not found', { status: 404 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' }
      });
    }

    let range = null;
    if (windowsRelease && request.method === 'GET' && request.headers.has('Range')) {
      const metadata = await env.DOWNLOADS.head(file);
      if (!metadata) return new Response('Download unavailable', { status: 404 });
      range = parseRange(request.headers.get('Range'), metadata.size);
      if (!range) return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${metadata.size}`, 'Cache-Control': 'no-store' }
      });
    }
    const object = request.method === 'HEAD'
      ? await env.DOWNLOADS.head(file)
      : await env.DOWNLOADS.get(file, range ? { range } : undefined);
    if (!object) return new Response('Download unavailable', { status: 404 });

    const headers = new Headers({
      'Content-Type': manifest ? 'text/yaml; charset=utf-8' : windowsRelease ? 'application/octet-stream' : 'application/vnd.android.package-archive',
      'Content-Disposition': `attachment; filename="${file.split('/').pop()}"`,
      'Content-Length': String(range ? range.length : object.size),
      'Cache-Control': manifest ? 'no-store' : windowsRelease ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      'ETag': object.httpEtag,
      'X-Content-Type-Options': 'nosniff'
    });
    if (windowsRelease) headers.set('Accept-Ranges', 'bytes');
    if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    return new Response(request.method === 'HEAD' ? null : object.body, { status: range ? 206 : 200, headers });
  }
};
