const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vynzo-desktop-smoke-'));
const child = spawn(require('electron'), [path.join(__dirname, 'smoke.cjs')], {
  stdio: 'inherit',
  env: { ...process.env, VYNZO_DESKTOP_SMOKE_PROFILE: profile }
});
const timeout = setTimeout(() => {
  console.error('Desktop smoke test did not exit in time.');
  child.kill();
  process.exitCode = 1;
}, 135000);

child.on('error', error => {
  console.error('Could not launch desktop smoke test:', error);
  process.exitCode = 1;
});
child.on('close', code => {
  clearTimeout(timeout);
  process.exitCode = process.exitCode || (code === 0 ? 0 : 1);
  try {
    // Chromium releases its Windows profile locks only after the process exits.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.error('Could not remove temporary smoke-test profile:', error);
    process.exitCode = 1;
  }
});
