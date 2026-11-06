# Android web updates

The Android app checks `https://www.vynzosocial.com/ota/manifest.json` for signed
web updates when it starts and periodically on resume. It downloads an update
in the background and activates it on a later cold start. A failed trial startup
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

Only web assets can be updated this way. Android code, permissions, plugins,
and signing-key changes require a new Play Store release. Ensure web updates
comply with Google Play policies and remain compatible with installed binaries;
raising `versionCode` in the Android project prevents the resulting OTA bundle
from being installed by older binaries.
