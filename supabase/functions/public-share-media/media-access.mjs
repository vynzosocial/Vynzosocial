import { isPublicPreview } from '../vynzo-api/public-preview.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function publicMediaReference(item, owner, kind, id, type, now = Date.now()) {
  if (!UUID.test(id || '') || !['image', 'video'].includes(type) ||
      !item || item.id !== id || item.media_type !== type || !isPublicPreview(item, owner, kind, now)) return null;
  const match = /^r2:\/\/(post|story)\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i.exec(item.media_url || '');
  if (match) {
    if (match[1] !== kind || match[2] !== item.user_id || match[3] !== id || !UUID.test(match[2]) || !UUID.test(match[3])) return null;
    return { kind, userId: match[2], uploadId: id, prefix: 'media', variant: type === 'video' ? 'playback' : 'original' };
  }
  try {
    const url = new URL(item.media_url);
    const prefix = `/storage/v1/object/public/uploads/${item.user_id}/`;
    if (url.origin !== 'https://qyfphwrmwvnwsklfsbbo.supabase.co' || !url.pathname.startsWith(prefix) ||
        !/^[A-Za-z0-9._/-]+$/.test(url.pathname.slice(prefix.length)) || url.pathname.includes('..') || url.search || url.hash) return null;
    return { legacyPath: decodeURIComponent(url.pathname.slice('/storage/v1/object/public/uploads/'.length)) };
  } catch {
    return null;
  }
}

export async function readLegacyPublicMedia(bucket, path, storageOrigin, range, fetchMedia = fetch) {
  const { data, error } = await bucket.createSignedUrl(path, 60);
  if (error) throw error;
  if (!data || typeof data.signedUrl !== 'string') throw new Error('Storage did not return a signed media URL.');
  const signedUrl = new URL(data.signedUrl);
  if (signedUrl.origin !== new URL(storageOrigin).origin ||
      !signedUrl.pathname.startsWith('/storage/v1/object/sign/uploads/')) {
    throw new Error('Storage returned an invalid signed media URL.');
  }
  return fetchMedia(signedUrl.href, { redirect: 'manual', headers: range ? { Range: range } : {} });
}
