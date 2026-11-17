const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'messages.js'), 'utf8');
const traceSource = source.slice(source.indexOf('function traceStickerSelection('), source.indexOf('function canvasToBlob('));
const context = {};
vm.runInNewContext(`${traceSource}\nthis.trace = traceStickerSelection;`, context);

test('free line stays open during drawing and closes when completed', () => {
  const calls = [];
  const drawing = {
    moveTo: (...point) => calls.push(['move', ...point]),
    lineTo: (...point) => calls.push(['line', ...point]),
    closePath: () => calls.push(['close'])
  };
  const selection = { mode: 'free', points: [{ x: 1, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 9 }] };
  context.trace(drawing, selection, 10, 10, false);
  assert.deepEqual(calls, [['move', 1, 2], ['line', 8, 2], ['line', 8, 9]]);
  calls.length = 0;
  context.trace(drawing, selection, 10, 10);
  assert.deepEqual(calls, [['move', 1, 2], ['line', 8, 2], ['line', 8, 9], ['close']]);
});
