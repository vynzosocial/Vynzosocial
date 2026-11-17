# Image-to-Video Implementation - Code Examples

## Complete Usage Examples

### Example 1: Create Video with Static Transition and No Audio

```javascript
import { createVideoFromImages } from './js/image-to-video.js';

// Get image files from user
const imageFiles = [
  document.getElementById('image1').files[0],
  document.getElementById('image2').files[0],
  document.getElementById('image3').files[0]
];

// All images use same transition
const transitions = imageFiles.map(() => 'static');

// Create video (no audio)
try {
  const videoFile = await createVideoFromImages(
    imageFiles,
    null,  // No audio
    transitions,
    (progress) => {
      console.log(`Creating video... ${progress}%`);
      document.getElementById('progress-bar').value = progress;
    }
  );
  
  console.log('Video created:', videoFile.name, `(${videoFile.size} bytes)`);
  
  // Upload to Vynzo
  await uploadToVynzo(videoFile);
} catch (error) {
  console.error('Failed to create video:', error.message);
  alert(`Error: ${error.message}`);
}
```

### Example 2: Extract Audio from Video and Create Video

```javascript
import { createVideoFromImages, extractAudioFromVideo } from './js/image-to-video.js';

async function createVideoWithExtractedAudio() {
  // User selects images
  const imageFiles = Array.from(
    document.getElementById('image-input').files
  );
  
  // User selects video to extract audio from
  const videoFile = document.getElementById('video-input').files[0];
  
  try {
    // Show extraction progress
    const audioResult = await extractAudioFromVideo(
      videoFile,
      (progress) => {
        console.log(`Extracting audio... ${progress}%`);
      }
    );
    
    console.log(`Audio extracted: ${audioResult.duration}s duration`);
    
    // Prepare audio source
    const audioSource = {
      type: 'extracted',
      file: videoFile,
      label: `Audio from ${videoFile.name}`,
      blob: audioResult.audio
    };
    
    // Use zoom-in for all images
    const transitions = imageFiles.map(() => 'zoom-in');
    
    // Create video with extracted audio
    const videoFile = await createVideoFromImages(
      imageFiles,
      audioSource,
      transitions,
      (progress) => {
        console.log(`Creating video... ${progress}%`);
      }
    );
    
    console.log('Video created with extracted audio');
    return videoFile;
  } catch (error) {
    console.error('Error:', error.message);
  }
}
```

### Example 3: Record Audio from Microphone and Create Video

```javascript
import { createVideoFromImages, recordAudioFromMicrophone } from './js/image-to-video.js';

async function createVideoWithRecordedAudio() {
  const imageFiles = Array.from(
    document.getElementById('image-input').files
  );
  
  try {
    // Request microphone access and record
    console.log('Starting audio recording...');
    const audioBlob = await recordAudioFromMicrophone(30); // Max 30 seconds
    console.log(`Audio recorded: ${audioBlob.size} bytes`);
    
    // Prepare audio source
    const audioSource = {
      type: 'recorded',
      blob: audioBlob,
      label: 'Recorded audio'
    };
    
    // Use different transitions for variety
    const transitions = [
      'static',
      'zoom-in',
      'fade'
    ];
    
    // Create video with recorded audio
    const videoFile = await createVideoFromImages(
      imageFiles,
      audioSource,
      transitions,
      (progress) => {
        console.log(`Creating video... ${progress}%`);
      }
    );
    
    console.log('Video created with recorded audio');
    return videoFile;
  } catch (error) {
    console.error('Error:', error.message);
  }
}
```

### Example 4: Different Transition per Image

```javascript
import { createVideoFromImages, getAvailableTransitions } from './js/image-to-video.js';

async function createVideoWithMixedTransitions() {
  const imageFiles = Array.from(
    document.getElementById('image-input').files
  );
  
  // Get available transitions to show user
  const availableTransitions = getAvailableTransitions();
  console.log('Available transitions:', availableTransitions);
  // Output:
  // [
  //   { value: 'static', label: 'Static', duration: 1 },
  //   { value: 'zoom-in', label: 'Zoom In', duration: 1.5 },
  //   { value: 'zoom-out', label: 'Zoom Out', duration: 1.5 },
  //   { value: 'fade', label: 'Fade', duration: 1 },
  //   { value: 'pan', label: 'Pan', duration: 1.5 }
  // ]
  
  // Create transitions array - different for each image
  const transitions = [
    'zoom-in',    // Image 1: zooms in
    'static',     // Image 2: stays still
    'fade',       // Image 3: fades
    'pan',        // Image 4: pans
    'zoom-out'    // Image 5: zooms out
  ];
  
  try {
    const videoFile = await createVideoFromImages(
      imageFiles,
      null, // No audio
      transitions,
      (progress) => {
        console.log(`${progress}%`);
      }
    );
    
    return videoFile;
  } catch (error) {
    console.error('Error:', error.message);
  }
}
```

### Example 5: Validate Duration Before Creating

```javascript
import { createVideoFromImages, validateDuration } from './js/image-to-video.js';

async function createVideoWithValidation() {
  const imageFiles = [/* ... */];
  const desiredDuration = 25; // seconds
  
  // Validate duration
  if (!validateDuration(desiredDuration)) {
    console.error('Invalid duration. Must be 0.5 - 30 seconds.');
    return;
  }
  
  console.log(`Duration ${desiredDuration}s is valid`);
  
  // Create video
  const videoFile = await createVideoFromImages(
    imageFiles,
    null,
    imageFiles.map(() => 'static'),
    (progress) => console.log(`${progress}%`)
  );
  
  return videoFile;
}
```

### Example 6: Full UI Integration (Like Existing Implementation)

```javascript
import { openVideoOptions } from './js/video-create.js';

// Initialize video upload button
document.getElementById('add-video-button').addEventListener('click', () => {
  const fileInput = document.getElementById('video-file-input');
  
  openVideoOptions({
    onFile: async (videoFile) => {
      // Video created or uploaded successfully
      console.log('Video ready:', videoFile);
      
      // Show review dialog and handle upload
      const captionInput = document.getElementById('caption-input');
      reviewVideo(videoFile, {
        onPost: async (file) => {
          // Upload to Vynzo
          const uploaded = await uploadToVynzo(file);
          return uploaded; // Return true if upload succeeded
        },
        captionInput
      });
    },
    fileInput
  });
});
```

### Example 7: Error Handling Best Practices

```javascript
import { createVideoFromImages, recordAudioFromMicrophone } from './js/image-to-video.js';

async function createVideoWithErrorHandling() {
  const imageFiles = Array.from(
    document.getElementById('image-input').files
  );
  
  // Validate images exist
  if (!imageFiles || imageFiles.length === 0) {
    alert('Please select at least one image');
    return null;
  }
  
  let audioSource = null;
  
  // Optionally record audio
  try {
    console.log('Recording audio...');
    const audioBlob = await recordAudioFromMicrophone(30);
    audioSource = {
      type: 'recorded',
      blob: audioBlob,
      label: 'Recorded audio'
    };
  } catch (error) {
    if (/permission.*denied/i.test(error.message)) {
      console.warn('Microphone access denied. Creating video without audio.');
    } else {
      console.error('Audio recording failed:', error.message);
    }
    audioSource = null; // Continue without audio
  }
  
  // Create video with error handling
  try {
    const videoFile = await createVideoFromImages(
      imageFiles,
      audioSource,
      imageFiles.map(() => 'static'),
      (progress) => {
        updateProgressBar(progress);
      }
    );
    
    // Validate output
    if (!videoFile || videoFile.size === 0) {
      throw new Error('Video file is empty');
    }
    
    if (videoFile.size > 50 * 1024 * 1024) {
      throw new Error('Video is too large (>50MB)');
    }
    
    console.log('✓ Video created successfully');
    return videoFile;
  } catch (error) {
    handleVideoCreationError(error);
    return null;
  }
}

function handleVideoCreationError(error) {
  const messages = {
    'no images': 'Please select at least one image.',
    'audio track': 'Selected video has no audio. Try a different video.',
    'too large': 'Generated video is too large. Try fewer images.',
    'encoding': 'Your browser doesn\'t support video encoding.',
    'default': 'Failed to create video. Please try again.'
  };
  
  const message = Object.entries(messages).find(
    ([key]) => error.message.toLowerCase().includes(key)
  )?.[1] || messages.default;
  
  alert(`Error: ${message}`);
  console.error('Full error:', error);
}
```

### Example 8: Progress Tracking UI

```javascript
async function createVideoWithProgressUI() {
  const imageFiles = Array.from(
    document.getElementById('image-input').files
  );
  
  const progressBar = document.getElementById('progress-bar');
  const progressLabel = document.getElementById('progress-label');
  const createButton = document.getElementById('create-button');
  
  // Disable UI during processing
  createButton.disabled = true;
  progressBar.style.display = 'block';
  
  try {
    const videoFile = await createVideoFromImages(
      imageFiles,
      null,
      imageFiles.map(() => 'zoom-in'),
      (progress) => {
        // Update progress UI
        progressBar.value = progress;
        progressLabel.textContent = `Creating video... ${progress}%`;
        
        // Show stage information
        if (progress < 30) {
          progressLabel.textContent = `Loading images... ${progress}%`;
        } else if (progress < 70) {
          progressLabel.textContent = `Rendering frames... ${progress}%`;
        } else {
          progressLabel.textContent = `Encoding video... ${progress}%`;
        }
      }
    );
    
    progressLabel.textContent = '✓ Video created!';
    return videoFile;
  } finally {
    createButton.disabled = false;
  }
}
```

### Example 9: Batch Processing Multiple Videos

```javascript
async function createMultipleVideos(videoConfigs) {
  const results = [];
  
  for (const config of videoConfigs) {
    try {
      console.log(`Creating video ${config.name}...`);
      
      const videoFile = await createVideoFromImages(
        config.images,
        config.audio,
        config.transitions,
        (progress) => {
          console.log(`${config.name}: ${progress}%`);
        }
      );
      
      results.push({
        success: true,
        name: config.name,
        file: videoFile
      });
    } catch (error) {
      results.push({
        success: false,
        name: config.name,
        error: error.message
      });
    }
  }
  
  return results;
}

// Usage
const configs = [
  {
    name: 'Video 1',
    images: [img1, img2, img3],
    audio: null,
    transitions: ['static', 'static', 'static']
  },
  {
    name: 'Video 2',
    images: [img4, img5],
    audio: audioSource,
    transitions: ['zoom-in', 'zoom-in']
  }
];

const results = await createMultipleVideos(configs);
results.forEach(r => {
  if (r.success) {
    console.log(`✓ ${r.name} created`);
  } else {
    console.error(`✗ ${r.name}: ${r.error}`);
  }
});
```

### Example 10: Memory Efficient Processing

```javascript
async function createVideoMemoryEfficient() {
  const imageInput = document.getElementById('image-input');
  const files = imageInput.files;
  
  // Process in smaller batches if too many images
  const MAX_IMAGES = 20;
  
  if (files.length > MAX_IMAGES) {
    alert(`Processing first ${MAX_IMAGES} images to save memory.`);
    const imagesToUse = Array.from(files).slice(0, MAX_IMAGES);
    
    const videoFile = await createVideoFromImages(
      imagesToUse,
      null,
      imagesToUse.map(() => 'static')
    );
    
    return videoFile;
  }
  
  // Normal processing
  const videoFile = await createVideoFromImages(
    Array.from(files),
    null,
    Array.from(files).map(() => 'static')
  );
  
  return videoFile;
}
```

---

## Common Patterns

### Pattern: User-Friendly Workflow

```javascript
async function userFriendlyVideoCreation() {
  // Step 1: Get images
  const imageFiles = await selectImages('Select 1-5 images');
  if (!imageFiles) return; // User cancelled
  
  // Step 2: Get transition
  const transition = await selectTransition();
  
  // Step 3: Get audio
  const audioSource = await selectAudioSource();
  
  // Step 4: Create video
  showProgressDialog('Creating your video...');
  const videoFile = await createVideoFromImages(
    imageFiles,
    audioSource,
    imageFiles.map(() => transition)
  );
  hideProgressDialog();
  
  // Step 5: Review
  showReviewDialog(videoFile);
}
```

### Pattern: Gallery to Video

```javascript
async function galleryToVideo(galleryId, transitionType = 'static') {
  // Get all images from gallery
  const gallery = document.getElementById(galleryId);
  const imageElements = gallery.querySelectorAll('img');
  
  // Convert to files (note: requires CORS or File inputs)
  const imageFiles = await Promise.all(
    Array.from(imageElements).map(img => urlToFile(img.src))
  );
  
  // Create video
  const videoFile = await createVideoFromImages(
    imageFiles,
    null,
    imageFiles.map(() => transitionType)
  );
  
  return videoFile;
}
```

---

These examples demonstrate all the common use cases and patterns for the image-to-video feature.
