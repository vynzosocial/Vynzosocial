export function createAccountLifecycleRepository(admin) {
  return {
    async issueCode(userId, codeHash, expiresAt) {
      const { data, error } = await admin.rpc('issue_account_deletion_otp', {
        p_user_id: userId,
        p_code_hash: codeHash,
        p_expires_at: expiresAt
      });
      if (error) throw error;
      if (typeof data !== 'boolean') throw new Error('Invalid account deletion response.');
      return data;
    },
    async beginDeletion(userId, codeHash) {
      const { data, error } = await admin.rpc('begin_account_deletion', {
        p_user_id: userId,
        p_code_hash: codeHash
      });
      if (error) throw error;
      if (typeof data !== 'boolean') throw new Error('Invalid account deletion response.');
      return data;
    },
    async recordTombstone(userId) {
      const { error } = await admin.from('account_deletion_tombstones')
        .upsert({ user_id: userId }, { onConflict: 'user_id' });
      if (error) throw error;
    },
    async beginDeactivation(userId) {
      const { data, error } = await admin.rpc('begin_account_deactivation', { p_user_id: userId });
      if (error) throw error;
      if (typeof data !== 'boolean') throw new Error('Invalid account lifecycle transition response.');
      return data;
    },
    async finishDeactivation(userId) {
      const { data, error } = await admin.from('account_lifecycle')
        .update({ state: 'deactivated', state_changed_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('state', 'deactivating')
        .select('user_id')
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
    async replaceTokenForDeactivatedAccount(userId, tokenHash, expiresAt) {
      const { data, error } = await admin.from('account_lifecycle')
        .update({ activation_token_hash: tokenHash, activation_expires_at: expiresAt })
        .eq('user_id', userId)
        .eq('state', 'deactivated')
        .select('user_id')
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
    async consumeTokenAndActivate(tokenHash, now) {
      const { data, error } = await admin.from('account_lifecycle')
        .delete()
        .eq('state', 'deactivated')
        .eq('activation_token_hash', tokenHash)
        .gt('activation_expires_at', now)
        .select('user_id')
        .maybeSingle();
      if (error) throw error;
      return Boolean(data);
    }
  };
}
