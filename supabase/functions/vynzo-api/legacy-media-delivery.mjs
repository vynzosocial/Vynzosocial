const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']);
const FILE_TYPES = new Set([...TYPES, 'audio/mp4', 'audio/webm', 'audio/ogg']);

export function legacyStoragePath(value, storageOrigin) {
  if (typeof value !== 'string') return null;
  let encoded;
  if (value.startsWith('/uploads/')) {
    encoded = value.slice('/uploads/'.length).split(/[?#]/, 1)[0];
  } else {
    let url;
    try { url = new URL(value); } catch { return null; }
    const prefix = '/storage/v1/object/public/uploads/';
    if (url.origin !== storageOrigin || !url.pathname.startsWith(prefix) || url.search || url.hash) return null;
    encoded = url.pathname.slice(prefix.length);
  }
  let path;
  try { path = decodeURIComponent(encoded); } catch { return null; }
  if (!path || path.includes('\\') || path.includes('\0') ||
      path.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return path;
}

export async function readAuthorizedLegacyMedia({ claims, range, origin, bucket, getPostContext, getStoryContext, fetchMedia = fetch }) {
  if (claims?.storage !== 'legacy' || claims.variant !== 'playback' ||
      !['post', 'story'].includes(claims.kind) ||
      ![claims.itemId, claims.viewerId, claims.userId, claims.uploadId].every(value => typeof value === 'string' && UUID.test(value)) ||
      claims.itemId !== claims.uploadId) {
    return { status: 400 };
  }
  const context = claims.kind === 'post'
    ? await getPostContext(claims.itemId, claims.viewerId)
    : await getStoryContext(claims.itemId, claims.viewerId);
  const item = context && (claims.kind === 'post' ? context.post : context.story);
  if (!item || item.id !== claims.itemId || item.user_id !== claims.userId) return { status: 403 };
  const path = legacyStoragePath(item.media_url, origin);
  if (!path || (path.includes('/') && !path.startsWith(`${item.user_id}/`))) return { status: 403 };
  const { data, error } = await bucket.createSignedUrl(path, 60);
  if (error) throw error;
  if (!data || typeof data.signedUrl !== 'string') throw new Error('Storage did not return a signed URL.');
  const target = new URL(data.signedUrl);
  if (target.origin !== origin || !target.pathname.startsWith('/storage/v1/object/sign/uploads/')) {
    throw new Error('Storage returned an invalid signed URL.');
  }
  const response = await fetchMedia(target.href, { redirect: 'manual', headers: range ? { Range: range } : {} });
  if (response.status === 404) return { status: 404 };
  if (response.status === 416) return { status: 416, response };
  if (![200, 206].includes(response.status)) throw new Error(`Storage media request failed (HTTP ${response.status}).`);
  const type = response.headers.get('Content-Type');
  if (!TYPES.has(type) || !['image', 'video'].includes(item.media_type) || !type.startsWith(`${item.media_type}/`)) {
    throw new Error('Storage returned an unsupported media type.');
  }
  return { status: response.status, response };
}

export async function readAuthorizedLegacyFile({ claims, range, origin, bucket, authorize, fetchMedia = fetch }) {
  const validIds = [claims?.itemId, claims?.viewerId, claims?.userId, claims?.uploadId]
    .every(value => typeof value === 'string' && UUID.test(value));
  const path = claims?.path;
  const safePath = typeof path === 'string' && path.length > 0 && path.length <= 1024 &&
    !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(part => part && part !== '.' && part !== '..');
  const ownedPath = safePath && (
    claims.scope === 'blog' && path.startsWith(`blogs/${claims.userId}/`) ||
    claims.scope === 'blog-upload' && claims.viewerId === claims.userId && path.startsWith(`blogs/${claims.userId}/`) ||
    claims.scope === 'message' && (path.startsWith(`${claims.userId}/messages/`) ||
      !path.includes('/') && UUID.test(claims.resourceId || '')) ||
    claims.scope === 'avatar' && (!path.includes('/') || path.startsWith(`${claims.userId}/`))
  );
  if (claims?.storage !== 'legacy-file' || claims.kind !== 'file' ||
      claims.variant !== 'playback' || !validIds || claims.uploadId !== claims.userId ||
      !['avatar', 'blog', 'blog-upload', 'message'].includes(claims.scope) || !ownedPath ||
      (claims.resourceId !== undefined && (typeof claims.resourceId !== 'string' || !UUID.test(claims.resourceId)))) {
    return { status: 400 };
  }
  if (!await authorize(claims)) return { status: 403 };
  const { data, error } = await bucket.createSignedUrl(path, 60);
  if (error) throw error;
  if (!data || typeof data.signedUrl !== 'string') throw new Error('Storage did not return a signed URL.');
  const target = new URL(data.signedUrl);
  if (target.origin !== new URL(origin).origin ||
      !target.pathname.startsWith('/storage/v1/object/sign/uploads/')) {
    throw new Error('Storage returned an invalid signed URL.');
  }
  const response = await fetchMedia(target.href, {
    redirect: 'manual',
    headers: range ? { Range: range } : {}
  });
  if (response.status === 404) return { status: 404 };
  if (response.status === 416) return { status: 416, response };
  if (![200, 206].includes(response.status)) {
    throw new Error(`Storage media request failed (HTTP ${response.status}).`);
  }
  const type = response.headers.get('Content-Type');
  if (!FILE_TYPES.has(type)) throw new Error('Storage returned an unsupported media type.');
  if (claims.scope === 'avatar' && !type.startsWith('image/')) {
    throw new Error('Storage returned an unsupported avatar media type.');
  }
  return { status: response.status, response };
}
