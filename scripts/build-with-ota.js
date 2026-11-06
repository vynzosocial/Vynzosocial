const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
execFileSync(process.execPath, [path.join(root, 'scripts', 'build.js')], {
  cwd: root,
  stdio: 'inherit'
});
execFileSync(process.execPath, [path.join(root, 'android-app', 'scripts', 'ota-publish.js')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, OTA_OUTPUT_DIR: path.join(root, 'dist', 'ota') }
});
