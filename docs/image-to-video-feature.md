# Image-to-Video Feature Documentation

## Overview
This feature allows users to create professional videos from images with support for:
- Multiple images in sequence
- Various transition effects (static, zoom-in, zoom-out, fade, pan)
- Audio from a video, a device audio file, or microphone recording
- Choose a 15-, 30-, or 60-second maximum duration
- All processing done device-side (no server encoding)
- Preview the finished video before posting to Vynzo

## Features

### 1. Image Selection
- Select one or more images from device storage
- Images are loaded as canvas elements for fast rendering
- Aspect ratio is preserved from the first image

### 2. Transition Effects
The following transition effects are available:
- **Static**: Image stays still (default)
- **Zoom In**: Gradually zooms to 1.2x
- **Zoom Out**: Gradually zooms down to 0.85x
- **Fade**: Slowly fades the image
- **Pan**: Smoothly pans the image to the right

Each image can have its own transition effect, or use the same transition for all images.

### 3. Audio Options

#### Extract from Video
- Users can select a video file from their device
- Preview the sound and move the start and end handles independently on one timeline.
- The video lasts as long as the selected segment, up to the selected 15-, 30-, or 60-second limit.
- The segment must be at least half a second long and no longer than the chosen maximum. Adjust either handle if the selection is invalid.
- The chosen portion is played and recorded into the new video on the device.

#### Choose Audio File
- Select a sound file on the device and choose its start and end in the same way.

#### Record from Microphone
- Real-time recording using device microphone
- Auto-stops after 60 seconds
- Audio is captured in WebM format
- Requires microphone permission

#### No Audio
- Users can create videos without audio

### 4. Video Creation Process
1. Load all selected images as HTML Canvas elements
2. If audio is provided, extract it and get its duration
3. Distribute images evenly across the selected audio segment (or chosen duration without audio)
4. Render each frame with transitions applied
5. Capture frames using Canvas.captureStream()
6. Record frames and selected audio using MediaRecorder
7. Return video file ready for upload

### 5. Video Specifications
- **Format**: MP4 or WebM, depending on device support
- **Resolution**: 720 × 1280, cropped to fill
- **Frame Rate**: 30 FPS
- **Bitrate**: 4 Mbps video
- **Max Duration**: 60 seconds
- **Max File Size**: 50 MB

## Technical Implementation

### Files Modified
- `frontend/js/image-to-video.js` (NEW) - Core video creation logic
- `frontend/js/video-create.js` - Integration with video upload UI
- `frontend/css/camera.css` - UI styling for new components

### Dependencies
- **mediabunny** (existing) - For audio extraction from videos
- **Native APIs**:
  - `HTMLCanvasElement.captureStream()` - Video capture
  - `MediaRecorder` - Frame recording
  - `navigator.mediaDevices.getUserMedia()` - Microphone access

### Browser Compatibility
- Requires WebRTC support (Chrome, Firefox, Edge, Safari 14.1+)
- Requires Canvas and MediaRecorder API support
- Mobile browsers (iOS Safari 14.1+, Android Chrome)

## Usage Flow

### Camera capture alternatives (mobile and web)

- **Image** offers **Take photo** or **Upload image**. Story camera and
  **Record video** also provide **Switch camera** before capture/recording.
- Chat photo and video capture provide **Switch camera** before recording.
  Camera switching is disabled during recording to keep the clip intact.
- Live streams provide **Settings > Switch camera** while sharing video, on
  both web and mobile. Video calls, including group calls, provide a
  **Switch camera** button. Switching keeps the existing microphone and mute
  state; live filters stay applied.
- Phones switch between front and rear cameras; computers cycle available
  webcams. Camera permission and a second accessible camera are required.
  If switching fails, the app attempts to restart the previous camera and
  reports the error. A native file-picker fallback uses the device's camera UI.

### From User's Perspective

1. **Open Video Menu**
   - User clicks "Add video" or similar button
   - Sees "Create from images" option

2. **Create Video Dialog**
   - Select images (1 or more)
   - Choose transition effect
   - Select audio source:
     - Extract from video file
     - Choose an audio file
     - Record new audio
     - No audio
   - Choose the audio start and end points and preview the selected segment
   - Click "Create video"

3. **Progress**
   - Dialog shows "Creating video... X%" during processing
   - Process runs entirely on device (can work offline for video generation)

4. **Review**
   - Video preview dialog appears
   - User can add caption
   - Click "Post" to upload to Vynzo

### For Developers

#### Creating a Video from Images

```javascript
import {
  createVideoFromImages,
  recordAudioFromMicrophone,
  getAvailableTransitions
} from './image-to-video.js';

// Get images
const imageFiles = [image1, image2, image3]; // File objects

// Audio source (optional)
const audioSource = {
  type: 'recorded',
  blob: audioBlob,
  label: 'Recorded audio'
};

// Transitions for each image
const transitions = ['zoom-in', 'static', 'fade'];

// Create video
try {
  const videoFile = await createVideoFromImages(
    imageFiles,
    audioSource,
    transitions,
    (progress) => console.log(`Progress: ${progress}%`)
  );
  console.log(`Video created: ${videoFile.name}`);
} catch (error) {
  console.error('Error creating video:', error);
}
```

#### Recording Audio

```javascript
import { recordAudioFromMicrophone } from './image-to-video.js';

try {
  const audioBlob = await recordAudioFromMicrophone(30); // Max 30 seconds
  console.log('Audio recorded:', audioBlob);
} catch (error) {
  console.error('Recording failed:', error);
}
```

#### Extracting Audio from Video

```javascript
import { extractAudioFromVideo } from './image-to-video.js';

try {
  const result = await extractAudioFromVideo(videoFile, (progress) => {
    console.log(`Extracting: ${progress}%`);
  });
  console.log('Audio duration:', result.duration);
  console.log('Audio blob:', result.audio);
} catch (error) {
  console.error('Extraction failed:', error);
}
```

## Performance Considerations

### Memory Usage
- Each image is loaded into a Canvas element in memory
- For typical smartphone images (e.g., 3000x4000px), this is 48MB per image raw
- Browser canvas uses 4 bytes per pixel in most cases
- 3-5 images typically use 150-250MB combined

### Processing Time
- Image loading: ~50-200ms per image
- Video rendering: ~1-2 seconds for 30-second video at 30fps (depends on device)
- Total time: Usually 2-5 seconds on modern devices

### Optimization Tips
- Resize images before upload if possible (max 1920x1440 recommended)
- Use fewer images for faster generation
- Use "static" transition for fastest rendering

## Error Handling

Common errors and recovery:

1. **"Please select at least one image"**
   - User must select images before creating

2. **"This video does not contain an audio track"**
   - Selected video has no audio
   - User can choose another video or record audio

3. **"This device does not support video encoding"**
   - Browser doesn't support required APIs
   - Fallback to uploading pre-made video

4. **"Microphone permission denied"**
   - User denied microphone access
   - Can retry or use video audio extraction instead

5. **"The generated video is too large"**
   - Output exceeded 50MB limit
   - User should reduce image count or resolution

## Future Enhancements

Potential improvements:
1. **FFmpeg.wasm integration** - Better audio-video synchronization
2. **MP4 encoding** - Better compatibility, smaller file sizes
3. **Advanced transitions** - Slide, flip, dissolve effects
4. **Text/sticker overlays** - Add captions or decorations to images
5. **Batch processing** - Create multiple videos at once
6. **Templates** - Pre-configured layouts and timings
7. **Voice-over** - Real-time voice sync with video

## Testing

### Manual Testing Checklist
- [ ] Select single image - video creates successfully
- [ ] Select multiple images - distributed evenly
- [ ] Each transition type works visually
- [ ] Audio extraction works with sample video
- [ ] Microphone recording works and captures sound
- [ ] 30-second limit is enforced
- [ ] File size limit is enforced
- [ ] Video plays in review dialog
- [ ] Caption input works
- [ ] Upload to Vynzo succeeds
- [ ] Video appears on feed after upload
- [ ] Works on mobile browsers (iOS Safari, Android Chrome)
- [ ] Works offline for video generation (uploads need network)

## Troubleshooting

### Video doesn't play after creation
- Browser may not support WebM format
- Try converting to MP4 server-side
- Check browser console for codec errors

### Audio out of sync
- Audio duration may differ from expected
- Mediabunny extraction can be imprecise
- Manual audio sync server-side may be needed

### Microphone not accessible
- Check browser permissions
- On mobile, ensure HTTPS (required for getUserMedia)
- Try another app/browser if microphone works elsewhere

### Video creation takes too long
- Reduce number of images
- Use simpler transitions (static is fastest)
- Try on a device with better GPU/CPU
- Check browser developer tools for performance insights

## Security & Privacy

- All video processing happens on the device
- No intermediate files are uploaded to servers
- Audio recording requires explicit user permission
- Video only uploaded after user clicks "Post"
- All data is processed in browser memory only
