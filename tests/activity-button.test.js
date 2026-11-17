const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/activity.js'), 'utf8');
const start = source.indexOf('function build()');
const end = source.indexOf('\nfunction init()', start);
const build = source.slice(start, end);

test('Activity button is placed immediately after For You', () => {
  const inserted = [];
  const forYouTab = { nextSibling: { id: 'later-tab' } };
  const activityButton = { addEventListener() {}, setAttribute() {} };
  const panel = { addEventListener() {}, querySelectorAll() { return []; } };
  const list = {};
  const badge = {};
  const wrap = {
    className: '',
    querySelector(selector) {
      return {
        '#activity-btn': activityButton,
        '#activity-panel': panel,
        '.activity-list': list,
        '.activity-badge': badge
      }[selector];
    }
  };
  const feedTabs = {
    querySelector: selector => selector === '[data-scope="all"]' ? forYouTab : null,
    insertBefore(node, anchor) { inserted.push({ node, anchor }); }
  };
  const topBar = {
    querySelector: selector => selector === '.feed-tabs' ? feedTabs : null,
    insertBefore() { assert.fail('Activity should be inserted into the feed tabs'); }
  };
  const context = {
    document: {
      querySelector: () => topBar,
      getElementById: () => null,
      createElement: () => wrap,
      body: { appendChild() {} },
      addEventListener() {}
    }
  };

  vm.runInNewContext(`let button, panel, list, badge;\n${build}\nthis.build = build;`, context);
  assert.equal(context.build(), true);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].node, wrap);
  assert.equal(inserted[0].anchor, forYouTab.nextSibling);
});
