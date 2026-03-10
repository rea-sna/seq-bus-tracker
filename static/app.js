const API = '';

let autoRefreshEnabled = true;
let currentStopId = null;  // ターミナルはparent_id、通常停はstop_id
let currentIsTerminal = false;
let currentStopLat = null;
let currentStopLon = null;
let refreshTimer = null;
let activeCardIndex = null;
let showAllArrivals = false;

// ── Favorites ────────────────────────────────────────────────────────────────
// { stop_id, stop_name, stop_lat, stop_lon, is_terminal }
let favorites = JSON.parse(localStorage.getItem('seq_favorites') || '[]');

function saveFavorites() {
  localStorage.setItem('seq_favorites', JSON.stringify(favorites));
}

function renderFavorites() {
  const section = document.getElementById('favorites-section');
  const list = document.getElementById('favorites-list');
  if (!favorites.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  list.innerHTML = favorites.map((f, i) => `
    <div class="fav-item${currentStopId === f.stop_id ? ' active' : ''}"
         onclick="selectStop('${f.stop_id}','${escAttr(f.stop_name)}','${f.stop_lat}','${f.stop_lon}',${f.is_terminal || false})">
      <span class="fav-icon">★</span>
      <span class="fav-name">${escHtml(f.stop_name)}</span>
      <button class="fav-remove" onclick="removeFavorite(event,${i})" title="Remove">×</button>
    </div>`).join('');
}

function toggleFavorite() {
  if (!currentStopId) return;
  const idx = favorites.findIndex(f => f.stop_id === currentStopId);
  if (idx >= 0) {
    favorites.splice(idx, 1);
  } else {
    favorites.push({
      stop_id: currentStopId,
      stop_name: document.getElementById('stop-header-name').textContent,
      stop_lat: currentStopLat,
      stop_lon: currentStopLon,
      is_terminal: currentIsTerminal || false,
    });
  }
  saveFavorites();
  renderFavorites();
  updateFavBtn();
}

function removeFavorite(e, index) {
  e.stopPropagation();
  favorites.splice(index, 1);
  saveFavorites();
  renderFavorites();
  updateFavBtn();
}

function updateFavBtn() {
  const btn = document.getElementById('fav-btn');
  if (!btn) return;
  const isFav = favorites.some(f => f.stop_id === currentStopId);
  btn.textContent = isFav ? '★' : '☆';
  btn.classList.toggle('active', isFav);
}

// 起動時にお気に入りを描画
renderFavorites();
let lastArrivals = [];

// ── Favorites ────────────────────────────────────────────────────────────────
const FAV_KEY = 'seq_bus_favorites';

function loadFavorites() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); }
  catch { return []; }
}

function saveFavorites(favs) {
  localStorage.setItem(FAV_KEY, JSON.stringify(favs));
}

function isFavorite(stopId) {
  return loadFavorites().some(f => f.stop_id === stopId);
}

function toggleFavorite() {
  if (!currentStopId) return;
  let favs = loadFavorites();
  const idx = favs.findIndex(f => f.stop_id === currentStopId);
  if (idx >= 0) {
    favs.splice(idx, 1);
  } else {
    favs.push({
      stop_id: currentStopId,
      stop_name: document.getElementById('stop-header-name').textContent,
      stop_lat: currentStopLat,
      stop_lon: currentStopLon,
      is_terminal: currentIsTerminal,
    });
  }
  saveFavorites(favs);
  renderFavBtn();
  renderFavorites();
}

function renderFavBtn() {
  const btn = document.getElementById('fav-btn');
  if (!btn) return;
  const active = isFavorite(currentStopId);
  btn.textContent = active ? '★' : '☆';
  btn.classList.toggle('active', active);
}

function renderFavorites() {
  const favs = loadFavorites();
  const section = document.getElementById('favorites-section');
  const list = document.getElementById('favorites-list');

  if (!favs.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  list.innerHTML = favs.map(f => `
    <div class="fav-chip${f.stop_id === currentStopId ? ' active' : ''}"
         onclick="selectStop('${f.stop_id}','${escAttr(f.stop_name)}','${f.stop_lat}','${f.stop_lon}',${f.is_terminal || false})">
      <span class="fav-chip-name">${escHtml(f.stop_name)}</span>
      <button class="fav-chip-remove" onclick="removeFavorite(event,'${f.stop_id}')">×</button>
    </div>`).join('');
}

function removeFavorite(e, stopId) {
  e.stopPropagation();
  const favs = loadFavorites().filter(f => f.stop_id !== stopId);
  saveFavorites(favs);
  renderFavBtn();
  renderFavorites();
}

// 起動時にお気に入りを表示
renderFavorites();

// ── Leaflet ──────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true });

const TILES = {
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors © <a href="https://carto.com">CARTO</a>'
  },
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors © <a href="https://carto.com">CARTO</a>'
  }
};

function getScheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

let tileLayer = L.tileLayer(TILES[getScheme()].url, {
  attribution: TILES[getScheme()].attribution,
  subdomains: 'abcd',
  maxZoom: 20
}).addTo(map);

map.setView([-27.47, 153.02], 12);

// OSのカラースキーム変化をリアルタイムに検知してタイルを差し替え
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const scheme = getScheme();
  map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILES[scheme].url, {
    attribution: TILES[scheme].attribution,
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);
  tileLayer.bringToBack();
});

let stopMarker = null;
let routeLayer = null;
let stopDotLayer = null;

const stopIcon = L.divIcon({
  className: '',
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#00e5a0;border:3px solid #fff;box-shadow:0 0 10px rgba(0,229,160,0.9);"></div>`,
  iconSize: [14, 14], iconAnchor: [7, 7]
});

function placeStopMarker(lat, lon, name) {
  if (stopMarker) map.removeLayer(stopMarker);
  stopMarker = L.marker([lat, lon], { icon: stopIcon, zIndexOffset: 1000 })
    .addTo(map)
    .bindPopup(`<b style="color:#111">${escHtml(name)}</b>`);
  map.setView([lat, lon], 12);
}

async function showRoute(shapeId, tripId, routeShort, headsign, routeColor, platformStopId = null) {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (stopDotLayer) { map.removeLayer(stopDotLayer); stopDotLayer = null; }

  const hint = document.getElementById('map-hint');
  const lineColor = routeColor || '#0099ff';
  hint.innerHTML = `<span style="color:var(--muted)">Loading…</span>`;

  // タイムラインは shape の有無に関わらず常に表示
  renderTimeline(tripId, lineColor, platformStopId);

  if (!shapeId) {
    hint.innerHTML = `<span style="color:var(--muted)">No shape data for this route</span>`;
    return;
  }

  try {
    const res = await fetch(`${API}/api/shapes/${shapeId}`);
    if (!res.ok) throw new Error();
    const data = await res.json();

    routeLayer = L.polyline(
      data.coords.map(c => [c[0], c[1]]),
      { color: lineColor, weight: 4, opacity: 0.9, lineJoin: 'round' }
    ).addTo(map);

    // バス停ドットを取得して描画
    try {
      const stRes = await fetch(`${API}/api/trips/${tripId}/stops`);
      if (stRes.ok) {
        const stData = await stRes.json();
        if (stopDotLayer) map.removeLayer(stopDotLayer);
        stopDotLayer = L.layerGroup();

        stData.stops.forEach(s => {
          const lat = parseFloat(s.stop_lat);
          const lon = parseFloat(s.stop_lon);
          if (isNaN(lat) || isNaN(lon)) return;

          const isCurrentStop = s.stop_id === (platformStopId || currentStopId);
          const dot = L.circleMarker([lat, lon], {
            radius: isCurrentStop ? 7 : 4,
            fillColor: isCurrentStop ? '#00e5a0' : '#ffffff',
            color: isCurrentStop ? '#fff' : (lineColor || '#0099ff'),
            weight: isCurrentStop ? 3 : 1.5,
            opacity: 1,
            fillOpacity: isCurrentStop ? 1 : 0.9,
          }).bindTooltip(escHtml(s.stop_name), {
            direction: 'top', offset: [0, -4],
            className: 'stop-tooltip'
          });
          stopDotLayer.addLayer(dot);
        });

        stopDotLayer.addTo(map);
      }
    } catch { /* ドット描画失敗は無視 */ }

    if (stopMarker) stopMarker.setZIndexOffset(1000);

    try {
      const bounds = currentStopLat
        ? routeLayer.getBounds().extend([currentStopLat, currentStopLon])
        : routeLayer.getBounds();
      map.fitBounds(bounds, { padding: [28, 28] });
    } catch { /* fitBounds失敗は無視 */ }

    hint.innerHTML = `<span class="map-route-label" style="background:${lineColor}">${escHtml(routeShort)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(headsign)}</span>`;

  } catch (e) {
    console.error('showRoute error:', e);
    hint.innerHTML = `<span style="color:var(--muted)">Route shape unavailable</span>`;
  }
}

function clearRoute() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (stopDotLayer) { map.removeLayer(stopDotLayer); stopDotLayer = null; }
  document.getElementById('map-hint').innerHTML = '← Select a bus to show its route';
  const tl = document.getElementById('stop-timeline');
  tl.style.display = 'none';
  tl.innerHTML = '';
  if (currentStopLat) map.setView([currentStopLat, currentStopLon], 12);
}

// ── GPS / Nearby stops ───────────────────────────────────────────────────────
let gpsMarker = null;

async function findNearbyStops() {
  const btn = document.getElementById('gps-btn');
  if (!navigator.geolocation) {
    showError('Geolocation is not supported by your browser.');
    return;
  }
  btn.classList.add('loading');
  btn.querySelector('#gps-icon').textContent = '↻';

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;

      // 現在地マーカーを地図に表示
      if (gpsMarker) map.removeLayer(gpsMarker);
      gpsMarker = L.circleMarker([lat, lon], {
        radius: 8, fillColor: '#0099ff', color: '#fff',
        weight: 2, opacity: 1, fillOpacity: 0.9,
      }).addTo(map).bindPopup('You are here');
      map.setView([lat, lon], 15);
      document.getElementById('main-panel').classList.add('visible');
      setTimeout(() => map.invalidateSize(), 50);

      try {
        const res = await fetch(`${API}/api/stops/nearby?lat=${lat}&lon=${lon}&radius=600`);
        const stops = await res.json();
        if (!stops.length) {
          showError('No bus stops found nearby.');
          btn.classList.remove('loading');
          btn.querySelector('#gps-icon').textContent = '◎';
          return;
        }
        // 検索結果ドロップダウンに距離付きで表示
        renderStopList(stops, true);
        stopList.classList.add('visible');
        searchInput.value = '';
        searchInput.placeholder = 'Nearby stops ↓';
      } catch {
        showError('Could not fetch nearby stops.');
      }

      btn.classList.remove('loading');
      btn.classList.add('active');
      btn.querySelector('#gps-icon').textContent = '◎';
    },
    (err) => {
      btn.classList.remove('loading');
      btn.querySelector('#gps-icon').textContent = '◎';
      if (err.code === 1) showError('Location access denied. Please allow location in your browser.');
      else showError('Could not get your location. Please try again.');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ── Search ───────────────────────────────────────────────────────────────────
const searchInput = document.getElementById('search-input');
const stopList = document.getElementById('stop-list');
let searchTimer = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { stopList.innerHTML = ''; stopList.classList.remove('visible'); return; }
  searchTimer = setTimeout(() => fetchStops(q), 300);
});

async function fetchStops(q) {
  try {
    const res = await fetch(`${API}/api/stops/search?q=${encodeURIComponent(q)}`);
    renderStopList(await res.json());
  } catch { showError('Could not reach the server. Is FastAPI running?'); }
}

function renderStopList(stops, showDistance = false) {
  if (!stops.length) {
    stopList.innerHTML = '<div class="stop-item"><span style="color:var(--muted);font-size:13px">No stops found</span></div>';
    stopList.classList.add('visible'); return;
  }
  stopList.innerHTML = stops.map(s => {
    const icon = s.is_terminal
      ? `<span class="stop-terminal-icon">🚏</span>`
      : `<span class="stop-dot"></span>`;
    const platforms = s.is_terminal && s.platforms.length
      ? `<span class="stop-platforms">${s.platforms.length} platforms</span>`
      : '';
    const distLabel = showDistance && s.distance_m != null
      ? `<span class="stop-dist">${s.distance_m}m</span>`
      : `<span class="stop-id">#${s.stop_id}</span>`;
    return `
      <div class="stop-item" onclick="selectStop('${s.stop_id}','${escAttr(s.stop_name)}','${s.stop_lat}','${s.stop_lon}',${s.is_terminal})">
        ${icon}
        <span class="stop-name">${escHtml(s.stop_name)}</span>
        ${platforms}
        ${distLabel}
      </div>`;
  }).join('');
  stopList.classList.add('visible');
}

// ── Select stop ──────────────────────────────────────────────────────────────
function selectStop(stopId, stopName, lat, lon, isTerminal = false) {
  currentStopId = stopId;
  currentIsTerminal = isTerminal;
  currentStopLat = parseFloat(lat);
  currentStopLon = parseFloat(lon);
  activeCardIndex = null;
  showAllArrivals = false;

  stopList.classList.remove('visible');
  searchInput.value = stopName;
  searchInput.placeholder = 'Search for a bus stop…';

  document.getElementById('stop-header-name').textContent = stopName;
  document.getElementById('stop-header-id').textContent = `Stop #${stopId}`;
  document.getElementById('stop-header-coords').textContent = `${currentStopLat.toFixed(4)}, ${currentStopLon.toFixed(4)}`;
  document.getElementById('stop-header').classList.add('visible');
  renderFavBtn();
  renderFavorites();
  document.getElementById('main-panel').classList.add('visible');

  setTimeout(() => map.invalidateSize(), 50);

  placeStopMarker(currentStopLat, currentStopLon, stopName);
  clearRoute();
  clearError();
  fetchArrivals(stopId);
  startAutoRefresh(stopId);
  updateFavBtn();
  renderFavorites(); // アクティブ状態を更新
}

// ── Arrivals ─────────────────────────────────────────────────────────────────
async function fetchArrivals(stopId) {
  const list = document.getElementById('arrivals-list');
  list.innerHTML = `<div class="state-msg"><span class="icon">⏳</span><p>Fetching real-time data…</p></div>`;
  try {
    const endpoint = currentIsTerminal
      ? `${API}/api/terminal/${stopId}/arrivals`
      : `${API}/api/stops/${stopId}/arrivals`;
    const res = await fetch(endpoint);
    lastArrivals = await res.json();
    renderArrivals(lastArrivals, showAllArrivals);
    clearError();

    // 翌日便が含まれる場合は自動更新を停止
    const hasTomorrow = lastArrivals.some(a => a.day_offset === 1);
    if (hasTomorrow && autoRefreshEnabled) {
      clearInterval(refreshTimer);
      document.getElementById('refresh-bar').classList.remove('visible');
      document.getElementById('auto-refresh-toggle').classList.remove('active');
      autoRefreshEnabled = false;
    }

    if (activeCardIndex !== null && lastArrivals[activeCardIndex]) {
      // 既存の選択を維持して再描画
      const a = lastArrivals[activeCardIndex];
      showRoute(a.shape_id, a.trip_id, a.route_short_name, a.headsign || a.route_long_name, a.route_color, a.stop_id);
    } else if (activeCardIndex === null && lastArrivals.length > 0) {
      // バス停選択直後（activeCardIndex が null）は最初の便を自動選択
      onCardClick(0);
    }
  } catch {
    showError('Could not fetch arrival data. Please try again.');
    list.innerHTML = '';
  }
}

function refreshArrivals() {
  if (!currentStopId) return;
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  fetchArrivals(currentStopId).finally(() => {
    btn.classList.remove('spinning');
    restartProgressBar();
  });
}

function renderArrivals(arrivals, showAll = false) {
  const list = document.getElementById('arrivals-list');
  if (!arrivals.length) {
    list.innerHTML = `<div class="state-msg"><span class="icon">🚌</span><p>No upcoming buses found.</p></div>`;
    return;
  }
  const isMobile = window.innerWidth <= 720;
  const limit = isMobile && !showAll ? 5 : arrivals.length;
  const visible = arrivals.slice(0, limit);

  list.innerHTML = visible.map((a, i) => {
    const min = a.minutes_until;
    const minClass = min <= 1 ? 'now' : min <= 5 ? 'soon' : 'later';
    const minText = min <= 1 ? 'Now' : `${min}`;
    const label = min <= 1 ? '' : 'min';
    const headsign = a.headsign || a.route_long_name || '—';
    const sub = a.headsign ? a.route_long_name : '';
    const active = i === activeCardIndex ? ' active' : '';
    const bgColor = a.route_color || 'var(--accent2)';
    const textColor = a.route_text_color || '#ffffff';

    const timeStr = min >= 10
      ? new Date(a.arrival_time * 1000).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false })
      : '';

    const delayMin = Math.round((a.delay_seconds || 0) / 60);
    const delayBadge = delayMin > 1
      ? `<span class="delay-badge late">+${delayMin}m</span>`
      : delayMin < -1
        ? `<span class="delay-badge early">${delayMin}m</span>`
        : '';
    const tomorrowBadge = a.day_offset === 1
      ? `<span class="delay-badge tomorrow">Tomorrow</span>`
      : '';

    return `
      <div class="arrival-card${active}" onclick="onCardClick(${i})" style="--route-color:${bgColor}">
        <div class="route-left">
          <div class="route-badge" style="background:${bgColor};color:${textColor}">${escHtml(a.route_short_name)}</div>
          ${a.platform_code ? `<div class="platform-box"><span class="platform-label">Plat</span><span class="platform-number">${escHtml(a.platform_code)}</span></div>` : ''}
        </div>
        <div class="route-info">
          <div class="marquee-wrap route-headsign">
            <span class="marquee-inner">${escHtml(headsign)}${delayBadge}${tomorrowBadge}</span>
          </div>
          ${sub ? `<div class="marquee-wrap route-long"><span class="marquee-inner">${escHtml(sub)}</span></div>` : ''}
        </div>
        <div class="arrival-time">
          <div class="minutes ${minClass}">${minText}</div>
          <div class="minutes-label">${label}</div>
          ${timeStr ? `<div class="arrival-clock">${timeStr}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  // テキストが溢れているカードに overflowing クラスを付与し、2つ目のテキストを追加
  requestAnimationFrame(() => {
    document.querySelectorAll('.marquee-wrap').forEach(wrap => {
      const inner = wrap.querySelector('.marquee-inner');
      if (!inner) return;
      // 既存の複製を削除してリセット
      wrap.querySelectorAll('.marquee-clone').forEach(el => el.remove());
      wrap.classList.remove('overflowing');

      if (inner.scrollWidth > wrap.clientWidth + 1) {
        // 溢れている場合：複製を追加してスクロールアニメーション開始
        const clone = inner.cloneNode(true);
        clone.classList.add('marquee-clone');
        wrap.appendChild(clone);
        wrap.classList.add('overflowing');
      }
    });
  });

  // モバイルで件数が超えている場合「もっと見る」ボタンを追加
  if (isMobile && !showAll && arrivals.length > 5) {
    list.innerHTML += `
      <div id="show-more-btn" onclick="showAllArrivals=true; renderArrivals(lastArrivals, true)" style="
        text-align:center; padding:12px;
        font-family:'Space Mono',monospace; font-size:12px;
        color:var(--accent2); cursor:pointer;
        border-top:1px solid var(--border);
        transition: background 0.15s;
      " onmouseover="this.style.background='rgba(0,153,255,0.05)'"
         onmouseout="this.style.background=''"
      >
        ＋ Show all ${arrivals.length - 5} more
      </div>`;
  }
}

function onCardClick(index) {
  if (activeCardIndex === index) {
    activeCardIndex = null;
    renderArrivals(lastArrivals, showAllArrivals);
    clearRoute();
    return;
  }
  activeCardIndex = index;
  renderArrivals(lastArrivals);
  const a = lastArrivals[index];
  showRoute(a.shape_id, a.trip_id, a.route_short_name, a.headsign || a.route_long_name, a.route_color, a.stop_id);
}

// ── Auto-refresh ─────────────────────────────────────────────────────────────
function startAutoRefresh(stopId) {
  clearInterval(refreshTimer);
  if (!autoRefreshEnabled) return;
  restartProgressBar();
  refreshTimer = setInterval(() => { fetchArrivals(stopId); restartProgressBar(); }, 30000);
}

function toggleAutoRefresh() {
  autoRefreshEnabled = !autoRefreshEnabled;
  const btn = document.getElementById('auto-refresh-toggle');
  btn.classList.toggle('active', autoRefreshEnabled);
  const bar = document.getElementById('refresh-bar');
  if (autoRefreshEnabled) {
    if (currentStopId) startAutoRefresh(currentStopId);
  } else {
    clearInterval(refreshTimer);
    bar.classList.remove('visible');
  }
}

function restartProgressBar() {
  const bar = document.getElementById('refresh-bar');
  const fill = document.getElementById('refresh-bar-fill');
  bar.classList.add('visible');
  const newFill = fill.cloneNode(true);
  fill.parentNode.replaceChild(newFill, fill);
}

// ── Stop timeline ────────────────────────────────────────────────────────────
async function renderTimeline(tripId, lineColor, stopId) {
  const tl = document.getElementById('stop-timeline');

  try {
    const res = await fetch(`${API}/api/trips/${tripId}/stops`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const stops = data.stops;

    // 選択中のバス停のインデックスを探す
    const selectedIdx = stops.findIndex(s => String(s.stop_id) === String(stopId || currentStopId));
    const splitIdx = selectedIdx >= 0 ? selectedIdx : 0;

    const passed = stops.slice(0, splitIdx);
    const upcoming = stops.slice(splitIdx);

    // 先頭（＝選択中バス停）を強調
    if (upcoming.length > 0) upcoming[0]._current = true;

    const color = lineColor || 'var(--accent2)';

    function formatTime(s) {
      // static_time は "HH:MM:SS"（25時間表記あり）
      if (s.predicted_unix) {
        return new Date(s.predicted_unix * 1000)
          .toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
      }
      if (s.static_time) {
        const parts = s.static_time.split(':');
        if (parts.length >= 2) {
          const h = parseInt(parts[0]) % 24;
          return `${String(h).padStart(2, '0')}:${parts[1]}`;
        }
      }
      return '';
    }

    function renderStop(s, extraClass) {
      const timeStr = formatTime(s);
      const isCurrent = s._current;
      const cls = isCurrent ? 'current' : extraClass;
      // 縦線の色を路線カラーに
      const dotStyle = isCurrent
        ? `background:${color};border-color:${color};box-shadow:0 0 8px ${color}40`
        : extraClass === 'upcoming'
          ? `border-color:${color}`
          : '';
      return `
        <div class="timeline-stop ${cls}">
          <div class="timeline-dot-wrap">
            <div class="timeline-dot" style="${dotStyle}"></div>
          </div>
          <div class="timeline-info">
            <span class="timeline-stop-name">${escHtml(s.stop_name || s.stop_id)}</span>
            ${timeStr ? `<span class="timeline-time">${timeStr}</span>` : ''}
          </div>
        </div>`;
    }

    let html = '';

    // ── 通過済み（折りたたみ） ──
    if (passed.length > 0) {
      html += `
        <div class="timeline-section-header collapsed" onclick="toggleTimelineSection(this)">
          <div class="timeline-section-title">
            Passed
            <span class="count-badge">${passed.length}</span>
          </div>
          <span class="timeline-chevron">▼</span>
        </div>
        <div class="timeline-body collapsed">
          ${passed.map(s => renderStop(s, 'passed')).join('')}
        </div>`;
    }

    // ── これから ──
    if (upcoming.length > 0) {
      html += `
        <div class="timeline-section-header" onclick="toggleTimelineSection(this)">
          <div class="timeline-section-title">
            Upcoming
            <span class="count-badge">${upcoming.length}</span>
          </div>
          <span class="timeline-chevron">▼</span>
        </div>
        <div class="timeline-body">
          ${upcoming.map(s => renderStop(s, 'upcoming')).join('')}
        </div>`;
    }

    tl.style.display = 'block';
    tl.innerHTML = html;

    // PCのみ：現在のバス停までスクロール
    if (window.innerWidth > 720) {
      requestAnimationFrame(() => {
        const currentEl = tl.querySelector('.timeline-stop.current');
        if (currentEl) {
          currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      });
    }

  } catch {
    tl.style.display = 'block';
    tl.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--muted);font-family:'Space Mono',monospace">Stop timeline unavailable</div>`;
  }
}

function toggleTimelineSection(header) {
  header.classList.toggle('collapsed');
  const body = header.nextElementSibling;
  body.classList.toggle('collapsed');
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = `⚠ ${msg}`; el.classList.add('visible');
}
function clearError() { document.getElementById('error-msg').classList.remove('visible'); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escAttr(str) {
  return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap') && !e.target.closest('#stop-list'))
    stopList.classList.remove('visible');
});