const fs = require('node:fs');
const path = require('node:path');

module.exports = function copyLiveFaceAssets(output) {
  const packageDir = path.resolve(path.dirname(require.resolve('@vladmandic/human')), '..');
  const target = path.join(output, 'vendor', 'human');
  fs.mkdirSync(path.join(target, 'models'), { recursive: true });
  for (const [source, destination] of [
    ['dist/human.esm.js', 'human.esm.js'],
    ['models/blazeface.json', 'models/blazeface.json'],
    ['models/blazeface.bin', 'models/blazeface.bin'],
    ['models/facemesh.json', 'models/facemesh.json'],
    ['models/facemesh.bin', 'models/facemesh.bin'],
    ['models/iris.json', 'models/iris.json'],
    ['models/iris.bin', 'models/iris.bin'],
    ['LICENSE', 'LICENSE.txt']
  ]) {
    fs.copyFileSync(path.join(packageDir, source), path.join(target, destination));
  }
};
