import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.91.0/+esm';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';

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
  localStorage.setItem('vynzo_user', JSON.stringify({
    id: session.user.id,
    username: metadata.username || '',
    email: session.user.email || '',
    display_name: metadata.display_name || metadata.username || '',
    avatar_url: metadata.avatar_url || null
  }));
}

export async function signOutSupabase() {
  if (supabase) {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }
  syncLegacySession(null);
}

export async function restoreSupabaseSession() {
  if (!supabase) return;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (data.session) syncLegacySession(data.session);
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
  });
}
