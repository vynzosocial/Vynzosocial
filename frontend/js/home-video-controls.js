const featuredVideo = document.getElementById('welcome-featured-video');
const audioToggle = document.getElementById('welcome-video-audio-toggle');

if (featuredVideo instanceof HTMLVideoElement && audioToggle instanceof HTMLButtonElement) {
  let audiblePlaythroughs = 0;
  let userInteracted = false;
  let pageActive = true;
  const welcomePage = document.getElementById('welcome-page');
  const canPlay = () => Boolean(welcomePage)
    && pageActive
    && !welcomePage.hidden
    && !document.hidden
    && !localStorage.getItem('vynzo_token');
  const canAutoplay = () => !/\bElectron\//.test(navigator.userAgent)
    && canPlay();
  const pauseOutsideWelcome = () => {
    if (!canPlay()) featuredVideo.pause();
  };
  const playFeaturedVideo = () => {
    if (!canPlay()) {
      featuredVideo.pause();
      return Promise.resolve();
    }
    return featuredVideo.play().then(pauseOutsideWelcome);
  };

  const updateAudioLabel = () => {
    const soundEnabled = !featuredVideo.muted;
    audioToggle.classList.toggle('is-muted', !soundEnabled);
    const label = featuredVideo.paused
      ? soundEnabled ? 'Play featured video with sound' : 'Play featured video'
      : soundEnabled ? 'Mute featured video sound' : 'Turn featured video sound on';
    audioToggle.setAttribute('aria-label', label);
  };

  audioToggle.addEventListener('click', () => {
    if (!canPlay()) {
      featuredVideo.pause();
      return;
    }
    userInteracted = true;
    if (featuredVideo.paused) {
      featuredVideo.muted = false;
      playFeaturedVideo().catch((error) => {
        console.error('Unable to play the featured video.', error);
      });
    } else {
      featuredVideo.muted = !featuredVideo.muted;
    }
    updateAudioLabel();
  });

  featuredVideo.addEventListener('volumechange', updateAudioLabel);
  featuredVideo.addEventListener('play', () => {
    pauseOutsideWelcome();
    updateAudioLabel();
  });
  featuredVideo.addEventListener('pause', updateAudioLabel);
  featuredVideo.addEventListener('ended', () => {
    if (!canPlay()) {
      featuredVideo.pause();
      return;
    }
    if (!featuredVideo.muted) audiblePlaythroughs += 1;
    if (audiblePlaythroughs >= 2) {
      featuredVideo.muted = true;
      featuredVideo.loop = true;
    }

    featuredVideo.currentTime = 0;
    playFeaturedVideo().catch((error) => {
      console.error('Unable to replay the featured video.', error);
    });
    updateAudioLabel();
  });
  if (welcomePage) {
    new MutationObserver(pauseOutsideWelcome).observe(welcomePage, {
      attributes: true,
      attributeFilter: ['hidden']
    });
  }
  document.addEventListener('visibilitychange', pauseOutsideWelcome);
  window.addEventListener('pagehide', () => {
    pageActive = false;
    featuredVideo.pause();
  });
  window.addEventListener('pageshow', () => {
    pageActive = true;
    pauseOutsideWelcome();
  });
  window.addEventListener('storage', pauseOutsideWelcome);
  pauseOutsideWelcome();
  updateAudioLabel();

  if (canAutoplay()) {
    playFeaturedVideo().catch((error) => {
      if (error.name === 'NotAllowedError' && !userInteracted && featuredVideo.paused && canAutoplay()) {
        featuredVideo.muted = true;
        playFeaturedVideo().catch((mutedError) => {
          console.error('Unable to autoplay the muted featured video.', mutedError);
          updateAudioLabel();
        });
      } else if (error.name !== 'NotAllowedError') {
        console.error('Unable to autoplay the featured video with sound.', error);
      }
      updateAudioLabel();
    });
  }
}
