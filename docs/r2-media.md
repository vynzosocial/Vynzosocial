# R2 media uploads

The R2 path handles new post and story images and videos;
existing Supabase uploads remain in Storage and use access-checked delivery.
Videos are encoded on the device as H.264 MP4 playback copies, and the original is
stored separately. Playback copies are capped at 720p and 30 FPS, encoded at a
1.5 Mbps video bitrate, and limited to 1-60 seconds. Each video also requires a
WebP cover image. Video autoplay starts muted; viewers can choose to enable sound.
Unsupported devices and videos outside the duration or upload limits are rejected
with an error rather than silently uploaded elsewhere.

Image previews try the bitmap decoder first, then the browser image decoder for
mobile Gallery compatibility. Chat images are copied into memory before resizing
so Gallery-backed file handles are not reused for upload. GIFs stay animated.
Unreadable or unsupported photos show an error suggesting JPG/PNG or My Files.

The R2 bucket must remain private. All media reads go through the Worker, which
checks the viewer's current post or story permissions with the API on every
request. Signed media URLs are bearer capabilities and expire after one hour.
The web app refreshes expired URLs; the original is available only to its owner.
Older clients must update before uploading when legacy uploads are disabled.
The Worker supports byte ranges and does not cache private media. Its daily
cleanup deletes abandoned staging objects older than 24 hours and reconciles
published objects against current posts and stories; expired stories and orphaned
media are removed when that job runs.
Setting the Worker variable `ACCOUNT_LIFECYCLE_PRESERVE_MEDIA=true` pauses both
scheduled cleanup jobs for all accounts, including staging cleanup. It does not
cancel a cleanup that has already started; wait for any in-flight job to finish
before accepting deactivations. Pausing cleanup increases storage usage. Keep the
deactivation disabled until preservation and the privacy checks below
have passed.

Legacy Supabase uploads include files outside account-scoped folders. Their
names or Storage ownership cannot always identify the uploader. The account
cleanup helpers do not remove these root-level objects, and a reference
inventory alone cannot establish ownership of an unreferenced file. Do not
deploy account deletion as complete until legacy ownership, shared references,
concurrent uploads and retryable cleanup have been handled. Deactivation also
requires access-controlled delivery for legacy public URLs and must preserve
the owner's media, including objects targeted by scheduled reconciliation.

The opt-in `LEGACY_MEDIA_GATEWAY_ENABLED` path routes legacy post, story,
avatar, blog, and message URLs returned by `vynzo-api` through the media Worker.
The Worker asks the API to recheck the reference and current access on every
read; avatar and blog references are checked against their current database
records, and message reads require current conversation membership.
The message gateway supports both sender-scoped message directories and older
root-level filenames. Root-level message files require a message-specific
permit; each read still verifies the exact stored attachment, sender,
conversation membership, and view-once/hidden-message restrictions. Deploy the
matching Edge Function and media Worker changes together.
Message bodies and reply snippets retain their original text, including links;
they are not attachment fields and must not be signed as message media.
The `public-share-media` and `blog-preview` functions continue to serve their
separately authorized public previews. `blog-preview` rewrites embedded legacy
image/video URLs to the site's `/share-blog-media` proxy, which supplies the
Supabase gateway authentication. Each read rechecks the published
article, active public author, and current asset reference, and forwards video
byte ranges. This gateway does not itself make previously returned public URLs
private. Keep the uploads bucket public until the gateway and all updated
clients have been deployed and verified; then apply
the separate `20261111004118_private_legacy_uploads_cutover.sql` migration.
Blog edits convert signed delivery URLs back to durable Storage references
before saving, and image moderation downloads private images server-side.
The separate `ACCOUNT_LIFECYCLE_ENABLED` guard checks
session and post/story media access, public previews, profile and discovery
routes, feeds, stories, reposted content, live listings and selected blog
routes. The `20261111002944_account_lifecycle.sql` migration filters inactive
actors from the activity-feed RPC and adds Realtime topic policies.
The frontend loads activity through authenticated `/api/activity`, including
gated media previews; direct table reads remain denied.
Set the same flag on `vynzo-api`, `blog-preview` and
`public-share-media` only after all privacy paths are complete.
The guarded messages API keeps existing message content while omitting inactive
participants' profile details from conversation lists, message details and reply
previews. Legacy attachment reads are routed through the Worker and recheck
message membership; lifecycle checks reject inactive senders and viewers once
the lifecycle flag is enabled. View-once claims share a transaction-level
advisory-lock barrier with deactivation and recheck sender and viewer state.
Inactive senders' unopened view-once media remain retained and become available
again after reactivation; successful claims remain single-use.
The calls Worker also has an opt-in `ACCOUNT_LIFECYCLE_ENABLED` guard that
verifies each caller with `vynzo-api` and checks room participants on each
request. Configure the same independent random `CALL_LIFECYCLE_SECRET` (at
least 32 characters) as a secret on both the Worker and Edge Function before
enabling this guard. Verification errors fail closed. When an active caller
polls, inactive participants are removed and their queued signals are dropped.
This is not instantaneous: existing peer-to-peer connections depend on clients
polling and processing call changes.
Realtime authorization is cached for existing connections until their JWT
expires or authorization is refreshed. New connections reject inactive users,
but deactivation does not forcibly disconnect already-authorized channels.
This bounded revocation behavior is disclosed in Settings; do not describe it
as immediate disconnection. See [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization).
Expose account controls only after the complete lifecycle flow and visibility
surfaces pass live checks.
With that flag enabled, a valid password for a deactivated account revokes the
temporary login session and sends a 30-minute activation link using the existing
`REPORT_SMTP_USER` and `REPORT_SMTP_PASSWORD` credentials. The activation page
requires explicit confirmation and stores only a hash of the single-use token.
For username and phone login, the guarded path looks up the current Auth email
by profile ID rather than relying on a potentially stale profile email. It
revokes the temporary session if the signed-in identity differs from that ID.
This does not synchronize the profile email or provide email-change controls.
The deactivation endpoint also requires the separate
`ACCOUNT_DEACTIVATION_ENABLED=true` guard. Keep that variable unset and keep the
Settings control hidden until the `uploads` bucket is private and every legacy
avatar, blog, message, and post/story path has been verified through
access-checked delivery. Until the private-bucket migration is applied, old
public URLs still bypass API and Realtime checks. Deactivation is not account deletion; deletion
orchestration is a separate feature and is not covered by this flow.

### Account lifecycle production verification

The configured production deployment has both lifecycle migrations applied,
the `uploads` bucket private, the API lifecycle/gateway/deactivation flags
enabled, the calls guard enabled, and scheduled media cleanup paused.
Settings initially shows only a Deactivate account button. Opening it hides
that button and reveals the explanation and required password form with an
empty password field and autofill disabled. Only the form's submit button remains.
Submitting asks for final
confirmation before sending the password-confirmed deactivation request.
Live fixture checks cover active reads, gated avatars/posts/stories/blogs and
attachments, public blog byte ranges, denied old public URLs, inactive API/media/
Realtime/call access, retained view-once claims, password confirmation, SMTP
acceptance, single-use reactivation, and restored access after fresh login.
Fixtures are removed after the checks. Inbox receipt was not verified;
SMTP acceptance does not guarantee delivery.

The lifecycle table is intentionally server-only: RLS is enabled and no client
policies or table grants are provided. Do not add a public policy merely to
silence the [RLS-without-policies advisor](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
The authenticated activity RPC intentionally checks `auth.uid()` and lifecycle
state under its existing privileged execution model; its
[SECURITY DEFINER advisor](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)
does not imply that clients may choose another user's activity.

Image and video posts can be reposted to another user's profile when the
original owner permits it. Reposting is enabled for existing and new posts by
default; owners can disable it before or after publication. A repost links to
the original rather than copying the media. It is hidden when the original is
deleted, reposting is disabled, or the viewer cannot access the original; the
reposter's profile privacy also applies. Re-enabling reposting makes previously
hidden reposts visible again if their other visibility rules allow it.

## Configuration

Configure three independent random secrets of at least 32 characters. Keep them
out of source control and use the same value for each corresponding pair:

| Supabase Edge Function secret | Cloudflare Worker secret |
| --- | --- |
| `R2_UPLOAD_PERMIT_SECRET` | `UPLOAD_PERMIT_SECRET` |
| `R2_DELIVERY_SECRET` | `DELIVERY_SECRET` |
| `R2_MEDIA_CONTROL_SECRET` | `MEDIA_CONTROL_SECRET` |

Set `R2_MEDIA_WORKER_URL` on the Edge Function to the HTTPS Worker origin. Set
`MEDIA_AUTH_URL` and `MEDIA_RECONCILE_URL` on the Worker to the respective
`/api/media/authorize` and `/api/media/reconcile` endpoints of the deployed
`vynzo-api` function. Set `MEDIA_AUTH_KEY` on the Worker to the Supabase
publishable key accepted by the gateway. These internal routes additionally require the control secret.
The Worker needs its `MEDIA` binding to point at the private `vynzo-media` bucket.

## Rollout

Deploy and verify the Worker and Edge Function while both upload flags are off.
Once the Worker secrets and internal API routes are configured, enable its
daily cron trigger (`30 3 * * *`) so staging and orphan cleanup can run.
Enable `R2_UPLOADS_ENABLED` on the Edge Function, then build and deploy a web and
Android release with `R2_UPLOADS_ENABLED` in `frontend/js/config.js` set to true.
Exercise image and video upload, playback, privacy changes, deletion, original
download, and Android playback on real accounts before setting
`R2_LEGACY_UPLOADS_DISABLED=true` on the Edge Function. Once legacy uploads are
disabled, older clients receive an update-required error instead of sending new
posts and stories to Supabase.
Legacy upload endpoints also reject videos so they cannot bypass these encoding
constraints; older clients must update to publish videos.

Do not disable the Worker, delete its secrets, or remove its bucket when rolling
back the upload flag: already published R2 media still depends on them. R2
storage and operations, Worker requests, and Supabase API requests may incur
charges even though R2 Standard internet egress is not charged.
