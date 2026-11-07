const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const decoder = new TextDecoder('utf-8', { fatal: true });
const extensions = new Set(['.html', '.js', '.css']);

function checkFrontendText(root) {
  const errors = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'vendor') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        let text;
        try {
          text = decoder.decode(fs.readFileSync(file));
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          errors.push(`${file}: invalid UTF-8`);
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          if (/\uFFFD|(?:['"`]|>)\?{2,}(?=\s|['"`<])|>\?+<|\?{3,}/.test(line)) {
            errors.push(`${file}:${index + 1}: possible corrupted text`);
          }
        }
      }
    }
  }
  walk(root);
  if (errors.length) throw new Error(`Frontend text validation failed:\n${errors.join('\n')}`);
}

module.exports = checkFrontendText;

if (require.main === module) {
  checkFrontendText(path.resolve(__dirname, '..', 'frontend'));
  console.log('Frontend text is valid UTF-8 with no detected replacement characters.');
}
