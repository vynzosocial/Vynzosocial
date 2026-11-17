export async function accountIsActive(admin, userId) {
  const { data: deleted, error: deletionError } = await admin.from('account_deletion_tombstones')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (deletionError) throw deletionError;
  if (deleted !== null) return false;

  const { data, error } = await admin.from('account_lifecycle')
    .select('state')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data === null;
}

export async function inactiveAccountIds(admin, userIds) {
  const ids = [...new Set(userIds)];
  const inactive = new Set();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const { data, error } = await admin.from('account_lifecycle')
      .select('user_id')
      .in('user_id', batch);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Invalid account lifecycle response.');
    const requested = new Set(batch);
    for (const row of data) {
      if (!row || !requested.has(row.user_id)) throw new Error('Invalid account lifecycle entry.');
      inactive.add(row.user_id);
    }
  }
  return inactive;
}
