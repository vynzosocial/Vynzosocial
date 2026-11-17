# Android notifications

Notifications require Android version 1.3 (version code 4) or newer. A web-only
OTA update cannot install the native Firebase service. Install the signed APK
over an existing installation signed with the same key; uninstalling is not
normally necessary.

The rollout uses the push-device migration and API, the call coordinator, and
a compatible Android binary. Configure these server-only secrets:

- `FIREBASE_SERVICE_ACCOUNT` on the Supabase Edge Function: JSON credentials
  for a service account restricted to sending Firebase Cloud Messaging messages.
- `CALL_PUSH_SECRET` on both the Edge Function and call Worker: the same
  randomly generated 32-byte value, encoded as 64 hexadecimal characters.

Never put either credential in the website, Android app, source repository, or
logs. `PUSH_NOTIFICATIONS_ENABLED=true` on the Edge Function,
`CALL_PUSH_ENABLED=true` on the call Worker, and the frontend flag in
`frontend/js/push-config.mjs` enable delivery. Coordinate future changes to
these settings with the Android binary and OTA compatibility.

Message notifications contain no message text. Call notifications use the
coordinator's authorized invitations, expire after 45 seconds, and send a
cancellation on answer, decline, or the end of the invitation. Firebase and
Android delivery are best-effort: connectivity, force-stop, battery restrictions,
and notification permissions can delay or prevent delivery.
Tapping a call notification opens the app and attempts to join the matching
pending invitation. The app checks with the coordinator first and reports an
expired invitation instead of joining it. Microphone and, for video calls,
camera permission must be granted.

Test on two Android devices with notifications allowed and denied, app open,
backgrounded and closed. Check voice and video calls, cancellation, message
taps, account switching, sign-out, and multiple devices before considering the
rollout fully validated. The installed app must be opened and signed in to
register the device, and Android notification permission must be granted.
