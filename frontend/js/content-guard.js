import { apiRequest } from './api.js?v=sb6';

const FRAME_WIDTH = 480;

function captureFrame(video) {
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_WIDTH;
  canvas.height = Math.round(FRAME_WIDTH * video.videoHeight / video.videoWidth);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL('image/jpeg', 0.6);
  } catch {
    return null;
  }
}

function seekTo(video, time) {
  return new Promise(resolve => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = time;
    setTimeout(done, 4000);
  });
}

async function sampleVideoFrames(url) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = reject;
    setTimeout(reject, 15000);
  });
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
  const frames = [];
  for (const point of [0.05, 0.25, 0.45, 0.65, 0.85]) {
    await seekTo(video, duration * point);
    const frame = captureFrame(video);
    if (frame) frames.push(frame);
  }
  video.removeAttribute('src');
  video.load();
  return frames;
}

function showNotices(notices) {
  const overlay = document.createElement('div');
  overlay.className = 'content-guard-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  const box = document.createElement('div');
  box.className = 'content-guard-box';
  const title = document.createElement('h3');
  title.textContent = 'Content removed';
  box.append(title);
  notices.forEach(notice => {
    const text = document.createElement('p');
    text.textContent = notice.message;
    box.append(text);
  });
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'I understand';
  button.addEventListener('click', () => {
    overlay.remove();
    apiRequest('/moderation/notices/seen', { method: 'POST' }).catch(() => {});
  });
  box.append(button);
  overlay.append(box);
  document.body.append(overlay);
  button.focus();
}

export async function showModerationNotices() {
  try {
    const { notices } = await apiRequest('/moderation/notices');
    if (notices?.length && !document.querySelector('.content-guard-overlay')) showNotices(notices);
  } catch { /* notices are retried on the next page load */ }
}

export async function scanMyMedia() {
  try {
    const { videos = [] } = await apiRequest('/moderation/pending');
    for (const item of videos.slice(0, 5)) {
      try {
        const frames = await sampleVideoFrames(item.media_url);
        if (frames.length) {
          await apiRequest('/moderation/frames', {
            method: 'POST',
            body: JSON.stringify({ kind: item.kind, id: item.id, frames })
          });
        }
      } catch { /* try again next time */ }
    }
  } catch { /* scanning is best effort */ }
  await showModerationNotices();
}

// Samples the host's camera every 20 seconds; the server ends the stream if a frame is flagged.
export function startLiveFrameGuard(getSessionId, getVideo, onEnded) {
  const timer = setInterval(async () => {
    const sessionId = getSessionId();
    if (!sessionId) return clearInterval(timer);
    const frame = captureFrame(getVideo());
    if (!frame) return;
    try {
      const result = await apiRequest('/moderation/live-frame', {
        method: 'POST',
        body: JSON.stringify({ session_id: sessionId, frame })
      });
      if (result?.ended) {
        clearInterval(timer);
        onEnded();
      }
    } catch { /* ignore and retry */ }
  }, 20000);
  return () => clearInterval(timer);
}

if (localStorage.getItem('vynzo_token')) {
  setTimeout(scanMyMedia, 3000);
}
