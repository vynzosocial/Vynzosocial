const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 100;

async function collectObjects(bucket, root) {
  const paths = [];
  const pending = [root];
  while (pending.length) {
    const folder = pending.pop();
    let offset = 0;
    const seen = new Set();
    for (;;) {
      const { data, error } = await bucket.list(folder, {
        limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' }
      });
      if (error) throw error;
      if (!Array.isArray(data) || data.length > PAGE_SIZE) throw new Error('Invalid storage listing.');
      for (const item of data) {
        if (!item || typeof item.name !== 'string' || !item.name || item.name === '.' || item.name === '..' ||
            item.name.includes('/') || item.name.includes('\\')) {
          throw new Error('Invalid storage object name.');
        }
        const path = `${folder}/${item.name}`;
        const type = item.id === null ? 'folder' : typeof item.id === 'string' && item.id ? 'object' : null;
        if (!type) throw new Error('Invalid storage listing entry.');
        const key = `${type}:${item.name}`;
        if (seen.has(key)) throw new Error('Storage listing repeated an entry.');
        seen.add(key);
        if (type === 'folder') pending.push(path);
        else paths.push(path);
      }
      if (data.length < PAGE_SIZE) break;
      offset += data.length;
    }
  }
  return paths;
}

export async function deleteAccountStorage(storage, userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new Error('Invalid account identifier.');
  const groups = [
    { bucket: storage.from('uploads'), roots: [userId, `blogs/${userId}`] },
    { bucket: storage.from('view-once'), roots: [userId] }
  ];
  for (const { bucket, roots } of groups) {
    for (const root of roots) {
      const paths = await collectObjects(bucket, root);
      for (let index = 0; index < paths.length; index += PAGE_SIZE) {
        const { error } = await bucket.remove(paths.slice(index, index + PAGE_SIZE));
        if (error) throw error;
      }
    }
  }
  for (const { bucket, roots } of groups) {
    for (const root of roots) {
      if ((await collectObjects(bucket, root)).length) {
        throw new Error('Account storage cleanup is incomplete.');
      }
    }
  }
}
