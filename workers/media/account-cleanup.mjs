const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function deleteAccountMedia(bucket, userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    throw new Error('Invalid account identifier.');
  }
  if (!bucket || typeof bucket.list !== 'function' || typeof bucket.delete !== 'function') {
    throw new Error('Media storage is not configured.');
  }

  const prefixes = ['media', 'staging'].flatMap(prefix =>
    ['post', 'story'].map(kind => `${prefix}/${kind}/${userId}/`)
  );
  for (const accountPrefix of prefixes) {
    let cursor;
    const cursors = new Set();
    const seenKeys = new Set();
    do {
      const page = await bucket.list({ prefix: accountPrefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      if (!page || !Array.isArray(page.objects) || page.objects.length > 1000 || typeof page.truncated !== 'boolean') {
        throw new Error('Invalid media listing.');
      }
      const keys = page.objects.map(object => object?.key);
      if (keys.some(key => typeof key !== 'string' || !key.startsWith(accountPrefix))) {
        throw new Error('Media listing returned an unrelated object.');
      }
      for (const key of keys) {
        if (seenKeys.has(key)) throw new Error('Media listing repeated an object.');
        seenKeys.add(key);
      }
      if (page.truncated && (typeof page.cursor !== 'string' || !page.cursor || cursors.has(page.cursor))) {
        throw new Error('Media cleanup cursor did not advance.');
      }
      if (page.truncated) cursors.add(page.cursor);
      if (keys.length) await bucket.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  for (const accountPrefix of prefixes) {
    const remaining = await bucket.list({ prefix: accountPrefix, limit: 1 });
    if (!remaining || !Array.isArray(remaining.objects) || typeof remaining.truncated !== 'boolean') {
      throw new Error('Invalid media listing.');
    }
    if (remaining.objects.length || remaining.truncated) {
      throw new Error('Account media cleanup is incomplete.');
    }
  }
}
