const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/screen-guard.js'), 'utf8')
  .replace('export function setScreenGuard', 'function setScreenGuard');

test('screen protection stays enabled until all owners release it', async () => {
  const updates = [];
  const context = {
    window: { Capacitor: { isNativePlatform: () => true, Plugins: { ScreenGuard: { setSecure: async ({ enabled }) => updates.push(enabled) } } } },
    console
  };
  vm.runInNewContext(`${source}\nthis.setScreenGuard = setScreenGuard;`, context);
  const viewOnce = Symbol();
  await Promise.all([
    context.setScreenGuard('call', true),
    context.setScreenGuard(viewOnce, true),
    context.setScreenGuard('call', false),
    context.setScreenGuard(viewOnce, false)
  ]);
  assert.deepEqual(updates, [true, true, true, false]);
});

test('browser and missing Android plugin report their limitations', async () => {
  const browser = { window: {}, console };
  vm.runInNewContext(`${source}\nthis.setScreenGuard = setScreenGuard;`, browser);
  assert.equal(await browser.setScreenGuard('call', true), false);
  const native = { window: { Capacitor: { isNativePlatform: () => true, Plugins: {} } }, console };
  vm.runInNewContext(`${source}\nthis.setScreenGuard = setScreenGuard;`, native);
  await assert.rejects(native.setScreenGuard('call', true), /not available/);
});
