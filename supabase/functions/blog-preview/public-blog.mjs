const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_STORAGE_ORIGIN = 'https://qyfphwrmwvnwsklfsbbo.supabase.co';

export function publicBlogMediaPath(value, authorId, storageOrigin = DEFAULT_STORAGE_ORIGIN) {
  if (typeof authorId !== 'string' || !UUID.test(authorId)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const prefix = '/storage/v1/object/public/uploads/';
  if (url.origin !== storageOrigin || !url.pathname.startsWith(prefix) || url.search || url.hash) return null;
  let path;
  try {
    path = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return null;
  }
  return path.startsWith(`blogs/${authorId}/`) &&
      /^[A-Za-z0-9._/-]+$/.test(path) && !path.includes('..') &&
      !path.includes('//')
    ? path
    : null;
}

export function publicBlogMediaPaths(article, storageOrigin = DEFAULT_STORAGE_ORIGIN) {
  if (!article || typeof article.author_id !== 'string' || !UUID.test(article.author_id)) return [];
  const values = [
    article.cover_url,
    ...[...String(article.content_html || '').matchAll(/<(?:img|video)\b[^>]*\bsrc="([^"]+)"/gi)]
      .map(match => match[1])
  ];
  return [...new Set(values.map(value => publicBlogMediaPath(value, article.author_id, storageOrigin)).filter(Boolean))];
}

export function rewritePublicBlogMedia(html, article, storageOrigin, endpoint) {
  return String(html).replace(/(<(?:img|video)\b[^>]*\bsrc=")([^"]+)(")/gi, (whole, before, value, after) => {
    const path = publicBlogMediaPath(value, article.author_id, storageOrigin);
    if (!path) return whole;
    const target = new URL(endpoint);
    target.searchParams.set('id', article.id);
    target.searchParams.set('image', '1');
    target.searchParams.set('asset', path);
    return `${before}${target.toString().replace(/&/g, '&amp;')}${after}`;
  });
}

export function publicBlogPreview(article, owner, storageOrigin = DEFAULT_STORAGE_ORIGIN) {
  if (!article || article.status !== 'published' || !owner || owner.is_private !== false) return null;
  const coverPath = publicBlogMediaPath(article.cover_url, article.author_id, storageOrigin);
  return { title: article.title, coverPath, mediaPaths: publicBlogMediaPaths(article, storageOrigin) };
}
