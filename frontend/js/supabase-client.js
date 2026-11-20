import { createClient } from './vendor/supabase-js-2.91.0.js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';
import { syncPushSession, unregisterPush } from './native-push.mjs';

const isConfigured = SUPABASE_PUBLISHABLE_KEY !== '__VYNZO_SUPABASE_PUBLISHABLE_KEY__';

if (typeof window !== 'undefined' && window.location.hash.includes('access_token=')) {
  const confirmedSession = new URLSearchParams(window.location.hash.slice(1));
  localStorage.setItem('vynzo_supabase_confirmation_pending', confirmedSession.get('access_token') || 'true');
}

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true
    }
  })
  : null;

export function requireSupabase() {
  if (!supabase) {
    throw new Error('Supabase is not configured for this site. Set the VYNZO_SUPABASE_PUBLISHABLE_KEY build secret and redeploy.');
  }
  return supabase;
}

export function syncLegacySession(session) {
  if (!session) {
    localStorage.removeItem('vynzo_token');
    localStorage.removeItem('vynzo_user');
    return;
  }

  const metadata = session.user.user_metadata || {};
  localStorage.setItem('vynzo_token', session.access_token);
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem('vynzo_user') || '{}'); } catch { stored = {}; }
  if (stored.id !== session.user.id) stored = {};
  localStorage.setItem('vynzo_user', JSON.stringify({
    ...stored,
    id: session.user.id,
    username: stored.username || metadata.username || '',
    email: session.user.email || '',
    display_name: stored.display_name || metadata.display_name || metadata.username || '',
    avatar_url: stored.avatar_url || metadata.avatar_url || null
  }));
}

export async function signOutSupabase({ scope = 'global', unregister = true } = {}) {
  if (supabase) {
    const { data, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    if (unregister) await unregisterPush(data.session);
    const { error } = await supabase.auth.signOut({ scope });
    if (error) throw error;
  }
  syncLegacySession(null);
}

export async function restoreSupabaseSession() {
  if (!supabase) return;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (data.session) syncLegacySession(data.session);
  void syncPushSession(data.session).catch(error => {
    console.error('Could not synchronize notification device:', error);
  });
}

if (supabase) {
  supabase.auth.onAuthStateChange((event, session) => {
    if (session) {
      syncLegacySession(session);
      if (event === 'SIGNED_IN' && localStorage.getItem('vynzo_supabase_confirmation_pending')) {
        localStorage.removeItem('vynzo_supabase_confirmation_pending');
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      }
    } else if (event === 'SIGNED_OUT') syncLegacySession(null);
    window.setTimeout(() => {
      syncPushSession(session).catch(error => console.error('Could not synchronize notification device:', error));
    }, 0);
  });
}
