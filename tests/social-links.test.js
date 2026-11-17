const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Facebook icon opens the supplied page safely beside the other social links', () => {
  const index = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const headerStart = index.indexOf('<header class="top-bar">');
  const headerEnd = index.indexOf('</header>', headerStart);
  const header = index.slice(headerStart, headerEnd);
  const facebookLink = header.indexOf('class="facebook-icon-link"');

  assert.ok(facebookLink > header.indexOf('class="instagram-icon-link"'));
  assert.ok(facebookLink < header.indexOf('class="snapchat-icon-link"'));
  assert.match(header.slice(facebookLink), /href="https:\/\/www\.facebook\.com\/share\/19u4zehaoU\/"/);
  assert.match(header.slice(facebookLink), /target="_blank" rel="noopener noreferrer"/);
});
