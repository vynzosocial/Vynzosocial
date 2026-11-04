// The app uses Supabase only. There is no separate backend server.
export const API_ORIGIN = '';
export const API_BASE_URL = '';

// Realtime (live rooms, calls, instant message push) was served by the removed
// backend. This inert socket keeps those screens from crashing until they are
// rebuilt on Supabase Realtime.
export function createOfflineSocket() {
  const socket = {
    connected: false,
    active: false,
    id: 'offline',
    on: () => socket,
    off: () => socket,
    emit: () => socket,
    connect: () => socket,
    disconnect: () => socket
  };
  return socket;
}
