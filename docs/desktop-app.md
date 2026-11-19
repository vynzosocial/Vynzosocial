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
`desktop-app/release/VynzoSocial-Setup-1.2.5-x64.exe`. The assisted installer installs
for the current user without administrator access and creates desktop and
Start menu shortcuts. Login data is retained between launches and upgrades.
Uninstalling does not automatically remove saved login data.

Version 1.1.0 changes the display name to **VynzoSocial** in the window title,
About dialog, installer, executable product information, and shortcuts.
The app ID and `Vynzo.exe` executable name stay unchanged for upgrade
compatibility. Normal launches continue to use `%APPDATA%\Vynzo`, including
the original `persist:vynzo-desktop` browser session, so the branding change
does not move the saved login into a new profile.

Version 1.2.5 is offered as a direct, unsigned EXE download with the brief notice
**This installer is not code-signed.** inside its confirmation dialog. Windows SmartScreen
may warn or block installation. Do not ask users to disable Windows security.
Trusted code signing remains recommended for a production release; no signing
certificate or signing service has been configured.

## Website download panel

The welcome page includes a compact Windows download button and a native
confirmation dialog. The current unsigned release is clearly disclosed before
download. The existing Android download stays available; native Android and
desktop apps hide the welcome download group. A website cannot reliably detect
whether its EXE is already installed in an ordinary browser, so the interface
does not claim to detect installation.
The front page shows only a small Download for Windows button alongside Android,
retaining a 44-pixel minimum tap target. Platform and version details are in the popup.
Small inline Android and Windows icons identify the download buttons without
extra image requests. Android's signed-in Home download uses the same icon.
Signing disclosure and download-request messages appear only inside the dialog.

Upload a checked, versioned installer to the existing downloads Worker. Verify
the served file's hash and inspect its Windows Authenticode signature status
before setting `data-download-url` on
`#windows-download-button` in [the welcome page](../frontend/index.html).
Use the full HTTPS URL under
`https://vynzo-app-download.vynzolive.workers.dev/windows/`.
The controller enables the button only when an approved versioned URL is
configured. The URL allowlist is not a signature check. Do not label an installer
as signed unless its signature is valid; retain the unsigned warnings otherwise.
Removing the URL restores the disabled coming-soon state. Build and publish the
website and signed Android web update after activation.

The public direct-download file is
`windows/VynzoSocial-Setup-1.2.5-x64.exe` in `vynzo-app-downloads`.
The automatic-update feed also offers version 1.2.5. Keep prior binaries available.

Clicking the button opens the confirmation dialog without downloading anything.
Cancel, Escape, and an outside click dismiss it. **Yes, download** requests the
installer from the downloads Worker. Users must open the downloaded installer
and approve setup themselves; a website cannot silently install a Windows app.
The dialog stays open with instructions after the download request; Close,
Escape, or an outside click dismisses it. Reopening starts a fresh confirmation.
The interface does not claim that a download or installation has completed.

## Behavior and limitations

- Posts, stories, blogs, messages, and live/video calls use the existing website.
- Home alone has drifting gold edge glows, twinkling accents, and a thin golden
  shimmer. Decorations cannot intercept controls and respect reduced motion;
  high-contrast and print modes hide them. The same Home design reaches web,
  desktop, and Android through website releases and signed Android web updates,
  without a new desktop installer.
- Home's Stories and Photos & videos panels, story previews, photo/video
  cards, and username box also have softly animated golden frames. Borders
  cannot intercept taps and remain still when reduced motion is enabled.
- Daylight mode uses readable dark text for Home tabs, People connections,
  Live audience settings, and messages. Outgoing messages use a light tinted
  bubble rather than white text on a vivid background. Post controls wrap
  inside narrow cards so privacy settings and other actions remain visible.
- The Home Me grid uses consistent landscape previews, reserved caption space,
  and aligned compact owner controls. Cards adapt to the available width;
  Following and For You keep their existing playback layout. Opening a post
  still shows its full photo or video. Previews fit the complete media without
  cropping or hover zoom, with letterboxing where necessary. The Home column
  stays within its parent width, and Image/Video upload tiles wrap their labels
  within two equal columns instead of requiring sideways scrolling.
- A local desktop shell provides a draggable title bar, native Windows caption
  controls and Snap support, a navigation rail, back/forward/reload, current
  section, loading progress, and connection status. The application menu is
  available with the Alt key; there is no three-dot title-bar button.
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
- Call startup restores the authenticated session before registering incoming
  calls. The website view keeps its timers running while minimized so call
  invitations and signaling are not delayed by background throttling.
- Protected voice-message links retain their audio player. Call invitation
  lists close when clicking outside or pressing Escape. Video-call names stay
  above the controls, including when those controls wrap on mobile screens.
  Stopping a voice recording prepares a playable attachment for Send; it can
  also be removed without sending.
- Message refreshes retain unchanged chat rows and contact portraits instead
  of rebuilding them. New messages, edits, deletions, previews, and read
  receipts still update without resetting existing media, drafts, or text
  selection.
- Outgoing text, stickers, and attachments appear immediately as **Sending**
  while the server saves them; they are marked sent only after confirmation.
  Failed sends keep the draft. Photos are compressed to at most 1200 pixels
  on the longest edge when this reduces their size; animated GIFs are retained.
  Videos are optimized as MP4 up to 720p before upload, without enlarging
  already-small gallery clips. Camera offers photo or video; camera videos
  automatically stop at 10 seconds and are trimmed to enforce that maximum.
  The existing 60-second limit for gallery videos is unchanged.
- Attachments send with one press of Send, without a size-confirmation dialog.
  Voice messages use compact bubbles and a moderate playback boost with peak
  compression. Recording requests automatic microphone gain and noise reduction;
  devices without Web Audio keep their normal playback volume.
- Chat attachments up to 6 MiB use one authenticated multipart send instead of
  separate upload-permission, file-transfer, and message-save requests. Larger
  files retain direct signed uploads. Voice recording uses mono 64 kbps audio.
  Server membership, privacy, and account checks still apply before saving;
  independent profile and privacy lookups run concurrently.
- Voice calls use circular participant portraits and compact name labels.
  Up to six people, including the caller, fit without scrolling: two side by
  side, three or four in a 2-by-2 grid, and five or six in two rows of three.
  Pending invitations reserve places within the six-person voice-call limit.
  A red **W** identifies website and desktop participants; native mobile-app
  participants have no W badge. This interface is delivered through website
  releases and signed Android web updates, without a new native installer.
- Live-stage requests, including requests from returning guests, open the
  host's Manage guests panel. Requests retry until the host confirms receipt,
  so reconnecting before presence synchronizes does not lose a rejoin request.
  Host approval is still required. Shared images fit fully inside their tiles;
  cameras retain their crop-to-fill display.
- Guests on stage can choose **Settings > Leave stage** to stop sharing camera,
  microphone, or an image without leaving the live session. They keep watching
  and chatting, and can request to join the stage again.
- Settings displays the installed desktop version using a read-only
  `VynzoSocialDesktop/<version>` user-agent marker. The website still has no
  preload or desktop IPC access. Older installers without this marker need
  a desktop update to report their version.
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
permission before restarting, recommending the update for new features and
improvements. Choosing Later leaves the Update button
available without interrupting an active call or upload. Clicking it offers the
restart prompt again. Once the installed version is current, the button hides.
Normal quitting does not silently install. Failures are logged and expose a
Retry update button. VynzoSocial > Check for desktop updates remains available
when the button is hidden.

Users of versions 1.0.0 and 1.1.0 must install version 1.2.1 manually once because
those builds did not contain an update feed. Later releases can use the updater.
Website changes do not require a new desktop installer.
Deploy the current website call modules as well as native desktop releases;
publishing only an installer does not update the website's calling code.
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
