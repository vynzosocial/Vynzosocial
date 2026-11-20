const video = document.getElementById('welcome-featured-video');
const welcome = document.getElementById('welcome-page');

if (video && welcome) {
  let pageActive = true;
  const canPlay = () => pageActive && !welcome.hidden && !document.hidden
    && !localStorage.getItem('vynzo_token');
  const pauseWhenHidden = () => { if (!canPlay()) video.pause(); };
  const canAutoplay = () => canPlay() && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function playIntro(allowMutedFallback = false) {
    try {
      await video.play();
      pauseWhenHidden();
    } catch (error) {
      if (error.name === 'NotAllowedError' && allowMutedFallback && video.paused && canAutoplay()) {
        video.muted = true;
        await playIntro();
      } else if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') {
        console.error('Unable to play the Vynzo intro:', error);
      }
    }
  }

  video.addEventListener('play', pauseWhenHidden);
  video.addEventListener('ended', () => {
    video.muted = true;
    if (!canAutoplay()) return;
    video.loop = true;
    void playIntro();
  });
  document.addEventListener('visibilitychange', pauseWhenHidden);
  window.addEventListener('storage', pauseWhenHidden);
  window.addEventListener('pagehide', () => {
    pageActive = false;
    video.pause();
  });
  window.addEventListener('pageshow', () => { pageActive = true; });
  new MutationObserver(pauseWhenHidden).observe(welcome, {
    attributes: true,
    attributeFilter: ['hidden']
  });

  if (canAutoplay()) void playIntro(true);
}
