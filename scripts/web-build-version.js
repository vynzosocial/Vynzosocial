const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function writeWebBuildVersion(outputDir) {
  const version = crypto.randomUUID();
  const marker = '<meta name="vynzo-web-version" content="development">';
  const pages = ['index.html', path.join('pages', 'settings.html')].map(relativePath => {
    const file = path.join(outputDir, relativePath);
    const html = fs.readFileSync(file, 'utf8');
    if (!html.includes(marker)) throw new Error(`Web version marker is missing from ${relativePath}.`);
    return { file, html };
  });
  for (const { file, html } of pages) {
    fs.writeFileSync(file, html.replace(marker, `<meta name="vynzo-web-version" content="${version}">`));
  }
  fs.writeFileSync(path.join(outputDir, 'web-version.json'), JSON.stringify({ version }));
};
