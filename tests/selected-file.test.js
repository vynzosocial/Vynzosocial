const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'selected-file.js'), 'utf8')
  .replace('export async function ', 'async function ');
const context = {};
vm.runInNewContext(source, context);

test('keeps the selected file available until upload finishes', async () => {
  const file = { name: 'video.mp4' };
  const input = { files: [file], value: 'selected', disabled: false };
  let finish;
  const upload = context.uploadSelectedFile(input, async selected => {
    assert.equal(selected, file);
    await new Promise(resolve => { finish = resolve; });
    assert.equal(input.value, 'selected');
  });
  assert.equal(input.disabled, true);
  assert.equal(input.value, 'selected');
  finish();
  await upload;
  assert.equal(input.value, '');
  assert.equal(input.disabled, false);
});

test('clears and re-enables the picker after an upload error', async () => {
  const input = { files: [{}], value: 'selected', disabled: false };
  await assert.rejects(context.uploadSelectedFile(input, async () => { throw new Error('upload failed'); }), /upload failed/);
  assert.equal(input.value, '');
  assert.equal(input.disabled, false);
});

test('does nothing when selection is cancelled', async () => {
  const input = { files: [], value: '', disabled: false };
  await context.uploadSelectedFile(input, () => { throw new Error('unexpected upload'); });
  assert.equal(input.disabled, false);
});
