import { openCamera } from './camera-capture.js';
import {
  DURATION_OPTIONS,
  MIN_DURATION_SECONDS,
  createVideoFromImages,
  recordAudioFromMicrophone,
  getAvailableTransitions
} from './image-to-video.js';

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

export function openPhotoOptions({ onFile, fileInput }) {
  const dialog = openDialog('Add image');
  const capture = actionButton('Take photo', 'Use your camera, front or rear', true);
  const upload = actionButton('Upload image', 'Choose a photo or GIF from your device');
  capture.addEventListener('click', () => {
    dialog.close();
    openCamera(onFile, { photoOnly: true });
  });
  upload.addEventListener('click', () => {
    dialog.close();
    fileInput.click();
  });
  dialog.dialog.append(capture, upload);
}

/**
 * Create a video from images with audio
 */
export function openCreateVideoFromImages({ onFile, imageInput, audioVideoInput }) {
  const dialog = openDialog('Create video from images');
  const note = el('p', 'vc-note');
  note.textContent = 'Select one or more images, choose the length and audio. The video is made on your device and you can preview it before posting.';
  dialog.dialog.appendChild(note);

  const imageFiles = [];
  let audioSource = null;
  let audioUrl = null;
  const durationSelect = el('select', 'vc-select');
  DURATION_OPTIONS.forEach(seconds => {
    const option = document.createElement('option');
    option.value = String(seconds);
    option.textContent = `${seconds} seconds`;
    durationSelect.appendChild(option);
  });
  durationSelect.value = '30';
  const transitionSelect = el('select', 'vc-select');
  const transitions = getAvailableTransitions();
  transitions.forEach(t => {
    const option = document.createElement('option');
    option.value = t.value;
    option.textContent = t.label;
    transitionSelect.appendChild(option);
  });

  const selectImages = actionButton('Select images', 'Choose one or more images', true);
  const selectAudio = actionButton('Select audio source', 'Choose audio, extract from video, or record');
  const createBtn = actionButton('Create video', 'Generate video with selected images and audio');
  const audioPicker = el('div', 'vc-audio-picker');
  audioPicker.hidden = true;
  let audioPreview = el('audio', 'vc-audio-preview');
  audioPreview.controls = true;
  audioPreview.preload = 'metadata';
  const timelineLabel = el('p', 'vc-label', 'Audio selection: pink is start, purple is end');
  const timeline = el('div', 'vc-audio-timeline');
  const audioStart = el('input', 'vc-audio-start');
  audioStart.type = 'range';
  audioStart.min = '0';
  audioStart.step = 'any';
  audioStart.setAttribute('aria-label', 'Audio start');
  const audioEnd = el('input', 'vc-audio-end');
  audioEnd.type = 'range';
  audioEnd.min = '0';
  audioEnd.step = 'any';
  audioEnd.setAttribute('aria-label', 'Audio end');
  timeline.append(audioStart, audioEnd);
  const segmentText = el('p', 'vc-note');
  segmentText.setAttribute('aria-live', 'polite');
  const playSegment = el('button', 'camera-retake', 'Play selected segment');
  playSegment.type = 'button';
  audioPicker.append(audioPreview, timelineLabel, timeline, segmentText, playSegment);

  const formatTime = seconds => {
    const tenths = Math.round(seconds * 10);
    const whole = Math.floor(tenths / 10);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${tenths % 10}`;
  };
  const updateSegment = () => {
    if (!audioSource || !Number.isFinite(audioSource.duration)) return;
    audioSource.start = Number(audioStart.value);
    audioSource.end = Number(audioEnd.value);
    const length = audioSource.end - audioSource.start;
    const limit = Number(durationSelect.value);
    timeline.style.setProperty('--audio-start', `${audioSource.start / audioSource.duration * 100}%`);
    timeline.style.setProperty('--audio-end', `${audioSource.end / audioSource.duration * 100}%`);
    audioStart.setAttribute('aria-valuetext', formatTime(audioSource.start));
    audioEnd.setAttribute('aria-valuetext', formatTime(audioSource.end));
    if (length < MIN_DURATION_SECONDS) {
      segmentText.textContent = `Start: ${formatTime(audioSource.start)}, end: ${formatTime(audioSource.end)}. End must be at least half a second after start.`;
    } else if (length > limit) {
      segmentText.textContent = `Selected: ${formatTime(audioSource.start)} – ${formatTime(audioSource.end)} (${length.toFixed(1)} seconds). Choose at most ${limit} seconds.`;
    } else {
      segmentText.textContent = `Selected: ${formatTime(audioSource.start)} – ${formatTime(audioSource.end)}. Video duration: ${length.toFixed(1)} seconds.`;
    }
    playSegment.disabled = createBtn.disabled = length < MIN_DURATION_SECONDS || length > limit;
  };
  const clearAudio = () => {
    audioPreview.onloadedmetadata = null;
    audioPreview.onerror = null;
    audioPreview.pause();
    audioPreview.removeAttribute('src');
    audioPreview.load();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  };
  dialog.onClose = () => { clearAudio(); return true; };
  audioStart.addEventListener('input', () => { audioPreview.pause(); updateSegment(); });
  audioEnd.addEventListener('input', () => { audioPreview.pause(); updateSegment(); });
  durationSelect.addEventListener('change', () => { audioPreview.pause(); updateSegment(); });
  playSegment.addEventListener('click', async () => {
    if (!audioSource || !Number.isFinite(audioSource.duration)) return;
    try {
      audioPreview.currentTime = audioSource.start;
      await audioPreview.play();
    } catch (error) {
      segmentText.textContent = `Could not play audio preview: ${error.message}`;
    }
  });
  const stopAtSegmentEnd = () => {
    if (audioSource && audioPreview.currentTime >= audioSource.end) {
      audioPreview.pause();
    }
  };
  audioPreview.addEventListener('timeupdate', stopAtSegmentEnd);

  selectImages.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      imageFiles.length = 0;
      imageFiles.push(...files);
      selectImages.querySelector('strong').textContent = `${imageFiles.length} image(s) selected`;
    };
    input.click();
  });

  selectAudio.addEventListener('click', () => {
    openAudioSourceDialog({ audioVideoInput, onAudioSelected: (selected) => {
      clearAudio();
      audioSource = selected;
      selectAudio.querySelector('strong').textContent = selected?.label || 'No audio';
      audioPicker.hidden = !selected;
      if (!selected) {
        createBtn.disabled = false;
        return;
      }
      const newPreview = el(selected.type === 'extracted' ? 'video' : 'audio', 'vc-audio-preview');
      newPreview.controls = true;
      newPreview.preload = 'metadata';
      newPreview.playsInline = true;
      newPreview.addEventListener('timeupdate', stopAtSegmentEnd);
      audioPreview.replaceWith(newPreview);
      audioPreview = newPreview;
      audioStart.disabled = audioEnd.disabled = playSegment.disabled = createBtn.disabled = true;
      segmentText.textContent = 'Loading audio preview...';
      audioUrl = URL.createObjectURL(selected.file || selected.blob);
      audioPreview.src = audioUrl;
      audioPreview.onloadedmetadata = async () => {
        let duration = audioPreview.duration;
        if ((!Number.isFinite(duration) || duration <= 0) && selected.blob) {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (AudioContextClass) {
            const context = new AudioContextClass();
            try {
              duration = (await context.decodeAudioData(await selected.blob.arrayBuffer())).duration;
            } catch (error) {
              segmentText.textContent = `Cannot read audio duration: ${error.message}`;
            } finally {
              await context.close();
            }
          }
        }
        if (audioSource !== selected) return;
        if (!Number.isFinite(duration) || duration < MIN_DURATION_SECONDS) {
          segmentText.textContent = 'Audio must be at least half a second long. Choose another file.';
          return;
        }
        selected.duration = duration;
        audioStart.max = String(duration);
        audioStart.value = '0';
        audioEnd.max = String(duration);
        audioEnd.value = String(Math.min(duration, Number(durationSelect.value)));
        audioStart.disabled = audioEnd.disabled = playSegment.disabled = createBtn.disabled = false;
        updateSegment();
      };
      audioPreview.onerror = () => {
        segmentText.textContent = 'This audio cannot be previewed on this device. Choose another file.';
      };
    } });
  });

  createBtn.addEventListener('click', async () => {
    if (imageFiles.length === 0) {
      alert('Please select at least one image.');
      return;
    }

    const transition = transitionSelect.value;
    const maxSeconds = Number(durationSelect.value);
    const controls = [selectImages, selectAudio, createBtn, durationSelect, transitionSelect, audioStart, audioEnd, playSegment];

    audioPreview.pause();
    dialog.onClose = () => false; // Prevent closing while rendering
    controls.forEach(control => { control.disabled = true; });

    const status = el('p', 'vc-status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Creating video... keep this screen open.';
    dialog.dialog.appendChild(status);

    try {
      const transitions = imageFiles.map(() => transition);
      const videoFile = await createVideoFromImages(imageFiles, audioSource, transitions, (progress) => {
        status.textContent = `Creating video... ${progress || 0}%`;
      }, { maxSeconds });

      if (videoFile.size > MAX_VIDEO_BYTES) {
        throw new Error('The generated video is larger than 50 MB. Choose a shorter length or fewer images.');
      }

      clearAudio();
      dialog.onClose = null;
      dialog.close();
      reviewVideo(videoFile, { onPost: onFile, captionInput: document.getElementById('post-caption') });
    } catch (error) {
      dialog.onClose = () => { clearAudio(); return true; };
      status.textContent = `Error: ${error.message}`;
      controls.forEach(control => { control.disabled = false; });
      updateSegment();
    }
  });

  dialog.dialog.append(
    el('label', 'vc-label', 'Video length:'),
    durationSelect,
    el('label', 'vc-label', 'Transition effect:'),
    transitionSelect,
    selectImages,
    selectAudio,
    audioPicker,
    createBtn
  );
}

/**
 * Audio source selection dialog
 */
function openAudioSourceDialog({ audioVideoInput, onAudioSelected }) {
  const dialog = openDialog('Select audio source');
  const extractAudio = actionButton('Extract from video', 'Choose a video file to extract audio from', true);
  const chooseAudio = actionButton('Choose audio file', 'Choose a sound file from your device');
  const recordAudio = actionButton('Record audio', 'Record voice using your device microphone');
  const noAudio = actionButton('No audio', 'Create video without audio');

  extractAudio.addEventListener('click', () => {
    audioVideoInput.accept = 'video/*';
    audioVideoInput.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      dialog.close();
      onAudioSelected({ type: 'extracted', file, label: `Audio from ${file.name}` });
      audioVideoInput.value = '';
    };
    audioVideoInput.click();
  });

  chooseAudio.addEventListener('click', () => {
    audioVideoInput.accept = 'audio/*';
    audioVideoInput.onchange = event => {
      const file = event.target.files?.[0];
      if (!file) return;
      dialog.close();
      onAudioSelected({ type: 'file', blob: file, label: `Audio: ${file.name}` });
      audioVideoInput.value = '';
    };
    audioVideoInput.click();
  });

  recordAudio.addEventListener('click', async () => {
    dialog.close();
    const recordDialog = openDialog('Record audio');
    const status = el('p', 'vc-status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Requesting microphone access...';

    const controls = el('div', 'vc-row');
    const startBtn = el('button', 'camera-use', 'Start Recording');
    const stopBtn = el('button', 'camera-retake', 'Stop Recording');
    stopBtn.disabled = true;
    controls.append(startBtn, stopBtn);

    const recorder = {};
    let cancelled = false;
    startBtn.addEventListener('click', async () => {
      try {
        status.textContent = 'Recording... (max 60 seconds)';
        startBtn.disabled = true;
        stopBtn.disabled = false;

        const audioBlob = await recordAudioFromMicrophone(60, recorder);

        recordDialog.onClose = null;
        recordDialog.close();
        if (!cancelled) onAudioSelected({ type: 'recorded', blob: audioBlob, label: 'Recorded audio' });
      } catch (error) {
        status.textContent = `Error: ${error.message}`;
        startBtn.disabled = false;
        stopBtn.disabled = true;
      }
    });

    stopBtn.addEventListener('click', () => {
      stopBtn.disabled = true;
      status.textContent = 'Finishing...';
      recorder.stop?.();
    });

    recordDialog.onClose = () => { cancelled = true; recorder.stop?.(); return true; };
    recordDialog.dialog.append(status, controls);
  });

  noAudio.addEventListener('click', () => {
    dialog.close();
    onAudioSelected(null);
  });

  dialog.dialog.append(extractAudio, chooseAudio, recordAudio, noAudio);
}

/** Entry point for the Video button: record directly, create with CapCut, or upload a file. */
export function openVideoOptions({ onFile, fileInput }) {
  const dialog = openDialog('Add a video');
  const record = actionButton('Record video', 'Use your camera, front or rear', true);
  const imageToVideo = actionButton('Create from images', 'Turn images into a video with audio');
  const capcut = actionButton('Create with CapCut', 'Edit in CapCut, then share the finished video back');
  const upload = actionButton('Upload from device', 'Choose a video file you already have');
  dialog.dialog.append(record, imageToVideo, capcut, upload);

  record.addEventListener('click', () => {
    dialog.close();
    openCamera(file => reviewVideo(file, { onPost: onFile, captionInput: document.getElementById('post-caption') }), { videoOnly: true });
  });

  // Create a hidden input for audio video extraction
  const audioVideoInput = document.createElement('input');
  audioVideoInput.type = 'file';
  audioVideoInput.accept = 'video/*';
  audioVideoInput.style.display = 'none';
  document.body.appendChild(audioVideoInput);

  // Create a hidden input for image selection in image-to-video
  const imageInput = document.createElement('input');
  imageInput.type = 'file';
  imageInput.accept = 'image/*';
  imageInput.multiple = true;
  imageInput.style.display = 'none';
  document.body.appendChild(imageInput);

  imageToVideo.addEventListener('click', () => {
    dialog.close();
    openCreateVideoFromImages({ onFile, imageInput, audioVideoInput });
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

  const repostLabel = el('label', 'protect-option');
  const noRepost = el('input');
  noRepost.type = 'checkbox';
  noRepost.checked = Boolean(document.getElementById('post-no-repost')?.checked);
  repostLabel.append(noRepost, document.createTextNode(' Do not allow reposting'));

  const status = el('p', 'vc-status');
  status.setAttribute('aria-live', 'polite');
  const actions = el('div', 'vc-row');
  const post = el('button', 'camera-use', 'Post');
  post.type = 'button';
  const discard = el('button', 'camera-retake', 'Discard');
  discard.type = 'button';
  actions.append(discard, post);
  dialog.dialog.append(video, caption, repostLabel, status, actions);

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
    const ok = await onPost(file, { allowRepost: !noRepost.checked });
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
