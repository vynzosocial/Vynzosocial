# VynzoSocial Windows desktop app

The Electron application in [desktop-app](../desktop-app) opens
`https://www.vynzosocial.com/`. Website releases appear when users reload or
reopen the app; website code is not bundled into the installer.

## Develop and build

On Windows with Node.js and npm:

```powershell
Set-Location desktop-app
npm ci
npm test
npm run test:smoke
npm start
npm run build
```

The Windows x64 installer is generated at
`desktop-app/release/VynzoSocial-Setup-1.2.1-x64.exe`. The assisted installer installs
for the current user without administrator access and creates desktop and
Start menu shortcuts. Login data is retained between launches and upgrades.
Uninstalling does not automatically remove saved login data.

Version 1.1.0 changes the display name to **VynzoSocial** in the window title,
About dialog, installer, executable product information, and shortcuts.
The app ID and `Vynzo.exe` executable name stay unchanged for upgrade
compatibility. Normal launches continue to use `%APPDATA%\Vynzo`, including
the original `persist:vynzo-desktop` browser session, so the branding change
does not move the saved login into a new profile.

The initial installer is unsigned and built for local testing. Windows
SmartScreen may warn. Do not ask users to disable Windows security. Obtain a
Windows code-signing certificate or configure a supported signing service
before public distribution.

## Behavior and limitations

- Posts, stories, blogs, messages, and live/video calls use the existing website.
- A local desktop shell provides a draggable title bar, native Windows caption
  controls and Snap support, a navigation rail, back/forward/reload, current
  section, loading progress, and connection status. The application menu is
  available from the three-dot button or the Alt key.
- Home, Messages, Live, Blogs, People, and Settings are accessible from the rail.
  Active navigation follows website navigation as well as native buttons.
  Duplicate website navigation and app-download links are hidden by a
  desktop-only stylesheet; the public website is not changed.
- The shell uses a local, sandboxed renderer with a narrow preload bridge.
  The website runs in a separate sandboxed `WebContentsView` with no preload
  or desktop IPC access. Only the exact local shell main frame can request
  fixed navigation actions; arbitrary URLs and commands are not accepted.
- The welcome video is restricted to the visible, signed-out front page and
  pauses when that page is hidden or backgrounded. Desktop playback requires a
  click. This behavior is delivered by the live website without another desktop
  installer. Android receives it through the signed web update and must reopen
  after that update has downloaded to activate it.
- Camera, microphone, and notification requests require explicit permission
  from the main Vynzo website. Native permission approval lasts for the current
  app session. Windows privacy settings also apply.
- File selection uses Windows dialogs; downloads ask where to save the file.
- HTTP/HTTPS external links open in the user's browser. Untrusted websites,
  custom protocols, webviews, and Node.js access are blocked inside the app.
- Minimize the app to keep website notifications running. Closing its last
  window quits it; this first release does not provide background push after
  quitting or a system tray service.
- Internet is required. A local recovery page provides a retry link on failure.
- Screenshot protection cannot be guaranteed on a desktop.
- Screen sharing is not added by this wrapper. Display capture remains denied
  until a consent-based source picker and website support are implemented.
- No macOS, Linux, or Windows ARM64 installer is included in this first release.

## Desktop automatic updates

Version 1.2.1 adds a native title-bar Update button and configures the production
feed at `https://vynzo-app-download.vynzolive.workers.dev/windows/`.
The existing downloads Worker serves Windows installers, blockmaps, and
`latest.yml` from the separate private `vynzo-app-downloads` R2 bucket.
The feed is not cached; versioned binaries are immutable and support single
byte ranges for differential downloads. The builder disables multipart range
requests to match this server. Existing APK downloads are unchanged.

`npm run build` embeds this production feed by default. To use a staging feed:

```powershell
$env:VYNZO_DESKTOP_UPDATE_URL = 'https://your-download-host.example/windows/'
npm run build
```

The URL is embedded into the packaged updater configuration. Host the generated
`latest.yml`, installer, and `.blockmap` together at that URL. Keep filenames
unchanged and publish metadata last, after its files are available. Increment
`desktop-app/package.json`'s version for every desktop release.
Upload those three files under `windows/` in `vynzo-app-downloads`, with the
installer and blockmap first and `latest.yml` last. Verify the served installer
against the generated SHA-512 before updating the feed. Keep prior versioned
files available for differential downloads. Storage and requests may incur
charges.

An update-enabled app checks on startup, downloads automatically, displays
download progress in the title-bar button and application menu, and asks
permission before restarting. Choosing Later leaves the Update button
available without interrupting an active call or upload. Clicking it offers the
restart prompt again. Once the installed version is current, the button hides.
Normal quitting does not silently install. Failures are logged and expose a
Retry update button. VynzoSocial > Check for desktop updates remains available
when the button is hidden.

Users of versions 1.0.0 and 1.1.0 must install version 1.2.1 manually once because
those builds did not contain an update feed. Later releases can use the updater.
Website changes do not require a new desktop installer.
Development runs leave binary updates disabled; they do not claim to have
checked the production feed.

Keep the app ID and signing identity consistent across releases. Configure
signing credentials through environment variables or a secret store, never
source code. `CSC_LINK` / `WIN_CSC_LINK` and the corresponding certificate
password environment variables are supported by electron-builder. Configure
code signing before trusting automatic binary updates for public distribution.
Never distribute a new unsigned build over an established signed release.

## Verification before public release

`npm test` verifies origin restrictions, native navigation, trusted shell IPC,
media permission consent, and update download/restart behavior.
`npm run test:smoke` launches the real Electron window with a temporary profile,
checks that the live website loads in a sandbox without Node access, confirms
the Supabase login endpoint returns its expected validation error for empty
credentials, and exits. This checks renderer networking and CORS without
attempting to sign in to a real account. It also checks branding, hidden
duplicate navigation, website/preload separation, native view resizing,
navigation between the About and Home sections, and Update button progress,
enabled/disabled states, hiding, and fit at the minimum window size.
The parent Node.js runner removes the temporary profile only after Electron
exits, because Chromium still holds profile locks during Electron's `quit`
event on Windows. It does not sign in, use a camera, or test an installed update.

The initial packaged executable was also checked for a fully loaded live page,
absence of renderer Node.js access, and clean shutdown. Runtime dependencies
passed `npm audit --omit=dev`. The full dependency audit currently reports six
moderate build-tool advisories involving minimatch; these are not in the
packaged runtime. Recheck the build dependencies before a public release.

Before publishing, verify on a clean Windows computer:

1. Install, launch, uninstall, and upgrade with the signed installer.
2. Log in, close/reopen, and confirm that the login is retained.
3. Test messages, file uploads/downloads, camera/microphone permission allow and
   deny, incoming notifications while minimized, and live/video calls.
4. Disconnect the internet, retry, and confirm recovery.
5. Publish a higher signed version to staging; verify automatic download,
   Later, explicit restart, version change, and retained login.

Open Help > Open desktop logs folder for `desktop.log` in the app's Windows
user-data folder. Logs may include URLs and errors; inspect them for private
information before sharing.
