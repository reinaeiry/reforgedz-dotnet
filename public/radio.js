// ---- ReforgedZ Radio Player ----
(function() {
  const audio = new Audio();
  audio.preload = 'auto';

  // Preloader for next track
  const preloader = new Audio();
  preloader.preload = 'auto';
  preloader.volume = 0;
  let preloadedSrc = '';

  function preloadNext() {
    let nextTrack = null;
    if (queue.length > 0) {
      nextTrack = queue[0];
    } else if (isRadioMode && radioIndex + 1 < radioPlaylist.length) {
      nextTrack = radioPlaylist[radioIndex + 1];
    }
    if (nextTrack && nextTrack.file !== preloadedSrc) {
      preloadedSrc = nextTrack.file;
      preloader.src = nextTrack.file;
      preloader.load();
    }
  }

  // State
  let allTracks = {};
  let flatTracks = [];
  let queue = [];
  let recentlyPlayed = [];
  let favorites = [];
  let currentTrack = null;
  let currentIndex = -1;
  let isRadioMode = false;
  let radioPlaylist = [];
  let radioIndex = -1;
  let loopMode = 'off';
  let radioStarted = false;
  let savedVolume = 0.8;
  let playStats = {}; // file -> play count (from server)
  let trackPlayStart = null; // timestamp when current track started

  const genreColors = {
    'Community': ['#e94560', '#b8354d'],
    'Country': ['#b8860b', '#8b6914'],
    'Dance': ['#8b5cf6', '#6d28d9'],
    'Pop': ['#e84393', '#c23070'],
    'Rap': ['#2d3436', '#636e72'],
    'Reggea': ['#00b894', '#00896e'],
    'Rock': ['#cc1f1f', '#991717'],
  };

  // DOM refs
  const playerTitle = document.getElementById('playerTitle');
  const playerCategory = document.getElementById('playerCategory');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const progressFill = document.getElementById('playerProgressFill');
  const progressBar = document.getElementById('playerProgressBar');
  const timeNow = document.getElementById('playerTimeNow');
  const timeDur = document.getElementById('playerTimeDur');
  const volFill = document.getElementById('playerVolFill');
  const volBar = document.getElementById('playerVolBar');
  const radioNpTitle = document.getElementById('radioNpTitle');
  const radioNpCategory = document.getElementById('radioNpCategory');
  const radioNpNext = document.getElementById('radioNpNext');
  const radioNowPlaying = document.getElementById('radioNowPlaying');
  const radioStartBtn = document.getElementById('radioStartBtn');
  const queueList = document.getElementById('radioQueue');
  const libraryContainer = document.getElementById('radioLibrary');
  const genresContainer = document.getElementById('radioGenres');
  const searchInput = document.getElementById('radioSearch');
  const playerHeart = document.getElementById('playerHeart');
  const playerShare = document.getElementById('playerShare');

  // ---- localStorage persistence ----
  function saveState() {
    try {
      localStorage.setItem('rz-radio', JSON.stringify({
        volume: audio.volume,
        recent: recentlyPlayed.slice(0, 10),
        favorites: favorites,
        queue: queue,
        loopMode: loopMode,
      }));
    } catch (e) {}
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem('rz-radio'));
      if (!saved) return;
      audio.volume = saved.volume ?? 0.8;
      savedVolume = audio.volume;
      volFill.style.width = (audio.volume * 100) + '%';
      recentlyPlayed = saved.recent || [];
      favorites = saved.favorites || [];
      queue = saved.queue || [];
      loopMode = saved.loopMode || 'off';
    } catch (e) {}
  }

  // ---- Favorites ----
  function isFavorite(file) {
    return favorites.some(f => f.file === file);
  }

  function toggleFavorite(track) {
    const idx = favorites.findIndex(f => f.file === track.file);
    if (idx >= 0) {
      favorites.splice(idx, 1);
    } else {
      favorites.push({ title: track.title, file: track.file, category: track.category, artist: track.artist || 'Modest', duration: track.duration || 0 });
    }
    saveState();
    updateHeartStates();
    renderFavorites();
  }

  function updateHeartStates() {
    if (playerHeart && currentTrack) {
      playerHeart.classList.toggle('active', isFavorite(currentTrack.file));
    }
    libraryContainer.querySelectorAll('.radio-lib-heart').forEach(btn => {
      btn.classList.toggle('active', isFavorite(btn.dataset.file));
    });
  }

  function renderFavorites() {
    const container = document.getElementById('radioFavorites');
    if (!container) return;
    if (favorites.length === 0) {
      container.innerHTML = '<div class="radio-queue-empty">No favorites yet. Click the heart on any track.</div>';
      return;
    }
    let html = '';
    favorites.forEach((t, i) => {
      const isPlaying = currentTrack && currentTrack.file === t.file;
      html += `<div class="radio-fav-item${isPlaying ? ' playing' : ''}" data-file="${t.file}" data-title="${t.title}" data-cat="${t.category}" data-artist="${t.artist || 'Modest'}" data-dur="${t.duration || 0}">
        <span class="radio-fav-idx">${i + 1}</span>
        <div class="radio-fav-info">
          <span class="radio-fav-title">${t.title}</span>
          <span class="radio-fav-sub">${t.artist || 'Modest'} \u00b7 ${t.category}</span>
        </div>
        <span class="radio-fav-dur">${t.duration ? formatTime(t.duration) : ''}</span>
        <button class="radio-fav-play" title="Play">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="radio-fav-add" title="Add to queue">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="radio-fav-remove" title="Remove from favorites">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
        </button>
      </div>`;
    });
    container.innerHTML = html;

    container.querySelectorAll('.radio-fav-item').forEach(el => {
      el.querySelector('.radio-fav-play').addEventListener('click', () => {
        isRadioMode = false;
        playTrack({ title: el.dataset.title, file: el.dataset.file, category: el.dataset.cat, artist: el.dataset.artist, duration: parseInt(el.dataset.dur) || 0 });
      });
      el.querySelector('.radio-fav-add').addEventListener('click', () => {
        addToQueue({ title: el.dataset.title, file: el.dataset.file, category: el.dataset.cat, artist: el.dataset.artist, duration: parseInt(el.dataset.dur) || 0 });
      });
      el.querySelector('.radio-fav-remove').addEventListener('click', () => {
        toggleFavorite({ file: el.dataset.file });
      });
    });
  }

  playerHeart?.addEventListener('click', () => {
    if (currentTrack) toggleFavorite(currentTrack);
  });

  // ---- Share ----
  function shareTrack(track) {
    if (!track) return;
    const url = window.location.origin + '/radio?track=' + encodeURIComponent(track.file);
    navigator.clipboard.writeText(url).then(() => {
      showToast('Link copied! Paste in Discord for a rich embed.');
    }).catch(() => {
      showToast('Could not copy link');
    });
  }

  playerShare?.addEventListener('click', () => {
    if (currentTrack) shareTrack(currentTrack);
  });

  // Auto-play from share link
  function checkShareLink() {
    const params = new URLSearchParams(window.location.search);
    const trackFile = params.get('track');
    if (trackFile) {
      const track = flatTracks.find(t => t.file === trackFile);
      if (track) {
        playTrack(track);
        showToast('Playing shared track');
      }
    }
  }

  // ---- Fetch tracks ----
  async function loadTracks() {
    try {
      const [tracksRes, statsRes] = await Promise.all([
        fetch('/api/radio/tracks'),
        fetch('/api/radio/stats'),
      ]);
      allTracks = await tracksRes.json();
      const statsData = await statsRes.json();
      playStats = statsData.plays || {};

      flatTracks = [];
      for (const cat in allTracks) {
        for (const t of allTracks[cat]) {
          flatTracks.push(t);
        }
      }
      buildGenres();
      buildLibrary();
      buildStats();
      buildGenreCards();
      buildRandomPicks();
      buildTop10();
      buildHoursCard(statsData);
      renderRecent();
      renderQueue();
      renderFavorites();
      updateLoopBtn();
      checkShareLink();
    } catch (e) {
      libraryContainer.innerHTML = '<p style="color:var(--text-dim);padding:24px;">Failed to load tracks.</p>';
    }
  }

  // ---- Build genre buttons in sidebar ----
  function buildGenres() {
    const cats = Object.keys(allTracks).filter(c => c !== 'Radio Jingles').sort();
    let html = '<div class="radio-sidebar-label">Genres</div>';
    html += '<button class="radio-genre-btn active" data-genre="all">All</button>';
    for (const cat of cats) {
      html += `<button class="radio-genre-btn" data-genre="${cat}">${cat} <span class="radio-genre-count">${allTracks[cat].length}</span></button>`;
    }
    genresContainer.innerHTML = html;

    genresContainer.querySelectorAll('.radio-genre-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        genresContainer.querySelectorAll('.radio-genre-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        buildLibrary(btn.dataset.genre);
        switchView('library');
      });
    });
  }

  // ---- Build library track listing ----
  function buildLibrary(genre = 'all', filter = '') {
    let tracks = [];
    const filterLower = filter.toLowerCase();
    for (const cat in allTracks) {
      if (cat === 'Radio Jingles') continue;
      if (genre !== 'all' && cat !== genre) continue;
      for (const t of allTracks[cat]) {
        if (filterLower && !t.title.toLowerCase().includes(filterLower) && !(t.artist && t.artist.toLowerCase().includes(filterLower))) continue;
        tracks.push(t);
      }
    }

    if (tracks.length === 0) {
      libraryContainer.innerHTML = '<p class="radio-empty-msg">No tracks found.</p>';
      return;
    }

    const grouped = {};
    for (const t of tracks) {
      if (!grouped[t.category]) grouped[t.category] = [];
      grouped[t.category].push(t);
    }

    let html = '';
    for (const cat of Object.keys(grouped).sort()) {
      html += `<div class="radio-lib-section">`;
      html += `<div class="radio-lib-cat-header">${cat} <span class="radio-lib-cat-count">${grouped[cat].length} tracks</span></div>`;
      html += `<div class="radio-lib-tracks">`;
      for (const t of grouped[cat]) {
        const isPlaying = currentTrack && currentTrack.file === t.file;
        const fav = isFavorite(t.file);
        const dur = t.duration ? formatTime(t.duration) : '';
        html += `<div class="radio-lib-track${isPlaying ? ' playing' : ''}" data-file="${t.file}" data-title="${t.title}" data-cat="${t.category}" data-artist="${t.artist || 'Modest'}" data-dur="${t.duration || 0}">
          <button class="radio-lib-play" title="Play">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
          <div class="radio-lib-track-info">
            <span class="radio-lib-track-title">${t.title}</span>
            <span class="radio-lib-track-artist">${t.artist || 'Modest'}</span>
          </div>
          <span class="radio-lib-plays">${formatPlays(playStats[t.file] || 0)}</span>
          <span class="radio-lib-dur">${dur}</span>
          <button class="radio-lib-heart${fav ? ' active' : ''}" data-file="${t.file}" title="Favorite">
            <svg viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
          <button class="radio-lib-add" title="Add to queue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <button class="radio-lib-playnext" title="Play next">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M5 4l10 8-10 8V4z"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
          </button>
        </div>`;
      }
      html += `</div></div>`;
    }
    libraryContainer.innerHTML = html;

    libraryContainer.querySelectorAll('.radio-lib-track').forEach(el => {
      const trackData = { title: el.dataset.title, file: el.dataset.file, category: el.dataset.cat, artist: el.dataset.artist, duration: parseInt(el.dataset.dur) || 0 };
      el.querySelector('.radio-lib-play').addEventListener('click', () => {
        isRadioMode = false;
        playTrack(trackData);
      });
      el.querySelector('.radio-lib-add').addEventListener('click', (e) => {
        e.stopPropagation();
        addToQueue(trackData);
      });
      el.querySelector('.radio-lib-playnext').addEventListener('click', (e) => {
        e.stopPropagation();
        addToQueue(trackData, true);
      });
      el.querySelector('.radio-lib-heart').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavorite(trackData);
        // Update this button immediately
        const btn = el.querySelector('.radio-lib-heart');
        const fav = isFavorite(trackData.file);
        btn.classList.toggle('active', fav);
        btn.querySelector('svg').setAttribute('fill', fav ? 'currentColor' : 'none');
      });
    });
  }

  // Search
  searchInput?.addEventListener('input', () => {
    const activeGenre = genresContainer.querySelector('.radio-genre-btn.active')?.dataset.genre || 'all';
    buildLibrary(activeGenre, searchInput.value);
  });

  // ---- Queue management ----
  function addToQueue(track, playNext) {
    if (playNext) {
      queue.unshift(track);
      showToast(`"${track.title}" plays next`);
    } else {
      queue.push(track);
      showToast(`Added "${track.title}" to queue`);
    }
    renderQueue();
    saveState();
  }

  function renderQueue() {
    if (queue.length === 0) {
      queueList.innerHTML = '<div class="radio-queue-empty">Your queue is empty. Add songs from the Library.</div>';
      return;
    }
    let html = '';
    queue.forEach((t, i) => {
      html += `<div class="radio-queue-item" data-index="${i}" draggable="true">
        <span class="radio-queue-drag" title="Drag to reorder">\u2261</span>
        <span class="radio-queue-num">${i + 1}</span>
        <div class="radio-queue-info">
          <span class="radio-queue-title">${t.title}</span>
          <span class="radio-queue-cat">${t.artist || 'Modest'} \u00b7 ${t.category}</span>
        </div>
        <span class="radio-queue-dur">${t.duration ? formatTime(t.duration) : ''}</span>
        <button class="radio-queue-play" title="Play now" data-index="${i}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="radio-queue-remove" title="Remove" data-index="${i}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
    });
    queueList.innerHTML = html;

    queueList.querySelectorAll('.radio-queue-play').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        isRadioMode = false;
        playTrack(queue[idx]);
        queue.splice(idx, 1);
        renderQueue();
        saveState();
      });
    });

    queueList.querySelectorAll('.radio-queue-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        queue.splice(parseInt(btn.dataset.index), 1);
        renderQueue();
        saveState();
      });
    });

    // Drag to reorder
    let dragIdx = null;
    queueList.querySelectorAll('.radio-queue-item').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        dragIdx = parseInt(el.dataset.index);
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        dragIdx = null;
        queueList.querySelectorAll('.radio-queue-item').forEach(item => item.classList.remove('drag-over'));
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        queueList.querySelectorAll('.radio-queue-item').forEach(item => item.classList.remove('drag-over'));
        el.classList.add('drag-over');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const dropIdx = parseInt(el.dataset.index);
        if (dragIdx !== null && dragIdx !== dropIdx) {
          const item = queue.splice(dragIdx, 1)[0];
          queue.splice(dropIdx, 0, item);
          renderQueue();
          saveState();
        }
      });
    });
  }

  document.getElementById('queueClearBtn')?.addEventListener('click', () => {
    queue = [];
    renderQueue();
    saveState();
  });

  // Shuffle queue
  document.getElementById('queueShuffleBtn')?.addEventListener('click', () => {
    if (queue.length < 2) return;
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    renderQueue();
    saveState();
    showToast('Queue shuffled');
  });

  // Loop button
  const loopBtn = document.getElementById('queueLoopBtn');
  function updateLoopBtn() {
    if (!loopBtn) return;
    loopBtn.classList.remove('active', 'loop-one');
    if (loopMode === 'queue') {
      loopBtn.classList.add('active');
      loopBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg> Loop';
    } else if (loopMode === 'one') {
      loopBtn.classList.add('active', 'loop-one');
      loopBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="16" fill="currentColor" stroke="none" font-size="9" text-anchor="middle" font-weight="bold">1</text></svg> Loop 1';
    } else {
      loopBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg> Loop';
    }
  }
  loopBtn?.addEventListener('click', () => {
    if (loopMode === 'off') loopMode = 'queue';
    else if (loopMode === 'queue') loopMode = 'one';
    else loopMode = 'off';
    updateLoopBtn();
    saveState();
    const labels = { off: 'Loop off', queue: 'Loop queue', one: 'Loop track' };
    showToast(labels[loopMode]);
  });

  // ---- Play a track ----
  function playTrack(track) {
    // Report seconds listened for the track we're leaving
    reportListened();

    currentTrack = track;
    trackPlayStart = Date.now();
    audio.src = track.file;
    audio.play().catch(() => {});
    addToRecent(track);
    updatePlayerUI();
    updateMediaSession();
    setTimeout(preloadNext, 1000);

    // Record play count
    if (track.category !== 'Radio Jingles') {
      fetch('/api/radio/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: track.file }),
      }).then(r => r.json()).then(data => {
        playStats[track.file] = data.plays;
        updatePlayCountDisplay(track.file, data.plays);
        buildTop10();
      }).catch(() => {});
    }
  }

  function reportListened() {
    if (!trackPlayStart || !currentTrack) return;
    const seconds = Math.floor((Date.now() - trackPlayStart) / 1000);
    trackPlayStart = null;
    if (seconds < 5) return;
    const payload = JSON.stringify({ seconds });
    // Use sendBeacon so it fires reliably on page close too
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/radio/listened', blob);
      refreshHoursCard();
    } else {
      fetch('/api/radio/listened', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }).then(() => refreshHoursCard()).catch(() => {});
    }
  }

  function updatePlayCountDisplay(file, count) {
    document.querySelectorAll(`.radio-lib-track[data-file="${CSS.escape(file)}"] .radio-lib-plays`).forEach(el => {
      el.textContent = formatPlays(count);
    });
  }

  function formatPlays(n) {
    if (!n) return '';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k plays';
    return n + (n === 1 ? ' play' : ' plays');
  }

  async function refreshHoursCard() {
    try {
      const r = await fetch('/api/radio/stats');
      const data = await r.json();
      playStats = data.plays || {};
      buildHoursCard(data);
    } catch (e) {}
  }

  function updatePlayerUI() {
    if (!currentTrack) return;
    playerTitle.textContent = currentTrack.title;
    playerCategory.textContent = (currentTrack.artist || 'Modest') + ' \u00b7 ' + currentTrack.category;
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';

    // Heart state
    if (playerHeart) {
      playerHeart.classList.toggle('active', isFavorite(currentTrack.file));
    }

    libraryContainer.querySelectorAll('.radio-lib-track').forEach(el => {
      el.classList.toggle('playing', el.dataset.file === currentTrack.file);
    });

    if (radioStarted) updateRadioBtn();

    if (isRadioMode) {
      radioNowPlaying.style.display = 'block';
      radioNpTitle.textContent = currentTrack.title;
      radioNpCategory.textContent = (currentTrack.artist || 'Modest') + ' \u00b7 ' + currentTrack.category;
      if (radioIndex + 1 < radioPlaylist.length) {
        radioNpNext.textContent = radioPlaylist[radioIndex + 1].title;
      } else {
        radioNpNext.textContent = 'Shuffling...';
      }
    }
  }

  // ---- Media Session API ----
  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !currentTrack) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: currentTrack.artist || 'Modest',
      album: currentTrack.category + ' \u2014 Modest AI Radio',
    });
    navigator.mediaSession.setActionHandler('play', () => { audio.play(); updatePlayPauseIcon(); });
    navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); updatePlayPauseIcon(); });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      if (audio.currentTime > 3) { audio.currentTime = 0; return; }
      if (isRadioMode && radioIndex > 0) { radioIndex -= 2; playNext(); }
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => { playNext(); });
  }

  function updatePlayPauseIcon() {
    if (audio.paused) {
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
    } else {
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
    }
    if (radioStarted) updateRadioBtn();
  }

  // Sync play/pause icon with audio state
  audio.addEventListener('play', updatePlayPauseIcon);
  audio.addEventListener('pause', updatePlayPauseIcon);

  // ---- Playback controls ----
  document.getElementById('playerPlayPause')?.addEventListener('click', () => {
    if (!currentTrack) return;
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  });

  document.getElementById('playerNext')?.addEventListener('click', () => {
    playNext();
  });

  document.getElementById('playerPrev')?.addEventListener('click', () => {
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (isRadioMode && radioIndex > 0) {
      radioIndex -= 2;
      playNext();
    }
  });

  // ---- Progress bar ----
  let isDraggingProgress = false;
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration || isDraggingProgress) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    progressFill.style.width = pct + '%';
    timeNow.textContent = formatTime(audio.currentTime);
    timeDur.textContent = formatTime(audio.duration);
  });

  // Draggable scrubber helper
  function makeDraggable(bar, onDrag, opts) {
    let dragging = false;
    const pauseAudio = opts && opts.pauseAudio;
    const onCommit = opts && opts.onCommit;
    let wasPlaying = false;
    let lastPct = 0;

    function getPct(e) {
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const rect = bar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }

    function onStart(e) {
      dragging = true;
      if (pauseAudio && !audio.paused) {
        wasPlaying = true;
        audio.pause();
      } else {
        wasPlaying = false;
      }
      lastPct = getPct(e);
      onDrag(lastPct);
    }

    function onMove(e) {
      if (!dragging) return;
      lastPct = getPct(e);
      onDrag(lastPct);
    }

    function onEnd() {
      if (!dragging) return;
      dragging = false;
      if (onCommit) onCommit(lastPct);
      if (pauseAudio && wasPlaying) {
        audio.play().catch(() => {});
        wasPlaying = false;
      }
    }

    bar.addEventListener('mousedown', (e) => { onStart(e); e.preventDefault(); });
    bar.addEventListener('touchstart', (e) => { onStart(e); }, { passive: true });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
  }

  if (progressBar) {
    makeDraggable(progressBar, (pct) => {
      if (!audio.duration) return;
      isDraggingProgress = true;
      progressFill.style.transition = 'none';
      progressFill.style.width = (pct * 100) + '%';
      timeNow.textContent = formatTime(pct * audio.duration);
    }, {
      pauseAudio: true,
      onCommit: (pct) => {
        if (!audio.duration) return;
        audio.currentTime = pct * audio.duration;
        isDraggingProgress = false;
        progressFill.style.transition = '';
      }
    });
  }

  if (volBar) {
    makeDraggable(volBar, (pct) => {
      audio.volume = pct;
      savedVolume = pct;
      volFill.style.width = (pct * 100) + '%';
      saveState();
    });
  }

  // ---- Auto-play next ----
  audio.addEventListener('ended', () => {
    reportListened();
    if (loopMode === 'one' && currentTrack) {
      trackPlayStart = Date.now();
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    playNext();
  });

  function playNext() {
    if (queue.length > 0) {
      const next = queue.shift();
      if (loopMode === 'queue') queue.push(next);
      renderQueue();
      playTrack(next);
      saveState();
      return;
    }

    if (isRadioMode) {
      radioIndex++;
      if (radioIndex >= radioPlaylist.length) {
        buildRadioPlaylist();
        radioIndex = 0;
      }
      playTrack(radioPlaylist[radioIndex]);
      return;
    }

    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
  }

  // ---- Radio mode ----
  function buildRadioPlaylist() {
    const songs = flatTracks.filter(t => t.category !== 'Radio Jingles');
    const jingles = allTracks['Radio Jingles'] || [];

    const shuffled = [...songs].sort(() => Math.random() - 0.5);
    radioPlaylist = [];

    let songCount = 0;
    let nextJingleAt = 2 + Math.floor(Math.random() * 3);

    for (const song of shuffled) {
      radioPlaylist.push(song);
      songCount++;

      if (songCount >= nextJingleAt && jingles.length > 0) {
        const jingle = jingles[Math.floor(Math.random() * jingles.length)];
        radioPlaylist.push(jingle);
        songCount = 0;
        nextJingleAt = 2 + Math.floor(Math.random() * 3);
      }
    }
  }

  function updateRadioBtn() {
    if (!radioStarted) {
      radioStartBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Start Radio
      `;
    } else if (audio.paused) {
      radioStartBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Resume
      `;
    } else {
      radioStartBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2a5.5 5.5 0 0 1 0-8.4"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M16.2 7.8a5.5 5.5 0 0 1 0 8.4"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/></svg>
        On Air
      `;
    }
  }

  radioStartBtn?.addEventListener('click', () => {
    if (!radioStarted) {
      isRadioMode = true;
      radioStarted = true;
      buildRadioPlaylist();
      radioIndex = 0;
      playTrack(radioPlaylist[0]);
    } else if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
    updateRadioBtn();
  });

  // ---- View switching ----
  function switchView(viewId) {
    document.querySelectorAll('.radio-view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.radio-nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + viewId)?.classList.add('active');
    document.querySelector(`.radio-nav-btn[data-view="${viewId}"]`)?.classList.add('active');
  }

  document.querySelectorAll('.radio-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // ---- Keyboard shortcuts ----
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    // Only handle when radio tab is active
    const radioTab = document.getElementById('tab-radio');
    if (!radioTab || !radioTab.classList.contains('active')) return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (!currentTrack) return;
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
        break;
      case 'ArrowRight':
        if (e.shiftKey) { playNext(); } else if (audio.duration) { audio.currentTime = Math.min(audio.duration, audio.currentTime + 10); }
        break;
      case 'ArrowLeft':
        if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 10);
        break;
      case 'ArrowUp':
        e.preventDefault();
        audio.volume = Math.min(1, audio.volume + 0.05);
        savedVolume = audio.volume;
        volFill.style.width = (audio.volume * 100) + '%';
        saveState();
        break;
      case 'ArrowDown':
        e.preventDefault();
        audio.volume = Math.max(0, audio.volume - 0.05);
        savedVolume = audio.volume;
        volFill.style.width = (audio.volume * 100) + '%';
        saveState();
        break;
      case 'KeyM':
        if (audio.volume > 0) {
          savedVolume = audio.volume;
          audio.volume = 0;
        } else {
          audio.volume = savedVolume || 0.8;
        }
        volFill.style.width = (audio.volume * 100) + '%';
        saveState();
        break;
      case 'KeyL':
        if (currentTrack) toggleFavorite(currentTrack);
        break;
    }
  });

  // ---- Toast notification ----
  function showToast(msg) {
    const existing = document.querySelector('.radio-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'radio-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // ---- Stats strip ----
  function buildStats() {
    const songs = flatTracks.filter(t => t.category !== 'Radio Jingles');
    const jingles = (allTracks['Radio Jingles'] || []).length;
    const genres = Object.keys(allTracks).filter(c => c !== 'Radio Jingles').length;
    const container = document.getElementById('radioStats');
    if (!container) return;
    container.innerHTML = `
      <div class="radio-stat-item"><div class="radio-stat-num">${songs.length}</div><div class="radio-stat-label">Songs</div></div>
      <div class="radio-stat-item"><div class="radio-stat-num">${genres}</div><div class="radio-stat-label">Genres</div></div>
      <div class="radio-stat-item"><div class="radio-stat-num">${jingles}</div><div class="radio-stat-label">Jingles</div></div>
      <div class="radio-stat-item"><div class="radio-stat-num">24/7</div><div class="radio-stat-label">On Air</div></div>
    `;
  }

  // ---- Top 10 most played ----
  function buildTop10() {
    const container = document.getElementById('radioTop10');
    if (!container) return;

    const ranked = Object.entries(playStats)
      .filter(([file]) => {
        const t = flatTracks.find(t => t.file === file);
        return t && t.category !== 'Radio Jingles';
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (ranked.length === 0) {
      container.innerHTML = '<div class="radio-top10-empty">Play some tracks to build the chart.</div>';
      return;
    }

    const maxPlays = ranked[0][1];
    let html = '';
    ranked.forEach(([file, count], i) => {
      const track = flatTracks.find(t => t.file === file);
      if (!track) return;
      const colors = genreColors[track.category] || ['#444', '#333'];
      const barPct = Math.round((count / maxPlays) * 100);
      const isPlaying = currentTrack && currentTrack.file === file;
      html += `<div class="radio-top10-item${isPlaying ? ' playing' : ''}" data-file="${file}" data-title="${track.title}" data-cat="${track.category}" data-artist="${track.artist || 'Modest'}" data-dur="${track.duration || 0}">
        <span class="radio-top10-rank">${i + 1}</span>
        <div class="radio-top10-bar-wrap">
          <div class="radio-top10-bar" style="width:${barPct}%;background:linear-gradient(90deg,${colors[0]},${colors[1]})"></div>
          <div class="radio-top10-info">
            <span class="radio-top10-title">${track.title}</span>
            <span class="radio-top10-sub">${track.artist || 'Modest'} \u00b7 ${track.category}</span>
          </div>
        </div>
        <span class="radio-top10-count">${formatPlays(count)}</span>
        <button class="radio-top10-play" title="Play">
          <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>`;
    });
    container.innerHTML = html;

    container.querySelectorAll('.radio-top10-item').forEach(el => {
      el.querySelector('.radio-top10-play').addEventListener('click', () => {
        isRadioMode = false;
        playTrack({ title: el.dataset.title, file: el.dataset.file, category: el.dataset.cat, artist: el.dataset.artist, duration: parseInt(el.dataset.dur) || 0 });
      });
    });
  }

  // ---- Hours listened card ----
  function buildHoursCard(data) {
    const totalPlays = Object.values(data.plays || {}).reduce((a, b) => a + b, 0);

    // Estimate average track duration from flatTracks for better approximation
    const avgDuration = flatTracks.length
      ? flatTracks.filter(t => t.duration > 0).reduce((s, t) => s + t.duration, 0) /
        Math.max(1, flatTracks.filter(t => t.duration > 0).length)
      : 180;

    // Use actual seconds if tracked, otherwise estimate from plays × avg duration
    const estimatedSeconds = totalPlays * avgDuration;
    const effectiveSeconds = Math.max(data.totalSeconds || 0, estimatedSeconds * 0.5);
    const hours = (effectiveSeconds / 3600).toFixed(1);

    const hoursEl = document.getElementById('radioHoursNum');
    const playsEl = document.getElementById('radioPlaysNum');
    if (hoursEl) hoursEl.textContent = hours;
    if (playsEl) playsEl.textContent = totalPlays.toLocaleString();
  }

  // ---- Genre quick-play cards ----
  function buildGenreCards() {
    const container = document.getElementById('radioGenreCards');
    if (!container) return;
    const cats = Object.keys(allTracks).filter(c => c !== 'Radio Jingles').sort();
    let html = '';
    for (const cat of cats) {
      const colors = genreColors[cat] || ['#444', '#333'];
      html += `<div class="radio-genre-card" data-genre="${cat}" style="background: linear-gradient(135deg, ${colors[0]}, ${colors[1]})">
        <div class="radio-genre-card-name">${cat}</div>
        <div class="radio-genre-card-count">${allTracks[cat].length} tracks</div>
        <button class="radio-genre-card-play" title="Play ${cat}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.radio-genre-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.radio-genre-card-play')) {
          const genre = card.dataset.genre;
          const tracks = [...allTracks[genre]].sort(() => Math.random() - 0.5);
          if (tracks.length > 0) {
            isRadioMode = false;
            queue = tracks.slice(1);
            playTrack(tracks[0]);
            renderQueue();
            saveState();
            showToast(`Playing ${genre} (${tracks.length} tracks)`);
          }
        } else {
          genresContainer.querySelectorAll('.radio-genre-btn').forEach(b => b.classList.remove('active'));
          const genreBtn = genresContainer.querySelector(`.radio-genre-btn[data-genre="${card.dataset.genre}"]`);
          if (genreBtn) genreBtn.classList.add('active');
          buildLibrary(card.dataset.genre);
          switchView('library');
        }
      });
    });
  }

  // ---- Random picks ----
  function buildRandomPicks() {
    const container = document.getElementById('radioPicks');
    if (!container) return;
    const songs = flatTracks.filter(t => t.category !== 'Radio Jingles');
    const shuffled = [...songs].sort(() => Math.random() - 0.5).slice(0, 8);
    renderPicks(shuffled);
  }

  function renderPicks(picks) {
    const container = document.getElementById('radioPicks');
    if (!container) return;
    let html = '';
    for (const t of picks) {
      const colors = genreColors[t.category] || ['#444', '#333'];
      const abbr = t.category.substring(0, 3).toUpperCase();
      html += `<div class="radio-pick" data-file="${t.file}" data-title="${t.title}" data-cat="${t.category}" data-artist="${t.artist || 'Modest'}" data-dur="${t.duration || 0}">
        <div class="radio-pick-art" style="background: linear-gradient(135deg, ${colors[0]}, ${colors[1]})">${abbr}</div>
        <div class="radio-pick-info">
          <div class="radio-pick-title">${t.title}</div>
          <div class="radio-pick-cat">${t.artist || 'Modest'} \u00b7 ${t.category}</div>
        </div>
        <button class="radio-pick-btn" title="Play">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>`;
    }
    container.innerHTML = html;

    container.querySelectorAll('.radio-pick').forEach(el => {
      el.addEventListener('click', () => {
        isRadioMode = false;
        playTrack({ title: el.dataset.title, file: el.dataset.file, category: el.dataset.cat, artist: el.dataset.artist, duration: parseInt(el.dataset.dur) || 0 });
      });
    });
  }

  document.getElementById('radioShuffleBtn')?.addEventListener('click', () => {
    buildRandomPicks();
  });

  // ---- Recently played ----
  function addToRecent(track) {
    if (track.category === 'Radio Jingles') return;
    recentlyPlayed = recentlyPlayed.filter(t => t.file !== track.file);
    recentlyPlayed.unshift(track);
    if (recentlyPlayed.length > 10) recentlyPlayed.pop();
    renderRecent();
    saveState();
  }

  function renderRecent() {
    const container = document.getElementById('radioRecent');
    if (!container) return;
    if (recentlyPlayed.length === 0) {
      container.innerHTML = '<div class="radio-recent-empty">Nothing played yet. Hit Start Radio or pick a track from the Library.</div>';
      return;
    }
    let html = '';
    recentlyPlayed.forEach((t, i) => {
      html += `<div class="radio-recent-item" data-file="${t.file}" data-title="${t.title}" data-cat="${t.category}" data-artist="${t.artist || 'Modest'}" data-dur="${t.duration || 0}">
        <span class="radio-recent-idx">${i + 1}</span>
        <span class="radio-recent-title">${t.title}</span>
        <span class="radio-recent-cat">${t.artist || 'Modest'} \u00b7 ${t.category}</span>
        <button class="radio-recent-play" title="Play again">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>`;
    });
    container.innerHTML = html;

    container.querySelectorAll('.radio-recent-item').forEach(el => {
      el.querySelector('.radio-recent-play').addEventListener('click', () => {
        isRadioMode = false;
        playTrack({ title: el.dataset.title, file: el.dataset.file, category: el.dataset.cat, artist: el.dataset.artist, duration: parseInt(el.dataset.dur) || 0 });
      });
    });
  }

  // Report listened time when tab is closed or navigated away
  window.addEventListener('beforeunload', () => {
    if (!trackPlayStart || !currentTrack) return;
    const seconds = Math.floor((Date.now() - trackPlayStart) / 1000);
    if (seconds < 5) return;
    const blob = new Blob([JSON.stringify({ seconds })], { type: 'application/json' });
    navigator.sendBeacon('/api/radio/listened', blob);
  });

  // ---- Init ----
  loadState();
  loadTracks();
})();
