const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

test('download worker serves only the published APK for GET and HEAD', async () => {
  const { default: worker } = await import('../workers/app-download/index.mjs');
  const calls = [];
  const bucket = {
    async get(key) {
      calls.push(['get', key]);
      return { size: 3, httpEtag: '"etag"', body: 'apk' };
    },
    async head(key) {
      calls.push(['head', key]);
      return { size: 3, httpEtag: '"etag"' };
    }
  };
  const url = 'https://example.test/vynzo-android-1.7.apk';
  const response = await worker.fetch(new Request(url), { DOWNLOADS: bucket });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'apk');
  assert.equal(response.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.equal((await worker.fetch(new Request(url, { method: 'HEAD' }), { DOWNLOADS: bucket })).status, 200);
  assert.equal((await worker.fetch(new Request(url, { method: 'POST' }), { DOWNLOADS: bucket })).status, 405);
  assert.equal((await worker.fetch(new Request('https://example.test/other'), { DOWNLOADS: bucket })).status, 404);
  assert.deepEqual(calls, [['get', 'vynzo-android-1.7.apk'], ['head', 'vynzo-android-1.7.apk']]);
  assert.equal((await worker.fetch(new Request('https://example.test/vynzo-android-1.6.apk'), { DOWNLOADS: bucket })).status, 200);
  assert.equal((await worker.fetch(new Request(url), { DOWNLOADS: { get: async () => null } })).status, 404);
});

test('welcome and signed-in home pages link to the published APK', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/app-download.css'), 'utf8');
  const url = 'https://vynzo-app-download.vynzolive.workers.dev/vynzo-android-1.7.apk';
  assert.equal(html.split(`href="${url}"`).length - 1, 2);
  assert.match(html, /class="app-download-link welcome-app-download"/);
  assert.match(html, /class="home-app-download"/);
  assert.match(css, /\.vynzo-android-app \.welcome-app-download/);
  assert.match(css, /\.vynzo-android-app \.home-app-download/);
});

test('Windows update feed is not cached and versioned downloads support byte ranges', async () => {
  const { default: worker } = await import('../workers/app-download/index.mjs');
  const content = 'installer';
  const reads = [];
  const bucket = {
    head: async () => ({ size: content.length, httpEtag: '"windows"' }),
    get: async (file, options) => {
      reads.push(file);
      const range = options?.range;
      return {
        size: content.length, httpEtag: '"windows"',
        body: range ? content.slice(range.offset, range.offset + range.length) : content
      };
    }
  };
  const feed = await worker.fetch(new Request('https://example.test/windows/latest.yml'), { DOWNLOADS: bucket });
  assert.equal(feed.status, 200);
  assert.equal(feed.headers.get('cache-control'), 'no-store');
  const url = 'https://example.test/windows/VynzoSocial-Setup-1.2.0-x64.exe';
  for (const [range, text, contentRange] of [
    ['bytes=0-2', 'ins', 'bytes 0-2/9'],
    ['bytes=-3', 'ler', 'bytes 6-8/9']
  ]) {
    const result = await worker.fetch(new Request(url, { headers: { Range: range } }), { DOWNLOADS: bucket });
    assert.equal(result.status, 206);
    assert.equal(await result.text(), text);
    assert.equal(result.headers.get('content-range'), contentRange);
    assert.equal(result.headers.get('content-length'), '3');
  }
  const before = reads.length;
  for (const range of ['bytes=9-', 'bytes=3-1', 'bytes=0-1,4-5']) {
    const result = await worker.fetch(new Request(url, { headers: { Range: range } }), { DOWNLOADS: bucket });
    assert.equal(result.status, 416);
    assert.equal(result.headers.get('content-range'), 'bytes */9');
  }
  assert.equal(reads.length, before);
  const full = await worker.fetch(new Request(url), { DOWNLOADS: bucket });
  assert.equal(full.status, 200);
  assert.match(full.headers.get('cache-control'), /immutable/);
  const blockmap = await worker.fetch(new Request(`${url}.blockmap`), { DOWNLOADS: bucket });
  assert.equal(blockmap.status, 200);
  for (const path of ['windows/private.pem', 'windows/arbitrary.exe', 'windows/VynzoSocial-Setup-1.2.0-x64.exe/extra']) {
    assert.equal((await worker.fetch(new Request(`https://example.test/${path}`), { DOWNLOADS: bucket })).status, 404);
  }
});

test('home header links Snapchat next to Instagram', () => {
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../frontend/css/app-download.css'), 'utf8');
  assert.match(html, /class="instagram-icon-link"[\s\S]*?<\/a>\s*<a class="snapchat-icon-link" href="https:\/\/www\.snapchat\.com\/@vynzosocial" target="_blank" rel="noopener noreferrer" aria-label="Vynzo on Snapchat"/);
  assert.match(css, /\.snapchat-icon-link\s*\{\s*background:\s*#fffc00/);
});

const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(file => file && fs.existsSync(file));

async function exerciseWindowsDownload(doc, state) {
  const win = doc.defaultView;
  const button = doc.getElementById('windows-download-button');
  const dialog = doc.getElementById('windows-download-dialog');
  const confirm = doc.getElementById('windows-download-confirm');
  const status = doc.getElementById('windows-download-status');
  const url = 'https://vynzo-app-download.vynzolive.workers.dev/windows/VynzoSocial-Setup-1.2.4-x64.exe';
  const result = { state };
  const card = doc.querySelector('.windows-download-card').getBoundingClientRect();
  result.compact = card.width <= 260 && card.height >= 44 && card.height <= 48;
  result.hidden = card.width === 0;
  result.fits = card.left >= 0 && card.right <= doc.documentElement.clientWidth + 1;
  result.disabled = button.disabled;
  result.link = confirm.getAttribute('href');
  result.status = status.textContent;
  result.buttonText = button.textContent;
  result.iconsDecorative = [...doc.querySelectorAll('.app-download-link, #windows-download-button')].every(control => {
    const icon = control.querySelector('.app-platform-icon');
    return icon?.getAttribute('aria-hidden') === 'true' && icon.getAttribute('focusable') === 'false';
  });
  if (state !== 'ready') return result;

  const icons = [...doc.querySelectorAll('.welcome-downloads .app-platform-icon')];
  result.iconsFit = icons.length === 2 && icons.every(icon => {
    const rect = icon.getBoundingClientRect(), parent = icon.parentElement.getBoundingClientRect();
    return Math.abs(rect.width - 16) < 1 && Math.abs(rect.height - 16) < 1
      && rect.left >= parent.left && rect.right <= parent.right && rect.top >= parent.top && rect.bottom <= parent.bottom;
  });
  const warning = doc.getElementById('windows-installer-warning');
  const panel = doc.querySelector('.windows-download-card');
  result.frontCardClean = !panel.contains(status) && !panel.contains(warning)
    && !panel.textContent.includes('code-signed');
  result.warningText = warning.textContent;
  result.messagesInitiallyHidden = warning.getBoundingClientRect().height === 0
    && status.getBoundingClientRect().height === 0;
  let downloads = 0;
  confirm.addEventListener('click', event => { event.preventDefault(); downloads++; }, true);
  result.initiallyClosed = !dialog.open;
  button.focus();
  button.click();
  result.warningVisible = warning.getBoundingClientRect().height > 0;
  const rect = dialog.getBoundingClientRect();
  result.dialogFits = rect.left >= 0 && rect.right <= doc.documentElement.clientWidth + 1
    && dialog.scrollWidth <= dialog.clientWidth + 1;
  result.asksFirst = dialog.open && downloads === 0
    && doc.getElementById('windows-installer-warning').getBoundingClientRect().height > 0;
  dialog.querySelector('button').click();
  await new Promise(resolve => win.setTimeout(resolve, 0));
  result.cancelled = !dialog.open && downloads === 0 && doc.activeElement === button;
  button.click();
  dialog.requestClose();
  await new Promise(resolve => win.setTimeout(resolve, 0));
  result.escaped = !dialog.open && downloads === 0;
  button.click();
  dialog.dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: -1, clientY: -1 }));
  result.outsideClosed = !dialog.open && downloads === 0;
  button.click();
  confirm.click();
  result.confirmed = dialog.open && downloads === 1 && confirm.href === url;
  result.requestStatus = status.textContent;
  result.messageVisible = dialog.contains(status) && status.getBoundingClientRect().height > 0;
  dialog.querySelector('button').click();
  result.messagesHiddenAfterClose = !dialog.open && status.getBoundingClientRect().height === 0
    && !panel.textContent.includes('Download requested');
  button.click();
  result.reopenedFresh = dialog.open && status.textContent === '' && downloads === 1;
  dialog.querySelector('button').click();
  return result;
}

test('Windows download stays gated and only requests an installer after consent, with responsive native dialogs',
  { skip: !chrome }, () => {
    const root = path.join(__dirname, '..');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vynzo-windows-download-'));
    try {
      const source = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/\s(?:src|poster)="[^"]*"/g, '')
        .replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'frontend', 'index.html')).href}">`);
      const module = fs.readFileSync(path.join(root, 'frontend', 'js', 'windows-download.mjs'), 'utf8').replace(/^export /gm, '');
      const pages = ['pending', 'ready', 'invalid', 'android', 'desktop', 'desktop-marker'].map(state => {
        let html = source;
        if (state === 'pending') html = html.replace(/\sdata-download-url="[^"]*"/, '');
        if (state === 'invalid') html = html.replace(/data-download-url="[^"]*"/,
          'data-download-url="https://example.test/untrusted.exe"');
        if (state === 'android') html = html.replace('<html lang=', '<html class="vynzo-android-app" lang=');
        if (state === 'desktop') html = html.replace('</head>',
          `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'desktop-app', 'ui', 'website.css')).href}"></head>`);
        const setup = state === 'desktop-marker'
          ? 'Object.defineProperty(navigator,"userAgent",{value:"VynzoSocialDesktop/1.2.4"});' : '';
        return { state, html: html.replace('</body>', `<script>${setup}${module}</script></body>`) };
      });
      for (const width of [320, 768, 1280]) {
        const fixture = path.join(directory, 'fixture.html');
        fs.writeFileSync(fixture, `<!doctype html><body><script>
          const exercise=${exerciseWindowsDownload.toString()}, results=[];
          for(const input of ${JSON.stringify(pages).replace(/</g, '\\u003c')}) {
            const frame=document.createElement('iframe');
            frame.style.cssText='border:0;width:${width}px;height:800px';
            frame.onload=async()=>{
              try { results.push(await exercise(frame.contentDocument,input.state)); }
              catch(error) { results.push({state:input.state,error:error.stack}); }
              if(results.length===${pages.length}) document.body.dataset.result=JSON.stringify(results);
            };
            frame.srcdoc=input.html;document.body.appendChild(frame);
          }
        </script>`);
        const run = spawnSync(chrome, ['--headless', '--disable-gpu', '--no-first-run',
          `--user-data-dir=${directory}`, '--virtual-time-budget=2000', '--dump-dom', pathToFileURL(fixture).href
        ], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
        assert.equal(run.status, 0, run.stderr);
        const match = run.stdout.match(/data-result="([^"]+)"/);
        assert.ok(match, 'Missing download-dialog browser results');
        const results = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&gt;/g, '>')
          .replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
        for (const result of results) {
          assert.ok(!result.error, result.error);
          assert.ok(result.iconsDecorative, `Platform icons must remain present without changing button names: ${result.state}`);
          if (['android', 'desktop', 'desktop-marker'].includes(result.state)) {
            assert.ok(result.hidden, `Do not advertise app installation inside ${result.state}`);
            if (result.state !== 'desktop') assert.ok(result.disabled && result.link === null);
          } else {
            assert.ok(result.fits, `Windows panel overflows the ${width}px viewport`);
            if (result.state === 'ready') {
              assert.equal(result.disabled, false);
              assert.equal(result.warningText.trim(), 'This installer is not code-signed.');
              for (const check of ['compact', 'iconsFit', 'frontCardClean', 'messagesInitiallyHidden', 'warningVisible', 'initiallyClosed',
                'dialogFits', 'asksFirst', 'cancelled', 'escaped', 'outsideClosed', 'confirmed',
                'messageVisible', 'messagesHiddenAfterClose', 'reopenedFresh']) {
                assert.ok(result[check], `Windows download ${check} failed at ${width}px: ${JSON.stringify(result)}`);
              }
              assert.match(result.requestStatus, /Download requested/);
            } else {
              assert.ok(result.disabled && result.link === null);
              assert.match(result.status, result.state === 'pending' ? /coming soon/ : /temporarily unavailable/);
              assert.match(result.buttonText, result.state === 'pending' ? /coming soon/ : /temporarily unavailable/);
            }
          }
        }
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
