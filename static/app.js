const API = '';
const METRO_COLOR = '#5EC4BC'; // M1 / M2 固定カラー

// M1/M2 はエンドポイントのカラーを無視して固定色を使う
function resolveRouteColor(routeShort, routeColor) {
  if (routeShort === 'M1' || routeShort === 'M2') return METRO_COLOR;
  return routeColor || '';
}

let autoRefreshEnabled = true;
let currentStopId = null;  // ターミナルはparent_id、通常停はstop_id
let currentIsTerminal = false;
let currentStopLat = null;
let currentStopLon = null;
let refreshTimer = null;
let activeCardIndex = null;
let activeArrivalTripId = null;
let showAllArrivals = false;
let activeArrivalFilter = { platform: null, direction: null, route: null };
let currentIsNameGrouped = false;
let currentGroupedStopIds = [];
const nameGroupedStopMap = {};  // stop_id -> stop_ids[] for name-grouped stops
let stopDirectionMap = {};       // stop_id -> '0' or '1' (majority direction)

// ── i18n ─────────────────────────────────────────────────────────────────────
const LANG_KEY = 'seq_lang';
let currentLang = localStorage.getItem(LANG_KEY) || 'en';

const STRINGS = {
  en: {
    searchPlaceholder: 'Search for a bus stop…',
    nearbyPlaceholder: 'Nearby stops ↓',
    noStopsFound: 'No stops found',
    fetchingData: 'Fetching real-time data…',
    noUpcomingBuses: 'No upcoming buses found.',
    serviceEnded: "Today's service has ended",
    filterPlatform: 'Platform',
    filterDirection: 'Direction',
    filterRoute: 'Route',
    outbound: 'Outbound',
    inbound: 'Inbound',
    dirEnded: 'Ended',
    timelinePassed: 'Passed',
    timelineUpcoming: 'Upcoming',
    timelineUnavailable: 'Stop timeline unavailable',
    mapHint: '← Select a bus to show its route',
    mapLoading: 'Loading…',
    mapNoShape: 'No shape data for this route',
    mapShapeUnavailable: 'Route shape unavailable',
    gpsYouAreHere: 'You are here',
    gpsNoStops: 'No bus stops found nearby.',
    gpsFetchError: 'Could not fetch nearby stops.',
    gpsAccessDenied: 'Location access denied. Please allow location in your browser.',
    gpsError: 'Could not get your location. Please try again.',
    serverError: 'Could not reach the server. Is FastAPI running?',
    fetchError: 'Could not fetch arrival data. Please try again.',
    tomorrow: 'Tomorrow',
    showMore: n => `＋ Show all ${n} more`,
    nPlatforms: n => `${n} platforms`,
    nStops: n => `${n} stops`,
    alertNone: 'No active service alerts.',
    alertNoneFor: r => `No alerts for ${r}.`,
    inactivityMsg: 'Auto-refresh paused after 30 min of inactivity.',
    inactivityResume: 'Resume',
    sectionFavorites: 'Favorites',
    sectionNextBuses: 'Next buses',
    sectionRouteMap: 'Route map',
    subtitle: 'Real-time arrivals powered by Translink GTFS-RT',
    alertPanelTitle: 'Service Alerts',
    alertBtnLabel: 'Service Alerts',
    autoLabel: 'Auto',
    refreshBtnLabel: '↺ Refresh',
    now: 'Now',
    minLabel: 'min',
    platLabel: 'Plat',
    vehicleLive: 'Live position',
    vehicleSecsAgo: s => `${s}s ago`,
    vehicleMinAgo: m => `${m}min ago`,
    vehicleNoPos: 'No live position available',
    vehicleStopsAway: n => n === 1 ? `1 stop away` : `${n} stops away`,
    vehicleAtStop: 'At this stop',
    vehiclePassed: 'Passed this stop',
    vehicleCurrentStop: stop => `At: ${stop}`,
  },
  ja: {
    searchPlaceholder: 'バス停を検索…',
    nearbyPlaceholder: '近くのバス停 ↓',
    noStopsFound: 'バス停が見つかりません',
    fetchingData: 'リアルタイムデータ取得中…',
    noUpcomingBuses: '次のバスは見つかりません',
    serviceEnded: '今日のバスは終了しました',
    filterPlatform: 'のりば',
    filterDirection: '方向',
    filterRoute: '路線',
    outbound: '下り',
    inbound: '上り',
    dirEnded: '終了',
    timelinePassed: '通過済み',
    timelineUpcoming: 'これから',
    timelineUnavailable: '停車駅情報を表示できません',
    mapHint: '← バスを選択するとルートを表示',
    mapLoading: '読み込み中…',
    mapNoShape: 'この路線のルートデータがありません',
    mapShapeUnavailable: 'ルートを表示できません',
    gpsYouAreHere: '現在地',
    gpsNoStops: '近くにバス停が見つかりません',
    gpsFetchError: '近くのバス停を取得できませんでした',
    gpsAccessDenied: '位置情報へのアクセスが拒否されました。ブラウザの設定を確認してください。',
    gpsError: '位置情報を取得できませんでした。もう一度お試しください。',
    serverError: 'サーバーに接続できません',
    fetchError: '到着情報を取得できませんでした。もう一度お試しください。',
    tomorrow: '明日',
    showMore: n => `＋ さらに${n}件表示`,
    nPlatforms: n => `${n} のりば`,
    nStops: n => `${n} バス停`,
    alertNone: '現在アクティブなアラートはありません',
    alertNoneFor: r => `${r} のアラートはありません`,
    inactivityMsg: '30分間操作がなかったため、自動更新を停止しました。',
    inactivityResume: '再開',
    sectionFavorites: 'お気に入り',
    sectionNextBuses: '次のバス',
    sectionRouteMap: 'ルートマップ',
    subtitle: 'Translinkリアルタイム情報',
    alertPanelTitle: 'サービス情報',
    alertBtnLabel: 'サービス情報',
    autoLabel: '自動',
    refreshBtnLabel: '↺ 更新',
    now: 'まもなく',
    minLabel: '分',
    platLabel: 'のりば',
    vehicleLive: 'リアルタイム位置',
    vehicleSecsAgo: s => `${s}秒前`,
    vehicleMinAgo: m => `${m}分前`,
    vehicleNoPos: '位置情報なし',
    vehicleStopsAway: n => `あと${n}駅`,
    vehicleAtStop: '停車中',
    vehiclePassed: '通過済み',
    vehicleCurrentStop: stop => `現在地: ${stop}`,
  }
};

function t(key, ...args) {
  const s = STRINGS[currentLang]?.[key] ?? STRINGS.en[key];
  if (typeof s === 'function') return s(...args);
  return s ?? key;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  const si = document.getElementById('search-input');
  if (si && !si.value) si.placeholder = t('searchPlaceholder');
  const langLabel = document.getElementById('lang-label');
  if (langLabel) langLabel.textContent = currentLang === 'en' ? '日本語' : 'English';
}

function toggleLang() {
  currentLang = currentLang === 'en' ? 'ja' : 'en';
  localStorage.setItem(LANG_KEY, currentLang);
  applyI18n();
  if (currentStopId) {
    renderFilterBar();
    renderArrivals(getFilteredArrivals(), showAllArrivals);
  }
  renderFavorites();
  // Update map hint if showing default
  const hint = document.getElementById('map-hint');
  if (hint && (hint.innerHTML.includes('Select a bus') || hint.innerHTML.includes('バスを選択'))) {
    hint.innerHTML = t('mapHint');
  }
}

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
      stop_ids: currentIsNameGrouped ? currentGroupedStopIds : [],
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

  // Pre-populate nameGroupedStopMap for name-grouped favorites
  favs.forEach(f => {
    if (f.stop_ids && f.stop_ids.length > 1) {
      nameGroupedStopMap[f.stop_id] = f.stop_ids;
    }
  });

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

// ── Theme management ──────────────────────────────────────────────────────────
const THEME_KEY = 'seq_theme';

function getEffectiveTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀' : '🌙';
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  }
  updateMapTiles(theme);
}

function toggleTheme() {
  const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

function updateMapTiles(theme) {
  map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILES[theme].url, {
    attribution: TILES[theme].attribution,
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);
  tileLayer.bringToBack();
}

let tileLayer = L.tileLayer(TILES[getEffectiveTheme()].url, {
  attribution: TILES[getEffectiveTheme()].attribution,
  subdomains: 'abcd',
  maxZoom: 20
}).addTo(map);

map.setView([-27.47, 153.02], 12);

// OSのカラースキーム変化を検知（手動設定がない場合のみ追従）
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!localStorage.getItem(THEME_KEY)) {
    applyTheme(getEffectiveTheme());
  }
});

// 初期テーマを適用（anti-flash スクリプトと同期）
applyTheme(getEffectiveTheme());

let stopMarker = null;
let routeLayer = null;
let stopDotLayer = null;
let neonAnimationId = null;
let vehicleMarker = null;
let vehicleRefreshTimer = null;
let currentTripStops = null;
let currentVehicleTargetStopId = null;

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
  neonAnimationId = null; // 実行中のアニメーションを停止
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (stopDotLayer) { map.removeLayer(stopDotLayer); stopDotLayer = null; }

  const hint = document.getElementById('map-hint');
  const lineColor = resolveRouteColor(routeShort, routeColor) || '#0099ff';
  hint.innerHTML = `<span style="color:var(--muted)">${t('mapLoading')}</span>`;

  // shape と trip stops を並列取得（重複リクエストを排除）
  const [shapeRes, stRes] = await Promise.all([
    shapeId ? fetch(`${API}/api/shapes/${shapeId}`).catch(() => null) : Promise.resolve(null),
    fetch(`${API}/api/trips/${tripId}/stops`).catch(() => null),
  ]);

  let stData = null;
  if (stRes && stRes.ok) {
    try { stData = await stRes.json(); } catch { }
  }

  currentTripStops = stData;
  currentVehicleTargetStopId = platformStopId || currentStopId;
  startVehicleTracking(tripId, lineColor);

  // タイムラインは shape の有無に関わらず常に表示（データを渡して再利用）
  renderTimeline(stData, lineColor, platformStopId);

  if (!shapeId || !shapeRes || !shapeRes.ok) {
    hint.innerHTML = `<span style="color:var(--muted)">${t('mapNoShape')}</span>`;
    return;
  }

  try {
    const data = await shapeRes.json();

    const coords = data.coords.map(c => [c[0], c[1]]);
    const glowOuter = L.polyline(coords, { color: lineColor, weight: 14, opacity: 0.10, lineJoin: 'round' });
    const glowInner = L.polyline(coords, { color: lineColor, weight: 7, opacity: 0.28, lineJoin: 'round' });
    const coreLine = L.polyline(coords, { color: lineColor, weight: 3, opacity: 1.00, lineJoin: 'round' });
    routeLayer = L.featureGroup([glowOuter, glowInner, coreLine]).addTo(map);

    // ネオントレースアニメーション（繰り返し）
    const animToken = {};
    neonAnimationId = animToken;
    const neonLayers = [glowOuter, glowInner, coreLine];

    function runNeonCycle() {
      if (neonAnimationId !== animToken) return; // ルート切替で無効化されたら停止

      // 始点にリセット
      neonLayers.forEach(pl => {
        const el = pl.getElement();
        if (!el) return;
        const len = el.getTotalLength();
        el.style.transition = 'none';
        el.style.strokeDasharray = `${len}`;
        el.style.strokeDashoffset = `${len}`;
      });

      coreLine.getElement()?.getBoundingClientRect(); // force reflow

      // 終点へアニメーション
      neonLayers.forEach(pl => {
        const el = pl.getElement();
        if (!el) return;
        el.style.transition = 'stroke-dashoffset 3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
        el.style.strokeDashoffset = '0';
      });

      // 描画完了後、少し待って次のサイクルを開始
      const coreEl = coreLine.getElement();
      if (coreEl) {
        coreEl.addEventListener('transitionend', function handler() {
          coreEl.removeEventListener('transitionend', handler);
          setTimeout(() => {
            if (neonAnimationId === animToken) runNeonCycle();
          }, 1000);
        });
      }
    }

    // バス停ドットを描画（stData を再利用）
    if (stData) {
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

    if (stopMarker) stopMarker.setZIndexOffset(1000);

    try {
      const bounds = currentStopLat
        ? routeLayer.getBounds().extend([currentStopLat, currentStopLon])
        : routeLayer.getBounds();
      map.fitBounds(bounds, { padding: [28, 28] });
    } catch { /* fitBounds失敗は無視 */ }

    // fitBounds のズームアニメーション完了後にネオンアニメーション開始
    // （アニメーション中にパス長が変わると途中から始まってしまうため）
    let animStarted = false;
    function startAnimOnce() {
      if (animStarted || neonAnimationId !== animToken) return;
      animStarted = true;
      requestAnimationFrame(runNeonCycle);
    }
    map.once('moveend', startAnimOnce);
    setTimeout(startAnimOnce, 400); // moveend が来ない場合のフォールバック

    hint.innerHTML = `<span class="map-route-label" style="background:${lineColor}">${escHtml(routeShort)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(headsign)}</span>`;

  } catch (e) {
    console.error('showRoute error:', e);
    hint.innerHTML = `<span style="color:var(--muted)">${t('mapShapeUnavailable')}</span>`;
  }
}

function clearRoute() {
  neonAnimationId = null;
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (stopDotLayer) { map.removeLayer(stopDotLayer); stopDotLayer = null; }
  document.getElementById('map-hint').innerHTML = t('mapHint');
  const tl = document.getElementById('stop-timeline');
  tl.style.display = 'none';
  tl.innerHTML = '';
  stopVehicleTracking();
  currentTripStops = null;
  currentVehicleTargetStopId = null;
  if (currentStopLat) map.setView([currentStopLat, currentStopLon], 12);
}

// ── Vehicle tracking ─────────────────────────────────────────────────────────
function makeVehicleIcon(bearing, color) {
  const c = color || '#0099ff';
  return L.divIcon({
    className: '',
    html: `<div class="vehicle-marker">
      <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
        <circle cx="14" cy="14" r="12" fill="${c}" stroke="#fff" stroke-width="2"/>
      </svg>
      <span class="vehicle-marker-emoji">🚌</span>
    </div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function calcStopsAway(pos) {
  if (!currentTripStops || !currentTripStops.stops) return null;
  const stops = currentTripStops.stops;
  const targetId = currentVehicleTargetStopId ? String(currentVehicleTargetStopId) : null;
  const vehicleStopId = pos.current_stop_id ? String(pos.current_stop_id) : null;
  const targetIdx = targetId ? stops.findIndex(s => String(s.stop_id) === targetId) : -1;
  if (targetIdx === -1) return null;

  // current_status: 0=INCOMING_AT, 1=STOPPED_AT, 2=IN_TRANSIT_TO
  // current_stop_id points to the stop the vehicle is at or heading toward
  if (!vehicleStopId) return null;
  const vehicleIdx = stops.findIndex(s => String(s.stop_id) === vehicleStopId);
  if (vehicleIdx === -1) return null;

  const diff = targetIdx - vehicleIdx;
  if (diff < 0) return { passed: true };
  if (diff === 0) return { atStop: true };
  const vehicleStop = stops[vehicleIdx];
  const intermediateStops = stops.slice(vehicleIdx + 1, targetIdx + 1);
  return { stopsAway: diff, vehicleStop, intermediateStops };
}

function updateVehiclePanel(pos, lineColor) {
  const panel = document.getElementById('vehicle-panel');
  if (!panel) return;
  if (!pos) {
    panel.style.display = 'none';
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const delta = pos.timestamp ? now - pos.timestamp : null;
  let agoStr = '';
  if (delta !== null) {
    agoStr = delta < 60 ? ` · ${t('vehicleSecsAgo', delta)}` : ` · ${t('vehicleMinAgo', Math.floor(delta / 60))}`;
  }
  const color = lineColor || 'var(--accent2)';
  const proximity = calcStopsAway(pos);
  let proximityStr = '';
  let currentStopHtml = '';

  if (proximity) {
    if (proximity.passed) {
      proximityStr = `<span class="vehicle-proximity-badge">${t('vehiclePassed')}</span>`;
    } else if (proximity.atStop) {
      proximityStr = `<span class="vehicle-proximity-badge vehicle-proximity-at" style="color:${color};border-color:${color}">${t('vehicleAtStop')}</span>`;
    } else {
      proximityStr = `<span class="vehicle-proximity-badge vehicle-proximity-away" style="color:${color};border-color:${color}">${t('vehicleStopsAway', proximity.stopsAway)}</span>`;
      if (proximity.vehicleStop) {
        currentStopHtml = `<div class="vehicle-current-stop">🚌 ${escHtml(t('vehicleCurrentStop', proximity.vehicleStop.stop_name))}</div>`;
      }
    }
  }

  panel.style.display = 'flex';
  panel.innerHTML = `
    <div class="vehicle-header">
      <div class="vehicle-header-left">
        <span class="vehicle-live-dot"></span>
        <span>${t('vehicleLive')}${agoStr}</span>
      </div>
      ${proximityStr}
    </div>
    ${currentStopHtml}`;
}

async function updateVehicleMarker(tripId, lineColor) {
  try {
    const res = await fetch(`${API}/api/trips/${tripId}/vehicle`);
    const pos = res.ok ? await res.json() : null;
    if (!pos) {
      if (vehicleMarker) { map.removeLayer(vehicleMarker); vehicleMarker = null; }
      updateVehiclePanel(null);
      return;
    }
    const icon = makeVehicleIcon(pos.bearing, lineColor);
    if (vehicleMarker) {
      vehicleMarker.setLatLng([pos.lat, pos.lon]);
      vehicleMarker.setIcon(icon);
    } else {
      vehicleMarker = L.marker([pos.lat, pos.lon], { icon, zIndexOffset: 900 })
        .addTo(map)
        .bindTooltip(t('vehicleLive'), { direction: 'top', offset: [0, -6], className: 'stop-tooltip' });
    }
    updateVehiclePanel(pos, lineColor);
  } catch {
    updateVehiclePanel(null);
  }
}

function startVehicleTracking(tripId, lineColor) {
  stopVehicleTracking();
  updateVehicleMarker(tripId, lineColor);
  vehicleRefreshTimer = setInterval(() => updateVehicleMarker(tripId, lineColor), 15000);
}

function stopVehicleTracking() {
  if (vehicleRefreshTimer) { clearInterval(vehicleRefreshTimer); vehicleRefreshTimer = null; }
  if (vehicleMarker) { map.removeLayer(vehicleMarker); vehicleMarker = null; }
  updateVehiclePanel(null);
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
      }).addTo(map).bindPopup(t('gpsYouAreHere'));
      map.setView([lat, lon], 15);
      document.getElementById('main-panel').classList.add('visible');
      setTimeout(() => map.invalidateSize(), 50);

      try {
        const res = await fetch(`${API}/api/stops/nearby?lat=${lat}&lon=${lon}&radius=600`);
        const stops = await res.json();
        if (!stops.length) {
          showError(t('gpsNoStops'));
          btn.classList.remove('loading');
          btn.querySelector('#gps-icon').textContent = '◎';
          return;
        }
        // 検索結果ドロップダウンに距離付きで表示
        renderStopList(stops, true);
        stopList.classList.add('visible');
        searchInput.value = '';
        searchInput.placeholder = t('nearbyPlaceholder');
      } catch {
        showError(t('gpsFetchError'));
      }

      btn.classList.remove('loading');
      btn.classList.add('active');
      btn.querySelector('#gps-icon').textContent = '◎';
    },
    (err) => {
      btn.classList.remove('loading');
      btn.querySelector('#gps-icon').textContent = '◎';
      if (err.code === 1) showError(t('gpsAccessDenied'));
      else showError(t('gpsError'));
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
  } catch { showError(t('serverError')); }
}

function renderStopList(stops, showDistance = false) {
  if (!stops.length) {
    stopList.innerHTML = `<div class="stop-item"><span style="color:var(--muted);font-size:13px">${t('noStopsFound')}</span></div>`;
    stopList.classList.add('visible'); return;
  }
  stopList.innerHTML = stops.map(s => {
    if (s.is_name_grouped && s.stop_ids) {
      nameGroupedStopMap[s.stop_id] = s.stop_ids;
    }
    const icon = s.is_terminal
      ? `<span class="stop-terminal-icon">🚏</span>`
      : s.is_name_grouped
        ? `<span class="stop-terminal-icon">⇄</span>`
        : `<span class="stop-dot"></span>`;
    const platforms = s.is_terminal && s.platforms.length
      ? `<span class="stop-platforms">${t('nPlatforms', s.platforms.length)}</span>`
      : s.is_name_grouped && s.stop_ids && s.stop_ids.length
        ? `<span class="stop-platforms">${t('nStops', s.stop_ids.length)}</span>`
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
  currentIsNameGrouped = !isTerminal && !!(nameGroupedStopMap[stopId] && nameGroupedStopMap[stopId].length > 1);
  currentGroupedStopIds = currentIsNameGrouped ? nameGroupedStopMap[stopId] : [];
  stopDirectionMap = {};
  currentStopLat = parseFloat(lat);
  currentStopLon = parseFloat(lon);
  activeCardIndex = null;
  activeArrivalTripId = null;
  activeArrivalFilter = { platform: null, direction: null, route: null };
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

// ── Arrivals filter ───────────────────────────────────────────────────────────
function getFilteredArrivals() {
  let arr = lastArrivals;
  if (activeArrivalFilter.platform !== null) {
    arr = arr.filter(a => a.platform_code === activeArrivalFilter.platform);
  }
  if (activeArrivalFilter.direction !== null) {
    arr = arr.filter(a => stopDirectionMap[a.stop_id] === activeArrivalFilter.direction);
  }
  if (activeArrivalFilter.route !== null) {
    arr = arr.filter(a => a.route_short_name === activeArrivalFilter.route);
  }
  return arr;
}

function renderFilterBar() {
  const bar = document.getElementById('arrivals-filter-bar');
  let html = '';

  if (currentIsTerminal) {
    // Platform filter for terminals
    const platforms = [...new Set(lastArrivals.map(a => a.platform_code).filter(Boolean))].sort();
    if (platforms.length > 1) {
      html += `<div class="arrivals-filter-group"><span class="arrivals-filter-label">${t('filterPlatform')}</span>`;
      platforms.forEach(p => {
        const active = activeArrivalFilter.platform === p ? ' active' : '';
        html += `<button class="arrivals-filter-chip${active}" onclick="setArrivalFilter('platform','${escAttr(p)}')">${escHtml(p)}</button>`;
      });
      html += '</div>';
    }
  } else if (currentIsNameGrouped) {
    // 到着データがある stop_id の方向を補完（stop_directions 未取得分のみ）
    for (const sid of currentGroupedStopIds) {
      if (stopDirectionMap[sid] !== undefined) continue;
      const stopArrivals = lastArrivals.filter(a => a.stop_id === sid);
      if (!stopArrivals.length) continue;
      const dir0 = stopArrivals.filter(a => a.direction_id === '0').length;
      const dir1 = stopArrivals.filter(a => a.direction_id === '1').length;
      stopDirectionMap[sid] = dir0 >= dir1 ? '0' : '1';
    }
    const directions = [...new Set(currentGroupedStopIds.map(sid => stopDirectionMap[sid]).filter(Boolean))].sort();
    if (directions.length > 1) {
      const DIR_LABEL = { '0': t('outbound'), '1': t('inbound') };
      html += `<div class="arrivals-filter-group"><span class="arrivals-filter-label">${t('filterDirection')}</span>`;
      directions.forEach(d => {
        const active = activeArrivalFilter.direction === d ? ' active' : '';
        const label = DIR_LABEL[d] || `Dir ${d}`;
        const stopsForDir = currentGroupedStopIds.filter(sid => stopDirectionMap[sid] === d);
        const hasArrivals = lastArrivals.some(a => stopsForDir.includes(a.stop_id));
        const endedClass = !hasArrivals ? ' ended' : '';
        const endedBadge = !hasArrivals ? `<span class="filter-ended-badge">${t('dirEnded')}</span>` : '';
        html += `<button class="arrivals-filter-chip${active}${endedClass}" onclick="setArrivalFilter('direction','${escAttr(d)}')">${escHtml(label)}${endedBadge}</button>`;
      });
      html += '</div>';
    }
  }

  // Route filter (all stop types, when 2+ distinct routes)
  const routes = [...new Set(lastArrivals.map(a => a.route_short_name).filter(Boolean))].sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
  });
  if (routes.length > 1) {
    html += `<div class="arrivals-filter-group"><span class="arrivals-filter-label">${t('filterRoute')}</span>`;
    routes.forEach(r => {
      const active = activeArrivalFilter.route === r ? ' active' : '';
      html += `<button class="arrivals-filter-chip${active}" onclick="setArrivalFilter('route','${escAttr(r)}')">${escHtml(r)}</button>`;
    });
    html += '</div>';
  }

  bar.innerHTML = html;
  bar.style.display = html ? 'block' : 'none';
}

function setArrivalFilter(type, value) {
  activeArrivalFilter[type] = activeArrivalFilter[type] === value ? null : value;
  activeCardIndex = null;
  activeArrivalTripId = null;
  clearRoute();
  renderFilterBar();
  const filtered = getFilteredArrivals();
  renderArrivals(filtered, showAllArrivals);
  if (filtered.length > 0) onCardClick(0);
}

// ── Arrivals ─────────────────────────────────────────────────────────────────
async function fetchArrivals(stopId) {
  const list = document.getElementById('arrivals-list');
  const wasShowingTomorrow = lastArrivals.length > 0 && lastArrivals.some(a => a.day_offset === 1);
  const isRefresh = lastArrivals.length > 0;
  if (!isRefresh) {
    list.innerHTML = `<div class="state-msg"><span class="icon">⏳</span><p>${t('fetchingData')}</p></div>`;
  } else {
    list.classList.add('refreshing');
  }
  try {
    const endpoint = currentIsTerminal
      ? `${API}/api/terminal/${stopId}/arrivals`
      : currentIsNameGrouped
        ? `${API}/api/stops/multi/arrivals?ids=${currentGroupedStopIds.join(',')}`
        : `${API}/api/stops/${stopId}/arrivals`;
    const res = await fetch(endpoint);
    const data = await res.json();
    if (currentIsNameGrouped) {
      lastArrivals = data.arrivals || [];
      // 静的データから導出した方向情報で stopDirectionMap を初期化（未設定のみ）
      if (data.stop_directions) {
        for (const [sid, dir] of Object.entries(data.stop_directions)) {
          if (stopDirectionMap[sid] === undefined) stopDirectionMap[sid] = dir;
        }
      }
    } else {
      lastArrivals = data;
    }
    list.classList.remove('refreshing');
    renderFilterBar();
    const filtered = getFilteredArrivals();
    renderArrivals(filtered, showAllArrivals);
    clearError();

    // 翌日便が含まれる場合は自動更新を停止し、5分おきに再チェック
    const hasTomorrow = lastArrivals.some(a => a.day_offset === 1);
    if (hasTomorrow && autoRefreshEnabled) {
      clearTimeout(refreshTimer);
      document.getElementById('refresh-bar').classList.remove('visible');
      document.getElementById('auto-refresh-toggle').classList.remove('active');
      autoRefreshEnabled = false;
      refreshTimer = setTimeout(() => { if (currentStopId) fetchArrivals(currentStopId); }, 5 * 60 * 1000);
    }

    // 明日便 → 今日便に切り替わった場合: auto-refresh を再開し選択をリセット
    if (wasShowingTomorrow && !hasTomorrow) {
      activeCardIndex = null;
      activeArrivalTripId = null;
      clearRoute();
      autoRefreshEnabled = true;
      document.getElementById('auto-refresh-toggle').classList.add('active');
    }

    // 更新間隔を再評価してスケジュール（翌日便チェック後）
    if (autoRefreshEnabled && currentStopId) {
      scheduleNextRefresh(currentStopId);
    }

    if (activeArrivalTripId !== null) {
      // 既存の選択をtrip_idで再検索して維持
      const newIdx = filtered.findIndex(a => a.trip_id === activeArrivalTripId);
      if (newIdx >= 0) {
        activeCardIndex = newIdx;
        renderArrivals(filtered, showAllArrivals);
        const a = filtered[newIdx];
        showRoute(a.shape_id, a.trip_id, a.route_short_name, a.headsign || a.route_long_name, a.route_color, a.stop_id);
      } else if (filtered.length > 0) {
        onCardClick(0);
      }
    } else if (activeCardIndex === null && filtered.length > 0) {
      // バス停選択直後（activeCardIndex が null）は最初の便を自動選択
      onCardClick(0);
    }
  } catch {
    list.classList.remove('refreshing');
    showError(t('fetchError'));
    if (!isRefresh) list.innerHTML = '';
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
    const isFilteredEmpty = lastArrivals.length > 0;
    list.innerHTML = isFilteredEmpty
      ? `<div class="state-msg"><span class="icon">🌙</span><p>${t('serviceEnded')}</p></div>`
      : `<div class="state-msg"><span class="icon">🚌</span><p>${t('noUpcomingBuses')}</p></div>`;
    return;
  }
  const isMobile = window.innerWidth <= 720;
  const limit = isMobile && !showAll ? 5 : arrivals.length;
  const visible = arrivals.slice(0, limit);

  list.innerHTML = visible.map((a, i) => {
    const min = a.minutes_until;
    const isTomorrow = a.day_offset === 1;
    const minClass = min <= 1 ? 'now' : min <= 5 ? 'soon' : 'later';
    const minText = min <= 1 ? t('now') : `${min}`;
    const label = min <= 1 ? '' : t('minLabel');
    const headsign = a.headsign || a.route_long_name || '—';
    const sub = a.headsign ? a.route_long_name : '';
    const active = i === activeCardIndex ? ' active' : '';
    const bgColor = resolveRouteColor(a.route_short_name, a.route_color) || 'var(--accent2)';
    const textColor = (a.route_short_name === 'M1' || a.route_short_name === 'M2') ? '#000000' : (a.route_text_color || '#ffffff');

    const clockTime = new Date(a.arrival_time * 1000).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

    const delayMin = Math.round((a.delay_seconds || 0) / 60);
    const delayBadge = delayMin > 1
      ? `<span class="delay-badge late">+${delayMin}m</span>`
      : delayMin < -1
        ? `<span class="delay-badge early">${delayMin}m</span>`
        : '';
    const tomorrowBadge = isTomorrow
      ? `<span class="delay-badge tomorrow">${t('tomorrow')}</span>`
      : '';

    const arrivalTimeHtml = isTomorrow
      ? `<div class="minutes later">${clockTime}</div>
         <div class="minutes-label">${t('tomorrow')}</div>`
      : `<div class="minutes ${minClass}">${minText}</div>
         <div class="minutes-label">${label}</div>
         ${min >= 10 ? `<div class="arrival-clock">${clockTime}</div>` : ''}`;

    return `
      <div class="arrival-card${active}" onclick="onCardClick(${i})" style="--route-color:${bgColor}">
        <div class="route-left">
          <div class="route-badge" style="background:${bgColor};color:${textColor}">${escHtml(a.route_short_name)}</div>
          ${a.platform_code ? `<div class="platform-box"><span class="platform-label">${t('platLabel')}</span><span class="platform-number">${escHtml(a.platform_code)}</span></div>` : ''}
        </div>
        <div class="route-info">
          <div class="marquee-wrap route-headsign">
            <span class="marquee-inner">${escHtml(headsign)}${delayBadge}${tomorrowBadge}</span>
          </div>
          ${sub ? `<div class="marquee-wrap route-long"><span class="marquee-inner">${escHtml(sub)}</span></div>` : ''}
        </div>
        <div class="arrival-time">
          ${arrivalTimeHtml}
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
      <div id="show-more-btn" onclick="showAllArrivals=true; renderArrivals(getFilteredArrivals(), true)" style="
        text-align:center; padding:12px;
        font-family:'Space Mono',monospace; font-size:12px;
        color:var(--accent2); cursor:pointer;
        border-top:1px solid var(--border);
        transition: background 0.15s;
      " onmouseover="this.style.background='rgba(0,153,255,0.05)'"
         onmouseout="this.style.background=''"
      >
        ${t('showMore', arrivals.length - 5)}
      </div>`;
  }
}

function onCardClick(index) {
  const filtered = getFilteredArrivals();
  if (activeCardIndex === index) {
    activeCardIndex = null;
    activeArrivalTripId = null;
    renderArrivals(filtered, showAllArrivals);
    clearRoute();
    return;
  }
  activeCardIndex = index;
  renderArrivals(filtered);
  const a = filtered[index];
  activeArrivalTripId = a.trip_id;
  showRoute(a.shape_id, a.trip_id, a.route_short_name, a.headsign || a.route_long_name, a.route_color, a.stop_id);
}

// ── Auto-refresh ─────────────────────────────────────────────────────────────
function getRefreshInterval(arrivals) {
  if (!arrivals || arrivals.length === 0) return 30000;
  const nextMinutes = arrivals[0].minutes_until ?? 0;
  if (nextMinutes >= 300) return null;   // オフ
  if (nextMinutes >= 100) return 600000; // 10分
  if (nextMinutes >= 10) return 60000;  // 1分
  return 30000;                          // 30秒
}

function scheduleNextRefresh(stopId) {
  clearTimeout(refreshTimer);
  if (!autoRefreshEnabled) return;
  const interval = getRefreshInterval(lastArrivals);
  if (interval === null) {
    // 300分以上: 自動更新をオフ
    autoRefreshEnabled = false;
    document.getElementById('refresh-bar').classList.remove('visible');
    document.getElementById('auto-refresh-toggle').classList.remove('active');
    return;
  }
  restartProgressBar(interval / 1000);
  refreshTimer = setTimeout(() => { fetchArrivals(stopId); }, interval);
}

function startAutoRefresh(stopId) {
  scheduleNextRefresh(stopId);
}

function toggleAutoRefresh() {
  autoRefreshEnabled = !autoRefreshEnabled;
  const btn = document.getElementById('auto-refresh-toggle');
  btn.classList.toggle('active', autoRefreshEnabled);
  const bar = document.getElementById('refresh-bar');
  if (autoRefreshEnabled) {
    if (currentStopId) scheduleNextRefresh(currentStopId);
  } else {
    clearTimeout(refreshTimer);
    bar.classList.remove('visible');
  }
}

function restartProgressBar(durationSec = 30) {
  const bar = document.getElementById('refresh-bar');
  const fill = document.getElementById('refresh-bar-fill');
  bar.classList.add('visible');
  const newFill = fill.cloneNode(true);
  newFill.style.setProperty('--refresh-duration', `${durationSec}s`);
  fill.parentNode.replaceChild(newFill, fill);
}

// ── Stop timeline ────────────────────────────────────────────────────────────
function renderTimeline(data, lineColor, stopId) {
  const tl = document.getElementById('stop-timeline');

  if (!data) {
    tl.style.display = 'block';
    tl.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--muted);font-family:'Space Mono',monospace">${t('timelineUnavailable')}</div>`;
    return;
  }

  try {
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
            ${t('timelinePassed')}
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
            ${t('timelineUpcoming')}
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
    tl.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--muted);font-family:'Space Mono',monospace">${t('timelineUnavailable')}</div>`;
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

// ── Service Alerts ────────────────────────────────────────────────────────────
let alertsCache = [];
let alertFilterTag = null; // 選択中のルートタグフィルタ（null = 全表示）

async function fetchAlerts() {
  try {
    const res = await fetch(`${API}/api/alerts`);
    if (!res.ok) return;
    alertsCache = await res.json();
  } catch {
    alertsCache = [];
  }

  const bar = document.getElementById('alert-bar');
  const badge = document.getElementById('alert-count-badge');
  const count = alertsCache.length;

  if (count > 0) {
    bar.style.display = 'block';
    badge.textContent = count;
  } else {
    bar.style.display = 'none';
  }
}

function openAlertPanel() {
  alertFilterTag = null;
  renderAlertPanel();
  document.getElementById('alert-panel').classList.add('open');
  document.getElementById('alert-overlay').classList.add('open');
}

function closeAlertPanel() {
  document.getElementById('alert-panel').classList.remove('open');
  document.getElementById('alert-overlay').classList.remove('open');
}

function setAlertFilter(tag) {
  alertFilterTag = alertFilterTag === tag ? null : tag; // 同じタグをクリックで解除
  renderAlertPanel();
}

function renderAlertPanel() {
  const list = document.getElementById('alert-panel-list');
  if (!alertsCache.length) {
    list.innerHTML = `<div class="alert-empty">${t('alertNone')}</div>`;
    return;
  }

  // 全ルートタグを収集してフィルタバーを構築
  const allTags = [...new Set(alertsCache.flatMap(a => a.route_short_names))].sort();

  const filterBar = allTags.length > 1 ? `
    <div class="alert-filter-bar">
      ${allTags.map(t => `
        <button class="alert-filter-tag${alertFilterTag === t ? ' active' : ''}"
                onclick="setAlertFilter('${escAttr(t)}')">${escHtml(t)}</button>
      `).join('')}
    </div>` : '';

  // フィルタ適用
  const filtered = alertFilterTag
    ? alertsCache.filter(a => a.route_short_names.includes(alertFilterTag))
    : alertsCache;

  const countLabel = alertFilterTag
    ? `<div class="alert-filter-count">${filtered.length} alert${filtered.length !== 1 ? 's' : ''} for ${escHtml(alertFilterTag)}</div>`
    : '';

  const items = filtered.length ? filtered.map((a, i) => {
    const routeTags = a.route_short_names.length
      ? a.route_short_names.map(r => `
          <button class="alert-route-tag${alertFilterTag === r ? ' active' : ''}"
                  onclick="setAlertFilter('${escAttr(r)}')">${escHtml(r)}</button>`).join('')
      : '';
    const metaTags = [a.cause, a.effect].filter(Boolean)
      .map(t => `<span class="alert-meta-tag">${escHtml(t)}</span>`).join('');
    return `
      <div class="alert-item" style="animation-delay:${i * 0.04}s">
        ${routeTags ? `<div class="alert-routes">${routeTags}</div>` : ''}
        ${a.header ? `<div class="alert-header">${escHtml(a.header)}</div>` : ''}
        ${a.description ? `<div class="alert-description">${escHtml(a.description)}</div>` : ''}
        ${metaTags ? `<div class="alert-meta">${metaTags}</div>` : ''}
      </div>`;
  }).join('') : `<div class="alert-empty">${t('alertNoneFor', escHtml(alertFilterTag))}</div>`;

  list.innerHTML = filterBar + countLabel + items;
}

// アラートを起動時に取得し、以降5分ごとに更新
fetchAlerts();
setInterval(fetchAlerts, 5 * 60 * 1000);

// ── Inactivity auto-refresh disable (15 min) ──────────────────────────────────
const INACTIVITY_MS = 15 * 60 * 1000; // 15分
let inactivityTimer = null;

function resetInactivityTimer() {
  clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(onInactivityTimeout, INACTIVITY_MS);
}

function onInactivityTimeout() {
  if (!autoRefreshEnabled) return;
  // 自動更新をオフ
  autoRefreshEnabled = false;
  clearTimeout(refreshTimer);
  const btn = document.getElementById('auto-refresh-toggle');
  if (btn) btn.classList.remove('active');
  document.getElementById('refresh-bar').classList.remove('visible');
  document.getElementById('inactivity-notice').classList.add('visible');
}

function resumeFromInactivity() {
  document.getElementById('inactivity-notice').classList.remove('visible');
  autoRefreshEnabled = true;
  const btn = document.getElementById('auto-refresh-toggle');
  if (btn) btn.classList.add('active');
  if (currentStopId) startAutoRefresh(currentStopId);
  resetInactivityTimer();
}

// ユーザー操作でタイマーをリセット
['click', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
  document.addEventListener(evt, resetInactivityTimer, { passive: true });
});
resetInactivityTimer();

// 初期言語を適用
applyI18n();