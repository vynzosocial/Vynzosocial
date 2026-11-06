const SIZE = 256;
const MAX_MASK_AGE = 1500;

export async function createBackgroundRenderer(video, background, signal, onError) {
  const moduleUrl = new URL('../vendor/human/human.esm.js', import.meta.url);
  moduleUrl.searchParams.set('background', `${Date.now()}-${Math.random()}`);
  const { Human } = await import(moduleUrl.href);
  if (signal.aborted) throw new Error('Background setup was cancelled.');
  const human = new Human({ backend: 'webgl' });
  const tf = human.tf;
  let model;
  let stopped = false;
  let detecting = false;
  let loading = false;
  let timeout = null;
  let latestAt = 0;
  let disposed = false;
  const snapshot = document.createElement('canvas');
  snapshot.width = SIZE;
  snapshot.height = SIZE;
  const snapshotContext = snapshot.getContext('2d');
  const person = document.createElement('canvas');
  person.width = SIZE;
  person.height = SIZE;
  const personContext = person.getContext('2d');
  const mask = document.createElement('canvas');
  mask.width = SIZE;
  mask.height = SIZE;
  const maskContext = mask.getContext('2d');
  if (!snapshotContext || !personContext || !maskContext) throw new Error('Background effects are not supported.');
  const dispose = () => {
    if (disposed || detecting || loading) return;
    disposed = true;
    if (model) model.dispose();
    if (tf.getBackend() === 'webgl') tf.removeBackend('webgl');
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timeout);
    dispose();
  };
  try {
    await tf.setBackend('webgl');
    await tf.ready();
    if (signal.aborted) throw new Error('Background setup was cancelled.');
    loading = true;
    const load = tf.loadGraphModel(new URL('../assets/live-background-model/selfie.json', import.meta.url).href);
    load.then(loaded => {
      model = loaded;
      loading = false;
      if (stopped) dispose();
    }, () => {
      loading = false;
      if (stopped) dispose();
    });
    let timer;
    let abort;
    try {
      await Promise.race([
        load,
        new Promise((_, reject) => {
          abort = () => reject(new Error('Background setup was cancelled.'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => reject(new Error('Background model took too long to load.')), 20000);
        })
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
    if (signal.aborted) throw new Error('Background setup was cancelled.');
    const detect = async () => {
      if (stopped) return;
      detecting = true;
      let output;
      let watchdog = setTimeout(() => {
        if (!stopped) {
          stop();
          onError(new Error('Background processing stopped responding.'));
        }
      }, 15000);
      try {
        snapshotContext.drawImage(video, 0, 0, SIZE, SIZE);
        output = tf.tidy(() => {
          const pixels = tf.browser.fromPixels(snapshot);
          const input = tf.expandDims(tf.div(tf.cast(pixels, 'float32'), 255), 0);
          return model.execute(input);
        });
        const values = await output.data();
        if (stopped) return;
        if (values.length !== SIZE * SIZE) throw new Error('Unexpected background model output.');
        const pixels = maskContext.createImageData(SIZE, SIZE);
        for (let i = 0; i < values.length; i++) {
          const value = values[i];
          if (!Number.isFinite(value)) throw new Error('Invalid background mask.');
          pixels.data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, (value - 0.25) / 0.5)) * 255);
        }
        maskContext.putImageData(pixels, 0, 0);
        personContext.globalCompositeOperation = 'source-over';
        personContext.clearRect(0, 0, SIZE, SIZE);
        personContext.drawImage(snapshot, 0, 0);
        personContext.globalCompositeOperation = 'destination-in';
        personContext.drawImage(mask, 0, 0);
        personContext.globalCompositeOperation = 'source-over';
        latestAt = performance.now();
      } catch (error) {
        if (!stopped) {
          stop();
          onError(error);
        }
      } finally {
        clearTimeout(watchdog);
        if (output) output.dispose();
        detecting = false;
        if (stopped) dispose();
        else timeout = setTimeout(detect, 50);
      }
    };
    timeout = setTimeout(detect, 0);
    return {
      draw(ctx, width, height) {
        ctx.fillStyle = '#171724';
        ctx.fillRect(0, 0, width, height);
        if (typeof background === 'string') {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, width, height);
        } else {
          const scale = Math.max(width / background.naturalWidth, height / background.naturalHeight);
          const w = background.naturalWidth * scale, h = background.naturalHeight * scale;
          ctx.drawImage(background, (width - w) / 2, (height - h) / 2, w, h);
        }
        if (latestAt && performance.now() - latestAt < MAX_MASK_AGE) ctx.drawImage(person, 0, 0, width, height);
      },
      stop
    };
  } catch (error) {
    stop();
    throw error;
  }
}
