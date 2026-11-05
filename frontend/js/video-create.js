import { openCamera } from './camera-capture.js';

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const CAPCUT_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.lemon.lvoverseas';
const CAPCUT_WEB_URL = 'https://www.capcut.com/editor';

const shareTarget = () => window.Capacitor?.Plugins?.ShareTarget;
const isNativeApp = () => Boolean(window.Capacitor?.isNativePlatform?.() && shareTarget());

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function openDialog(title) {
  const overlay = el('div', 'camera-overlay');
  const dialog = el('div', 'camera-dialog vc-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', title);
  const close = el('button', 'camera-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  dialog.append(close, el('h3', 'vc-title', title));
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const api = {
    dialog,
    onClose: null,
    close() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    }
  };
  const requestClose = () => { if (api.onClose ? api.onClose() !== false : true) api.close(); };
  function onKey(event) { if (event.key === 'Escape') requestClose(); }
  document.addEventListener('keydown', onKey);
  close.addEventListener('click', requestClose);
  overlay.addEventListener('click', event => { if (event.target === overlay) requestClose(); });
  return api;
}

function actionButton(label, hint, primary = false) {
  const button = el('button', `vc-action${primary ? ' is-primary' : ''}`);
  button.type = 'button';
  button.append(el('strong', '', label), el('small', '', hint));
  return button;
}

/** Entry point for the Video button: record directly, create with CapCut, or upload a file. */
export function openVideoOptions({ onFile, fileInput }) {
  const dialog = openDialog('Add a video');
  const record = actionButton('Record video', 'Use your camera, front or rear', true);
  const capcut = actionButton('Create with CapCut', 'Edit in CapCut, then share the finished video back');
  const upload = actionButton('Upload from device', 'Choose a video file you already have');
  dialog.dialog.append(record, capcut, upload);

  record.addEventListener('click', () => {
    dialog.close();
    openCamera(onFile, { videoOnly: true });
  });
  upload.addEventListener('click', () => {
    dialog.close();
    fileInput.click();
  });
  capcut.addEventListener('click', () => {
    dialog.close();
    openCapCutOptions({ fileInput });
  });
}

function openCapCutOptions({ fileInput }) {
  const dialog = openDialog('Create with CapCut');
  const note = el('p', 'vc-note');
  const status = el('p', 'vc-status');
  status.setAttribute('aria-live', 'polite');

  const back = (label, handler) => {
    const button = actionButton(label.title, label.hint, label.primary);
    button.addEventListener('click', handler);
    dialog.dialog.appendChild(button);
    return button;
  };

  if (isNativeApp()) {
    note.textContent = 'CapCut opens next. When your video is ready, export it, tap Share and choose Vynzo. It will come back here for you to review before posting.';
    dialog.dialog.appendChild(note);
    const run = async (method) => {
      status.textContent = '';
      try {
        const result = await shareTarget()[method]();
        if (result?.installed === false) {
          status.textContent = 'CapCut is not installed on this device. Install it, or upload a video you already have.';
          storeLink.hidden = false;
        } else {
          dialog.close();
        }
      } catch (error) {
        if (error?.message && !/cancel/i.test(error.message)) status.textContent = 'Could not open CapCut. You can upload a video from your device instead.';
      }
    };
    back({ title: 'Open CapCut', hint: 'Start a new video in CapCut', primary: true }, () => run('openCapCut'));
    back({ title: 'Edit an existing video', hint: 'Pick a video and send it to CapCut' }, () => run('editInCapCut'));
  } else {
    note.textContent = 'Edit your video in CapCut, export it, then come back and upload the exported file here. Opening CapCut from a browser is not supported on every device.';
    dialog.dialog.appendChild(note);
    const link = el('a', 'vc-action is-primary');
    link.href = CAPCUT_WEB_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.append(el('strong', '', 'Open CapCut editor'), el('small', '', 'Opens capcut.com in a new tab'));
    dialog.dialog.appendChild(link);
  }

  const storeLink = el('a', 'vc-link', 'Get CapCut on Google Play');
  storeLink.href = CAPCUT_PLAY_URL;
  storeLink.target = '_blank';
  storeLink.rel = 'noopener noreferrer';
  storeLink.hidden = true;

  back({ title: 'Choose exported video', hint: 'Upload the finished video from your device' }, () => {
    dialog.close();
    fileInput.click();
  });
  dialog.dialog.append(status, storeLink);
}

/**
 * Shows a received/selected video before posting. onPost must resolve true only when the
 * upload succeeded, so a failed upload keeps the video on screen instead of losing it.
 */
export function reviewVideo(file, { onPost, captionInput }) {
  const dialog = openDialog('Review your video');
  const url = URL.createObjectURL(file);
  const video = el('video', 'vc-preview');
  video.src = url;
  video.controls = true;
  video.playsInline = true;

  const caption = el('textarea', 'vc-caption');
  caption.maxLength = 500;
  caption.rows = 3;
  caption.placeholder = 'Write a description and #hashtags (optional)';
  caption.value = captionInput?.value || '';

  const status = el('p', 'vc-status');
  status.setAttribute('aria-live', 'polite');
  const actions = el('div', 'vc-row');
  const post = el('button', 'camera-use', 'Post');
  post.type = 'button';
  const discard = el('button', 'camera-retake', 'Discard');
  discard.type = 'button';
  actions.append(discard, post);
  dialog.dialog.append(video, caption, status, actions);

  let busy = false;
  const finish = () => { URL.revokeObjectURL(url); dialog.close(); };
  dialog.onClose = () => {
    if (busy) return false;
    if (!window.confirm('Discard this video? It will not be posted.')) return false;
    URL.revokeObjectURL(url);
    return true;
  };
  discard.addEventListener('click', () => { if (dialog.onClose()) dialog.close(); });
  post.addEventListener('click', async () => {
    busy = true;
    post.disabled = discard.disabled = true;
    status.textContent = 'Uploading...';
    if (captionInput) captionInput.value = caption.value;
    const ok = await onPost(file);
    busy = false;
    post.disabled = discard.disabled = false;
    if (ok) finish();
    else status.textContent = (document.getElementById('post-upload-status')?.textContent || 'Upload failed.') + ' Your video is still here, so you can try again.';
  });
}

/** Receives videos shared to Vynzo from other Android apps such as CapCut. */
export function initSharedVideoReceiver({ onPost, captionInput }) {
  const plugin = shareTarget();
  if (!plugin?.addListener) return;

  plugin.addListener('sharedVideo', async (data) => {
    if (!localStorage.getItem('vynzo_token')) {
      window.alert('Log in to Vynzo, then share the video again to post it.');
      window.location.href = './pages/login.html';
      return;
    }
    for (const error of data?.errors || []) window.alert(error);
    for (const item of data?.files || []) {
      try {
        const response = await fetch(window.Capacitor.convertFileSrc(item.path));
        const blob = await response.blob();
        if (blob.size > MAX_VIDEO_BYTES) throw new Error('too large');
        reviewVideo(new File([blob], item.name || `shared-${Date.now()}.mp4`, { type: item.mimeType || blob.type || 'video/mp4' }), { onPost, captionInput });
      } catch (error) {
        window.alert('Could not open the shared video. Try exporting it again or upload it from your device.');
      }
    }
  });
}
