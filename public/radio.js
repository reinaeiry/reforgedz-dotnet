// ---- ReforgedZ Radio Player ----
(function() {
  const audio = new Audio();
  audio.volume = 0.8;

  let allTracks = {};
  let flatTracks = [];
  let queue = [];
  let currentTrack = null;
  let currentIndex = -1;
  let isRadioMode = false;
  let radioPlaylist = [];
  let radioIndex = -1;

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

  radioStartBtn?.addEventListener('click', () => {
    isRadioMode = true;
    buildRadioPlaylist();
    radioIndex = 0;
    playTrack(radioPlaylist[0]);
    radioStartBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
      On Air
    `;
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

  // Init
  loadTracks();
})();
