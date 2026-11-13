const { build, Platform, Arch } = require('electron-builder');
const { validateUpdateUrl } = require('../lib/policy.cjs');

async function run() {
  if (process.platform !== 'win32') throw new Error('Build this Windows installer on Windows.');
  const updateUrl = process.env.VYNZO_DESKTOP_UPDATE_URL?.trim()
    || 'https://vynzo-app-download.vynzolive.workers.dev/windows/';
  const config = { publish: [{ provider: 'generic', url: validateUpdateUrl(updateUrl), useMultipleRangeRequest: false }] };
  if (!process.env.CSC_LINK && !process.env.WIN_CSC_LINK) {
    console.warn('No signing certificate was supplied. Windows may warn about this local unsigned installer.');
  }
  const artifacts = await build({ targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never', config });
  for (const artifact of artifacts) console.log(`Built: ${artifact}`);
}

run().catch(error => {
  console.error('Windows installer build failed:', error);
  process.exitCode = 1;
});
