// ---- ReforgedZ Radio Player ----
(function() {
  const audio = new Audio();
  audio.volume = 0.8;

  let allTracks = {};
  let flatTracks = [];
  let queue = [];
  let recentlyPlayed = [];
  let currentTrack = null;
  let currentIndex = -1;
  let isRadioMode = false;
  let radioPlaylist = [];
  let radioIndex = -1;

  const genreColors = {
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

  // Fetch tracks
  async function loadTracks() {
    try {
      const res = await fetch('/api/radio/tracks');
      allTracks = await res.json();
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
    } catch (e) {
      libraryContainer.innerHTML = '<p style="color:var(--text-dim);padding:24px;">Failed to load tracks.</p>';
    }
  }

  // Build genre buttons in sidebar
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
        // Switch to library view
        switchView('library');
      });
    });
  }

  // Build library track listing
  function buildLibrary(genre = 'all', filter = '') {
    let tracks = [];
    const filterLower = filter.toLowerCase();
    for (const cat in allTracks) {
      if (cat === 'Radio Jingles') continue;
      if (genre !== 'all' && cat !== genre) continue;
      for (const t of allTracks[cat]) {
        if (filterLower && !t.title.toLowerCase().includes(filterLower)) continue;
        tracks.push(t);
      }
    }

    if (tracks.length === 0) {
      libraryContainer.innerHTML = '<p class="radio-empty-msg">No tracks found.</p>';
      return;
    }

    // Group by category
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
        html += `<div class="radio-lib-track${isPlaying ? ' playing' : ''}" data-file="${t.file}" data-title="${t.title}" data-cat="${t.category}">
          <button class="radio-lib-play" title="Play">
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>
          <span class="radio-lib-track-title">${t.title}</span>
          <button class="radio-lib-add" title="Add to queue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>`;
      }
      html += `</div></div>`;
    }
    libraryContainer.innerHTML = html;

    // Attach click handlers
    libraryContainer.querySelectorAll('.radio-lib-track').forEach(el => {
      el.querySelector('.radio-lib-play').addEventListener('click', () => {
        isRadioMode = false;
        playTrack({ title: el.dataset.title, file: el.dataset.file, category: el.dataset.cat });
      });
      el.querySelector('.radio-lib-add').addEventListener('click', (e) => {
        e.stopPropagation();
        addToQueue({ title: el.dataset.title, file: el.dataset.file, category: el.dataset.cat });
      });
    });
  }

  // Search
  searchInput?.addEventListener('input', () => {
    const activeGenre = genresContainer.querySelector('.radio-genre-btn.active')?.dataset.genre || 'all';
    buildLibrary(activeGenre, searchInput.value);
  });

  // Queue management
  function addToQueue(track) {
    queue.push(track);
    renderQueue();
    showToast(`Added "${track.title}" to queue`);
  }

  function renderQueue() {
    if (queue.length === 0) {
      queueList.innerHTML = '<div class="radio-queue-empty">Your queue is empty. Add songs from the Library.</div>';
      return;
    }
    let html = '';
    queue.forEach((t, i) => {
      html += `<div class="radio-queue-item" data-index="${i}">
        <span class="radio-queue-num">${i + 1}</span>
        <div class="radio-queue-info">
          <span class="radio-queue-title">${t.title}</span>
          <span class="radio-queue-cat">${t.category}</span>
        </div>
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
      });
    });

    queueList.querySelectorAll('.radio-queue-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        queue.splice(parseInt(btn.dataset.index), 1);
        renderQueue();
      });
    });
  }

  document.getElementById('queueClearBtn')?.addEventListener('click', () => {
    queue = [];
    renderQueue();
  });

  // Play a track
  function playTrack(track) {
    currentTrack = track;
    audio.src = track.file;
    audio.play().catch(() => {});
    addToRecent(track);
    updatePlayerUI();
  }

  function updatePlayerUI() {
    if (!currentTrack) return;
    playerTitle.textContent = currentTrack.title;
    playerCategory.textContent = currentTrack.category;
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';

    // Update library highlighting
    libraryContainer.querySelectorAll('.radio-lib-track').forEach(el => {
      el.classList.toggle('playing', el.dataset.file === currentTrack.file);
    });

    // Update radio button state
    if (radioStarted) updateRadioBtn();

    // Update radio now playing
    if (isRadioMode) {
      radioNowPlaying.style.display = 'block';
      radioNpTitle.textContent = currentTrack.title;
      radioNpCategory.textContent = currentTrack.category;
      if (radioIndex + 1 < radioPlaylist.length) {
        radioNpNext.textContent = radioPlaylist[radioIndex + 1].title;
      } else {
        radioNpNext.textContent = 'Shuffling...';
      }
    }
  }

  // Playback controls
  document.getElementById('playerPlayPause')?.addEventListener('click', () => {
    if (!currentTrack) return;
    if (audio.paused) {
      audio.play().catch(() => {});
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
    } else {
      audio.pause();
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
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

  // Progress bar
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    progressFill.style.width = pct + '%';
    timeNow.textContent = formatTime(audio.currentTime);
    timeDur.textContent = formatTime(audio.duration);
  });

  progressBar?.addEventListener('click', (e) => {
    if (!audio.duration) return;
    const rect = progressBar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
  });

  // Volume
  volBar?.addEventListener('click', (e) => {
    const rect = volBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.volume = pct;
    volFill.style.width = (pct * 100) + '%';
  });

  // Auto-play next
  audio.addEventListener('ended', () => {
    playNext();
  });

  function playNext() {
    // Check queue first
    if (queue.length > 0) {
      const next = queue.shift();
      renderQueue();
      playTrack(next);
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

    // If playing from library, just stop
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
  }

  // Radio mode
  function buildRadioPlaylist() {
    const songs = flatTracks.filter(t => t.category !== 'Radio Jingles');
    const jingles = allTracks['Radio Jingles'] || [];

    // Shuffle songs
    const shuffled = [...songs].sort(() => Math.random() - 0.5);
    radioPlaylist = [];

    // Insert jingles between every 2-4 songs
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

  let radioStarted = false;

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
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
    } else {
      audio.pause();
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
    }
    updateRadioBtn();
  });

  // View switching
  function switchView(viewId) {
    document.querySelectorAll('.radio-view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.radio-nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('view-' + viewId)?.classList.add('active');
    document.querySelector(`.radio-nav-btn[data-view="${viewId}"]`)?.classList.add('active');
  }

  document.querySelectorAll('.radio-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Toast notification
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

  // Stats strip
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

  // Genre quick-play cards
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
          // Play all from this genre shuffled
          const genre = card.dataset.genre;
          const tracks = [...allTracks[genre]].sort(() => Math.random() - 0.5);
          if (tracks.length > 0) {
            isRadioMode = false;
            queue = tracks.slice(1);
            playTrack(tracks[0]);
            renderQueue();
            showToast(`Playing ${genre} (${tracks.length} tracks)`);
          }
        } else {
          // Navigate to library filtered by genre
          genresContainer.querySelectorAll('.radio-genre-btn').forEach(b => b.classList.remove('active'));
          const genreBtn = genresContainer.querySelector(`.radio-genre-btn[data-genre="${card.dataset.genre}"]`);
          if (genreBtn) genreBtn.classList.add('active');
          buildLibrary(card.dataset.genre);
          switchView('library');
        }
      });
    });
  }

  // Random picks
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
      html += `<div class="radio-pick" data-file="${t.file}" data-title="${t.title}" data-cat="${t.category}">
        <div class="radio-pick-art" style="background: linear-gradient(135deg, ${colors[0]}, ${colors[1]})">${abbr}</div>
        <div class="radio-pick-info">
          <div class="radio-pick-title">${t.title}</div>
          <div class="radio-pick-cat">${t.category}</div>
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
        playTrack({ title: el.dataset.title, file: el.dataset.file, category: el.dataset.cat });
      });
    });
  }

  document.getElementById('radioShuffleBtn')?.addEventListener('click', () => {
    buildRandomPicks();
  });

  // Recently played
  function addToRecent(track) {
    if (track.category === 'Radio Jingles') return;
    recentlyPlayed = recentlyPlayed.filter(t => t.file !== track.file);
    recentlyPlayed.unshift(track);
    if (recentlyPlayed.length > 10) recentlyPlayed.pop();
    renderRecent();
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
      html += `<div class="radio-recent-item" data-file="${t.file}" data-title="${t.title}" data-cat="${t.category}">
        <span class="radio-recent-idx">${i + 1}</span>
        <span class="radio-recent-title">${t.title}</span>
        <span class="radio-recent-cat">${t.category}</span>
        <button class="radio-recent-play" title="Play again">
          <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>`;
    });
    container.innerHTML = html;

    container.querySelectorAll('.radio-recent-item').forEach(el => {
      el.querySelector('.radio-recent-play').addEventListener('click', () => {
        isRadioMode = false;
        playTrack({ title: el.dataset.title, file: el.dataset.file, category: el.dataset.cat });
      });
    });
  }

  // Init
  loadTracks();
})();
