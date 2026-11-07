const fs = require('node:fs');
const path = require('node:path');

module.exports = function copyVideoEncoderAssets(output) {
  const packageDir = path.resolve(path.dirname(require.resolve('mediabunny')), '..', '..');
  const target = path.join(output, 'vendor', 'mediabunny');
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(packageDir, 'dist', 'bundles', 'mediabunny.min.mjs'), path.join(target, 'mediabunny.min.mjs'));
  fs.copyFileSync(path.join(packageDir, 'LICENSE'), path.join(target, 'LICENSE.txt'));
};
