export function isPublicPreview(item, owner, kind, now = Date.now()) {
  if (!item || !owner || item.is_protected || (item.privacy || 'everyone') !== 'everyone') return false;
  if (kind === 'post') return (owner.posts_privacy || 'everyone') === 'everyone';
  return kind === 'story' && !owner.is_private && Number.isFinite(Date.parse(item.expires_at)) && Date.parse(item.expires_at) > now;
}
