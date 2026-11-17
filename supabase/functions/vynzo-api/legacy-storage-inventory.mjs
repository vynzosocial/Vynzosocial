const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function legacyRootPath(value, storageOrigin) {
  if (typeof value !== 'string' || !value) return null;
  let encodedPath;
  if (value.startsWith('/uploads/')) {
    encodedPath = value.slice('/uploads/'.length).split(/[?#]/, 1)[0];
  } else {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const prefix = '/storage/v1/object/public/uploads/';
    if (url.origin !== storageOrigin || !url.pathname.startsWith(prefix)) return null;
    encodedPath = url.pathname.slice(prefix.length);
  }
  let path;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    throw new Error('Invalid legacy storage path.');
  }
  if (!path || path === '.' || path === '..' || path.includes('/') || path.includes('\\') || path.includes('\0')) {
    return null;
  }
  return path;
}

// Callers must supply every relevant owner's references, not just the deleting account's.
export function inventoryLegacyRootMedia({ userId, storageOrigin, references }) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new Error('Invalid account identifier.');
  let origin;
  try {
    const url = new URL(storageOrigin);
    if (url.origin !== storageOrigin || url.protocol !== 'https:') throw new Error();
    origin = url.origin;
  } catch {
    throw new Error('Invalid storage origin.');
  }
  if (!Array.isArray(references)) throw new Error('Invalid media reference inventory.');

  const ownersByPath = new Map();
  for (const reference of references) {
    if (!reference || typeof reference.ownerId !== 'string' || !UUID.test(reference.ownerId) ||
        typeof reference.url !== 'string') {
      throw new Error('Invalid media reference.');
    }
    const path = legacyRootPath(reference.url, origin);
    if (!path) continue;
    const owners = ownersByPath.get(path) || new Set();
    owners.add(reference.ownerId.toLowerCase());
    ownersByPath.set(path, owners);
  }
  const exclusive = [];
  const shared = [];
  for (const [path, owners] of ownersByPath) {
    if (!owners.has(userId.toLowerCase())) continue;
    (owners.size === 1 ? exclusive : shared).push(path);
  }
  return { exclusive: exclusive.sort(), shared: shared.sort() };
}
