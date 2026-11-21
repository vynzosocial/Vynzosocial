# Android web updates

The Android app checks `https://www.vynzosocial.com/ota/manifest.json` for signed
web updates when it starts and periodically on resume. It downloads an update
in the background and activates it on a later cold start. When a signed update is
ready, the home page shows an **Update available** button. Android versions 1.2
and 1.3 ask the user to close and reopen the app to apply it; a future binary
with native apply support can apply it from the button. A failed trial startup
can roll back to the previous bundle; this is not a substitute for testing the
website and the app before deployment.

The Cloudflare website build must include the OTA files. Configure the
Cloudflare build as follows:

1. Use `npm ci && npm ci --prefix android-app && npm run build:ota` as the build
   command and `npx wrangler deploy` as the deploy command. Both the website and
   the signed update files are deployed from `dist` together.
2. Set the **build secret** `OTA_PRIVATE_KEY_BASE64` to the base64 encoding of
   the existing `android-app/ota-keys/private.pem` file. Keep this secret out of
   the repository, build logs, and the website. On the machine holding the key,
   PowerShell can copy its value to the clipboard:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path 'android-app\ota-keys\private.pem'))) | Set-Clipboard
   ```

3. Keep a secure backup of that private key. The build rejects a key that does
   not match the public key embedded in the Android app. Replacing the key
   requires a new Android release with the new public key.
4. Deploy the build, verify the manifest and signature are publicly reachable,
   and release an Android binary containing the configured URL and public key.
   Existing binaries with a blank URL cannot receive these updates.

For a local build, `npm run build:ota` uses the existing local private key, or
`OTA_PRIVATE_KEY_FILE` or `OTA_PRIVATE_KEY_BASE64` if supplied. `npm run build`
still builds the website without OTA files; deploying that build to the same
Cloudflare worker removes the update endpoint until an OTA-enabled build is
deployed again.

The website's home page also checks for new website builds and offers a reload
button. The build writes a fresh version into the home page and
`web-version.json`; Settings receives the same build identifier, and the
version endpoint must not be cached.

Settings displays the installed Android version and build from the native
`Ota.getInfo()` response, separately from the active web-update version.
These fields are available starting with Android 1.7 and require a new APK. Older native plugins report that an
app update is needed rather than displaying the latest APK's version as if it
were installed. Web updates alone cannot change or reliably infer the installed
APK version.

Only web assets can be updated this way. Android code, permissions, plugins,
and signing-key changes require a new Android binary. On Android releases
without the native notification plugin, the home button offers the signed
version 1.3 APK; the user must approve its installation. This compatibility
check is specific to version 1.3, not general APK version detection. Ensure web updates
comply with Google Play policies and remain compatible with installed binaries.

The OTA compatibility floor is `ota_min_binary_version_code` in
`android-app/android/app/src/main/res/values/ota.xml`, independently of the APK's
`versionCode`. It is currently 4 (Android 1.3), so later APK releases do not
silently block compatible older apps from receiving web-only updates. Raise
this floor only when the web bundle requires newer native capabilities. The
publisher rejects a missing, invalid, or newer-than-current compatibility floor.
Older binaries reject incompatible bundles before staging, so they cannot show
the home page's **Update available** button for those bundles. This is an in-app
button on Home, not an Android system push notification.

Pages do not wait for notification-device registration before showing content.
On native mobile, Settings, feed, stories, friend-list, Find and conversation-list
details are kept in account-scoped device storage (750 KB total). Find and
conversation lists are retained for up to 24 hours; other snapshots expire after
15 minutes. Conversation snapshots exclude message bodies and previews.
Returning pages show that snapshot while refreshing from the server. Feed scope,
the visible post and its video position are restored; unchanged video elements
are retained during refresh. Settings refreshes do not overwrite fields being
edited. Snapshots are cleared on logout, account changes, profile/privacy changes
and authorization failures; post and story changes invalidate their own snapshots.
Message bodies, view-once files and video binaries
are not cached; playback still requires an authorized media connection. Video
posts use their authorized uploaded cover while playback loads; older videos
without covers preload video metadata so the browser can display a frame.
Profile settings use **Add links** to open a separate social-links page. Users
can save Instagram, Facebook and Snapchat profile URLs or usernames there, or
clear a field to remove its profile button.
Content reads retry brief connection or gateway failures once; the feed, stories
and profile also offer a manual retry. Off-screen story video previews load as
they approach the visible carousel.
