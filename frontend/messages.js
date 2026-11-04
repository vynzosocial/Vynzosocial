
// Custom voice-message player: no native menu, so no download option.
(() => {
  const fmt = s => (isFinite(s) && s >= 0) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';
  let current = null;
  function audioFor(player) {
    if (player._audio) return player._audio;
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = player.dataset.src;
    const btn = player.querySelector('.voice-play');
    const seek = player.querySelector('.voice-seek');
    const time = player.querySelector('.voice-time');
    let seeking = false;
    const update = () => {
      const d = isFinite(audio.duration) ? audio.duration : 0;
      if (!seeking) seek.value = d ? (audio.currentTime / d) * 100 : 0;
      time.textContent = audio.paused && !audio.currentTime && d ? fmt(d) : fmt(audio.currentTime);
    };
    audio.addEventListener('loadedmetadata', () => {
      if (audio.duration === Infinity) {
        audio.currentTime = 1e101;
        audio.addEventListener('timeupdate', function fix() {
          audio.removeEventListener('timeupdate', fix);
          audio.currentTime = 0;
        });
      }
      update();
    });
    audio.addEventListener('timeupdate', update);
    audio.addEventListener('play', () => { btn.textContent = '?'; });
    audio.addEventListener('pause', () => { btn.textContent = '?'; });
    audio.addEventListener('ended', () => { btn.textContent = '?'; audio.currentTime = 0; update(); });
    audio.addEventListener('error', () => { time.textContent = 'Unavailable'; });
    seek.addEventListener('input', () => {
      seeking = true;
      if (isFinite(audio.duration)) audio.currentTime = (seek.value / 100) * audio.duration;
    });
    seek.addEventListener('change', () => { seeking = false; });
    player._audio = audio;
    return audio;
  }
  document.addEventListener('click', event => {
    const btn = event.target.closest('.voice-play');
    if (!btn) return;
    const player = btn.closest('.voice-player');
    const audio = audioFor(player);
    if (audio.paused) {
      if (current && current !== audio) current.pause();
      current = audio;
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  });
  document.addEventListener('contextmenu', event => {
    if (event.target.closest('.voice-player')) event.preventDefault();
  });
})();
