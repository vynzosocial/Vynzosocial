import { legacyStoragePath } from './legacy-media-delivery.mjs';
import { UploadValidationError } from './media-permits.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export async function restoreBlogMediaReferences(value, { viewerId, workerUrl, storageOrigin, secret }) {
  if (typeof value !== 'string' || !value.includes('/media?permit=')) return value;
  if (!workerUrl || !secret || secret.length < 32) throw new Error('Legacy blog media is not configured.');
  const workerOrigin = new URL(workerUrl).origin;
  const matches = [...value.matchAll(/https:\/\/[^\s"'<>]+\/media\?permit=[A-Za-z0-9_.-]+/g)];
  let restored = value;
  for (const [url] of matches) {
    const target = new URL(url);
    if (target.origin !== workerOrigin) continue;
    const token = target.searchParams.get('permit') || '';
    const parts = token.split('.');
    let claims, signature;
    try {
      if (parts.length !== 2) throw new Error('Invalid token.');
      const decode = part => Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
      claims = JSON.parse(new TextDecoder().decode(decode(parts[0])));
      signature = decode(parts[1]);
    } catch {
      throw new UploadValidationError('Invalid blog media reference.');
    }
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, signature, encoder.encode(parts[0])) ||
        claims.viewerId !== viewerId || !UUID.test(claims.userId || '') ||
        claims.storage !== 'legacy-file' || !['blog', 'blog-upload'].includes(claims.scope) ||
        typeof claims.path !== 'string' || !claims.path.startsWith(`blogs/${claims.userId}/`) ||
        legacyStoragePath(`/uploads/${claims.path}`, storageOrigin) !== claims.path) {
      throw new UploadValidationError('Invalid blog media reference.');
    }
    // Saving a reference grants no read access, so an editor may outlive its delivery permit.
    const canonical = `${storageOrigin}/storage/v1/object/public/uploads/${claims.path.split('/').map(encodeURIComponent).join('/')}`;
    restored = restored.replaceAll(url, canonical);
  }
  return restored;
}

export async function privateBlogImages(admin, values, storageOrigin) {
  return await Promise.all(values.map(async value => {
    const path = legacyStoragePath(value, storageOrigin);
    if (!path) return value;
    const { data, error } = await admin.storage.from('uploads').download(path);
    if (error) throw error;
    if (!data || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(data.type)) {
      throw new Error('Blog moderation image is unavailable or has an invalid type.');
    }
    let binary = '';
    for (const byte of new Uint8Array(await data.arrayBuffer())) binary += String.fromCharCode(byte);
    return `data:${data.type};base64,${btoa(binary)}`;
  }));
}
