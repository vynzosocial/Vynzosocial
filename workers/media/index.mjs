import { deleteAccountMedia } from './account-cleanup.mjs';
import { parseRange } from '../shared/byte-range.mjs';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PERMIT_SECONDS = 15 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']);
const ORIGINS = new Set(['https://www.vynzosocial.com', 'https://vynzosocial.com', 'https://localhost', 'capacitor://localhost']);
const encoder = new TextEncoder();

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

async function verifyPermit(token, secret, now) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, decodeBase64Url(parts[1]), encoder.encode(parts[0]))) return null;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    if (!UUID.test(claims.userId) || !UUID.test(claims.uploadId) ||
        !['post', 'story'].includes(claims.kind) ||
        !['original', 'playback', 'cover'].includes(claims.variant) ||
        !TYPES.has(claims.contentType) ||
        (claims.variant === 'playback' && claims.contentType !== 'video/mp4') ||
        (claims.variant === 'cover' && (!['image/jpeg', 'image/webp'].includes(claims.contentType) || claims.size > 2 * 1024 * 1024)) ||
        !Number.isSafeInteger(claims.size) || claims.size <= 0 || claims.size > MAX_BYTES ||
        !Number.isSafeInteger(claims.expires) || claims.expires <= now || claims.expires > now + MAX_PERMIT_SECONDS) return null;
    return claims;
  } catch {
    return null;
  }
}

function cors(origin) {
  const headers = { 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, x-upload-permit, range', 'Referrer-Policy': 'no-referrer' };
  if (ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

async function verifyDelivery(token, secret, now) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, decodeBase64Url(parts[1]), encoder.encode(parts[0]))) return null;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    const validIds = [claims.viewerId, claims.itemId, claims.userId, claims.uploadId].every(value => UUID.test(value));
    const legacyPost = claims.storage === 'legacy' && ['post', 'story'].includes(claims.kind) &&
      ['original', 'playback'].includes(claims.variant) && claims.uploadId === claims.itemId &&
      claims.variant === 'playback';
    const legacyFile = claims.storage === 'legacy-file' && claims.kind === 'file' &&
      claims.variant === 'playback' && ['avatar', 'blog', 'blog-upload', 'message'].includes(claims.scope) &&
      typeof claims.path === 'string' && claims.path.length <= 1024 && !claims.path.startsWith('/') &&
      !claims.path.includes('\\') && !claims.path.includes('\0') &&
      claims.path.split('/').every(part => part && part !== '.' && part !== '..') &&
      UUID.test(claims.resourceId) && claims.itemId === claims.resourceId &&
      claims.uploadId === claims.userId &&
      (claims.scope === 'avatar' && (!claims.path.includes('/') || claims.path.startsWith(`${claims.userId}/`)) ||
        claims.scope === 'blog' && claims.path.startsWith(`blogs/${claims.userId}/`) ||
      claims.scope === 'blog-upload' && claims.viewerId === claims.userId && claims.path.startsWith(`blogs/${claims.userId}/`) ||
      claims.scope === 'message' && (claims.path.startsWith(`${claims.userId}/messages/`) ||
        !claims.path.includes('/')));
    const r2 = (claims.storage === undefined || claims.storage === '') &&
      ['post', 'story'].includes(claims.kind) && ['original', 'playback'].includes(claims.variant);
    if (!validIds || !(legacyPost || legacyFile || r2) ||
        !Number.isSafeInteger(claims.expires) || claims.expires <= now ||
        claims.expires > now + (legacyFile ? 5 * 60 : 60 * 60)) return null;
    return claims;
  } catch {
    return null;
  }
}

async function deliver(request, env, headers) {
  if (!env.MEDIA || typeof env.MEDIA_AUTH_URL !== 'string' || typeof env.MEDIA_AUTH_KEY !== 'string' ||
      typeof env.MEDIA_CONTROL_SECRET !== 'string' || env.MEDIA_CONTROL_SECRET.length < 32) {
    return reply(503, 'Media delivery is not configured.', headers);
  }
  const claims = await verifyDelivery(new URL(request.url).searchParams.get('permit'), env.DELIVERY_SECRET, Math.floor(Date.now() / 1000));
  if (!claims) return reply(401, 'Invalid or expired media permit.', headers);
  const auth = await fetch(env.MEDIA_AUTH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.MEDIA_AUTH_KEY}`,
      'apikey': env.MEDIA_AUTH_KEY,
      'X-Media-Control': env.MEDIA_CONTROL_SECRET,
      'Content-Type': 'application/json',
      ...(claims.storage && request.headers.has('Range') ? { Range: request.headers.get('Range') } : {})
    },
    body: JSON.stringify(claims)
  });
  if (auth.status === 403 || auth.status === 404) return reply(403, 'Media is unavailable or private.', headers);
  if (claims.storage === 'legacy' || claims.storage === 'legacy-file') {
    if (![200, 206, 416].includes(auth.status)) return reply(503, 'Media authorization is temporarily unavailable.', headers);
    const responseHeaders = new Headers({ ...headers, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
      const value = auth.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(request.method === 'HEAD' || auth.status === 416 ? null : auth.body, { status: auth.status, headers: responseHeaders });
  }
  if (!auth.ok) return reply(503, 'Media authorization is temporarily unavailable.', headers);
  const authorization = await auth.json();
  if (authorization.allowed !== true || !['original', 'playback'].includes(authorization.objectVariant)) {
    return reply(403, 'Media is unavailable or private.', headers);
  }
  const path = objectPath('media', claims, authorization.objectVariant);
  const metadata = await env.MEDIA.head(path);
  if (!metadata) return reply(404, 'Media not found.', headers);
  const rangeValue = request.headers.get('Range');
  const range = rangeValue ? parseRange(rangeValue, metadata.size) : null;
  if (rangeValue && !range) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${metadata.size}`, 'Cache-Control': 'no-store' } });
  }
  const responseHeaders = {
    ...headers,
    'Accept-Ranges': 'bytes',
    'Content-Type': metadata.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Length': String(range ? range.length : metadata.size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  if (claims.variant === 'original') {
    const extensions = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov'
    };
    const extension = extensions[metadata.httpMetadata?.contentType] || 'bin';
    responseHeaders['Content-Disposition'] = `attachment; filename="original.${extension}"`;
  }
  if (range) responseHeaders['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`;
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers: responseHeaders });
  const object = await env.MEDIA.get(path, range ? { range } : undefined);
  if (!object) return reply(404, 'Media not found.', headers);
  return new Response(object.body, { status: range ? 206 : 200, headers: responseHeaders });
}

function reply(status, message, headers) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function validObjectRef(body) {
  return body && ['post', 'story'].includes(body.kind) && UUID.test(body.userId) && UUID.test(body.uploadId);
}

function objectPath(prefix, ref, variant) {
  return `${prefix}/${ref.kind}/${ref.userId}/${ref.uploadId}/${variant}`;
}

export async function reconcileMedia(env, now = Date.now()) {
  if (!env.MEDIA || typeof env.MEDIA_RECONCILE_URL !== 'string' || typeof env.MEDIA_AUTH_KEY !== 'string' ||
      typeof env.MEDIA_CONTROL_SECRET !== 'string' || env.MEDIA_CONTROL_SECRET.length < 32) {
    throw new Error('Media reconciliation is not configured.');
  }
  let cursor;
  do {
    const page = await env.MEDIA.list({ prefix: 'media/', limit: 1000, ...(cursor ? { cursor } : {}) });
    const refs = new Map();
    for (const object of page.objects) {
      if (now - object.uploaded.getTime() < 2 * 60 * 60 * 1000) continue;
      const parts = object.key.split('/');
      const ref = { kind: parts[1], userId: parts[2], uploadId: parts[3] };
      if (parts.length !== 5 || !['original', 'playback', 'cover'].includes(parts[4]) || !validObjectRef(ref)) continue;
      refs.set(`${ref.kind}/${ref.userId}/${ref.uploadId}`, ref);
    }
    const items = [...refs.values()];
    for (let i = 0; i < items.length; i += 100) {
      const batch = items.slice(i, i + 100);
      const response = await fetch(env.MEDIA_RECONCILE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.MEDIA_AUTH_KEY}`,
          'apikey': env.MEDIA_AUTH_KEY,
          'X-Media-Control': env.MEDIA_CONTROL_SECRET,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ refs: batch })
      });
      if (!response.ok) throw new Error(`Media reconciliation authorization failed (HTTP ${response.status}).`);
      const data = await response.json();
      if (!Array.isArray(data.orphaned)) throw new Error('Invalid media reconciliation response.');
      const allowed = new Set(batch.map(ref => `${ref.kind}/${ref.userId}/${ref.uploadId}`));
      const keys = [];
      for (const ref of data.orphaned) {
        if (!validObjectRef(ref) || !allowed.has(`${ref.kind}/${ref.userId}/${ref.uploadId}`)) {
          throw new Error('Media reconciliation returned an invalid reference.');
        }
        keys.push(objectPath('media', ref, 'original'), objectPath('media', ref, 'playback'), objectPath('media', ref, 'cover'));
      }
      if (keys.length) await env.MEDIA.delete(keys);
    }
    if (page.truncated && (!page.cursor || page.cursor === cursor)) throw new Error('Media reconciliation cursor did not advance.');
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function removeExpiredStaging(env, now = Date.now()) {
  if (!env.MEDIA) throw new Error('Media staging cleanup is not configured.');
  let cursor;
  do {
    const page = await env.MEDIA.list({ prefix: 'staging/', limit: 1000, ...(cursor ? { cursor } : {}) });
    const keys = page.objects
      .filter(object => now - object.uploaded.getTime() >= 24 * 60 * 60 * 1000)
      .map(object => object.key);
    if (keys.length) await env.MEDIA.delete(keys);
    if (page.truncated && (!page.cursor || page.cursor === cursor)) throw new Error('Staging cleanup cursor did not advance.');
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function authorizedControl(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const provided = request.headers.get('X-Media-Control');
  if (!provided || provided.length > 512) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const proposedKey = await crypto.subtle.importKey('raw', encoder.encode(provided), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const proposed = await crypto.subtle.sign('HMAC', proposedKey, encoder.encode('vynzo-media-control'));
  return crypto.subtle.verify('HMAC', key, proposed, encoder.encode('vynzo-media-control'));
}

async function control(request, env, headers) {
  if (!await authorizedControl(request, env.MEDIA_CONTROL_SECRET)) return reply(401, 'Unauthorized.', headers);
  let body;
  try {
    body = await request.json();
  } catch {
    return reply(400, 'Invalid request.', headers);
  }
  const action = new URL(request.url).pathname;
  if (action === '/internal/delete-account-media') {
    if (typeof body?.userId !== 'string' || !UUID.test(body.userId)) {
      return reply(400, 'Invalid account identifier.', headers);
    }
    await deleteAccountMedia(env.MEDIA, body.userId);
    return Response.json({ deleted: true }, { headers: { ...headers, 'Cache-Control': 'no-store' } });
  }
  if (!validObjectRef(body)) return reply(400, 'Invalid media reference.', headers);
  if (action === '/internal/inspect') {
    const objects = await Promise.all(['original', 'playback', 'cover'].map(variant => env.MEDIA.head(objectPath('staging', body, variant))));
    if (!objects[0]) return reply(404, 'Original upload not found.', headers);
    return Response.json({
      original: { size: objects[0].size, contentType: objects[0].httpMetadata?.contentType },
      playback: objects[1] ? { size: objects[1].size, contentType: objects[1].httpMetadata?.contentType } : null,
      cover: objects[2] ? { size: objects[2].size, contentType: objects[2].httpMetadata?.contentType } : null
    }, { headers: { ...headers, 'Cache-Control': 'no-store' } });
  }
  if (action === '/internal/read') {
    if (!['staging', 'media'].includes(body.prefix) || !['original', 'playback', 'cover'].includes(body.variant)) {
      return reply(400, 'Invalid media reference.', headers);
    }
    const path = objectPath(body.prefix, body, body.variant);
    const rangeValue = request.headers.get('Range');
    let range = null;
    if (rangeValue) {
      const metadata = await env.MEDIA.head(path);
      if (!metadata) return reply(404, 'Media not found.', headers);
      range = parseRange(rangeValue, metadata.size);
      if (!range) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${metadata.size}`, 'Cache-Control': 'no-store' } });
    }
    const object = await env.MEDIA.get(path, range ? { range } : undefined);
    if (!object) return reply(404, 'Media not found.', headers);
    return new Response(object.body, {
      status: range ? 206 : 200,
      headers: {
        ...headers,
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': String(range ? range.length : object.size),
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}` } : {}),
        'Cache-Control': 'no-store'
      }
    });
  }
  if (action === '/internal/promote') {
    if (!['image', 'video'].includes(body.mediaType) ||
        (body.mediaType === 'video' && body.hasCover !== true)) return reply(400, 'Invalid media type or missing video cover.', headers);
    const variants = body.mediaType === 'video' ? ['original', 'playback'] : ['original'];
    if (body.hasCover === true) variants.push('cover');
    const sources = await Promise.all(variants.map(variant => env.MEDIA.get(objectPath('staging', body, variant))));
    if (sources.some(object => !object)) return reply(404, 'Staged media is incomplete.', headers);
    const type = sources[0].httpMetadata?.contentType;
    if (!TYPES.has(type) || !type.startsWith(`${body.mediaType}/`) ||
        (body.mediaType === 'video' && sources[1].httpMetadata?.contentType !== 'video/mp4') ||
        (variants.includes('cover') && (sources[variants.indexOf('cover')].httpMetadata?.contentType !==
          (body.mediaType === 'video' ? 'image/webp' : 'image/jpeg') || sources[variants.indexOf('cover')].size > 2 * 1024 * 1024)) ||
        sources.some(object => object.size <= 0 || object.size > MAX_BYTES)) {
      return reply(400, 'Staged media is invalid.', headers);
    }
    const created = [];
    try {
      for (let i = 0; i < variants.length; i++) {
        const path = objectPath('media', body, variants[i]);
        const object = await env.MEDIA.put(path, sources[i].body, {
          onlyIf: new Headers({ 'If-None-Match': '*' }),
          httpMetadata: { contentType: sources[i].httpMetadata.contentType }
        });
        if (!object) {
          if (created.length) await env.MEDIA.delete(created);
          return reply(409, 'Media has already been promoted.', headers);
        }
        created.push(path);
      }
    } catch (error) {
      if (created.length) {
        try {
          await env.MEDIA.delete(created);
        } catch (cleanupError) {
          console.error('Failed to clean up partially promoted media:', cleanupError);
        }
      }
      throw error;
    }
    return Response.json({ promoted: true }, { headers: { ...headers, 'Cache-Control': 'no-store' } });
  }
  if (action === '/internal/delete') {
    if (!['staging', 'media'].includes(body.prefix)) return reply(400, 'Invalid media reference.', headers);
    await env.MEDIA.delete(['original', 'playback', 'cover'].map(variant => objectPath(body.prefix, body, variant)));
    return Response.json({ deleted: true }, { headers: { ...headers, 'Cache-Control': 'no-store' } });
  }
  return reply(404, 'Not found.', headers);
}

export default {
  scheduled(_controller, env, ctx) {
    if (env.ACCOUNT_LIFECYCLE_PRESERVE_MEDIA === 'true') return;
    ctx.waitUntil(Promise.all([reconcileMedia(env), removeExpiredStaging(env)]));
  },
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = cors(origin);
    if (origin && !ORIGINS.has(origin)) return reply(403, 'Origin is not allowed.', headers);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (new URL(request.url).pathname === '/media' && ['GET', 'HEAD'].includes(request.method)) {
      try {
        return await deliver(request, env, headers);
      } catch (error) {
        console.error('Media delivery failed:', error);
        return reply(503, 'Media delivery is temporarily unavailable.', headers);
      }
    }
    if (new URL(request.url).pathname.startsWith('/internal/') && request.method === 'POST') {
      if (!env.MEDIA) return reply(503, 'Media storage is not configured.', headers);
      try {
        return await control(request, env, headers);
      } catch (error) {
        console.error('Media control operation failed:', error);
        return reply(502, 'The media operation could not be completed.', headers);
      }
    }
    if (new URL(request.url).pathname !== '/stage' || request.method !== 'PUT') return reply(404, 'Not found.', headers);
    if (!env.MEDIA || typeof env.UPLOAD_PERMIT_SECRET !== 'string' || env.UPLOAD_PERMIT_SECRET.length < 32) {
      console.error('Media staging is not configured.');
      return reply(503, 'Media staging is not configured.', headers);
    }

    const claims = await verifyPermit(request.headers.get('X-Upload-Permit'), env.UPLOAD_PERMIT_SECRET, Math.floor(Date.now() / 1000));
    if (!claims) return reply(401, 'Invalid or expired upload permit.', headers);
    if (request.headers.get('Content-Type') !== claims.contentType ||
        request.headers.get('Content-Length') !== String(claims.size) || !request.body) {
      return reply(400, 'Upload does not match its permit.', headers);
    }
    const path = `staging/${claims.kind}/${claims.userId}/${claims.uploadId}/${claims.variant}`;
    try {
      const object = await env.MEDIA.put(path, request.body, {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        httpMetadata: { contentType: claims.contentType }
      });
      if (!object) return reply(409, 'This upload has already been used.', headers);
      return new Response(JSON.stringify({ uploaded: true }), {
        status: 201, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    } catch (error) {
      console.error('Media staging upload failed:', error);
      return reply(502, 'The media upload could not be stored.', headers);
    }
  }
};
