const assert = require('node:assert/strict');
const fs = require('node:fs');
const { once } = require('node:events');
const { app, BrowserWindow, WebContentsView, Menu, desktopCapturer, dialog } = require('electron');
const { SITE_URL } = require('../lib/policy.cjs');
const { sectionForUrl, viewBounds } = require('../lib/shell-policy.cjs');

assert.ok(process.env.VYNZO_DESKTOP_SMOKE_PROFILE, 'Launch this test with npm run test:smoke.');
app.setPath('userData', process.env.VYNZO_DESKTOP_SMOKE_PROFILE);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const timeout = setTimeout(() => {
  console.error('Desktop smoke test timed out before the website finished loading.');
  app.exit(1);
}, 120000);
app.on('quit', () => {
  clearTimeout(timeout);
});
app.on('browser-window-created', (event, window) => {
  window.once('ready-to-show', async () => {
    let phase = 'shell startup';
    try {
      const view = window.contentView.children.find(child => child instanceof WebContentsView);
      assert.ok(view, 'The website must run in a separate native view.');
      const contents = view.webContents;
      contents.session.webRequest.onErrorOccurred(
        { urls: ['https://qyfphwrmwvnwsklfsbbo.supabase.co/*'] },
        details => console.error(`Supabase request failed: ${details.error}`)
      );
      if (contents.isLoadingMainFrame() || !contents.getURL()) await once(contents, 'did-finish-load');
      assert.equal(new URL(contents.getURL()).origin, new URL(SITE_URL).origin, 'The live website must load, not the recovery page.');
      assert.equal(window.getTitle(), 'VynzoSocial');
      assert.equal(window.isMenuBarVisible(), false);
      const shell = await window.webContents.executeJavaScript(`({
        title: document.title,
        brand: document.querySelector('.brand').textContent,
        sections: document.querySelectorAll('.navigation-rail [data-section]').length,
        menuButtons: document.querySelectorAll('.titlebar [data-action="menu"]').length,
        version: document.getElementById('version').textContent,
        bridge: typeof window.desktopApp,
        nodeAccess: typeof require
      })`);
      assert.equal(shell.title, 'VynzoSocial');
      assert.match(shell.brand, /VynzoSocial/);
      assert.equal(shell.sections, 6);
      assert.equal(shell.menuButtons, 0, 'The title bar must not show a three-dot menu button.');
      assert.equal(shell.version, `v${require('../package.json').version}`);
      assert.equal(shell.bridge, 'object');
      assert.equal(shell.nodeAccess, 'undefined');
      const preferences = contents.getLastWebPreferences();
      assert.equal(preferences.nodeIntegration, false);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.sandbox, true);
      assert.equal(preferences.webSecurity, true);
      assert.equal(contents.getBackgroundThrottling(), false);
      const renderer = await contents.executeJavaScript('({ title: document.title, nodeAccess: typeof require, electronAccess: typeof process, desktopBridge: typeof window.desktopApp, body: Boolean(document.body), sidebar: getComputedStyle(document.querySelector(".sidebar.desktop-nav")).display })');
      assert.equal(renderer.nodeAccess, 'undefined');
      assert.equal(renderer.electronAccess, 'undefined');
      assert.equal(renderer.desktopBridge, 'undefined');
      assert.equal(renderer.body, true);
      assert.equal(renderer.sidebar, 'none');
      phase = 'Settings version';
      const settingsLoaded = once(contents, 'did-finish-load');
      await window.webContents.executeJavaScript("window.desktopApp.action('navigate', 'settings')");
      await settingsLoaded;
      const versionSettings = await contents.executeJavaScript("document.getElementById('application-version').textContent");
      assert.equal(versionSettings, `Windows desktop: ${require('../package.json').version}`);
      const returnHome = once(contents, 'did-finish-load');
      await window.webContents.executeJavaScript("window.desktopApp.action('navigate', 'home')");
      await returnHome;
      phase = 'login and navigation';
      const loginProbe = await contents.executeJavaScript(`(async () => {
        try {
          const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = await import('/js/supabase-config.js');
          const response = await fetch(SUPABASE_URL + '/functions/v1/vynzo-api/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
            body: '{}',
            signal: AbortSignal.timeout(15000)
          });
          return { status: response.status, body: await response.json() };
        } catch (error) {
          return { error: error.name + ': ' + error.message };
        }
      })()`);
      assert.equal(loginProbe.error, undefined, loginProbe.error);
      assert.equal(loginProbe.status, 400, 'The login endpoint must be reachable and reject empty credentials.');
      assert.match(loginProbe.body.error, /password/i);
      phase = 'welcome video';
      const welcomeVideo = await contents.executeJavaScript(`(() => {
        const video = document.getElementById('welcome-featured-video');
        return video ? { present: true, paused: video.paused, autoplay: video.autoplay } : { present: false };
      })()`);
      assert.equal(welcomeVideo.present, true, 'Deploy the current website before running the live smoke test.');
      assert.equal(welcomeVideo.paused, true, 'The desktop welcome video must wait for a click.');
      assert.equal(welcomeVideo.autoplay, false, 'HTML autoplay must not bypass the front-page controller.');
      assert.match(Menu.getApplicationMenu().getMenuItemById('update-status').label, /not configured/);
      phase = 'update controls and navigation';
      const actualState = await window.webContents.executeJavaScript('window.desktopApp.getState()');
      window.setSize(940, 600);
      for (const [update, hidden, disabled] of [
        [{ state: 'downloading', detail: 'Downloading...', progress: 43 }, false, true],
        [{ state: 'downloaded', detail: 'Ready to install.', progress: null }, false, false],
        [{ state: 'current', detail: 'You have the latest version.', progress: null }, true, false]
      ]) {
        window.webContents.send('vynzosocial:shell:changed', { ...actualState, update });
        const button = await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => {
          const button = document.getElementById('desktop-update');
          resolve({
            hidden: getComputedStyle(button).display === 'none',
            disabled: button.disabled,
            text: button.textContent,
            fits: button.hidden || button.getBoundingClientRect().right <= document.querySelector('.connection').getBoundingClientRect().left
          });
        }))`);
        assert.equal(button.hidden, hidden);
        assert.equal(button.disabled, disabled);
        assert.equal(button.fits, true, 'Update controls must fit at the minimum window width.');
        if (update.state === 'downloading') assert.equal(button.text, 'Updating 43%');
      }
      window.webContents.send('vynzosocial:shell:changed', actualState);
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      window.setSize(1100, 760);
      await new Promise(resolve => setTimeout(resolve, 200));
      const { width, height } = window.getContentBounds();
      assert.deepEqual(view.getBounds(), viewBounds(width, height));
      const aboutLoaded = once(contents, 'did-finish-load');
      await window.webContents.executeJavaScript("window.desktopApp.action('navigate', 'about')");
      await aboutLoaded;
      assert.equal(sectionForUrl(contents.getURL()), 'about');
      assert.equal(window.getTitle(), 'VynzoSocial');
      const homeLoaded = once(contents, 'did-finish-load');
      await window.webContents.executeJavaScript("document.querySelector('.navigation-rail [data-section=\"home\"]').click()");
      await homeLoaded;
      assert.equal(sectionForUrl(contents.getURL()), 'home');
      assert.equal((await window.webContents.executeJavaScript('window.desktopApp.getState()')).section, 'home');
      const originalMessage = dialog.showMessageBox;
      const prompts = [];
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        assert.equal(options.title, 'VynzoSocial permission');
        prompts.push(options.message);
        return { response: 0 };
      };
      try {
        for (const video of [false, true]) {
          phase = `${video ? 'video' : 'voice'} RTP exchange`;
          const result = await contents.executeJavaScript(`(async () => {
            const streams = [];
            const peers = [];
            try {
              const gather = peer => peer.iceGatheringState === 'complete' ? Promise.resolve()
                : new Promise(resolve => peer.addEventListener('icegatheringstatechange', () => {
                  if (peer.iceGatheringState === 'complete') resolve();
                }));
              for (let index = 0; index < 2; index++) {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: ${video} });
                streams.push(stream);
                const peer = new RTCPeerConnection({ iceServers: [] });
                peers.push(peer);
                stream.getTracks().forEach(track => peer.addTrack(track, stream));
              }
              const [caller, receiver] = peers;
              await caller.setLocalDescription(await caller.createOffer());
              await gather(caller);
              await receiver.setRemoteDescription(caller.localDescription);
              await receiver.setLocalDescription(await receiver.createAnswer());
              await gather(receiver);
              await caller.setRemoteDescription(receiver.localDescription);
              for (let attempt = 0; attempt < 50; attempt++) {
                const received = await Promise.all(peers.map(async peer => {
                  const stats = await peer.getStats();
                  return [...stats.values()].filter(item => item.type === 'inbound-rtp'
                    && item.bytesReceived > 0 && item.packetsReceived > 0).map(item => item.kind);
                }));
                if (received.every(kinds => kinds.includes('audio') && (!${video} || kinds.includes('video')))) {
                  return { received, states: peers.map(peer => peer.connectionState) };
                }
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              throw new Error('Both peers must receive actual voice/video RTP packets.');
            } catch (error) {
              return { error: error.name + ': ' + error.message };
            } finally {
              peers.forEach(peer => peer.close());
              streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
            }
          })()`);
          assert.equal(result.error, undefined, result.error);
          assert.deepEqual(result.states, ['connected', 'connected']);
          assert.ok(result.received.every(kinds => kinds.includes('audio') && (!video || kinds.includes('video'))));
        }
        assert.equal(prompts.length, 2, 'Microphone and camera each require explicit consent.');
      } finally {
        dialog.showMessageBox = originalMessage;
      }
      if (process.env.VYNZO_DESKTOP_SCREENSHOT) {
        window.setSize(1280, 850);
        await new Promise(resolve => setTimeout(resolve, 200));
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1100 } });
        const source = sources.find(item => item.id === window.getMediaSourceId());
        assert.ok(source, 'The desktop preview must capture only the smoke-test window.');
        fs.writeFileSync(process.env.VYNZO_DESKTOP_SCREENSHOT, source.thumbnail.toPNG());
      }
      console.log(`Desktop smoke test passed: isolated native shell; navigation; reachable login; paused welcome video; update controls; actual Settings version; explicit media consent; two-way voice/video RTP with synthetic devices; no website IPC access.`);
      clearTimeout(timeout);
      app.quit();
    } catch (error) {
      console.error(`Desktop smoke test failed during ${phase}:`, error);
      app.exit(1);
    }
  });
});
require('../main.cjs');
