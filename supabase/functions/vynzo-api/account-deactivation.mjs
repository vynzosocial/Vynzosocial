import { usableActivationEmail } from './account-reactivation.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function deactivateAccount({ user, password, verifyPassword, repository, revokeSessions }) {
  if (!user || typeof user.id !== 'string' || !UUID.test(user.id)) throw new Error('Invalid authenticated account.');
  if (!usableActivationEmail(user)) return { status: 'verified_email_required' };
  if (typeof password !== 'string' || !password) return { status: 'password_required' };
  const verified = await verifyPassword(user.email, password);
  if (!verified || verified.id !== user.id) return { status: 'invalid_password' };
  if (!await repository.beginDeactivation(user.id)) return { status: 'account_unavailable' };
  await revokeSessions(user.id);
  if (!await repository.finishDeactivation(user.id)) throw new Error('Could not complete account deactivation.');
  return { status: 'deactivated' };
}
