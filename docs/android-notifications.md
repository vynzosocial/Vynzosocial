# Android notifications

Notifications require Android version 1.3 (version code 4) or newer. A web-only
OTA update cannot install the native Firebase service. Install the signed APK
over an existing installation signed with the same key; uninstalling is not
normally necessary.

Inbox counts appear on every signed-in page, refresh on message events and
resume, and clear after the server acknowledges a conversation as read.
Background chats are not marked read until they become visible.
Supported installed browsers also receive the unread count through the web
Badging API and clear it when the inbox has no unread messages.

Android 1.8 (version code 9) adds native read-notification cleanup. After an
unread-count refresh, it removes notifications for read conversations, which
also clears their launcher badges. It only clears conversations explicitly
confirmed read, preserving unread or unlisted conversations, incoming call
notifications, and notifications posted after the refresh began. Calls
keep their existing answer/end/expiry cancellation. Launcher badge appearance
and numeric support depend on the Android launcher. Older APKs need the new
APK for this cleanup; an OTA alone cannot add the native method.

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

Each person can turn on **Notify me when this friend goes live** on a mutual
friend's profile. The setting is off by default and applies only to that friend.
Starting a live alerts only subscribed mutual friends who can watch, excluding
blocked and inactive accounts. With **Selected friends**, only subscribed
friends who were chosen can receive an alert. Subscriptions are removed when
either person unfollows the other. Each host can send alerts at most once every
five minutes. Tapping an alert opens the livestream, where normal viewing
permissions apply.

Open web, desktop, iOS, and Android clients receive alerts through Supabase
Realtime. Android background alerts require a native build that supports the
live notification channel, starting with Android 1.9 (version code 10); an OTA
alone cannot add this support. The push
expires after 90 seconds and does not include the host name or stream title.
Closed browsers, Windows and iOS apps do not receive live alerts.
Deploy the live-friend-alerts database migration before the Edge Function and
shared frontend; verify with two signed-in friend accounts before rollout.

Test on two Android devices with notifications allowed and denied, app open,
backgrounded and closed. Check voice and video calls, cancellation, message
taps, account switching, sign-out, and multiple devices before considering the
rollout fully validated. The installed app must be opened and signed in to
register the device, and Android notification permission must be granted.
