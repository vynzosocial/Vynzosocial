const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/live.js'), 'utf8');
const handler = source.slice(source.indexOf("  socket.off('live_camera_state');"), source.indexOf("\n  socket.off('live_guest_joined');"));

test('camera-off signal shows the profile and ignores our own signal', () => {
  let listener;
  const states = new Map();
  const classes = new Set();
  const tile = {
    frame: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
    video: { srcObject: { getVideoTracks: () => [{ readyState: 'live', muted: false }] } }
  };
  const context = {
    socket: { id: 'self', off() {}, on(_event, fn) { listener = fn; } },
    remoteCameraStates: states,
    ensureVideoTile: () => tile
  };
  vm.runInNewContext(handler, context);
  listener({ socketId: 'host', enabled: false });
  assert.equal(states.get('host'), false);
  assert.equal(classes.has('camera-off'), true);
  listener({ socketId: 'self', enabled: true });
  assert.equal(classes.has('camera-off'), true);
  listener({ socketId: 'host', enabled: true });
  assert.equal(states.get('host'), true);
  assert.equal(classes.has('camera-off'), false);
});
