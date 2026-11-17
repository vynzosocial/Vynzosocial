import { legacyStoragePath } from './legacy-media-delivery.mjs';
import { createDeliveryPermit, createLegacyFileDeliveryPermit } from './media-permits.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ownerForPath(path, context) {
  const parts = path.split('/');
  if (parts[0] === 'blogs' && UUID.test(parts[1] || '')) return parts[1];
  if (UUID.test(parts[0] || '')) return parts[0];
  return UUID.test(context.userId || '') ? context.userId : null;
}

function mediaContext(value, parent, key, routeKind) {
  const context = { ...parent };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (key === 'avatar_url' || key === 'author_avatar_url' || key.endsWith('_avatar_url')) {
      context.scope = 'avatar';
    } else if (['cover_url', 'content_html'].includes(key)) {
      context.scope = 'blog';
    } else if (key === 'media_url') {
      context.scope = 'message';
    }
    return context;
  }
  if (typeof value.id === 'string' && UUID.test(value.id)) context.itemId = value.id;
  if (typeof value.user_id === 'string' && UUID.test(value.user_id)) context.userId = value.user_id;
  if (typeof value.id === 'string' && UUID.test(value.id) && value.avatar_url && !value.user_id && !value.sender_id) context.userId = value.id;
  if (typeof value.author_id === 'string' && UUID.test(value.author_id)) {
    context.userId = value.author_id;
    context.scope = 'blog';
  }
  if (typeof value.sender_id === 'string' && UUID.test(value.sender_id)) context.userId = value.sender_id;
  if (typeof value.conversation_id === 'string' && UUID.test(value.conversation_id)) {
    context.conversationId = value.conversation_id;
  }
  if (key === 'avatar_url' || key.endsWith('_avatar_url')) {
    const avatarOwner = key === 'other_avatar_url' ? value.other_user_id
      : key === 'host_avatar_url' ? value.host_id
      : key === 'author_avatar_url' ? value.author_id || value.user_id
      : value.sender_id || value.actor_id || value.user_id || value.id;
    if (UUID.test(avatarOwner || '')) context.avatarUserId = avatarOwner;
  }
  if (value.actor_id && UUID.test(value.target_id || '') && ['image', 'video', 'story', 'blog'].includes(value.kind)) {
    context.itemId = value.target_id;
    context.kind = value.kind === 'story' ? 'story' : 'post';
    context.scope = value.kind === 'blog' ? 'blog' : 'post';
    return context;
  }
  if (value.id && value.sender_id && value.conversation_id) {
    context.scope = 'message';
    context.itemId = value.id;
  } else if (value.expires_at !== undefined && value.media_url) {
    context.kind = 'story';
    context.scope = 'post';
  } else if (value.user_id && value.media_type && value.media_url) {
    context.kind = 'post';
    context.scope = 'post';
  } else if (value.content_html !== undefined || value.cover_url !== undefined) {
    context.scope = 'blog';
  } else if (key === 'author' || value.avatar_url) {
    context.scope = context.scope || 'avatar';
  } else if (routeKind) {
    context.kind = routeKind;
    context.scope = 'post';
  }
  return context;
}

export async function rewriteLegacyMediaResponse({
  response,
  request,
  viewerId,
  enabled,
  storageOrigin,
  workerUrl,
  secret,
  now = Math.floor(Date.now() / 1000)
}) {
  if (!enabled || !viewerId || !response.headers.get('Content-Type')?.toLowerCase().includes('application/json')) {
    return response;
  }
  const body = await response.clone().json();
  if (!JSON.stringify(body).includes('/uploads/')) return response;
  if (!workerUrl || !secret) throw new Error('Legacy media delivery is not configured.');

  const routeParts = new URL(request.url).pathname.split('/').filter(Boolean);
  const routeKind = routeParts.includes('stories') ? 'story'
    : routeParts.includes('posts') ? 'post'
    : null;
  const cache = new Map();
  const workerOrigin = new URL(workerUrl);

  async function replaceUrl(value, context, key) {
    const path = legacyStoragePath(value, storageOrigin);
    if (!path) return value;
    const avatarKey = key === 'avatar_url' || key.endsWith('_avatar_url');
    const userId = ownerForPath(path, avatarKey && context.avatarUserId ? { ...context, userId: context.avatarUserId } : context);
    const kind = context.kind;
    const itemId = context.itemId;
    const scope = avatarKey ? 'avatar'
      : path.startsWith('blogs/') ? (UUID.test(context.itemId || '') ? 'blog' : 'blog-upload')
      : path.includes('/messages/') ? 'message'
      : context.scope === 'avatar' || /(^|\/)avatars?\//i.test(path) ? 'avatar'
      : context.scope;

    if (!userId || !UUID.test(userId)) {
      throw new Error('A legacy media URL has no verifiable owner.');
    }
    let permit;
    if (!avatarKey && scope === 'post' && ['post', 'story'].includes(kind) && UUID.test(itemId || '')) {
      const cacheKey = `post:${kind}:${itemId}:${userId}`;
      permit = cache.get(cacheKey);
      if (!permit) {
        permit = await createDeliveryPermit({
          viewerId,
          itemId,
          userId,
          uploadId: itemId,
          kind,
          variant: 'playback',
          storage: 'legacy',
          secret,
          now
        });
        cache.set(cacheKey, permit);
      }
    } else if (['avatar', 'blog', 'blog-upload', 'message'].includes(scope)) {
      const resourceId = ['avatar', 'blog-upload'].includes(scope) ? userId
        : (scope === 'message' ? itemId : context.itemId);
      if (!UUID.test(resourceId || '')) throw new Error('A legacy media URL has no verifiable resource.');
      const cacheKey = `${scope}:${resourceId}:${userId}:${path}`;
      permit = cache.get(cacheKey);
      if (!permit) {
        permit = await createLegacyFileDeliveryPermit({
          viewerId,
          userId,
          path,
          scope,
          resourceId,
          secret,
          now
        });
        cache.set(cacheKey, permit);
      }
    } else {
      throw new Error(`Unsupported legacy media reference in ${key || 'response'}.`);
    }
    const proxy = new URL('/media', workerOrigin);
    proxy.searchParams.set('permit', permit);
    return proxy.toString();
  }

  async function transform(value, context = {}, key = '') {
    if (typeof value === 'string') {
      if (context.scope === 'message' && ['content', 'text'].includes(key)) return value;
      const direct = legacyStoragePath(value, storageOrigin);
      if (direct) return await replaceUrl(value, context, key);
      return await replaceEmbeddedUrls(value, context, key);
    }
    if (Array.isArray(value)) {
      return await Promise.all(value.map(item => transform(item, context, key)));
    }
    if (!value || typeof value !== 'object') return value;
    const next = mediaContext(value, context, key, routeKind);
    const entries = await Promise.all(Object.entries(value).map(async ([name, child]) => [
      name,
      await transform(child, mediaContext(value, next, name, routeKind), name)
    ]));
    return Object.fromEntries(entries);
  }

  async function replaceEmbeddedUrls(value, context, key) {
    const matcher = new RegExp(
      `(?:${storageOrigin.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/storage/v1/object/public/uploads/|/uploads/)[A-Za-z0-9%._~!$&'()*+,;=:@/-]+`,
      'g'
    );
    const matches = [...value.matchAll(matcher)];
    if (!matches.length) return value;
    let output = '';
    let offset = 0;
    for (const match of matches) {
      output += value.slice(offset, match.index);
      output += await replaceUrl(match[0], context, key);
      offset = match.index + match[0].length;
    }
    return output + value.slice(offset);
  }

  const transformed = await transform(body, routeParts.includes('activity') ? { userId: viewerId } : {});
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(transformed), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
