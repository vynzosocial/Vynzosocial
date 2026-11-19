import { createPushLifecycle } from './push-lifecycle.mjs';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';
import { PUSH_NOTIFICATIONS_ENABLED } from './push-config.mjs';

const capacitor = window.Capacitor;
const plugin = PUSH_NOTIFICATIONS_ENABLED && capacitor?.isNativePlatform?.() ? capacitor.Plugins?.VynzoPush : null;
let lifecycle;
let started;
let unreadSyncUnavailable = false;

if (plugin) {
  lifecycle = createPushLifecycle({
    plugin,
    async request(method, token, device) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/vynzo-api/api/push/device`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: SUPABASE_PUBLISHABLE_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            deviceId: device.deviceId,
            deviceSecret: device.deviceSecret,
            ...(method === 'POST' ? { installationId: device.installationId } : {})
          }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Notification registration failed (HTTP ${response.status}).`);
      } finally {
        clearTimeout(timer);
      }
    },
    async onOpen(event) {
      const pages = window.location.pathname.includes('/pages/') ? '' : 'pages/';
      if (event.type === 'message') {
        window.location.href = `${pages}messages.html?conversationId=${encodeURIComponent(event.id)}`;
      } else if (event.type === 'live_started') {
        window.location.href = `${pages}live.html?sessionId=${encodeURIComponent(event.id)}`;
      } else if (event.type === 'voice_call' || event.type === 'video_call') {
        try {
          const { openCallNotification } = await import('./calls.js?v=audio1');
          await openCallNotification(event.id);
        } catch (error) {
          console.error('Could not open call notification:', error);
          window.alert('Could not open the call. Please try again.');
        }
      }
    },
    reportError(error) { console.error('Notification device setup failed:', error); }
  });
  started = lifecycle.start();
  started.catch(error => console.error('Could not initialize Android notifications:', error));
}

export async function syncPushSession(session) {
  if (!lifecycle) return;
  await started;
  await lifecycle.setSession(session);
}

export async function unregisterPush(session) {
  if (!lifecycle) return;
  await started;
  await lifecycle.unregister(session);
}

export async function enableNativePush() {
  if (!lifecycle) throw new Error('Android notifications are unavailable.');
  await started;
  await lifecycle.enable();
}

export async function syncNativeUnreadNotifications({ userId, readConversationIds, before }) {
  if (!plugin || unreadSyncUnavailable) return;
  await started;
  if (!userId) return;
  try {
    await plugin.syncUnreadNotifications({ userId, readConversationIds, before });
  } catch (error) {
    if (error.code !== 'UNIMPLEMENTED') throw error;
    unreadSyncUnavailable = true;
    console.warn('Install Android 1.8 or newer to clear read-message notifications and the launcher badge automatically.');
  }
}

export const hasNativePush = Boolean(lifecycle);
