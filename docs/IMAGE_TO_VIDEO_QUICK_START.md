# Image-to-Video Quick Start Guide

## What Was Added

A complete image-to-video creation system that allows users to:
- Create videos from 1+ images
- Add audio by extracting from video or recording from microphone
- Use various transition effects
- All processing happens on the device
- Maximum video duration: 30 seconds

## Files Modified/Created

| File | Change | Purpose |
|------|--------|---------|
| `frontend/js/image-to-video.js` | **NEW** | Core video creation logic |
| `frontend/js/video-create.js` | Modified | Added UI for image-to-video workflow |
| `frontend/css/camera.css` | Modified | Added styles for new UI components |
| `tests/image-to-video.test.js` | **NEW** | Unit tests |
| `docs/image-to-video-feature.md` | **NEW** | User documentation |
| `docs/IMAGE_TO_VIDEO_IMPLEMENTATION.md` | **NEW** | Developer implementation guide |

## How to Use

### Basic Usage in Code

```javascript
import { createVideoFromImages, recordAudioFromMicrophone } from './js/image-to-video.js';

// 1. Get image files
const images = [imageFile1, imageFile2, imageFile3];

// 2. Optional: Record audio
const audioBlob = await recordAudioFromMicrophone(30);
const audioSource = { type: 'recorded', blob: audioBlob };

// 3. Create video
const video = await createVideoFromImages(
  images,
  audioSource,
  ['static', 'zoom-in', 'fade'],  // transitions for each image
  (progress) => console.log(`${progress}%`)
);

// 4. Upload to server
await uploadVideo(video);
```

### UI Integration

The feature is integrated into the video upload menu:
1. User clicks "Add video"
2. User sees "Create from images" option
3. User selects images and audio source
4. Video is created locally
5. User reviews and posts

## Key Functions

### `createVideoFromImages(imageFiles, audioSource, transitions, onProgress)`
Main function to create a video from images.

**Parameters:**
- `imageFiles` - Array of File objects (images)
- `audioSource` - Object: `{ type: 'extracted'|'recorded'|null, file?: File, blob?: Blob, label?: string }`
- `transitions` - Array of transition names ('static', 'zoom-in', 'zoom-out', 'fade', 'pan')
- `onProgress` - Callback: `(percentComplete) => void`

**Returns:** `Promise<File>` - MP4 video file

### `recordAudioFromMicrophone(maxDuration = 30)`
Record audio from device microphone.

**Parameters:**
- `maxDuration` - Max recording time in seconds (default 30)

**Returns:** `Promise<Blob>` - Audio blob in WebM format

### `extractAudioFromVideo(videoFile, onProgress)`
Extract audio track from a video file.

**Parameters:**
- `videoFile` - Video File object
- `onProgress` - Progress callback

**Returns:** `Promise<{audio: Blob, duration: number, fileName: string}>`

### `getAvailableTransitions()`
Get list of available transition effects.

**Returns:** `Array<{value: string, label: string, duration: number}>`

### `validateDuration(seconds)`
Check if duration is within allowed range (0.5-30 seconds).

**Returns:** `boolean`

## Transition Effects

| Effect | Duration | Visual |
|--------|----------|--------|
| **static** | 1.0s | Image stays still |
| **zoom-in** | 1.5s | Zooms from 1x to 1.2x |
| **zoom-out** | 1.5s | Zooms from 1x to 0.85x |
| **fade** | 1.0s | Image gradually dims |
| **pan** | 1.5s | Image pans 50px right |

## Audio Options

### Extract from Video
```javascript
const audioResult = await extractAudioFromVideo(videoFile, (progress) => {
  console.log(`Extracting: ${progress}%`);
});
// Returns: { audio: Blob, duration: number, fileName: string }

const audioSource = {
  type: 'extracted',
  file: videoFile,
  label: 'Audio from video.mp4'
};
```

### Record from Microphone
```javascript
const audioBlob = await recordAudioFromMicrophone(30);
const audioSource = {
  type: 'recorded',
  blob: audioBlob,
  label: 'Recorded audio'
};
```

### No Audio
```javascript
const audioSource = null;
```

## Video Specifications

- **Format:** WebM (VP8/VP9 codec)
- **Resolution:** Same as first image selected
- **Frame Rate:** 30 FPS
- **Bitrate:** 5 Mbps
- **Duration:** 0.5 - 30 seconds
- **Max File Size:** 50 MB

## Error Handling

```javascript
try {
  const video = await createVideoFromImages(images, audioSource, transitions);
  console.log('Video created:', video);
} catch (error) {
  console.error('Error:', error.message);
  // "Please select at least one image"
  // "This video does not contain an audio track"
  // "Failed to determine audio duration"
  // etc.
}
```

## Performance Tips

1. **Resize images** - Use max 1920x1440 for faster processing
2. **Fewer images** - 3-5 images typically faster than 10+
3. **Simple transitions** - 'static' is faster than 'zoom-in'
4. **Powerful device** - Modern devices process 2-3x faster

## Mobile Considerations

- **iOS:** Requires HTTPS and iOS 14.5+
- **Android:** Chrome, Firefox, Edge all supported
- **Microphone:** Requires explicit permission prompt
- **Storage:** Generated video stays in device memory until uploaded

## Testing

```bash
# Run unit tests
npm test -- tests/image-to-video.test.js

# Manual testing
1. Open http://localhost:3000
2. Upload media
3. Click "Create from images"
4. Select 2-3 images
5. Choose "Static" transition
6. Select "No audio"
7. Click "Create video"
8. Review and post
```

## Troubleshooting

### "Please select at least one image"
- User clicked "Create" without selecting images
- Ensure `imageFiles` array is not empty

### "This device does not support video encoding"
- Browser too old or missing WebRTC
- Requires Chrome 90+, Firefox 88+, Safari 14.1+

### Microphone permission error
- User denied microphone access
- Check browser permissions
- HTTPS required on mobile

### Video creation very slow
- Too many images or large resolution
- Try reducing image count or using static transitions
- Check system RAM availability

### Audio out of sync
- Some audio formats not supported
- Try different video file format
- Extract audio manually server-side if needed

## Deployment

1. Files are included in default build
2. No additional dependencies needed (uses existing mediabunny)
3. All modern browsers supported
4. Progressive enhancement - feature degrades gracefully

## Browser Support Matrix

| Browser | Version | Support |
|---------|---------|---------|
| Chrome | 90+ | ✅ Full |
| Firefox | 88+ | ✅ Full |
| Safari | 14.1+ | ✅ Full |
| Edge | 90+ | ✅ Full |
| IE11 | All | ❌ Not supported |
| Mobile Safari | 14.5+ | ✅ Full |
| Chrome Mobile | 90+ | ✅ Full |

## Related Features

- Video upload (existing)
- Camera recording (existing)
- Video preview/review (existing)
- Caption/description input (existing)

All integrated seamlessly with existing video workflow.

## Questions?

See full documentation in:
- `docs/image-to-video-feature.md` - User guide
- `docs/IMAGE_TO_VIDEO_IMPLEMENTATION.md` - Implementation details
