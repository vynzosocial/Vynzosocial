const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const root = path.join(__dirname, '..', 'frontend', 'css');
const css = ['variables.css', 'reset.css', 'layout.css', 'messages.css', 'messages-glow.css', 'responsive.css', 'mobile.css', 'theme.css']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const tablet = fs.readFileSync(path.join(root, 'tablet-app.css'), 'utf8');
const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(file => file && fs.existsSync(file));

test('Android tablet composer keeps input and controls visible without changing web or phone', { skip: !chrome }, () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vynzo-tablet-test-'));
  try {
    for (const [width, app] of [[768, true], [800, true], [1024, true], [1280, true], [1400, true], [1024, false]]) {
      const html = `<!doctype html><meta name="viewport" content="width=device-width">
        <style>${css}\n${app ? tablet : ''}</style>
        <body class="messages-page"><div id="app-container">
          <aside class="sidebar"></aside><main class="messaging-container">
          <div class="conversations-sidebar"></div><div class="chat-area">
          <form class="chat-input-form has-emoji-picker"><div class="reply-bar" hidden></div>
          <div class="chat-attachment-preview" hidden></div>
          <button type="button" class="attach-btn">1</button><button type="button" class="attach-btn">2</button>
          <button type="button" class="attach-btn">3</button><button type="button" class="attach-btn">4</button>
          <button type="button" class="emoji-toggle">5</button><input type="text" class="chat-input">
          <button type="submit" class="send-btn">Send</button></form></div></main></div>
        <script>
          const form = document.querySelector('form');
          const input = form.querySelector('.chat-input');
          const controls = [...form.querySelectorAll('button')];
          const rect = input.getBoundingClientRect();
          const f = form.getBoundingClientRect();
          const overlap = controls.some(button => {
            const r = button.getBoundingClientRect();
            return rect.left < r.right && rect.right > r.left && rect.top < r.bottom && rect.bottom > r.top;
          });
          document.body.dataset.result = JSON.stringify({
            wrap: getComputedStyle(form).flexWrap,
            order: getComputedStyle(input).order,
            inputWidth: rect.width,
            formWidth: f.width,
            overlap,
            controlsInside: controls.every(button => {
              const r = button.getBoundingClientRect();
              return r.left >= f.left && r.right <= f.right && r.top >= f.top && r.bottom <= f.bottom;
            })
          });
        </script>`;
      const fixture = path.join(profile, 'fixture.html');
      fs.writeFileSync(fixture, html);
      const url = pathToFileURL(fixture).href;
      const result = spawnSync(chrome, [
        '--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
        `--window-size=${width},900`, '--dump-dom', url
      ], { encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 0, result.stderr);
      const match = result.stdout.match(/data-result="([^"]+)"/);
      assert.ok(match, `missing result at ${width}`);
      const actual = JSON.parse(match[1].replace(/&quot;/g, '"'));
      if (app && width >= 769) {
        assert.equal(actual.wrap, 'wrap', `wrap at ${width}`);
        assert.equal(actual.order, '-1', `input order at ${width}`);
        assert.ok(actual.inputWidth >= 200, `input width at ${width}: ${actual.inputWidth}`);
        assert.equal(actual.overlap, false, `overlap at ${width}`);
        assert.equal(actual.controlsInside, true, `controls outside at ${width}`);
      } else {
        assert.equal(actual.wrap, 'nowrap', `unchanged layout at ${width}`);
        assert.equal(actual.order, '0', `unchanged order at ${width}`);
      }
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
