export function createAudioDevices({ getTrack, replaceTrack, getOutputs, onError }) {
  let selectedInput = '';
  let selectedOutput = '';
  let dialog = null;
  let dialogStatus = null;
  let changing = false;
  let generation = 0;
  const mediaDevices = navigator.mediaDevices;

  function reportError(message) {
    if (dialogStatus) dialogStatus.textContent = message;
    onError(message);
  }

  mediaDevices?.addEventListener?.('devicechange', async () => {
    if (!selectedInput && !selectedOutput) return;
    try {
      const devices = await mediaDevices.enumerateDevices();
      const inputMissing = selectedInput && !devices.some(device => device.kind === 'audioinput' && device.deviceId === selectedInput);
      const outputMissing = selectedOutput && !devices.some(device => device.kind === 'audiooutput' && device.deviceId === selectedOutput);
      if (inputMissing) selectedInput = '';
      if (outputMissing) {
        selectedOutput = '';
        const results = await Promise.allSettled(getOutputs().map(element => element.setSinkId('')));
        if (results.some(result => result.status === 'rejected')) {
          console.error('Unable to restore the default audio output:', results);
          reportError('The selected speaker disconnected and the default output could not be restored. Check your device audio settings.');
          return;
        }
      }
      if (inputMissing || outputMissing) {
        reportError('A selected audio device was disconnected. Check your device audio settings.');
      }
    } catch (error) {
      console.error('Unable to check audio devices:', error);
      reportError('Unable to check audio devices. Check your device audio settings.');
    }
  });

  function audioConstraints(base) {
    return selectedInput ? { ...base, deviceId: { exact: selectedInput } } : base;
  }

  async function applyOutput(element) {
    if (!selectedOutput || typeof element.setSinkId !== 'function') return;
    try {
      await element.setSinkId(selectedOutput);
    } catch (error) {
      console.error('Unable to apply audio output:', error);
      reportError('Unable to use the selected speaker. Check your device audio settings.');
    }
  }

  async function switchInput(deviceId) {
    if (changing) return;
    const oldTrack = getTrack();
    if (!oldTrack) {
      selectedInput = deviceId;
      if (dialogStatus) dialogStatus.textContent = 'Microphone selected. It will be used when you join the stage or start your camera.';
      return;
    }
    changing = true;
    const requestGeneration = generation;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      } });
      const newTrack = stream.getAudioTracks()[0];
      if (!newTrack) throw new Error('No microphone track was returned.');
      if (requestGeneration !== generation || getTrack() !== oldTrack) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      newTrack.enabled = false;
      await replaceTrack(oldTrack, newTrack);
      newTrack.enabled = oldTrack.enabled;
      selectedInput = deviceId;
      oldTrack.stop();
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      console.error('Unable to change microphone:', error);
      reportError('Could not change microphone. Check its connection and permissions.');
    } finally {
      changing = false;
    }
  }

  async function open() {
    close();
    if (!navigator.mediaDevices?.enumerateDevices) {
      onError('Use your device audio settings to select your microphone and speaker.');
      return;
    }
    if (!document.getElementById('vynzo-audio-device-css')) {
      const style = document.createElement('link');
      style.id = 'vynzo-audio-device-css';
      style.rel = 'stylesheet';
      style.href = new URL('../css/audio-devices.css?v=1', import.meta.url).href;
      document.head.append(style);
    }
    const panel = document.createElement('section');
    dialog = panel;
    panel.className = 'audio-device-dialog';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Audio devices');
    const heading = document.createElement('strong');
    heading.textContent = 'Audio devices';
    const status = document.createElement('p');
    status.textContent = 'Connect your headphones. If selection is unavailable, use your device audio controls.';
    status.setAttribute('role', 'status');
    dialogStatus = status;
    const label = document.createElement('label');
    label.textContent = 'Microphone ';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Microphone');
    label.append(select);
    panel.append(heading, status, label);
    if (navigator.mediaDevices.selectAudioOutput && typeof HTMLMediaElement.prototype.setSinkId === 'function') {
      const output = document.createElement('button');
      output.type = 'button';
      output.textContent = 'Choose speaker or headphones';
      output.addEventListener('click', async () => {
        try {
          const device = await navigator.mediaDevices.selectAudioOutput();
          const elements = getOutputs();
          const previous = selectedOutput;
          const results = await Promise.allSettled(elements.map(element => element.setSinkId(device.deviceId)));
          const failure = results.find(result => result.status === 'rejected');
          if (failure) {
            const restored = await Promise.allSettled(elements.map(element => element.setSinkId(previous)));
            if (restored.some(result => result.status === 'rejected')) {
              console.error('Unable to restore the previous audio output:', restored);
            }
            throw failure.reason;
          }
          selectedOutput = device.deviceId;
          status.textContent = `Audio output: ${device.label || 'selected device'}`;
        } catch (error) {
          if (error.name === 'AbortError') return;
          console.error('Unable to select audio output:', error);
          reportError('Could not change audio output. Use your device audio settings.');
        }
      });
      panel.append(output);
    }
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = 'Close';
    closeButton.addEventListener('click', close);
    panel.append(closeButton);
    document.body.append(panel);
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const microphones = devices.filter(device => device.kind === 'audioinput');
      for (const [index, device] of microphones.entries()) {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${index + 1}`;
        select.append(option);
      }
      const current = getTrack()?.getSettings().deviceId || selectedInput;
      if (microphones.some(device => device.deviceId === current)) select.value = current;
      select.disabled = !microphones.length;
      select.addEventListener('change', async () => {
        select.disabled = true;
        await switchInput(select.value);
        const actual = getTrack()?.getSettings().deviceId || selectedInput;
        if (actual) select.value = actual;
        if (select.isConnected) select.disabled = !microphones.length;
      });
    } catch (error) {
      console.error('Unable to list audio devices:', error);
      select.disabled = true;
      reportError('Could not list audio devices. Check browser permissions.');
    }
  }

  function close() {
    dialog?.remove();
    dialog = null;
    dialogStatus = null;
  }

  function reset() {
    generation += 1;
    close();
    selectedInput = '';
    selectedOutput = '';
  }

  return { open, close, reset, applyOutput, audioConstraints };
}
