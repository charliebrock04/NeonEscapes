const AudioManager = (() => {
  const tracks = {
    menu:     new Audio('assets/audio/menu-music.mp3'),
    gameplay: new Audio('assets/audio/gameplay-music.mp3'),
    boss:     new Audio('assets/audio/boss-music.mp3'),
  };

  // All tracks loop forever
  Object.values(tracks).forEach(t => t.loop = true);

  let muted = localStorage.getItem('neonEscape_muted') === 'true';
  let current = null;

  function applyMute() {
    Object.values(tracks).forEach(t => t.muted = muted);
    const btn = document.getElementById('mute-btn');
    if (btn) btn.textContent = muted ? '🔇' : '🔊';
  }

  function play(name) {
    if (current === name) return;       // already playing this track
    Object.values(tracks).forEach(t => { t.pause(); t.currentTime = 0; });
    tracks[name].play().catch(() => {}); // catch autoplay block silently
    current = name;
  }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem('neonEscape_muted', muted);
    applyMute();
  }

  // Restore mute state on load
  applyMute();

  return {
    playMenu()     { play('menu'); },
    playGameplay() { play('gameplay'); },
    playBoss()     { play('boss'); },
    toggleMute,
  };
})();