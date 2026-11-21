const MAX_BYTES = 50 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const encoder = new TextEncoder();

export class UploadValidationError extends Error {}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createUploadPermits({ userId, kind, original, playback, cover, secret, now = Math.floor(Date.now() / 1000) }) {
  if (!UUID.test(userId) || !['post', 'story'].includes(kind)) throw new UploadValidationError('Invalid upload owner or kind.');
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Media upload signing is not configured.');
  const isImage = IMAGE_TYPES.has(original?.contentType);
  const isVideo = VIDEO_TYPES.has(original?.contentType);
  const validSize = file => Number.isSafeInteger(file?.size) && file.size > 0 && file.size <= MAX_BYTES;
  if ((!isImage && !isVideo) || !validSize(original) ||
      (isImage && playback != null) ||
      (cover != null && (!validSize(cover) || cover.size > 2 * 1024 * 1024 ||
        cover.contentType !== (isVideo ? 'image/webp' : 'image/jpeg'))) ||
      (isVideo && (!validSize(playback) || playback.contentType !== 'video/mp4' || !cover))) {
    throw new UploadValidationError('Choose a supported image or video up to 50 MB. Videos require an MP4 playback copy and WebP cover.');
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const uploadId = crypto.randomUUID();
  const expires = now + 15 * 60;
  const files = isVideo ? [['original', original], ['playback', playback]] : [['original', original]];
  if (cover) files.push(['cover', cover]);
  const permits = {};
  for (const [variant, file] of files) {
    const claims = { userId, uploadId, kind, variant, contentType: file.contentType, size: file.size, expires };
    const payload = base64Url(encoder.encode(JSON.stringify(claims)));
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    permits[variant] = `${payload}.${base64Url(new Uint8Array(signature))}`;
  }
  return { uploadId, expires, permits };
}

export async function createDeliveryPermit({ viewerId, itemId, userId, uploadId, kind, variant, secret, storage = '', now = Math.floor(Date.now() / 1000) }) {
  if (![viewerId, itemId, userId, uploadId].every(value => UUID.test(value)) ||
      !['post', 'story'].includes(kind) || !['original', 'playback', 'cover'].includes(variant) ||
      (storage === 'legacy' && variant === 'cover') ||
      (storage !== '' && storage !== 'legacy')) {
    throw new UploadValidationError('Invalid media reference.');
  }
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Media delivery signing is not configured.');
  const claims = { viewerId, itemId, userId, uploadId, kind, variant, ...(storage ? { storage } : {}), expires: now + 60 * 60 };
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

export async function createLegacyFileDeliveryPermit({ viewerId, userId, path, scope, resourceId, secret, now = Math.floor(Date.now() / 1000) }) {
  const ownedPath = typeof path === 'string' && (
    scope === 'avatar' && (!path.includes('/') || path.startsWith(`${userId}/`)) ||
    scope === 'blog' && path.startsWith(`blogs/${userId}/`) ||
    scope === 'blog-upload' && viewerId === userId && path.startsWith(`blogs/${userId}/`) ||
    scope === 'message' && (path.startsWith(`${userId}/messages/`) ||
      !path.includes('/') && UUID.test(resourceId || ''))
  );
  if (![viewerId, userId].every(value => typeof value === 'string' && UUID.test(value)) ||
      typeof path !== 'string' || path.length > 1024 || path.startsWith('/') ||
      path.includes('\\') || path.includes('\0') ||
      path.split('/').some(part => !part || part === '.' || part === '..') ||
      !ownedPath ||
      (resourceId !== undefined && (typeof resourceId !== 'string' || !UUID.test(resourceId)))) {
    throw new UploadValidationError('Invalid legacy media reference.');
  }
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Media delivery is not configured.');
  const claims = {
    viewerId,
    itemId: resourceId || userId,
    userId,
    uploadId: userId,
    kind: 'file',
    variant: 'playback',
    storage: 'legacy-file',
    path,
    scope,
    resourceId: resourceId || userId,
    expires: now + 5 * 60
  };
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}
