const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function authorizeMediaClaims(claims, getPostContext, getStoryContext) {
  if (!['post', 'story'].includes(claims?.kind) || !['original', 'playback'].includes(claims?.variant) ||
      ![claims?.itemId, claims?.viewerId, claims?.userId, claims?.uploadId]
        .every(value => typeof value === 'string' && UUID.test(value))) {
    return { valid: false, allowed: false };
  }
  const context = claims.kind === 'post'
    ? await getPostContext(claims.itemId, claims.viewerId)
    : await getStoryContext(claims.itemId, claims.viewerId);
  const item = context && ('post' in context ? context.post : context.story);
  const expectedUrl = `r2://${claims.kind}/${claims.userId}/${claims.uploadId}`;
  if (!item || item.user_id !== claims.userId || item.media_url !== expectedUrl ||
      (claims.variant === 'original' && claims.viewerId !== item.user_id)) {
    return { valid: true, allowed: false };
  }
  return {
    valid: true,
    allowed: true,
    objectVariant: claims.variant === 'playback' && item.media_type === 'image' ? 'original' : claims.variant
  };
}
