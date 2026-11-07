# R2 media uploads

The R2 path handles new post and story images and videos;
existing Supabase media, avatars, messages, and view-once media remain unchanged.
Videos are encoded on the device as H.264 MP4 playback copies, and the original is
stored separately. The playback copy is lossy; its quality and size depend on the
device. Unsupported devices and videos that cannot be made smaller are rejected
with an error rather than silently uploaded elsewhere.

The R2 bucket must remain private. All media reads go through the Worker, which
checks the viewer's current post or story permissions with the API on every
request. Signed media URLs are bearer capabilities and expire after one hour.
The web app refreshes expired URLs; the original is available only to its owner.
Older clients must update before uploading when legacy uploads are disabled.
The Worker supports byte ranges and does not cache private media. Its daily
cleanup deletes abandoned staging objects older than 24 hours and reconciles
published objects against current posts and stories; expired stories and orphaned
media are removed when that job runs.

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

Do not disable the Worker, delete its secrets, or remove its bucket when rolling
back the upload flag: already published R2 media still depends on them. R2
storage and operations, Worker requests, and Supabase API requests may incur
charges even though R2 Standard internet egress is not charged.
