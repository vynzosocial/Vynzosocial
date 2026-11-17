export function createCameraSwitcher({ getStream, replaceTrack = async () => {}, onChanged = () => {}, onError, constraints = {} }) {
  let switching = false;

  async function switchCamera() {
    if (switching) return;
    const stream = getStream();
    const oldTrack = stream?.getVideoTracks()[0];
    if (!oldTrack) {
      onError('Turn on your camera before switching cameras.');
      return;
    }
    switching = true;
    const current = () => getStream() === stream && stream.getVideoTracks().includes(oldTrack);
    const settings = oldTrack.getSettings?.() || {};
    let released = false;

    async function acquire(video) {
      const media = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      const track = media.getVideoTracks()[0];
      media.getTracks().filter(item => item !== track).forEach(item => item.stop());
      if (!track) throw new Error('The selected camera did not provide video.');
      return track;
    }

    async function install(track) {
      try {
        if (!current()) return false;
        track.enabled = oldTrack.enabled;
        await replaceTrack(oldTrack, track);
        if (!current()) return false;
        track.enabled = oldTrack.enabled;
        stream.removeTrack(oldTrack);
        stream.addTrack(track);
        onChanged(track);
        return true;
      } finally {
        if (!stream.getVideoTracks().includes(track) || getStream() !== stream) track.stop();
      }
    }

    try {
      let selection;
      if (settings.facingMode === 'user' || settings.facingMode === 'environment') {
        selection = { facingMode: { exact: settings.facingMode === 'user' ? 'environment' : 'user' } };
      } else {
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
        const index = devices.findIndex(device => device.deviceId === settings.deviceId);
        if (devices.length < 2) throw new Error('No other camera is available on this device.');
        selection = { deviceId: { exact: devices[(index + 1) % devices.length].deviceId } };
      }
      if (!current()) return;
      // Mobile devices often cannot open the other lens until the current one is released.
      oldTrack.stop();
      released = true;
      await install(await acquire({ ...constraints, ...selection }));
    } catch (error) {
      if (!current()) return;
      if (released) {
        try {
          const selection = settings.deviceId
            ? { deviceId: { exact: settings.deviceId } }
            : { facingMode: { exact: settings.facingMode || 'user' } };
          if (!await install(await acquire({ ...constraints, ...selection }))) return;
        } catch (restoreError) {
          console.error('Could not restore the camera:', restoreError);
          onError('Camera switching failed and the previous camera could not restart. Turn the camera off and on to retry.');
          return;
        }
      }
      console.error('Could not switch camera:', error);
      onError(error.message || 'Could not switch cameras. Check camera permissions and try again.');
    } finally {
      switching = false;
    }
  }

  return { switchCamera, get switching() { return switching; } };
}
