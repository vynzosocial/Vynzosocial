export async function initCamera(videoElement) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 720 }, height: { ideal: 1280 }, facingMode: 'user' },
      audio: true
    });
    videoElement.srcObject = stream;
    return stream;
  } catch (err) {
    console.error('Camera access denied or unavailable:', err);
    throw new Error('Unable to access device camera. Please check permissions.');
  }
}

export function captureSnapshot(videoElement) {
  const canvas = document.createElement('canvas');
  canvas.width = videoElement.videoWidth || 720;
  canvas.height = videoElement.videoHeight || 1280;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
  
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(new File([blob], `snapshot-${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  });
}

export function stopCameraStream(stream) {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
}