# Android APK download

The website's welcome page and signed-in home page link to the release APK.
The `vynzo-app-download` Worker serves permitted APKs from the
separate private `vynzo-app-downloads` R2 bucket. Do not make the media bucket
public or store the APK in it. The download Worker permits public downloads;
R2 storage, operations and Worker requests may incur charges.

## Signing key backup

The release is signed with `android-app/android/app/upload-keystore.jks`, using
the alias `upload`. Its generated password is protected for the current Windows
user in `android-app/ota-keys/apk-signing-password.dpapi`. These files are
git-ignored and must never be published. The OTA signing key is separate.

Back up the keystore and password securely in a password manager or another
secure location. The protected password file alone is not a portable backup:
Windows encrypts it for the current user. On the machine and account that
created it, this PowerShell command copies the password to the clipboard so it
can be stored securely without printing it:

```powershell
$secure = Get-Content android-app\ota-keys\apk-signing-password.dpapi | ConvertTo-SecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) | Set-Clipboard }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
```

Clear the clipboard after saving the password. Losing the keystore or password
prevents signing compatible updates. A different signing key cannot update
existing installations in place.

## Releasing an update

Install a full JDK 21 (including `javac` and `jlink`) and set `JAVA_HOME` to its
installation directory. Gradle's daemon criteria are pinned to Java 21 and take
precedence over `JAVA_HOME`; JDK auto-download URLs are intentionally omitted,
so a matching local JDK is required.

1. Review the native code and web assets to be included. Increment Android
   `versionCode` for a new APK and verify OTA compatibility. The standard
   `scripts/build-play-store-release.ps1` prepares web assets and overwrites
   generated build output, so do not run it against unreviewed local changes.
2. Sign with the same keystore and password, test the APK, and verify its
   signature and package information with Android SDK `apksigner` and `aapt`.
3. Give the new APK a versioned filename. Upload it to the downloads bucket,
   add its filename to the allowlist in `workers/app-download/index.mjs` and update both
   website links, then run `node --test tests\app-download.test.js`.
4. Deploy the download Worker and verify the downloaded APK's SHA-256 against
   the local APK before deploying the website. Deploy the website with its
   existing OTA files intact and verify both download links. Keep the existing
   download available until the new one has been verified.

Users may need to allow their browser to install apps from unknown sources.
Web OTA updates do not replace a new APK when native code or permissions change.
Version 1.6 (version code 7) makes navigation 35% smaller on every page, reduces
Settings card spacing and button sizes, and keeps Log out last in Settings.
It retains the combined deactivation/deletion control, empty password fields,
and native message and call notifications.
Version 1.7 (version code 8) adds native installed-version reporting for Settings
and includes the call initialization and welcome-video fixes. Version 1.6 and
older cannot report their installed version through the OTA bridge; a web
update alone cannot add this native capability.
Mobile Settings displays only the installed version number, without platform,
build, or web-update details.
Users of previous website APKs can install version 1.7 over them
without uninstalling because it uses the same signing key. The published
download is `vynzo-android-1.7.apk`; previous downloads remain available.
