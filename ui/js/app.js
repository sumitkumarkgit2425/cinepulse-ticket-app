/**
 * CinePulse — Premium Cinema & Movie Ticket Booking System (BookMyShow Style)
 * Client Application Logic:
 * - Multi-View Navigation: Home Screen -> Movie Details & Theaters -> Seat Map & Checkout
 * - Hero Billboard Carousel with auto-rotation
 * - Real-time Search & Genre Filter Engine
 * - City Selector & Cinema Venue Multi-Hall Routing
 * - Real-time WebSocket synchronization across all open sessions
 * - Atomic Compare-And-Swap (CAS) Seat Hold Engine with 120s TTL leases
 * - Interactive Concurrency Stress-Test Suite ("Bot Rush Simulator")
 * - Web Audio API synthesized acoustic feedback
 * - Dynamic Canvas QR Code Generator for Verified Cinema Boarding Passes
 */

import { fetchNowPlayingMovies, formatTMDBMovieForCinePulse } from './services/tmdb.js';
import { loginWithGoogle, listenToAuthChanges, logout, loginAsGuest } from './services/firebaseAuth.js';
import { initShowSeats, listenToSeats, holdSeat, releaseSeat, bookSeats } from './services/firestoreDb.js';

const state = {
    clientId: 'client_' + Math.random().toString(36).substring(2, 9),
    socket: null,
    currentView: 'home', // 'home' | 'movie-detail' | 'seat-map'
    movies: [],
    filteredMovies: [],
    activeMovie: null,
    activeCinema: null,
    activeShow: null,
    activeDate: 'Today, Sep 24',
    activeGenre: 'all',
    searchQuery: '',
    selectedCity: 'New York, NY',
    carouselIndex: 0,
    carouselInterval: null,
    seatsData: {}, // seatId -> seatObject
    myHeldSeats: new Map(), // seatId -> { holdToken, expiresAt, price, tier }
    holdTimerInterval: null,
    audioEnabled: true,
    audioCtx: null,
    user: null // Track authenticated user
  };

  // --- AUDIO SYNTHESIZER (Web Audio API) ---
  function initAudio() {
    if (!state.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        state.audioCtx = new AudioContext();
      }
    }
    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }
  }

  function playTone(freq, type = 'sine', duration = 0.08, gainVal = 0.15) {
    if (!state.audioEnabled) return;
    try {
      initAudio();
      if (!state.audioCtx) return;
      const osc = state.audioCtx.createOscillator();
      const gain = state.audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, state.audioCtx.currentTime);
      gain.gain.setValueAtTime(gainVal, state.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, state.audioCtx.currentTime + duration);
      osc.connect(gain);
      gain.connect(state.audioCtx.destination);
      osc.start();
      osc.stop(state.audioCtx.currentTime + duration);
    } catch (e) {
      // Audio autoplay policy fallback
    }
  }

  function playClickSound() { playTone(540, 'triangle', 0.04, 0.12); }
  function playConflictSound() {
    playTone(220, 'sawtooth', 0.15, 0.2);
    setTimeout(() => playTone(180, 'sawtooth', 0.2, 0.2), 80);
  }
  function playSuccessChord() {
    [523.25, 659.25, 783.99, 1046.50].forEach((freq, idx) => {
      setTimeout(() => playTone(freq, 'sine', 0.4, 0.15), idx * 70);
    });
  }

  function updateWsStatus(status, text) {
    const dot = document.getElementById('ws-pulse-dot');
    const label = document.getElementById('ws-status-text');
    if (!dot || !label) return;

    dot.className = 'pulse-dot';
    if (status === 'connected') {
      dot.classList.add('active');
    }
    label.textContent = text;
  }

  // --- VIEW ROUTING & NAVIGATION ---
  function showView(viewName, params = {}) {
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const viewAuth = document.getElementById('view-auth');
    const viewHome = document.getElementById('view-home');
    const viewMovieDetail = document.getElementById('view-movie-detail');
    const viewSeatMap = document.getElementById('view-seat-map');

    if (viewAuth) viewAuth.classList.add('hidden');
    if (viewHome) viewHome.classList.add('hidden');
    if (viewMovieDetail) viewMovieDetail.classList.add('hidden');
    if (viewSeatMap) viewSeatMap.classList.add('hidden');

    state.currentView = viewName;

    if (viewName === 'auth') {
      if (viewAuth) viewAuth.classList.remove('hidden');
      stopCarouselAutoSlide();
    } else if (viewName === 'home') {
      viewHome.classList.remove('hidden');
      startCarouselAutoSlide();
    } else if (viewName === 'movie-detail') {
      stopCarouselAutoSlide();
      if (params.movieId) {
        const movie = state.movies.find(m => m.id === params.movieId);
        if (movie) setupMovieDetailPage(movie);
      }
      viewMovieDetail.classList.remove('hidden');
    } else if (viewName === 'seat-map') {
      stopCarouselAutoSlide();
      if (params.showId) {
        setupSeatMapPage(params.showId, params.movie, params.cinema, params.show);
      }
      viewSeatMap.classList.remove('hidden');
    }
  }

  // --- DATA LOADING ---
  async function loadInitialData() {
    try {
      // 1. Try to fetch from TMDB
      let finalMovies = [];
      const tmdbMovies = await fetchNowPlayingMovies();
      
      // 2. Fetch local API mock data as fallback/base
      const res = await fetch('/api/shows');
      const data = await res.json();
      let localMovies = data.success ? data.movies : [];

      if (tmdbMovies && tmdbMovies.length > 0) {
        // Map TMDB movies and attach local mock cinemas for the demo
        finalMovies = tmdbMovies.slice(0, 10).map((tmdbM, idx) => {
          const formatted = formatTMDBMovieForCinePulse(tmdbM);
          // Attach cinemas from local mock data if available, or generate mock ones
          formatted.cinemas = localMovies[idx % localMovies.length]?.cinemas || localMovies[0]?.cinemas || [];
          return formatted;
        });
      } else {
        // Fallback to local
        finalMovies = localMovies;
      }

      if (finalMovies.length > 0) {
        state.movies = finalMovies;
        state.filteredMovies = [...finalMovies];
        
        renderHeroCarousel();
        renderMoviesGrid();
        populateLabSeatDropdown();
      }
    } catch (e) {
      console.error('Failed to load shows:', e);
      showToast('Could not reach cinema server.', 'conflict');
    }
    loadBookingsCount();
  }

  // --- VIEW 1: HERO CAROUSEL ---
  function renderHeroCarousel() {
    const wrap = document.getElementById('hero-slide-wrap');
    const indicators = document.getElementById('carousel-indicators');
    if (!wrap || !indicators) return;

    wrap.innerHTML = '';
    indicators.innerHTML = '';

    const featuredMovies = state.movies.slice(0, 4);

    featuredMovies.forEach((m, idx) => {
      const slide = document.createElement('div');
      slide.className = `hero-slide ${idx === 0 ? 'active' : ''}`;
      slide.id = `hero-slide-${idx}`;

      slide.innerHTML = `
        <div class="hero-slide-backdrop" style="background-image: url('${m.banner}')"></div>
        <div class="hero-slide-content">
          <div class="hero-poster-box">
            <img src="${m.poster}" alt="${m.title}">
          </div>
          <div class="hero-details-box">
            <div class="hero-pill-row">
              <span class="hero-format-badge">IMAX 70MM & 4DX</span>
              <span class="hero-cert-badge">${m.rating}</span>
              <span class="hero-cert-badge">${m.duration}</span>
            </div>
            <h1 class="hero-title">${m.title}</h1>
            <p class="hero-tagline">${m.tagline}</p>
            <div class="hero-rating-box">
              <span class="score">⭐ ${m.score}/10</span>
              <span class="votes">(${m.votes})</span>
            </div>
            <p class="hero-synopsis">${m.synopsis}</p>
            <button class="hero-cta-btn" data-movie-id="${m.id}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
              <span>Book Tickets</span>
            </button>
          </div>
        </div>
      `;

      slide.querySelector('.hero-cta-btn').addEventListener('click', () => {
        playClickSound();
        showView('movie-detail', { movieId: m.id });
      });

      wrap.appendChild(slide);

      // Indicator dot
      const dot = document.createElement('div');
      dot.className = `carousel-dot ${idx === 0 ? 'active' : ''}`;
      dot.addEventListener('click', () => setCarouselSlide(idx));
      indicators.appendChild(dot);
    });

    startCarouselAutoSlide();
  }

  function setCarouselSlide(index) {
    const slides = document.querySelectorAll('.hero-slide');
    const dots = document.querySelectorAll('.carousel-dot');
    if (slides.length === 0) return;

    state.carouselIndex = (index + slides.length) % slides.length;

    slides.forEach((s, i) => s.classList.toggle('active', i === state.carouselIndex));
    dots.forEach((d, i) => d.classList.toggle('active', i === state.carouselIndex));
  }

  function startCarouselAutoSlide() {
    stopCarouselAutoSlide();
    state.carouselInterval = setInterval(() => {
      setCarouselSlide(state.carouselIndex + 1);
    }, 6000);
  }

  function stopCarouselAutoSlide() {
    if (state.carouselInterval) {
      clearInterval(state.carouselInterval);
      state.carouselInterval = null;
    }
  }

  // --- VIEW 1: MOVIES GRID (NOW SHOWING) ---
  function renderMoviesGrid() {
    const grid = document.getElementById('movies-grid');
    const countBadge = document.getElementById('movies-count-badge');
    if (!grid) return;

    grid.innerHTML = '';

    // Filter by genre & search query
    let list = state.movies;
    if (state.activeGenre !== 'all') {
      if (state.activeGenre === 'IMAX') {
        list = list.filter(m => m.languages.some(l => l.includes('IMAX')));
      } else {
        list = list.filter(m => m.genre.toLowerCase().includes(state.activeGenre.toLowerCase()));
      }
    }

    if (state.searchQuery.trim()) {
      const q = state.searchQuery.toLowerCase();
      list = list.filter(m => 
        m.title.toLowerCase().includes(q) || 
        m.genre.toLowerCase().includes(q) ||
        m.cast.toLowerCase().includes(q)
      );
    }

    state.filteredMovies = list;
    if (countBadge) {
      countBadge.textContent = `${list.length} Movie${list.length === 1 ? '' : 's'} Available`;
    }

    if (list.length === 0) {
      grid.innerHTML = `
        <div class="empty-seats-state" style="grid-column: 1 / -1; padding: 40px;">
          <p>No movies match your search or filter.</p>
          <span style="color: var(--text-muted);">Try a different keyword or select "All Movies".</span>
        </div>
      `;
      return;
    }

    list.forEach(m => {
      const card = document.createElement('div');
      card.className = 'movie-card';
      card.innerHTML = `
        <div class="movie-poster-container">
          <img src="${m.poster}" alt="${m.title}" loading="lazy">
          <div class="card-rating-strip">
            <span class="star">⭐</span>
            <span class="score-val">${m.score}/10</span>
            <span class="votes-val">${m.votes}</span>
          </div>
          <div class="card-hover-overlay">
            <button class="hover-book-btn">Book Tickets</button>
          </div>
        </div>
        <div class="card-info">
          <h3 class="card-title">${m.title}</h3>
          <p class="card-genre">${m.genre}</p>
          <span class="card-languages">${m.languages.join(' • ')}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        playClickSound();
        showView('movie-detail', { movieId: m.id });
      });

      grid.appendChild(card);
    });
  }

  // --- VIEW 2: MOVIE DETAILS & SHOWTIME SELECTOR ---
  function setupMovieDetailPage(movie) {
    state.activeMovie = movie;

    document.getElementById('crumb-movie-title').textContent = movie.title;
    document.getElementById('detail-movie-title').textContent = movie.title;
    document.getElementById('detail-movie-tagline').textContent = movie.tagline;
    document.getElementById('detail-movie-cert').textContent = movie.rating;
    document.getElementById('detail-movie-duration').textContent = movie.duration;
    document.getElementById('detail-movie-languages').textContent = movie.languages.join(' • ');
    document.getElementById('detail-movie-score').textContent = movie.score;
    document.getElementById('detail-movie-votes').textContent = `(${movie.votes})`;
    document.getElementById('detail-movie-genres').textContent = movie.genre;
    document.getElementById('detail-movie-synopsis').textContent = movie.synopsis;
    document.getElementById('detail-director').textContent = movie.director;
    document.getElementById('detail-cast').textContent = movie.cast;
    document.getElementById('detail-movie-poster').src = movie.poster;

    const backdrop = document.getElementById('movie-detail-backdrop');
    if (backdrop) backdrop.style.backgroundImage = `url('${movie.banner}')`;

    renderCinemaVenues(movie);
  }

  function renderCinemaVenues(movie) {
    const stack = document.getElementById('cinemas-stack');
    if (!stack) return;
    stack.innerHTML = '';

    if (!movie.cinemas || movie.cinemas.length === 0) {
      stack.innerHTML = `<div class="empty-seats-state"><p>No screening venues available for this film today.</p></div>`;
      return;
    }

    movie.cinemas.forEach(cinema => {
      const card = document.createElement('div');
      card.className = 'cinema-venue-card';

      // Left info
      const meta = document.createElement('div');
      meta.className = 'cinema-meta-info';
      meta.innerHTML = `
        <h3 class="cinema-name-title">${cinema.name}</h3>
        <span class="cinema-distance">📍 ${cinema.distance} • Free Parking Available</span>
        <div class="cinema-amenities-row">
          ${cinema.amenities.map(a => `<span class="amenity-chip">${a}</span>`).join('')}
        </div>
      `;
      card.appendChild(meta);

      // Right showtimes
      const grid = document.createElement('div');
      grid.className = 'cinema-showtimes-grid';

      cinema.shows.forEach(show => {
        const btn = document.createElement('button');
        btn.className = `showtime-pill-btn status-${show.status}`;
        btn.title = `${show.format} • ${show.hall} • Starts at ₹${show.priceStarting.toFixed(0)}`;

        btn.innerHTML = `
          <span class="pill-time">${show.time}</span>
          <span class="pill-format">${show.format}</span>
          <span class="pill-price">₹${show.priceStarting.toFixed(0)}</span>
        `;

        btn.addEventListener('click', () => {
          playClickSound();
          showView('seat-map', {
            showId: show.id,
            movie: movie,
            cinema: cinema,
            show: show
          });
        });

        grid.appendChild(btn);
      });

      card.appendChild(grid);
      stack.appendChild(card);
    });
  }

  // --- VIEW 3: SEAT MAP & CHECKOUT ---
  async function setupSeatMapPage(showId, movie, cinema, show) {
    state.activeShow = show;
    state.activeMovie = movie;
    state.activeCinema = cinema;

    // Release any previous holds if moving to a different show
    releaseAllHeldSeats(false);

    // Update Header and Summary
    document.getElementById('crumb-screening-summary').textContent = `${movie.title} • ${show.time} (${show.hall})`;
    document.getElementById('current-hall-name').textContent = `${cinema ? cinema.name : 'Cinema Hall'} — ${show.hall}`;
    document.getElementById('current-hall-screen').textContent = show.screenType;

    document.getElementById('summary-movie-name').textContent = movie.title;
    document.getElementById('summary-cinema-name').textContent = cinema ? cinema.name : 'Cinema Theater';
    document.getElementById('summary-hall-name').textContent = show.hall;
    document.getElementById('summary-show-time').textContent = show.time;
    document.getElementById('summary-show-date').textContent = state.activeDate;

    await loadSeatsForShow(showId);
  }

  async function loadSeatsForShow(showId) {
    try {
      await initShowSeats(showId);
      listenToSeats(showId, (seats) => {
        state.seatsData = seats;
        renderSeatGrid();
        updateSeatStats();
        checkHoldTimerStatus();
        updateCheckoutDrawer();
      });
    } catch (e) {
      console.error(e);
    }
  }

  function renderSeatGrid() {
    const container = document.getElementById('seat-grid-container');
    if (!container) return;
    container.innerHTML = '';

    const now = Date.now();
    const sections = [
      { name: 'VIP Recliners — Rows A & B (₹450)', rows: ['A', 'B'] },
      { name: 'Premium Club — Rows C, D & E (₹320)', rows: ['C', 'D', 'E'] },
      { name: 'Standard Experience — Rows F, G & H (₹220)', rows: ['F', 'G', 'H'] }
    ];

    sections.forEach(sec => {
      const block = document.createElement('div');
      block.className = 'tier-section-block';

      const secLabel = document.createElement('div');
      secLabel.className = 'tier-section-label';
      secLabel.textContent = sec.name;
      block.appendChild(secLabel);

      sec.rows.forEach(rowLetter => {
        const rowEl = document.createElement('div');
        rowEl.className = 'seat-row';

        const rowLabelL = document.createElement('span');
        rowLabelL.className = 'row-letter';
        rowLabelL.textContent = rowLetter;
        rowEl.appendChild(rowLabelL);

        // 12 seats with center aisle (3 - 6 - 3)
        const cluster1 = document.createElement('div');
        cluster1.className = 'seat-cluster';
        for (let i = 1; i <= 3; i++) cluster1.appendChild(createSeatElement(`${rowLetter}${i}`, now));
        rowEl.appendChild(cluster1);

        const aisle1 = document.createElement('div');
        aisle1.className = 'aisle-space';
        rowEl.appendChild(aisle1);

        const cluster2 = document.createElement('div');
        cluster2.className = 'seat-cluster';
        for (let i = 4; i <= 9; i++) cluster2.appendChild(createSeatElement(`${rowLetter}${i}`, now));
        rowEl.appendChild(cluster2);

        const aisle2 = document.createElement('div');
        aisle2.className = 'aisle-space';
        rowEl.appendChild(aisle2);

        const cluster3 = document.createElement('div');
        cluster3.className = 'seat-cluster';
        for (let i = 10; i <= 12; i++) cluster3.appendChild(createSeatElement(`${rowLetter}${i}`, now));
        rowEl.appendChild(cluster3);

        const rowLabelR = document.createElement('span');
        rowLabelR.className = 'row-letter';
        rowLabelR.textContent = rowLetter;
        rowEl.appendChild(rowLabelR);

        block.appendChild(rowEl);
      });

      container.appendChild(block);
    });
  }

  function createSeatElement(seatId, now) {
    const seat = state.seatsData[seatId];
    const el = document.createElement('div');
    el.className = `seat tier-${seat ? seat.tier : 'standard'}`;
    el.dataset.seatId = seatId;

    if (!seat) {
      el.classList.add('sold-out');
      return el;
    }

    const isSelectedByMe = state.myHeldSeats.has(seatId);
    const isHeldByOther = seat.status === 'HELD' && seat.heldBy !== state.clientId && seat.holdExpiresAt > now;
    const isSold = seat.status === 'CONFIRMED';

    if (isSelectedByMe) {
      el.classList.add('selected-by-me');
      el.title = `Seat ${seatId} — Reserved by you (₹${seat.price})`;
    } else if (isHeldByOther) {
      el.classList.add('locked-by-other');
      const remSecs = Math.max(1, Math.round((seat.holdExpiresAt - now) / 1000));
      el.title = `Seat ${seatId} — Reserved by another customer (${remSecs}s hold remaining)`;
    } else if (isSold) {
      el.classList.add('sold-out');
      el.title = `Seat ${seatId} — Sold Out`;
    } else {
      el.classList.add('available');
      el.title = `Seat ${seatId} — ${seat.tierLabel} (₹${seat.price})`;
    }

    el.innerHTML = `
      <span class="seat-num">${seat.number}</span>
      <div class="seat-cushion"></div>
    `;

    el.addEventListener('click', () => handleSeatClick(seatId));

    return el;
  }

  function updateSeatStats() {
    let avail = 0;
    let held = 0;
    let sold = 0;
    const now = Date.now();

    Object.values(state.seatsData).forEach(s => {
      if (s.status === 'CONFIRMED') sold++;
      else if (s.status === 'HELD' && s.holdExpiresAt > now) held++;
      else avail++;
    });

    const elAvail = document.getElementById('stat-available-count');
    const elHeld = document.getElementById('stat-held-count');
    const elSold = document.getElementById('stat-sold-count');
    if (elAvail) elAvail.textContent = avail;
    if (elHeld) elHeld.textContent = held;
    if (elSold) elSold.textContent = sold;
  }

  // --- SEAT INTERACTION & CONCURRENCY HOLD LEASE ---
  async function handleSeatClick(seatId) {
    initAudio();
    const seat = state.seatsData[seatId];
    if (!seat) return;

    if (state.myHeldSeats.has(seatId)) {
      playClickSound();
      await releaseSeatHold(seatId);
      return;
    }

    if (seat.status === 'CONFIRMED') {
      playConflictSound();
      showToast(`Seat ${seatId} is already booked.`, 'conflict');
      return;
    }

    if (seat.status === 'HELD' && seat.heldBy !== state.clientId && seat.holdExpiresAt > Date.now()) {
      playConflictSound();
      const remSecs = Math.max(1, Math.round((seat.holdExpiresAt - Date.now()) / 1000));
      showToast(`⚠️ Seat ${seatId} is locked by another customer! (${remSecs}s hold lease remaining)`, 'conflict');
      return;
    }

    playClickSound();
    const customerName = document.getElementById('cust-name')?.value || 'Customer';

    const res = await holdSeat(state.activeShow.id, seatId, state.clientId);
    if (res.success) {
      state.myHeldSeats.set(seatId, {
        expiresAt: res.expiresAt,
        price: res.price,
        tier: res.tierLabel
      });
      startHoldCountdown(res.expiresAt);
      showToast(`Seat ${seatId} locked exclusively for you for 2 minutes.`, 'info');
    } else {
      playConflictSound();
      showToast(res.message || `Could not reserve seat ${seatId}.`, 'conflict');
    }
  }

  async function releaseSeatHold(seatId) {
    if (!state.myHeldSeats.has(seatId)) return;
    await releaseSeat(state.activeShow.id, seatId, state.clientId);
    state.myHeldSeats.delete(seatId);
  }

  async function releaseAllHeldSeats(notify = true) {
    if (state.myHeldSeats.size === 0) return;
    const seatIds = Array.from(state.myHeldSeats.keys());
    for (const id of seatIds) {
      await releaseSeat(state.activeShow?.id || 'show-101', id, state.clientId);
    }
    state.myHeldSeats.clear();
    stopHoldCountdown();
    if (notify) {
      showToast('All seat locks released.', 'info');
    }
  }

  // --- HOLD COUNTDOWN TIMER ---
  function startHoldCountdown(targetExpiresAt) {
    const banner = document.getElementById('hold-timer-banner');
    if (banner) banner.classList.remove('hidden');

    if (state.holdTimerInterval) {
      clearInterval(state.holdTimerInterval);
    }

    const totalDuration = 120 * 1000;

    const updateTick = () => {
      const now = Date.now();
      const remaining = Math.max(0, targetExpiresAt - now);

      if (remaining <= 0) {
        clearInterval(state.holdTimerInterval);
        state.holdTimerInterval = null;
        state.myHeldSeats.clear();
        stopHoldCountdown();
        renderSeatGrid();
        updateCheckoutDrawer();
        playConflictSound();
        showToast('Your reservation lock has expired. Seats returned to pool.', 'conflict');
        return;
      }

      const totalSec = Math.floor(remaining / 1000);
      const mins = Math.floor(totalSec / 60);
      const secs = totalSec % 60;
      const displayStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

      const countEl = document.getElementById('countdown-display');
      if (countEl) countEl.textContent = displayStr;

      const progressFill = document.getElementById('timer-progress-bar');
      if (progressFill) {
        const pct = (remaining / totalDuration) * 100;
        progressFill.style.width = `${pct}%`;
      }

      if (totalSec <= 15 && totalSec > 0 && totalSec % 5 === 0) {
        playTone(440, 'triangle', 0.05, 0.1);
      }
    };

    updateTick();
    state.holdTimerInterval = setInterval(updateTick, 1000);
  }

  function stopHoldCountdown() {
    if (state.holdTimerInterval) {
      clearInterval(state.holdTimerInterval);
      state.holdTimerInterval = null;
    }
    const banner = document.getElementById('hold-timer-banner');
    if (banner) banner.classList.add('hidden');
  }

  function checkHoldTimerStatus() {
    if (state.myHeldSeats.size === 0) {
      stopHoldCountdown();
    }
  }

  // --- CHECKOUT DRAWER & MATH ---
  function updateCheckoutDrawer() {
    const selectedCount = state.myHeldSeats.size;
    const elSelectedCount = document.getElementById('selected-count');
    if (elSelectedCount) elSelectedCount.textContent = selectedCount;

    const clearBtn = document.getElementById('clear-selection-btn');
    if (clearBtn) clearBtn.classList.toggle('hidden', selectedCount === 0);

    const badge = document.getElementById('booking-badge');
    if (badge) {
      if (selectedCount > 0) {
        badge.textContent = `${selectedCount} Seat${selectedCount === 1 ? '' : 's'} Locked`;
        badge.className = 'booking-status-tag active';
      } else {
        badge.textContent = 'No Seats Selected';
        badge.className = 'booking-status-tag';
      }
    }

    const listEl = document.getElementById('selected-chips-list');
    if (!listEl) return;

    if (selectedCount === 0) {
      listEl.innerHTML = `
        <div class="empty-seats-state">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"></path>
            <path d="M3 11v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z"></path>
          </svg>
          <span>Click on any available seat in the map to reserve it.</span>
        </div>
      `;
    } else {
      listEl.innerHTML = '';
      state.myHeldSeats.forEach((data, seatId) => {
        const chip = document.createElement('div');
        chip.className = 'selected-seat-chip';
        chip.innerHTML = `
          <span>${seatId} (${data.tier})</span>
          <button class="chip-remove-btn" title="Remove">&times;</button>
        `;
        chip.querySelector('.chip-remove-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          releaseSeatHold(seatId);
        });
        listEl.appendChild(chip);
      });
    }

    // Math
    let subtotal = 0;
    state.myHeldSeats.forEach(d => { subtotal += d.price; });
    const fee = selectedCount > 0 ? selectedCount * 25 : 0;
    const tax = subtotal > 0 ? parseFloat(((subtotal + fee) * 0.18).toFixed(2)) : 0;
    const total = subtotal > 0 ? parseFloat((subtotal + fee + tax).toFixed(2)) : 0;

    document.getElementById('price-subtotal').textContent = `₹${subtotal.toFixed(0)}`;
    document.getElementById('price-fee').textContent = `₹${fee.toFixed(0)}`;
    document.getElementById('price-tax').textContent = `₹${tax.toFixed(2)}`;
    document.getElementById('price-total').textContent = `₹${total.toFixed(2)}`;
    document.getElementById('btn-total-amount').textContent = `₹${total.toFixed(0)}`;

    const submitBtn = document.getElementById('checkout-submit-btn');
    if (submitBtn) {
      submitBtn.disabled = selectedCount === 0;
    }
  }

  async function submitBooking() {
    if (state.myHeldSeats.size === 0) return;

    const seatIds = Array.from(state.myHeldSeats.keys());
    const custName = document.getElementById('cust-name').value.trim() || 'Alex Mercer';
    const custEmail = document.getElementById('cust-email').value.trim() || 'alex.mercer@example.com';
    const submitBtn = document.getElementById('checkout-submit-btn');

    const subtotal = seatIds.reduce((sum, id) => sum + (state.seatsData[id]?.price || 0), 0);
    const fee = seatIds.length * 25;
    const tax = parseFloat(((subtotal + fee) * 0.18).toFixed(2));
    const total = parseFloat((subtotal + fee + tax).toFixed(2));

    const selectedMethod = document.querySelector('input[name="payment-method"]:checked')?.value || 'Razorpay';

    if (selectedMethod === 'DemoPay') {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="btn-text">Confirming Booking...</span>';
      const res = await bookSeats(state.activeShow.id, seatIds, state.clientId, { 
        name: custName, 
        email: custEmail, 
        paymentMethod: 'Instant Pass (Direct Test)', 
        paymentId: 'TEST_' + Date.now().toString().slice(-6)
      });
      if (res.success) {
        playSuccessChord();
        state.myHeldSeats.clear();
        stopHoldCountdown();
        updateCheckoutDrawer();
        renderSeatGrid();
        showTicketPassModal({
          bookingId: res.bookingId,
          hall: state.activeShow.hall,
          screenType: state.activeShow.screenType,
          movieTitle: state.activeMovie.title,
          showDate: state.activeDate,
          showTime: state.activeShow.time,
          seatIds,
          customer: { name: custName },
          total
        });
        loadBookingsCount();
        showToast('🎉 Booking Confirmed! Cinema Pass Issued.', 'success');
      } else {
        playConflictSound();
        showToast(res.message || 'Booking failed.', 'conflict');
      }
      submitBtn.disabled = state.myHeldSeats.size === 0;
      submitBtn.innerHTML = `
        <span class="btn-text">Confirm Booking</span>
        <span class="btn-amount" id="btn-total-amount">₹0</span>
      `;
      updateCheckoutDrawer();
      return;
    }

    const paymentMethod = 'Razorpay (Online)';
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="btn-text">Opening Razorpay...</span>';

    try {
      let orderData = null;
      try {
        const orderRes = await fetch('/api/payment/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: total })
        });
        const data = await orderRes.json();
        if (data && data.success) {
          orderData = data;
        }
      } catch (apiErr) {
        console.warn("Backend order creation endpoint error:", apiErr);
      }

      if (!orderData || !orderData.order || !orderData.order.id) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
          <span class="btn-text">Confirm Booking</span>
          <span class="btn-amount" id="btn-total-amount">₹${total.toFixed(0)}</span>
        `;
        playConflictSound();
        showToast("Razorpay requires a valid Key Secret in .env to create orders. Add your Secret in .env or select 'Instant Pass' to test immediately.", "conflict");
        return;
      }

      if (typeof window.Razorpay === 'undefined') {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
          <span class="btn-text">Confirm Booking</span>
          <span class="btn-amount" id="btn-total-amount">₹${total.toFixed(0)}</span>
        `;
        throw new Error("Razorpay payment gateway SDK is not loaded. Please check your internet connection.");
      }

      const keyId = orderData.keyId;
      const amountInPaise = orderData.order.amount;

      const options = {
        key: keyId,
        amount: amountInPaise,
        currency: "INR",
        name: "CinePulse Cinema",
        description: `Tickets for ${state.activeMovie?.title || 'Selected Show'}`,
        order_id: orderData.order.id,
        prefill: { name: custName, email: custEmail },
        theme: { color: "#00f0ff" },
      handler: async function (response) {
        submitBtn.innerHTML = '<span class="btn-text">Confirming Booking...</span>';
        const res = await bookSeats(state.activeShow.id, seatIds, state.clientId, { 
          name: custName, 
          email: custEmail, 
          paymentMethod, 
          paymentId: response.razorpay_payment_id || ('PAY_' + Date.now().toString().slice(-6))
        });
        if (res.success) {
          playSuccessChord();
          state.myHeldSeats.clear();
          stopHoldCountdown();
          updateCheckoutDrawer();
          renderSeatGrid();
          showTicketPassModal({
            bookingId: res.bookingId,
            hall: state.activeShow.hall,
            screenType: state.activeShow.screenType,
            movieTitle: state.activeMovie.title,
            showDate: state.activeDate,
            showTime: state.activeShow.time,
            seatIds,
            customer: { name: custName },
            total
          });
          loadBookingsCount();
          showToast('🎉 Booking Confirmed! Cinema Pass Issued.', 'success');
        } else {
          playConflictSound();
          showToast(res.message || 'Booking failed.', 'conflict');
        }
        submitBtn.disabled = state.myHeldSeats.size === 0;
        submitBtn.innerHTML = `
          <span class="btn-text">Confirm Booking</span>
          <span class="btn-amount" id="btn-total-amount">₹0</span>
        `;
        updateCheckoutDrawer();
      },
      modal: {
        ondismiss: function() {
          submitBtn.disabled = false;
          submitBtn.innerHTML = `
            <span class="btn-text">Confirm Booking</span>
            <span class="btn-amount" id="btn-total-amount">₹${total.toFixed(0)}</span>
          `;
        }
      }
    };

    if (orderData && orderData.order && orderData.order.id) {
      options.order_id = orderData.order.id;
    }

    const rzp = new window.Razorpay(options);
      rzp.on('payment.failed', function (response){
        playConflictSound();
        const msg = response.error?.description || response.error?.reason || 'Payment failed';
        showToast(msg, 'conflict');
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
          <span class="btn-text">Confirm Booking</span>
          <span class="btn-amount" id="btn-total-amount">₹${total.toFixed(0)}</span>
        `;
      });
      rzp.open();
    } catch (e) {
      playConflictSound();
      showToast(e.message || 'Payment initialization failed', 'conflict');
      submitBtn.disabled = false;
      submitBtn.innerHTML = `
        <span class="btn-text">Confirm Booking</span>
        <span class="btn-amount" id="btn-total-amount">₹${total.toFixed(0)}</span>
      `;
    }
  }

  // --- DIGITAL CINEMA PASS & QR CODE GENERATOR ---
  function showTicketPassModal(booking) {
    document.getElementById('ticket-hall').textContent = `${booking.hall} • ${booking.screenType}`;
    document.getElementById('ticket-booking-id').textContent = booking.bookingId;
    document.getElementById('ticket-movie-title').textContent = booking.movieTitle;
    document.getElementById('ticket-screen-type').textContent = booking.screenType;
    document.getElementById('ticket-date').textContent = booking.showDate;
    document.getElementById('ticket-time').textContent = booking.showTime;
    document.getElementById('ticket-seats').textContent = booking.seatIds.join(', ');
    document.getElementById('ticket-guest-name').textContent = booking.customer.name;
    document.getElementById('stub-seats-display').textContent = booking.seatIds.join(', ');
    document.getElementById('stub-total-display').textContent = `₹${booking.total.toFixed(2)} PAID`;
    document.getElementById('ticket-barcode-num').textContent = `4829 0184 ${booking.bookingId.replace(/[^0-9]/g, '').padEnd(8, '0')}`;

    drawTicketQRCode('ticket-qr-canvas', booking.qrPayload || booking.bookingId);

    const modal = document.getElementById('ticket-pass-modal');
    if (modal) modal.classList.remove('hidden');
  }

  function drawTicketQRCode(canvasId, payload) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    const cells = 25;
    const cellSize = size / cells;

    let hash = 0;
    for (let i = 0; i < payload.length; i++) {
      hash = ((hash << 5) - hash) + payload.charCodeAt(i);
      hash |= 0;
    }

    ctx.fillStyle = '#000000';

    function drawFinder(startX, startY) {
      ctx.fillRect(startX * cellSize, startY * cellSize, 7 * cellSize, 7 * cellSize);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect((startX + 1) * cellSize, (startY + 1) * cellSize, 5 * cellSize, 5 * cellSize);
      ctx.fillStyle = '#000000';
      ctx.fillRect((startX + 2) * cellSize, (startY + 2) * cellSize, 3 * cellSize, 3 * cellSize);
    }

    drawFinder(1, 1);
    drawFinder(cells - 8, 1);
    drawFinder(1, cells - 8);

    for (let r = 0; r < cells; r++) {
      for (let c = 0; c < cells; c++) {
        if ((r < 9 && c < 9) || (r < 9 && c > cells - 10) || (r > cells - 10 && c < 9)) {
          continue;
        }
        const pseudoBit = Math.abs(Math.sin((r * 31) + (c * 17) + hash)) > 0.48;
        if (pseudoBit) {
          ctx.fillRect(c * cellSize, r * cellSize, cellSize - 0.5, cellSize - 0.5);
        }
      }
    }
  }

  // --- MY BOOKINGS MODAL ---
  async function loadBookingsCount() {
    try {
      const res = await fetch('/api/bookings');
      const data = await res.json();
      if (data.success) {
        const badge = document.getElementById('my-bookings-count');
        if (badge) badge.textContent = data.bookings.length;
      }
    } catch (e) {
      // ignore
    }
  }

  async function openMyBookings() {
    try {
      const res = await fetch('/api/bookings');
      const data = await res.json();
      const grid = document.getElementById('bookings-grid');
      if (!grid) return;

      if (!data.success || data.bookings.length === 0) {
        grid.innerHTML = `
          <div class="empty-seats-state" style="padding: 40px;">
            <p>No confirmed bookings yet.</p>
            <span style="font-size: 0.8rem; color: var(--text-muted);">Reserve seats and checkout to view your passes here.</span>
          </div>
        `;
      } else {
        grid.innerHTML = '';
        data.bookings.forEach(b => {
          const item = document.createElement('div');
          item.className = 'booking-ticket-item';
          item.innerHTML = `
            <div class="ticket-item-info">
              <div>
                <span class="ticket-item-id">#${b.bookingId}</span>
                <h4 class="ticket-item-title">${b.movieTitle}</h4>
                <div class="ticket-item-meta">
                  ${b.hall} • ${b.showTime} • ${b.showDate}
                  <span class="ticket-item-seats">Seats: ${b.seatIds.join(', ')}</span>
                </div>
              </div>
            </div>
            <div class="ticket-item-actions">
              <button class="view-pass-btn">View Pass</button>
              <button class="cancel-booking-btn">Cancel & Release</button>
            </div>
          `;

          item.querySelector('.view-pass-btn').addEventListener('click', () => {
            document.getElementById('my-bookings-modal').classList.add('hidden');
            showTicketPassModal(b);
          });

          item.querySelector('.cancel-booking-btn').addEventListener('click', async () => {
            if (confirm(`Cancel booking #${b.bookingId} and release seats [${b.seatIds.join(', ')}]?`)) {
              await cancelBooking(b.bookingId);
              openMyBookings();
            }
          });

          grid.appendChild(item);
        });
      }

      document.getElementById('my-bookings-modal').classList.remove('hidden');
    } catch (e) {
      console.error('Error fetching bookings:', e);
    }
  }

  async function cancelBooking(bookingId) {
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        showToast(`Booking #${bookingId} cancelled. Seats returned to pool.`, 'info');
        loadBookingsCount();
      }
    } catch (e) {
      showToast('Error cancelling booking', 'conflict');
    }
  }

  // --- CONCURRENCY LABORATORY & BOT RUSH SIMULATOR ---
  function populateLabSeatDropdown() {
    const select = document.getElementById('lab-target-seat');
    if (!select) return;
    select.innerHTML = `
      <option value="C6" selected>Seat C6 (Premium Club - Center)</option>
      <option value="A6">Seat A6 (VIP Recliner - Center)</option>
      <option value="D7">Seat D7 (Premium Club)</option>
      <option value="F6">Seat F6 (Standard Center)</option>
    `;
  }

  async function launchBotRushSimulation() {
    initAudio();
    const seatId = document.getElementById('lab-target-seat').value;
    const botCount = parseInt(document.getElementById('lab-bot-count').value, 10);
    const showId = state.activeShow ? state.activeShow.id : 'show-101';

    const launchBtn = document.getElementById('launch-stress-btn');
    launchBtn.disabled = true;
    launchBtn.innerHTML = '<span>Simulating High Concurrency...</span>';

    try {
      const res = await fetch('/api/simulate-race', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showId, seatId, botCount })
      });

      const data = await res.json();

      if (data.success && data.report) {
        playTone(660, 'sine', 0.2, 0.2);
        displaySimulationResults(data.report);
      } else {
        showToast(data.message || 'Simulation failed.', 'conflict');
      }
    } catch (e) {
      console.error('Simulation error:', e);
      showToast('Network error during bot rush.', 'conflict');
    } finally {
      launchBtn.disabled = false;
      launchBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        <span>Launch Bot Rush Simulation</span>
      `;
      loadAuditLogs();
    }
  }

  function displaySimulationResults(report) {
    const box = document.getElementById('simulation-results-box');
    box.classList.remove('hidden');

    document.getElementById('metric-duration').textContent = `${report.totalDurationMs}ms`;
    document.getElementById('metric-winners').textContent = report.winnerCount;
    document.getElementById('metric-conflicts').textContent = report.conflictCount;

    const verdictTitle = document.getElementById('verdict-title');
    const verdictDesc = document.getElementById('verdict-desc');

    if (report.doubleBookingPrevented) {
      verdictTitle.textContent = 'RACE CONDITION ELIMINATED: ZERO DOUBLE-BOOKINGS';
      verdictDesc.textContent = `${report.totalBots} concurrent bot requests submitted simultaneously at t0. Atomic Lock granted exclusively to ${report.winner ? report.winner.botName : 'Bot'}; exactly ${report.conflictCount} requests blocked with HTTP 409 Conflict.`;
    } else {
      verdictTitle.textContent = 'WARNING: Contention Anomaly Detected';
    }

    const waterfallList = document.getElementById('waterfall-list');
    waterfallList.innerHTML = '';

    report.attempts.forEach(att => {
      const row = document.createElement('div');
      row.className = `waterfall-row ${att.success ? 'winner-row' : 'conflict-row'}`;
      row.innerHTML = `
        <span><strong>${att.botName}</strong></span>
        <span><span class="${att.success ? 'badge-200' : 'badge-409'}">${att.status} ${att.success ? 'OK' : 'CONFLICT'}</span></span>
        <span>${att.reason}</span>
        <span style="text-align: right;">${att.latencyUs} μs</span>
      `;
      waterfallList.appendChild(row);
    });
  }

  async function loadAuditLogs() {
    try {
      const res = await fetch('/api/audit-logs');
      const data = await res.json();
      const tbody = document.getElementById('audit-logs-tbody');
      if (!tbody) return;

      if (data.success && data.logs.length > 0) {
        tbody.innerHTML = '';
        data.logs.slice(0, 30).forEach(log => {
          const tr = document.createElement('tr');
          const timeFormatted = new Date(log.timestamp).toLocaleTimeString();
          tr.innerHTML = `
            <td>${timeFormatted}</td>
            <td><strong>${log.type}</strong></td>
            <td>${log.seatId || (log.seatIds ? log.seatIds.join(', ') : '--')}</td>
            <td>${(log.clientId || log.prevHolder || log.customer || '--').slice(0, 10)}</td>
            <td>${log.message || ''}</td>
          `;
          tbody.appendChild(tr);
        });
      }
    } catch (e) {
      console.error('Audit logs error:', e);
    }
  }

  // --- RESET SCREENING UTILITY ---
  async function resetCurrentShow() {
    if (!state.activeShow) return;
    if (confirm(`Reset all seats in ${state.activeShow.hall} to available?`)) {
      try {
        const res = await fetch(`/api/shows/${state.activeShow.id}/reset`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          state.myHeldSeats.clear();
          stopHoldCountdown();
          state.seatsData = data.seats;
          renderSeatGrid();
          updateCheckoutDrawer();
          updateSeatStats();
          showToast('Screening reset to default state.', 'info');
        }
      } catch (e) {
        showToast('Error resetting screening.', 'conflict');
      }
    }
  }

  // --- TOAST NOTIFICATIONS ---
  function showToast(message, type = 'info') {
    const stack = document.getElementById('toast-container');
    if (!stack) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'conflict') icon = '⚠️';
    if (type === 'success') icon = '🎉';

    toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
    stack.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // --- SETUP EVENT LISTENERS ---
  function setupEventListeners() {
    // Brand Logo -> Return to Home
    document.getElementById('brand-logo')?.addEventListener('click', () => {
      showView('home');
    });

    document.getElementById('nav-home-btn')?.addEventListener('click', () => {
      showView('home');
    });

    document.getElementById('back-to-home-btn')?.addEventListener('click', () => {
      showView('home');
    });

    document.getElementById('back-to-showtimes-btn')?.addEventListener('click', () => {
      if (state.activeMovie) {
        showView('movie-detail', { movieId: state.activeMovie.id });
      } else {
        showView('home');
      }
    });

    // City Selector Toggle & Menu
    const cityBtn = document.getElementById('city-toggle-btn');
    const cityMenu = document.getElementById('city-dropdown-menu');
    cityBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      cityMenu.classList.toggle('hidden');
    });

    document.querySelectorAll('.city-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('.city-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        state.selectedCity = opt.dataset.city;
        document.getElementById('current-city-label').textContent = state.selectedCity;
        cityMenu.classList.add('hidden');
        showToast(`City changed to ${state.selectedCity}`, 'info');
      });
    });

    document.addEventListener('click', (e) => {
      if (!cityMenu.contains(e.target) && e.target !== cityBtn) {
        cityMenu.classList.add('hidden');
      }
    });

    // Global Search Input
    const searchInput = document.getElementById('global-search-input');
    const clearSearchBtn = document.getElementById('search-clear-btn');

    searchInput?.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      clearSearchBtn.classList.toggle('hidden', !state.searchQuery);
      if (state.currentView !== 'home') {
        showView('home');
      }
      renderMoviesGrid();
    });

    clearSearchBtn?.addEventListener('click', () => {
      searchInput.value = '';
      state.searchQuery = '';
      clearSearchBtn.classList.add('hidden');
      renderMoviesGrid();
    });

    // Genre Filter Chips
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.activeGenre = chip.dataset.genre;
        renderMoviesGrid();
      });
    });

    // Date Cards in Movie Detail
    document.querySelectorAll('.date-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.date-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        state.activeDate = card.dataset.date;
        showToast(`Showtimes for ${state.activeDate}`, 'info');
      });
    });

    // Sound Toggle
    document.getElementById('audio-toggle-btn')?.addEventListener('click', () => {
      initAudio();
      state.audioEnabled = !state.audioEnabled;
      document.getElementById('audio-icon-on').classList.toggle('hidden', !state.audioEnabled);
      document.getElementById('audio-icon-off').classList.toggle('hidden', state.audioEnabled);
      showToast(`Sound ${state.audioEnabled ? 'Enabled' : 'Muted'}`, 'info');
    });

    // Hold Banner Release
    document.getElementById('release-all-holds-btn')?.addEventListener('click', () => {
      releaseAllHeldSeats(true);
    });

    document.getElementById('clear-selection-btn')?.addEventListener('click', () => {
      releaseAllHeldSeats(true);
    });

    // Reset Demo Seats
    document.getElementById('reset-hall-seats-btn')?.addEventListener('click', resetCurrentShow);

    // Checkout Form
    document.getElementById('checkout-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      submitBooking();
    });

    // Payment Radio Buttons
    document.querySelectorAll('.pay-radio').forEach(radio => {
      radio.addEventListener('click', () => {
        document.querySelectorAll('.pay-radio').forEach(r => r.classList.remove('active'));
        radio.classList.add('active');
        radio.querySelector('input').checked = true;
      });
    });

    // Concurrency Lab Modal
    const labModal = document.getElementById('concurrency-lab-modal');
    document.getElementById('open-lab-btn')?.addEventListener('click', () => {
      labModal.classList.remove('hidden');
      loadAuditLogs();
    });
    document.getElementById('close-lab-btn')?.addEventListener('click', () => {
      labModal.classList.add('hidden');
    });
    document.getElementById('launch-stress-btn')?.addEventListener('click', launchBotRushSimulation);
    document.getElementById('refresh-audit-btn')?.addEventListener('click', loadAuditLogs);

    const botSlider = document.getElementById('lab-bot-count');
    const botLabel = document.getElementById('bot-count-display');
    botSlider?.addEventListener('input', () => {
      if (botLabel) botLabel.textContent = `${botSlider.value} Bots`;
    });

    // My Bookings Modal
    const bookingsModal = document.getElementById('my-bookings-modal');
    document.getElementById('open-bookings-btn')?.addEventListener('click', openMyBookings);
    document.getElementById('close-bookings-btn')?.addEventListener('click', () => {
      bookingsModal.classList.add('hidden');
    });

    // Ticket Pass Modal
    const ticketModal = document.getElementById('ticket-pass-modal');
    document.getElementById('close-ticket-pass-btn')?.addEventListener('click', () => {
      ticketModal.classList.add('hidden');
    });
    document.getElementById('done-ticket-btn')?.addEventListener('click', () => {
      ticketModal.classList.add('hidden');
    });
    document.getElementById('print-ticket-btn')?.addEventListener('click', () => {
      window.print();
    });

    // Close on backdrop or escape
    [labModal, bookingsModal, ticketModal].forEach(modal => {
      modal?.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    });

    // Auth Flow Event Listeners
    document.getElementById('login-google-btn')?.addEventListener('click', async () => {
      try {
        const user = await loginWithGoogle();
        if (user) {
          showView('home');
        }
      } catch (err) {
        showToast('Login Failed', 'conflict');
      }
    });

    document.getElementById('login-guest-btn')?.addEventListener('click', async () => {
      try {
        const user = await loginAsGuest();
        if (user) {
          showView('home');
          showToast('Logged in as Guest', 'info');
        }
      } catch (err) {
        showToast('Guest Login Failed', 'conflict');
      }
    });

    document.getElementById('profile-toggle-btn')?.addEventListener('click', async () => {
      if (state.user) {
        if (confirm("Do you want to log out?")) {
          await logout();
          showView('auth');
        }
      } else {
        showView('auth');
      }
    });

    // Listen to Firebase Auth state
    listenToAuthChanges((user) => {
      state.user = user;
      const navNameEl = document.getElementById('nav-user-name');
      const avatarEl = document.querySelector('.user-avatar img');
      const navAvatarEl = document.querySelector('.nav-avatar');

      if (user) {
        const nameEl = document.querySelector('.greeting-name');
        if (nameEl) nameEl.textContent = user.displayName || 'Guest User';
        if (navNameEl) navNameEl.textContent = user.displayName ? user.displayName.split(' ')[0] : 'Account';
        if (avatarEl && user.photoURL) avatarEl.src = user.photoURL;
        if (navAvatarEl && user.photoURL) navAvatarEl.src = user.photoURL;
        if (state.currentView === 'auth') {
          showView('home');
        }
      } else {
        const nameEl = document.querySelector('.greeting-name');
        if (nameEl) nameEl.textContent = 'Guest User';
        if (navNameEl) navNameEl.textContent = 'Sign In';
      }
    });
  }

  function updateGreetingTime() {
    const el = document.getElementById('greeting-time');
    if (!el) return;
    const hour = new Date().getHours();
    if (hour < 12) el.textContent = 'Good Morning,';
    else if (hour < 18) el.textContent = 'Good Afternoon,';
    else el.textContent = 'Good Evening,';
  }

  // --- BOOTSTRAP ---
  window.addEventListener('DOMContentLoaded', () => {
    updateGreetingTime();
    setupEventListeners();
    updateWsStatus('connected', 'Live Sync (Firestore)');
    loadInitialData();
  });
