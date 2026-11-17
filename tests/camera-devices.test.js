const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/js/camera-devices.js'), 'utf8').replace(/^export /gm, '');

function track(settings = {}, enabled = true) {
  return {
    kind: 'video', enabled, readyState: 'live', stops: 0,
    getSettings: () => settings,
    stop() { this.stops++; this.readyState = 'ended'; }
  };
}

function setup({ settings = { facingMode: 'user', deviceId: 'front' }, enabled = true, devices = [] } = {}) {
  const original = track(settings, enabled);
  const microphone = { kind: 'audio', enabled: false, stop() { assert.fail('Microphone must not stop.'); } };
  const tracks = [original, microphone];
  const stream = {
    getTracks: () => [...tracks],
    getVideoTracks: () => tracks.filter(item => item.kind === 'video'),
    removeTrack(item) { tracks.splice(tracks.indexOf(item), 1); },
    addTrack(item) { tracks.push(item); }
  };
  let active = stream;
  const requests = [], changes = [], errors = [], replacements = [], acquired = [];
  const context = {
    navigator: { mediaDevices: {
      enumerateDevices: async () => devices,
      async getUserMedia(constraints) {
        requests.push(constraints);
        assert.equal(original.readyState, 'ended', 'Release the current lens before opening the next one.');
        const next = track({ facingMode: 'environment', deviceId: 'rear' });
        acquired.push(next);
        return { getTracks: () => [next], getVideoTracks: () => [next] };
      }
    } },
    console: { error() {} }
  };
  vm.runInNewContext(source, context);
  let replace = async (oldTrack, newTrack) => { replacements.push([oldTrack, newTrack]); };
  const options = {
    getStream: () => active,
    onChanged: item => changes.push(item),
    onError: message => errors.push(message),
    replaceTrack: (...args) => replace(...args)
  };
  const switcher = context.createCameraSwitcher(options);
  return { switcher, options, context, original, microphone, stream, requests, changes, errors, replacements, acquired,
    setReplace(callback) { replace = callback; },
    close() { active = null; stream.getTracks().forEach(item => { if (item.kind === 'video') item.stop(); }); } };
}

test('switches front/rear without requesting audio and preserves camera-off state', async () => {
  const state = setup({ enabled: false });
  await state.switcher.switchCamera();
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].video.facingMode.exact, 'environment');
  assert.equal(state.requests[0].audio, false);
  assert.equal(state.original.stops, 1);
  assert.equal(state.stream.getVideoTracks()[0], state.acquired[0]);
  assert.equal(state.acquired[0].enabled, false);
  assert.ok(state.stream.getTracks().includes(state.microphone));
  assert.equal(state.microphone.enabled, false);
  assert.equal(state.changes.length, 1);
  assert.equal(state.replacements.length, 1);
  await state.switcher.switchCamera();
  assert.equal(state.requests[1].video.facingMode.exact, 'user');
});

test('cycles physical webcams when facingMode is not reported', async () => {
  const state = setup({ settings: { deviceId: 'one' }, devices: [
    { kind: 'videoinput', deviceId: 'one' }, { kind: 'audioinput', deviceId: 'mic' }, { kind: 'videoinput', deviceId: 'two' }
  ] });
  await state.switcher.switchCamera();
  assert.equal(state.requests[0].video.deviceId.exact, 'two');
  assert.equal(state.errors.length, 0);
});

test('single-camera devices report the limitation without stopping video', async () => {
  const state = setup({ settings: { deviceId: 'only' }, devices: [{ kind: 'videoinput', deviceId: 'only' }] });
  await state.switcher.switchCamera();
  assert.equal(state.original.stops, 0);
  assert.equal(state.requests.length, 0);
  assert.match(state.errors[0], /No other camera/);
});

test('failed lens acquisition restarts the previous camera and reports the error', async () => {
  const state = setup();
  const acquire = state.context.navigator.mediaDevices.getUserMedia;
  let attempts = 0;
  state.context.navigator.mediaDevices.getUserMedia = async constraints => {
    if (++attempts === 1) throw new Error('Rear camera is unavailable.');
    assert.equal(constraints.video.deviceId.exact, 'front');
    return acquire(constraints);
  };
  await state.switcher.switchCamera();
  assert.equal(attempts, 2);
  assert.equal(state.stream.getVideoTracks()[0], state.acquired[0]);
  assert.equal(state.errors[0], 'Rear camera is unavailable.');
  assert.equal(state.switcher.switching, false);
});

test('replacement failure releases the rejected track and restores outgoing video', async () => {
  const state = setup();
  state.setReplace(async (_old, next) => {
    if (next === state.acquired[0]) throw new Error('Sender failed.');
  });
  await state.switcher.switchCamera();
  assert.equal(state.acquired[0].stops, 1);
  assert.equal(state.stream.getVideoTracks()[0], state.acquired[1]);
  assert.equal(state.errors[0], 'Sender failed.');
});

test('closing during acquisition stops the late stream without resurrecting the camera', async () => {
  const state = setup();
  let resolve;
  const late = track();
  state.context.navigator.mediaDevices.getUserMedia = () => new Promise(done => { resolve = done; });
  const switching = state.switcher.switchCamera();
  await state.switcher.switchCamera();
  state.close();
  resolve({ getTracks: () => [late], getVideoTracks: () => [late] });
  await switching;
  assert.equal(late.stops, 1);
  assert.equal(state.changes.length, 0);
  assert.equal(state.replacements.length, 0);
  assert.equal(state.errors.length, 0);
});

test('failed recovery explicitly tells the user to restart the camera', async () => {
  const state = setup();
  state.context.navigator.mediaDevices.getUserMedia = async () => { throw new Error('Permission denied'); };
  await state.switcher.switchCamera();
  assert.match(state.errors[0], /previous camera could not restart/);
  assert.equal(state.switcher.switching, false);
});
