const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..', 'frontend');
const css = fs.readFileSync(path.join(root, 'css', 'layout.css'), 'utf8');
const users = fs.readFileSync(path.join(root, 'js', 'users.js'), 'utf8');
const formFunction = users.slice(users.indexOf('function createProfileReportForm('), users.indexOf('\nfunction renderUserProfile('));
const handler = users.match(/reportButton\.addEventListener\('click', \(\) => \{[\s\S]*?\n  \}\);/);
const chrome = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(file => file && fs.existsSync(file));

test('desktop report form opens on request and closes on cancel without changing mobile styling', { skip: !chrome }, () => {
  assert.ok(handler, 'Profile report button handler is present');
  const html = `<!doctype html><meta name="viewport" content="width=device-width">
    <style>${css}</style><button id="report">Report profile</button><main></main>
    <script>
      ${formFunction}
      const reportButton = document.getElementById('report');
      const reportForm = createProfileReportForm('user', reportButton);
      document.querySelector('main').append(reportForm);
      ${handler[0]}
      const before = getComputedStyle(reportForm).display;
      reportButton.click();
      const opened = getComputedStyle(reportForm).display;
      reportForm.querySelector('.account-profile-report-cancel').click();
      const cancelled = getComputedStyle(reportForm).display;
      document.body.dataset.result = [before, opened, cancelled].join(',');
    </script>`;
  const url = `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vynzo-profile-test-'));
  try {
    for (const [width, expected] of [[1200, 'none,grid,none'], [500, 'grid,grid,grid']]) {
      const result = spawnSync(chrome, [
        '--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
        `--window-size=${width},900`, '--dump-dom', url
      ], { encoding: 'utf8', timeout: 30000 });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`data-result="${expected}"`));
    }
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
