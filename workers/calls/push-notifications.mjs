import { signCallPush } from '../../supabase/functions/_shared/call-push-auth.mjs';

export function createCallPushSender({ url, secret, publishableKey, fetchImpl = fetch, now = () => Date.now() }) {
  if (!url || !secret || !publishableKey) throw new Error('Call push sender is not configured.');
  return async event => {
    const body = JSON.stringify(event);
    const timestamp = String(now());
    const signature = await signCallPush(secret, timestamp, body);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${publishableKey}`,
        apikey: publishableKey,
        'Content-Type': 'application/json',
        'X-Call-Timestamp': timestamp,
        'X-Call-Signature': signature
      },
      body
    });
    if (!response.ok) throw new Error(`Call push service failed (HTTP ${response.status}).`);
  };
}
