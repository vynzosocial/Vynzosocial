const EYES = [
  { upper: [33, 246, 161, 160, 159, 158, 157, 173, 133], lower: [133, 155, 154, 153, 145, 144, 163, 7, 33], iris: 473, brow: [70, 63, 105, 66, 107, 55] },
  { upper: [263, 466, 388, 387, 386, 385, 384, 398, 362], lower: [362, 382, 381, 380, 374, 373, 390, 249, 263], iris: 468, brow: [300, 293, 334, 296, 336, 285] }
];
const FACE_OUTLINE = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const LIPS_OUTLINE = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];

function appendPath(ctx, mesh, indices) {
  const points = indices.map(index => mesh[index]);
  if (points.some(point => !point)) return false;
  ctx.moveTo(points[0][0], points[0][1]);
  for (const point of points.slice(1)) ctx.lineTo(point[0], point[1]);
  ctx.closePath();
  return true;
}

function polygon(ctx, mesh, indices, color, alpha) {
  const points = indices.map(index => mesh[index]);
  if (points.some(point => !point)) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const point of points.slice(1)) ctx.lineTo(point[0], point[1]);
  ctx.closePath();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fill();
}

function line(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const point of points.slice(1)) ctx.lineTo(point[0], point[1]);
  ctx.stroke();
}

export function drawFaceEffect(ctx, face, name, scaleX, scaleY, video) {
  const mesh = face?.mesh;
  if (!mesh || mesh.length < 468) return;
  ctx.save();
  ctx.scale(scaleX, scaleY);
  if (name === 'skin' && video) {
    ctx.beginPath();
    const paths = [FACE_OUTLINE, ...EYES.map(eye => [...eye.upper, ...eye.lower]), LIPS_OUTLINE];
    if (paths.every(indices => appendPath(ctx, mesh, indices))) {
      ctx.clip('evenodd');
      ctx.filter = 'blur(3px)';
      ctx.globalAlpha = 0.4;
      ctx.drawImage(video, 0, 0, ctx.canvas.width / scaleX, ctx.canvas.height / scaleY);
    }
  }
  if (name === 'lipstick' || name === 'party') {
    polygon(ctx, mesh, [61,185,40,39,37,0,267,269,270,409,291,308,415,310,311,312,13,82,81,80,191,78], '#c72e62', 0.53);
    polygon(ctx, mesh, [61,146,91,181,84,17,314,405,321,375,291,308,324,318,402,317,14,87,178,88,95,78], '#c72e62', 0.53);
  }
  if (name === 'blush' || name === 'party') {
    for (const index of [205, 425]) {
      const point = mesh[index];
      const radius = Math.max(2, face.box[2] * 0.095);
      const gradient = ctx.createRadialGradient(point[0], point[1], 0, point[0], point[1], radius);
      gradient.addColorStop(0, 'rgba(242,80,113,0.38)');
      gradient.addColorStop(1, 'rgba(242,80,113,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.ellipse(point[0], point[1], radius, radius * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (['eyeshadow', 'eyeliner', 'lashes', 'eyebrows', 'eyes-blue', 'eyes-green', 'eyes-violet'].includes(name)) {
    for (const eye of EYES) {
      const upper = eye.upper.map(index => mesh[index]);
      const lower = eye.lower.map(index => mesh[index]);
      if (upper.some(point => !point) || lower.some(point => !point)) continue;
      const width = Math.hypot(upper[0][0] - upper[upper.length - 1][0], upper[0][1] - upper[upper.length - 1][1]);
      const opening = Math.hypot(upper[4][0] - lower[4][0], upper[4][1] - lower[4][1]);
      if (width < 2) continue;
      if (name === 'eyeshadow') {
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = '#9b55b9';
        ctx.lineWidth = width * 0.22;
        ctx.lineCap = 'round';
        line(ctx, upper.slice(1, -1).map(point => [point[0], point[1] - width * 0.1]));
      } else if (name === 'eyeliner' || name === 'lashes') {
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = '#24202a';
        ctx.lineWidth = Math.max(1, width * 0.04);
        ctx.lineCap = 'round';
        line(ctx, upper);
        if (name === 'lashes') {
          for (const point of upper.slice(2, 7)) line(ctx, [point, [point[0], point[1] - width * 0.12]]);
        }
      } else if (name === 'eyebrows') {
        const brow = eye.brow.map(index => mesh[index]);
        if (brow.every(Boolean)) {
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = '#4b3029';
          ctx.lineWidth = Math.max(1, width * 0.12);
          ctx.lineCap = 'round';
          line(ctx, brow);
        }
      } else if (opening > width * 0.1) {
        const center = mesh[eye.iris], edge = mesh[eye.iris + 1];
        if (!center || !edge) continue;
        const radius = Math.hypot(center[0] - edge[0], center[1] - edge[1]);
        if (radius < 0.5 || radius > width * 0.35) continue;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(upper[0][0], upper[0][1]);
        for (const point of [...upper.slice(1), ...lower]) ctx.lineTo(point[0], point[1]);
        ctx.closePath();
        ctx.clip();
        ctx.beginPath();
        ctx.ellipse(center[0], center[1], radius * 0.66, radius * 0.66, 0, 0, Math.PI * 2);
        ctx.globalAlpha = 0.65;
        ctx.strokeStyle = { 'eyes-blue': '#4ba9ee', 'eyes-green': '#4bc788', 'eyes-violet': '#b36be8' }[name];
        ctx.lineWidth = radius * 0.65;
        ctx.stroke();
        ctx.restore();
      }
    }
  }
  if (name === 'hat') {
    const left = mesh[127], right = mesh[356], forehead = mesh[10];
    if (left && right && forehead) {
      const width = Math.hypot(right[0] - left[0], right[1] - left[1]);
      const angle = Math.atan2(right[1] - left[1], right[0] - left[0]);
      ctx.save();
      ctx.translate(forehead[0], forehead[1]);
      ctx.rotate(angle);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#bc47da';
      ctx.beginPath();
      ctx.moveTo(-width * 0.35, 0);
      ctx.lineTo(0, -width * 0.8);
      ctx.lineTo(width * 0.35, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#ffdc6b';
      ctx.lineWidth = Math.max(2, width * 0.06);
      line(ctx, [[-width * 0.38, 0], [width * 0.38, 0]]);
      ctx.restore();
    }
  }
  if (name === 'stars') {
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#ffd95b';
    for (const index of [205, 425]) {
      const point = mesh[index];
      const radius = Math.max(2, face.box[2] * 0.06);
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? radius * 0.45 : radius;
        const angle = -Math.PI / 2 + i * Math.PI / 5;
        const x = point[0] + Math.cos(angle) * r;
        const y = point[1] + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
  if (name === 'glasses' || name === 'party') {
    const a = mesh[33], b = mesh[263], centerA = mesh[159], centerB = mesh[386];
    if (a && b && centerA && centerB) {
      const radius = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.23;
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = name === 'party' ? '#f4c846' : '#1c1720';
      ctx.lineWidth = Math.max(2, radius * 0.12);
      ctx.beginPath();
      ctx.ellipse(centerA[0], centerA[1], radius, radius * 0.75, 0, 0, Math.PI * 2);
      ctx.ellipse(centerB[0], centerB[1], radius, radius * 0.75, 0, 0, Math.PI * 2);
      ctx.moveTo(centerA[0] + radius, centerA[1]);
      ctx.lineTo(centerB[0] - radius, centerB[1]);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export async function createFaceTracker(video, signal, onError, { iris = false } = {}) {
  const moduleUrl = new URL('../vendor/human/human.esm.js', import.meta.url);
  moduleUrl.searchParams.set('session', `${Date.now()}-${Math.random()}`);
  const { Human } = await import(moduleUrl.href);
  if (signal.aborted) throw new Error('Face effects setup was cancelled.');
  const human = new Human({
    backend: 'webgl',
    modelBasePath: new URL('../vendor/human/models/', import.meta.url).href,
    wasmPath: new URL('../vendor/human/', import.meta.url).href,
    cacheModels: false,
    filter: { enabled: false },
    face: { enabled: true, iris: { enabled: iris }, emotion: { enabled: false }, description: { enabled: false } },
    body: { enabled: false }, hand: { enabled: false }, object: { enabled: false },
    gesture: { enabled: false }, segmentation: { enabled: false }
  });
  let stopped = false;
  let detecting = false;
  let timer = null;
  let latest = null;
  let latestAt = 0;
  let input;
  let disposed = false;
  let loading = true;
  const dispose = () => {
    if (disposed || loading || detecting) return;
    disposed = true;
    const loaded = new Set(human.models.stats().modelStats.filter(model => model.loaded).map(model => model.name));
    for (const [name, model] of Object.entries(human.models.models)) {
      if (model && loaded.has(name)) model.dispose();
    }
    human.models.reset();
    if (human.tf.getBackend() === 'webgl') human.tf.removeBackend('webgl');
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    latest = null;
    dispose();
  };
  try {
    const load = human.load();
    load.then(() => {
      loading = false;
      if (stopped) dispose();
    }, () => {
      loading = false;
      if (stopped) dispose();
    });
    let timeout;
    let abort;
    try {
      await Promise.race([
        load,
        new Promise((_, reject) => {
          abort = () => reject(new Error('Face effects setup was cancelled.'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
          timeout = setTimeout(() => reject(new Error('Face effects models took too long to load.')), 20000);
        })
      ]);
    } catch (error) {
      stopped = true;
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
    if (signal.aborted) throw new Error('Face effects setup was cancelled.');
    const stats = human.models.stats().modelStats;
    const required = iris ? ['blazeface', 'facemesh', 'iris'] : ['blazeface', 'facemesh'];
    if (!required.every(name => stats.some(model => model.name === name && model.loaded))) {
      throw new Error('Face effects models could not be loaded.');
    }
    input = document.createElement('canvas');
    const scale = Math.min(1, 640 / video.videoWidth, 480 / video.videoHeight);
    input.width = Math.max(1, Math.round(video.videoWidth * scale));
    input.height = Math.max(1, Math.round(video.videoHeight * scale));
    const inputContext = input.getContext('2d');
    if (!inputContext) throw new Error('Face effects are not supported by this browser.');
    const detect = async () => {
      if (stopped) return;
      detecting = true;
      const watchdog = setTimeout(() => {
        if (!stopped) {
          stop();
          onError(new Error('Face tracking stopped responding.'));
        }
      }, 15000);
      try {
        inputContext.drawImage(video, 0, 0, input.width, input.height);
        const result = await human.detect(input);
        if (!stopped) {
          latest = result.face[0] || null;
          latestAt = performance.now();
        }
      } catch (error) {
        if (!stopped) {
          stop();
          onError(error);
        }
      } finally {
        clearTimeout(watchdog);
        detecting = false;
        if (stopped) dispose();
        else timer = setTimeout(detect, 80);
      }
    };
    timer = setTimeout(detect, 0);
    return {
      hasIris: iris,
      draw(ctx, name, width, height) {
        if (latest && performance.now() - latestAt < 1000) {
          drawFaceEffect(ctx, latest, name, width / input.width, height / input.height, video);
        }
      },
      stop
    };
  } catch (error) {
    stop();
    throw error;
  }
}
