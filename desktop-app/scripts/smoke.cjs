const assert = require('node:assert/strict');
const fs = require('node:fs');
const { once } = require('node:events');
const { app, BrowserWindow, WebContentsView, Menu, desktopCapturer } = require('electron');
const { SITE_URL } = require('../lib/policy.cjs');
const { sectionForUrl, viewBounds } = require('../lib/shell-policy.cjs');

assert.ok(process.env.VYNZO_DESKTOP_SMOKE_PROFILE, 'Launch this test with npm run test:smoke.');
app.setPath('userData', process.env.VYNZO_DESKTOP_SMOKE_PROFILE);
const timeout = setTimeout(() => {
  console.error('Desktop smoke test timed out before the website finished loading.');
  app.exit(1);
}, 120000);
app.on('quit', () => {
  clearTimeout(timeout);
});
app.on('browser-window-created', (event, window) => {
  window.once('ready-to-show', async () => {
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
        version: document.getElementById('version').textContent,
        bridge: typeof window.desktopApp,
        nodeAccess: typeof require
      })`);
      assert.equal(shell.title, 'VynzoSocial');
      assert.match(shell.brand, /VynzoSocial/);
      assert.equal(shell.sections, 6);
      assert.equal(shell.version, `v${require('../package.json').version}`);
      assert.equal(shell.bridge, 'object');
      assert.equal(shell.nodeAccess, 'undefined');
      const preferences = contents.getLastWebPreferences();
      assert.equal(preferences.nodeIntegration, false);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.sandbox, true);
      assert.equal(preferences.webSecurity, true);
      const renderer = await contents.executeJavaScript('({ title: document.title, nodeAccess: typeof require, electronAccess: typeof process, desktopBridge: typeof window.desktopApp, body: Boolean(document.body), sidebar: getComputedStyle(document.querySelector(".sidebar.desktop-nav")).display })');
      assert.equal(renderer.nodeAccess, 'undefined');
      assert.equal(renderer.electronAccess, 'undefined');
      assert.equal(renderer.desktopBridge, 'undefined');
      assert.equal(renderer.body, true);
      assert.equal(renderer.sidebar, 'none');
      const loginProbe = await contents.executeJavaScript(`(async () => {
        const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = await import('/js/supabase-config.js');
        const response = await fetch(SUPABASE_URL + '/functions/v1/vynzo-api/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
          body: '{}',
          signal: AbortSignal.timeout(15000)
        });
        return { status: response.status, body: await response.json() };
      })()`);
      assert.equal(loginProbe.status, 400, 'The login endpoint must be reachable and reject empty credentials.');
      assert.match(loginProbe.body.error, /password/i);
      const welcomeVideo = await contents.executeJavaScript(`({
        paused: document.getElementById('welcome-featured-video').paused,
        autoplay: document.getElementById('welcome-featured-video').autoplay
      })`);
      assert.equal(welcomeVideo.paused, true, 'The desktop welcome video must wait for a click.');
      assert.equal(welcomeVideo.autoplay, false, 'HTML autoplay must not bypass the front-page controller.');
      assert.match(Menu.getApplicationMenu().getMenuItemById('update-status').label, /not configured/);
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
      if (process.env.VYNZO_DESKTOP_SCREENSHOT) {
        window.setSize(1280, 850);
        await new Promise(resolve => setTimeout(resolve, 200));
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1100 } });
        const source = sources.find(item => item.id === window.getMediaSourceId());
        assert.ok(source, 'The desktop preview must capture only the smoke-test window.');
        fs.writeFileSync(process.env.VYNZO_DESKTOP_SCREENSHOT, source.thumbnail.toPNG());
      }
      console.log(`Desktop smoke test passed: VynzoSocial native shell; isolated live website; native navigation and resizing; login endpoint reachable; welcome video stays paused; update button progress and hiding verified; no website IPC access.`);
      clearTimeout(timeout);
      app.quit();
    } catch (error) {
      console.error('Desktop smoke test failed:', error);
      app.exit(1);
    }
  });
});
require('../main.cjs');
