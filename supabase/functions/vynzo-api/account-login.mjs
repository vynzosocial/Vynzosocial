import { issueReactivation } from './account-reactivation.mjs';

export async function currentLoginEmail(userId, getUser) {
  const user = await getUser(userId);
  if (!user || user.id !== userId) throw new Error('Authentication account lookup returned an invalid user.');
  return typeof user.email === 'string' && user.email ? user.email : null;
}

export async function verifyLoginIdentity(signedIn, expectedUserId, signOut) {
  if (!expectedUserId) return true;
  if (signedIn.user?.id === expectedUserId && signedIn.session?.user?.id === expectedUserId) return true;
  await signOut();
  return false;
}

export async function resolveAccountLogin({ signedIn, getState, signOut, repository, sendEmail }) {
  const { session, user } = signedIn;
  if (!session || !user || session.user?.id !== user.id) {
    const error = new Error('Invalid authenticated session.');
    if (session) {
      try {
        await signOut();
      } catch (signOutError) {
        throw new AggregateError([error, signOutError], 'Invalid session and session revocation failed.');
      }
    }
    throw error;
  }
  let state;
  try {
    state = await getState(user.id);
  } catch (error) {
    try {
      await signOut();
    } catch (signOutError) {
      throw new AggregateError([error, signOutError], 'Account status check and session revocation failed.');
    }
    throw error;
  }
  if (state === null) return { status: 'active', session };
  await signOut();
  if (state === 'deleting') return { status: 'deleting' };
  if (state === 'deactivating') return { status: 'deactivating' };
  if (state !== 'deactivated') throw new Error('Unknown account lifecycle state.');
  await issueReactivation({ user, repository, sendEmail });
  return { status: 'activation_sent' };
}
