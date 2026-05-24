const API = '';
const M1_COLOR = '#80c242'; // M1 固定カラー
const M2_COLOR = '#5EC4BC'; // M2 固定カラー

// M1/M2 はエンドポイントのカラーを無視して固定色を使う
function resolveRouteColor(routeShort, routeColor) {
  if (routeShort === 'M1') return M1_COLOR;
  if (routeShort === 'M2') return M2_COLOR;
  return routeColor || '';
}

let autoRefreshEnabled = true;
let demoMode = false;
let timetableMode = false;
let timetableDate = null; // 'YYYY-MM-DD'
let timetableTime = null; // 'HH:MM'
let currentStopRoutes = [];
let currentTab = 'stop';
let currentRouteId = null;
let currentRouteDirection = 0;
let currentRouteData = null;
let mapTabRouteData = null;
let mapTabDirection = 0;
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
    settingsTitle: 'Settings',
    settingsTheme: 'Theme',
    settingsThemeDark: 'Dark',
    settingsThemeLight: 'Light',
    settingsLang: 'Language',
    autoLabel: 'Auto',
    refreshBtnLabel: '↺ Refresh',
    now: 'Now',
    minLabel: 'min',
    platLabel: 'Plat',
    vehicleLive: 'Live position',
    vehicleApproaching: 'Approaching (pre-turnaround)',
    vehicleSecsAgo: s => `${s}s ago`,
    vehicleMinAgo: m => `${m}min ago`,
    vehicleNoPos: 'No live position available',
    vehicleStopsAway: n => n === 1 ? `1 stop away` : `${n} stops away`,
    vehicleAtStop: 'At this stop',
    vehiclePassed: 'Passed this stop',
    vehicleCurrentStop: stop => `At: ${stop}`,
    demoLabel: 'DEMO',
    demoBanner: 'Demo mode — showing timetable from 8:00 AM today',
    tabStop: 'Stop',
    tabRoute: 'Route',
    tabMap: 'Map',
    mapTabHint: 'Search a route number to view its map',
    routeSearchPlaceholder: 'Search by route number…',
    noRoutesFound: 'No routes found',
    routeDir0: 'Outbound',
    routeDir1: 'Inbound',
    rtUnavailable: 'Real-time data unavailable — showing scheduled times only.',
    lastStop: 'Terminates here',
    timetableGo: 'Go',
    timetableBanner: (date, time) => `Timetable from ${date} ${time}`,
    liveMode: 'Live',
    timetableMode: 'Timetable',
    today: 'Today',
    viewStopTimetable: 'View timetable',
    timetableMorning: 'Morning (before noon)',
    timetableAfternoon: 'Afternoon (12–18)',
    timetableEvening: 'Evening (after 18)',
    noServiceOnDate: 'No service on this date',
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
    settingsTitle: '設定',
    settingsTheme: 'テーマ',
    settingsThemeDark: 'ダーク',
    settingsThemeLight: 'ライト',
    settingsLang: '言語',
    autoLabel: '自動',
    refreshBtnLabel: '↺ 更新',
    now: 'まもなく',
    minLabel: '分',
    platLabel: 'のりば',
    vehicleLive: 'リアルタイム位置',
    vehicleApproaching: '折り返し前の位置',
    vehicleSecsAgo: s => `${s}秒前`,
    vehicleMinAgo: m => `${m}分前`,
    vehicleNoPos: '位置情報なし',
    vehicleStopsAway: n => `あと${n}駅`,
    vehicleAtStop: '停車中',
    vehiclePassed: '通過済み',
    vehicleCurrentStop: stop => `現在地: ${stop}`,
    demoLabel: 'DEMO',
    demoBanner: 'デモモード — 本日 08:00 からの時刻表を表示中',
    tabStop: 'バス停',
    tabRoute: '路線',
    tabMap: 'マップ',
    mapTabHint: '路線番号を検索してマップを表示',
    routeSearchPlaceholder: '路線番号で検索…',
    noRoutesFound: '路線が見つかりません',
    routeDir0: '下り',
    routeDir1: '上り',
    rtUnavailable: 'リアルタイム情報を取得できません。時刻表の予定時刻を表示しています。',
    lastStop: '当駅止まり',
    timetableGo: '表示',
    timetableBanner: (date, time) => `時刻表: ${date} ${time}～`,
    liveMode: 'リアルタイム',
    timetableMode: '時刻表',
    today: '今日',
    viewStopTimetable: '時刻表を見る',
    timetableMorning: '午前（〜12時）',
    timetableAfternoon: '午後（12〜18時）',
    timetableEvening: '夜間（18時〜）',
    noServiceOnDate: 'この日の運行はありません',
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
  const langSw = document.getElementById('settings-lang-switch');
  if (langSw) {
    langSw.classList.toggle('active', currentLang === 'en');
    const val = document.getElementById('settings-lang-val');
    if (val) val.textContent = currentLang === 'en' ? 'English' : '日本語';
  }
  const themeVal = document.getElementById('settings-theme-val');
  if (themeVal) themeVal.textContent = getEffectiveTheme() === 'dark' ? t('settingsThemeDark') : t('settingsThemeLight');
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
      routes: currentStopRoutes || [],
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
  list.innerHTML = favs.map(f => {
    const routesJson = escAttr(JSON.stringify(f.routes || []));
    return `
    <div class="fav-chip${f.stop_id === currentStopId ? ' active' : ''}"
         onclick="if(currentTab!=='stop')switchTab('stop');selectStop('${f.stop_id}','${escAttr(f.stop_name)}','${f.stop_lat}','${f.stop_lon}',${f.is_terminal || false},JSON.parse(this.dataset.routes))"
         data-routes="${routesJson}">
      <span class="fav-chip-name">${escHtml(f.stop_name)}</span>
      <button class="fav-chip-remove" onclick="removeFavorite(event,'${f.stop_id}')">×</button>
    </div>`;
  }).join('');
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
  const sw = document.getElementById('settings-theme-switch');
  if (sw) {
    sw.classList.toggle('active', theme === 'dark');
    const val = document.getElementById('settings-theme-val');
    if (val) val.textContent = theme === 'dark' ? t('settingsThemeDark') : t('settingsThemeLight');
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
let routeRenderToken = null;
let vehicleMarker = null;
let vehicleRefreshTimer = null;
let currentTripStops = null;
let currentVehicleTargetStopId = null;
let vehicleZoomedAt2Stops = false;

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

async function showRoute(shapeId, tripId, routeShort, headsign, routeColor, platformStopId = null, vehicleId = null) {
  neonAnimationId = null; // 実行中のアニメーションを停止
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (stopDotLayer) { map.removeLayer(stopDotLayer); stopDotLayer = null; }

  const myToken = {};
  routeRenderToken = myToken;

  const hint = document.getElementById('map-hint');
  const lineColor = resolveRouteColor(routeShort, routeColor) || '#0099ff';
  hint.innerHTML = `<span style="color:var(--muted)">${t('mapLoading')}</span>`;

  // タイムライン・車両パネルを即クリアしてローディング表示
  const tl = document.getElementById('stop-timeline');
  if (tl) {
    tl.style.display = 'block';
    tl.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--muted);font-family:'Space Mono',monospace">${t('mapLoading')}</div>`;
  }
  const vp = document.getElementById('vehicle-panel');
  if (vp) vp.style.display = 'none';

  // shape と trip stops を並列取得（重複リクエストを排除）
  const [shapeRes, stRes] = await Promise.all([
    shapeId ? fetch(`${API}/api/shapes/${shapeId}`).catch(() => null) : Promise.resolve(null),
    fetch(`${API}/api/trips/${tripId}/stops`).catch(() => null),
  ]);

  // 待機中に別のバスが選択された場合は描画をキャンセル
  if (routeRenderToken !== myToken) return;

  let stData = null;
  if (stRes && stRes.ok) {
    try { stData = await stRes.json(); } catch { }
  }

  currentTripStops = stData;
  currentVehicleTargetStopId = platformStopId || currentStopId;
  startVehicleTracking(tripId, lineColor, vehicleId);

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

    if (!vehicleZoomedAt2Stops) {
      try {
        const bounds = currentStopLat
          ? routeLayer.getBounds().extend([currentStopLat, currentStopLon])
          : routeLayer.getBounds();
        map.fitBounds(bounds, { padding: [28, 28] });
      } catch { /* fitBounds失敗は無視 */ }
    }

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

function renderRouteAlertPanel(routeShortName) {
  const panel = document.getElementById('route-alert-panel');
  const matched = alertsCache.filter(a => a.route_short_names.includes(routeShortName));
  if (!matched.length) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML = matched.map(a => `
    <div class="route-alert-item">
      <div class="route-alert-icon">⚠️</div>
      <div class="route-alert-body">
        ${a.header ? `<div class="route-alert-header">${escHtml(a.header)}</div>` : ''}
        ${a.description ? `<div class="route-alert-desc">${escHtml(a.description)}</div>` : ''}
      </div>
    </div>`).join('');
  panel.style.display = 'block';
}

function clearRoute() {
  neonAnimationId = null;
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (stopDotLayer) { map.removeLayer(stopDotLayer); stopDotLayer = null; }
  document.getElementById('map-hint').innerHTML = t('mapHint');
  const rap = document.getElementById('route-alert-panel');
  rap.style.display = 'none';
  rap.innerHTML = '';
  const tl = document.getElementById('stop-timeline');
  tl.style.display = 'none';
  tl.innerHTML = '';
  stopVehicleTracking();
  currentTripStops = null;
  currentVehicleTargetStopId = null;
  if (currentStopLat) map.setView([currentStopLat, currentStopLon], 12);
}

function handleTitleClick() {
  if (routeLayer !== null || activeArrivalTripId !== null) {
    activeCardIndex = null;
    activeArrivalTripId = null;
    clearRoute();
    renderArrivals(getFilteredArrivals(), showAllArrivals);
  } else {
    clearDisplay();
  }
}

function clearDisplay() {
  clearTimeout(refreshTimer);
  autoRefreshEnabled = true;
  currentStopId = null;
  currentIsTerminal = false;
  currentStopLat = null;
  currentStopLon = null;
  activeCardIndex = null;
  activeArrivalTripId = null;
  showAllArrivals = false;
  activeArrivalFilter = { platform: null, direction: null, route: null };
  lastArrivals = [];

  history.replaceState(null, '', window.location.pathname);

  setRtUnavailableBanner(false);
  if (stopMarker) { map.removeLayer(stopMarker); stopMarker = null; }
  clearRoute();
  clearError();
  _clearTimetableState();

  document.getElementById('stop-header').classList.remove('visible');
  document.getElementById('main-panel').classList.remove('visible');
  document.getElementById('refresh-bar').classList.remove('visible');
  document.getElementById('auto-refresh-toggle').classList.add('active');
  document.getElementById('arrivals-list').innerHTML = '';
  document.getElementById('arrivals-filter-bar').style.display = 'none';
  document.getElementById('stop-header-name').textContent = '—';
  document.getElementById('stop-header-routes').innerHTML = '';
  document.getElementById('mode-switch').style.display = 'none';

  searchInput.value = '';
  searchInput.placeholder = t('searchPlaceholder');
  stopList.classList.remove('visible');
  stopList.innerHTML = '';
  renderFavorites();
}

// ── Vehicle tracking ─────────────────────────────────────────────────────────
function makeVehicleIcon(bearing, color, dashed = false) {
  const c = color || '#0099ff';
  const strokeAttr = dashed
    ? `stroke="#fff" stroke-width="2" stroke-dasharray="4 3"`
    : `stroke="#fff" stroke-width="2"`;
  return L.divIcon({
    className: '',
    html: `<div class="vehicle-marker">
      <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
        <circle cx="14" cy="14" r="12" fill="${c}" ${strokeAttr}/>
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

function updateVehiclePanel(pos, lineColor, vehicleId = null) {
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

  const vehicleLabel = (() => {
    if (!vehicleId) return '';
    const parts = vehicleId.split('_');
    if (parts.length < 2) return '';
    const nums = parts[1].replace(/\D/g, '');
    return nums ? `<span class="vehicle-id-badge">#${nums}</span>` : '';
  })();

  panel.style.display = 'flex';
  panel.innerHTML = `
    <div class="vehicle-header">
      <div class="vehicle-header-left">
        <span class="vehicle-live-dot"></span>
        <span>${t('vehicleLive')}${agoStr}</span>
        ${vehicleLabel}
      </div>
      ${proximityStr}
    </div>
    ${currentStopHtml}`;
}

async function updateVehicleMarker(tripId, lineColor, vehicleId = null) {
  try {
    const res = await fetch(`${API}/api/trips/${tripId}/vehicle`);
    let pos = res.ok ? await res.json() : null;
    let isPreTurnaround = false;

    // trip_idで見つからず vehicle_id がある場合、折り返し前の位置を検索
    if (!pos && vehicleId) {
      const res2 = await fetch(`${API}/api/vehicles/${encodeURIComponent(vehicleId)}/position`);
      if (res2.ok) {
        const p2 = await res2.json();
        // 別のtripを走行中の場合のみ表示（同じtripなら通常追跡と同じ）
        if (p2 && p2.current_trip_id !== tripId) {
          pos = p2;
          isPreTurnaround = true;
        }
      }
    }

    if (!pos) {
      if (vehicleMarker) { map.removeLayer(vehicleMarker); vehicleMarker = null; }
      updateVehiclePanel(null, null, vehicleId);
      return;
    }
    const icon = makeVehicleIcon(pos.bearing, lineColor, isPreTurnaround);
    if (vehicleMarker) {
      vehicleMarker.setLatLng([pos.lat, pos.lon]);
      vehicleMarker.setIcon(icon);
    } else {
      const tooltip = isPreTurnaround ? t('vehicleApproaching') : t('vehicleLive');
      vehicleMarker = L.marker([pos.lat, pos.lon], { icon, zIndexOffset: 900 })
        .addTo(map)
        .bindTooltip(tooltip, { direction: 'top', offset: [0, -6], className: 'stop-tooltip' });
    }
    updateVehiclePanel(pos, lineColor, vehicleId);

    // 3つ前のバス停に到達したら（停車中も含む）、バスの現在位置と選択中のバス停が収まるよう拡大（一度だけ）
    const proximity = calcStopsAway(pos);
    if (proximity && !proximity.passed && !vehicleZoomedAt2Stops &&
        (proximity.atStop || proximity.stopsAway <= 3) &&
        currentStopLat != null && currentStopLon != null) {
      vehicleZoomedAt2Stops = true;
      map.fitBounds(
        L.latLngBounds([[pos.lat, pos.lon], [currentStopLat, currentStopLon]]),
        { padding: [48, 48], maxZoom: 17 }
      );
    }
  } catch {
    updateVehiclePanel(null);
  }
}

function startVehicleTracking(tripId, lineColor, vehicleId = null) {
  stopVehicleTracking();
  updateVehicleMarker(tripId, lineColor, vehicleId);
  vehicleRefreshTimer = setInterval(() => updateVehicleMarker(tripId, lineColor, vehicleId), 15000);
}

function stopVehicleTracking() {
  if (vehicleRefreshTimer) { clearInterval(vehicleRefreshTimer); vehicleRefreshTimer = null; }
  if (vehicleMarker) { map.removeLayer(vehicleMarker); vehicleMarker = null; }
  updateVehiclePanel(null);
  vehicleZoomedAt2Stops = false;
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
  if (q.length < 1) { stopList.innerHTML = ''; stopList.classList.remove('visible'); return; }
  if (currentTab === 'route' || currentTab === 'map') {
    searchTimer = setTimeout(() => fetchRoutes(q), 300);
  } else {
    if (q.length < 2) { stopList.innerHTML = ''; stopList.classList.remove('visible'); return; }
    searchTimer = setTimeout(() => fetchStops(q), 300);
  }
});

// ── Tab switching ─────────────────────────────────────────────────────────────

function openSettings() {
  document.getElementById('settings-overlay').classList.add('open');
  document.getElementById('settings-modal').classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.remove('open');
  document.getElementById('settings-modal').classList.remove('open');
}

function switchTab(tab) {
  clearDisplay();
  currentTab = tab;
  document.getElementById('tab-stop').classList.toggle('active', tab === 'stop');
  document.getElementById('tab-route').classList.toggle('active', tab === 'route');
  document.getElementById('tab-map').classList.toggle('active', tab === 'map');
  document.body.classList.toggle('tab-map', tab === 'map');
  stopList.innerHTML = '';
  stopList.classList.remove('visible');
  document.getElementById('gps-btn').style.display = tab === 'stop' ? '' : 'none';
  currentRouteId = null;
  currentRouteData = null;
  document.getElementById('route-stops-panel').style.display = 'none';

  if (tab === 'map') {
    searchInput.placeholder = t('routeSearchPlaceholder');
    setTimeout(() => map.invalidateSize(), 50);
    const hdr = document.getElementById('map-tab-header');
    if (!mapTabRouteData) {
      hdr.innerHTML = `<p class="map-tab-hint">${t('mapTabHint')}</p>`;
    }
  } else {
    searchInput.placeholder = tab === 'route' ? t('routeSearchPlaceholder') : t('searchPlaceholder');
    mapTabRouteData = null;
    mapTabDirection = 0;
    document.getElementById('map-tab-header').innerHTML = '';
    document.getElementById('map-tab-stops-panel').innerHTML = '';
    if (routeLayer && !currentStopId) { map.removeLayer(routeLayer); routeLayer = null; }
    if (stopDotLayer && !currentStopId) { map.removeLayer(stopDotLayer); stopDotLayer = null; }
  }
}

// ── Route search ──────────────────────────────────────────────────────────────
async function fetchRoutes(q) {
  try {
    const res = await fetch(`${API}/api/routes/search?q=${encodeURIComponent(q)}`);
    renderRouteList(await res.json());
  } catch { showError(t('serverError')); }
}

function renderRouteList(routes) {
  if (!routes.length) {
    stopList.innerHTML = `<div class="stop-item"><span style="color:var(--muted);font-size:13px">${t('noRoutesFound')}</span></div>`;
    stopList.classList.add('visible');
    return;
  }
  stopList.innerHTML = routes.map(r => {
    const bg = resolveRouteColor(r.route_short_name, r.route_color) || r.route_color || 'var(--accent2)';
    const fg = r.route_text_color || '#fff';
    const fn = currentTab === 'map'
      ? `selectRouteForMap('${escAttr(r.route_id)}','${escAttr(r.route_short_name)}','${escAttr(r.route_color)}','${escAttr(r.route_text_color)}')`
      : `selectRoute('${escAttr(r.route_id)}','${escAttr(r.route_short_name)}','${escAttr(r.route_color)}','${escAttr(r.route_text_color)}')`;
    return `
      <div class="stop-item route-list-item" onclick="${fn}">
        <span class="route-list-badge" style="background:${bg};color:${fg}">${escHtml(r.route_short_name)}</span>
        <span class="route-list-name">${escHtml(r.route_long_name)}</span>
      </div>`;
  }).join('');
  stopList.classList.add('visible');
}

async function selectRoute(routeId, routeShort, routeColor, routeTextColor) {
  currentRouteId = routeId;
  currentRouteDirection = 0;
  stopList.classList.remove('visible');
  const panel = document.getElementById('route-stops-panel');
  panel.style.display = 'block';
  panel.innerHTML = `<div class="state-msg"><span class="icon">⏳</span><p>${t('mapLoading')}</p></div>`;
  try {
    const [res0, res1] = await Promise.all([
      fetch(`${API}/api/routes/${encodeURIComponent(routeId)}/stops?direction=0`),
      fetch(`${API}/api/routes/${encodeURIComponent(routeId)}/stops?direction=1`),
    ]);
    const data0 = res0.ok ? await res0.json() : null;
    const data1 = res1.ok ? await res1.json() : null;
    currentRouteData = { routeId, routeShort, routeColor, routeTextColor, directions: [data0, data1] };
    renderRouteStops();
  } catch { panel.innerHTML = `<div class="state-msg"><p>${t('fetchError')}</p></div>`; }
}

function renderRouteStops() {
  const panel = document.getElementById('route-stops-panel');
  const { routeShort, routeColor, routeTextColor, directions } = currentRouteData;
  const bg = resolveRouteColor(routeShort, routeColor) || routeColor || 'var(--accent2)';
  const fg = routeTextColor || '#fff';
  const d = currentRouteDirection;
  const data = directions[d];
  if (!data) { panel.innerHTML = `<div class="state-msg"><p>${t('fetchError')}</p></div>`; return; }

  const dirButtons = [1, 0].map(i => {
    if (!directions[i]) return '';
    const label = i === 0 ? t('routeDir0') : t('routeDir1');
    const active = i === d ? ' active' : '';
    return `<button class="route-dir-btn${active}" onclick="switchRouteDirection(${i})">${escHtml(label)}</button>`;
  }).join('');

  const rId = escAttr(currentRouteData.routeId);
  const rShort = escAttr(routeShort);
  const rColor = escAttr(routeColor);
  const rTextColor = escAttr(routeTextColor);
  const stopItems = data.stops.map((s, i) => {
    const isLast = i === data.stops.length - 1;
    const routesJson = escAttr(JSON.stringify(s.routes || []));
    return `
      <div class="route-stop-item${isLast ? ' last' : ''}"
           data-routes="${routesJson}"
           onclick="selectStop('${escAttr(s.stop_id)}','${escAttr(s.stop_name)}','${s.stop_lat}','${s.stop_lon}',false,JSON.parse(this.dataset.routes))">
        <div class="route-stop-line-wrap">
          ${i > 0 ? `<div class="route-stop-line" style="background:${bg}"></div>` : '<div class="route-stop-line-spacer"></div>'}
          <div class="route-stop-dot" style="border-color:${bg}"></div>
          ${!isLast ? `<div class="route-stop-line" style="background:${bg}"></div>` : '<div class="route-stop-line-spacer"></div>'}
        </div>
        <span class="route-stop-name">${escHtml(s.stop_name)}</span>
        <button class="route-stop-timetable-btn"
                title="${t('viewStopTimetable')}"
                onclick="event.stopPropagation();openStopTimetableModal('${escAttr(s.stop_id)}','${escAttr(s.stop_name)}','${rId}','${rShort}','${rColor}','${rTextColor}')">📅</button>
      </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="route-stops-header">
      <div class="route-stops-title">
        <span class="route-stops-badge" style="background:${bg};color:${fg}">${escHtml(routeShort)}</span>
        ${data.stops.length >= 2
          ? `<span class="route-stops-headsign">${escHtml(data.stops[0].stop_name)} — ${escHtml(data.stops[data.stops.length - 1].stop_name)}</span>`
          : data.headsign ? `<span class="route-stops-headsign">${escHtml(data.headsign)}</span>` : ''}
      </div>
      <div class="route-dir-btns">${dirButtons}</div>
    </div>
    <div class="route-stops-list">${stopItems}</div>`;
}

function switchRouteDirection(dir) {
  currentRouteDirection = dir;
  renderRouteStops();
}

// ── Map tab ───────────────────────────────────────────────────────────────────
async function selectRouteForMap(routeId, routeShort, routeColor, routeTextColor) {
  stopList.classList.remove('visible');
  stopList.innerHTML = '';
  searchInput.value = '';
  mapTabDirection = 0;
  const bg = resolveRouteColor(routeShort, routeColor) || routeColor || 'var(--accent2)';

  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (stopDotLayer) { map.removeLayer(stopDotLayer); stopDotLayer = null; }
  document.getElementById('map-tab-stops-panel').innerHTML = '';
  const hint = document.getElementById('map-hint');
  hint.innerHTML = `<span style="color:var(--muted)">${t('mapLoading')}</span>`;
  hint.style.display = '';

  try {
    const [res0, res1] = await Promise.all([
      fetch(`${API}/api/routes/${encodeURIComponent(routeId)}/stops?direction=0`),
      fetch(`${API}/api/routes/${encodeURIComponent(routeId)}/stops?direction=1`),
    ]);
    const data0 = res0.ok ? await res0.json() : null;
    const data1 = res1.ok ? await res1.json() : null;
    mapTabRouteData = { routeId, routeShort, routeColor, routeTextColor, bg, directions: [data0, data1] };
    await _renderMapTab();
  } catch {
    document.getElementById('map-hint').innerHTML = `<span style="color:var(--muted)">${t('fetchError')}</span>`;
  }
}

function _renderMapTabStopsPanel(data) {
  const { routeShort, routeTextColor, bg, directions } = mapTabRouteData;
  const fg = routeTextColor || '#fff';
  const panel = document.getElementById('map-tab-stops-panel');

  const dirBtns = [0, 1].map(i => {
    if (!directions[i]) return '';
    const label = i === 0 ? t('routeDir0') : t('routeDir1');
    const active = i === mapTabDirection ? ' active' : '';
    return `<button class="route-dir-btn${active}" onclick="switchMapTabDirection(${i})">${escHtml(label)}</button>`;
  }).filter(Boolean).join('');

  const stops = data.stops || [];
  const fromTo = stops.length >= 2
    ? `${stops[0].stop_name} — ${stops[stops.length - 1].stop_name}`
    : (data.headsign || '');

  const stopItems = stops.map((s, i) => {
    const isLast = i === stops.length - 1;
    return `
      <div class="map-tab-stop-item${isLast ? ' last' : ''}"
           onclick="mapTabPanToStop(${s.stop_lat},${s.stop_lon})">
        <div class="route-stop-line-wrap">
          ${i > 0 ? `<div class="route-stop-line" style="background:${bg}"></div>` : '<div class="route-stop-line-spacer"></div>'}
          <div class="route-stop-dot" style="border-color:${bg}"></div>
          ${!isLast ? `<div class="route-stop-line" style="background:${bg}"></div>` : '<div class="route-stop-line-spacer"></div>'}
        </div>
        <span class="route-stop-name">${escHtml(s.stop_name)}</span>
      </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="route-stops-header">
      <div class="route-stops-title">
        <span class="route-stops-badge" style="background:${bg};color:${fg}">${escHtml(routeShort)}</span>
        <span class="route-stops-headsign">${escHtml(fromTo)}</span>
      </div>
      <div class="route-dir-btns">${dirBtns}</div>
    </div>
    <div class="route-stops-list">${stopItems}</div>`;
}

function mapTabPanToStop(lat, lon) {
  map.setView([lat, lon], Math.max(map.getZoom(), 15), { animate: true });
}

async function _renderMapTab() {
  if (!mapTabRouteData) return;
  const { bg, directions } = mapTabRouteData;
  const data = directions[mapTabDirection] || directions[mapTabDirection === 0 ? 1 : 0];

  if (!data) return;
  _renderMapTabStopsPanel(data);

  const hint = document.getElementById('map-hint');
  if (!data.shape_id) {
    hint.innerHTML = `<span style="color:var(--muted)">${t('mapNoShape')}</span>`;
    return;
  }

  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (stopDotLayer) { map.removeLayer(stopDotLayer); stopDotLayer = null; }

  const shapeRes = await fetch(`${API}/api/shapes/${encodeURIComponent(data.shape_id)}`).catch(() => null);
  if (!shapeRes || !shapeRes.ok) {
    hint.innerHTML = `<span style="color:var(--muted)">${t('mapNoShape')}</span>`;
    return;
  }
  const shapeData = await shapeRes.json();
  const coords = shapeData.coords.map(c => [c[0], c[1]]);
  if (!coords.length) {
    hint.innerHTML = `<span style="color:var(--muted)">${t('mapNoShape')}</span>`;
    return;
  }

  const glowOuter = L.polyline(coords, { color: bg, weight: 14, opacity: 0.10, lineJoin: 'round' });
  const glowInner = L.polyline(coords, { color: bg, weight: 7,  opacity: 0.28, lineJoin: 'round' });
  const coreLine  = L.polyline(coords, { color: bg, weight: 3,  opacity: 1.00, lineJoin: 'round' });
  routeLayer = L.featureGroup([glowOuter, glowInner, coreLine]).addTo(map);

  // バス停ドットを描画
  const stops = data.stops || [];
  if (stops.length) {
    stopDotLayer = L.layerGroup();
    stops.forEach(s => {
      const lat = parseFloat(s.stop_lat);
      const lon = parseFloat(s.stop_lon);
      if (isNaN(lat) || isNaN(lon)) return;
      L.circleMarker([lat, lon], {
        radius: 4,
        fillColor: '#ffffff',
        color: bg,
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.9,
      }).bindTooltip(escHtml(s.stop_name), {
        direction: 'top', offset: [0, -4], className: 'stop-tooltip'
      }).addTo(stopDotLayer);
    });
    stopDotLayer.addTo(map);
  }

  map.fitBounds(routeLayer.getBounds(), { padding: [28, 28] });
  hint.style.display = 'none';
}

async function switchMapTabDirection(dir) {
  mapTabDirection = dir;
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (stopDotLayer) { map.removeLayer(stopDotLayer); stopDotLayer = null; }
  const hint = document.getElementById('map-hint');
  hint.innerHTML = `<span style="color:var(--muted)">${t('mapLoading')}</span>`;
  hint.style.display = '';
  await _renderMapTab();
}

// ── Stop timetable modal ──────────────────────────────────────────────────────
let _ttStopId = null;
let _ttRouteId = null;

async function openStopTimetableModal(stopId, stopName, routeId, routeShort, routeColor, routeTextColor) {
  _ttStopId = stopId;
  _ttRouteId = routeId;
  const bg = resolveRouteColor(routeShort, routeColor) || routeColor || 'var(--accent2)';
  const fg = routeTextColor || '#fff';

  document.getElementById('stop-tt-title').innerHTML =
    `<span class="routes-badge" style="background:${bg};color:${fg};font-family:'Space Mono',monospace;font-size:13px;font-weight:700;padding:3px 10px;border-radius:5px">${escHtml(routeShort)}</span>
     <span style="font-size:14px;font-weight:600">${escHtml(stopName)}</span>`;

  const today = new Date();
  document.getElementById('stop-tt-date').value =
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  document.getElementById('stop-tt-overlay').classList.add('open');
  document.getElementById('stop-tt-modal').classList.add('open');
  await loadStopTimetableModal();
}

async function loadStopTimetableModal() {
  const date = document.getElementById('stop-tt-date').value;
  const content = document.getElementById('stop-tt-content');
  content.innerHTML = `<div class="stop-tt-loading">${t('mapLoading')}</div>`;
  try {
    const res = await fetch(`${API}/api/stops/${encodeURIComponent(_ttStopId)}/timetable?route_id=${encodeURIComponent(_ttRouteId)}&date=${encodeURIComponent(date)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();

    if (!data.departures.length) {
      content.innerHTML = `<div class="stop-tt-loading">${t('noServiceOnDate')}</div>`;
      return;
    }

    const [y, m, d] = date.split('-').map(Number);
    const now = new Date();
    const isToday = now.getFullYear() === y && (now.getMonth() + 1) === m && now.getDate() === d;
    const nowMins = isToday ? now.getHours() * 60 + now.getMinutes() : -1;

    const groups = [
      { label: t('timetableMorning'), items: [] },
      { label: t('timetableAfternoon'), items: [] },
      { label: t('timetableEvening'), items: [] },
    ];

    data.departures.forEach(dep => {
      const [h, min] = dep.time.split(':').map(Number);
      const totalMins = h * 60 + min;
      const passed = isToday && totalMins < nowMins;
      const chip = { time: dep.time, passed };
      if (totalMins < 720) groups[0].items.push(chip);
      else if (totalMins < 1080) groups[1].items.push(chip);
      else groups[2].items.push(chip);
    });

    let html = '';
    for (const g of groups) {
      if (!g.items.length) continue;
      html += `<div class="stop-tt-group-label">${g.label}</div><div class="stop-tt-grid">`;
      g.items.forEach(c => {
        html += `<span class="stop-tt-chip${c.passed ? ' passed' : ''}">${c.time}</span>`;
      });
      html += `</div>`;
    }
    content.innerHTML = html;
  } catch {
    content.innerHTML = `<div class="stop-tt-loading">${t('fetchError')}</div>`;
  }
}

function closeStopTimetableModal() {
  document.getElementById('stop-tt-overlay').classList.remove('open');
  document.getElementById('stop-tt-modal').classList.remove('open');
}

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
    const routeBadges = s.routes && s.routes.length
      ? `<div class="stop-route-badges">${s.routes.map(r => {
          const bg = resolveRouteColor(r.name, r.color) || r.color || '';
          const fg = r.text_color || (bg ? '#fff' : '');
          const style = bg ? `style="background:${bg};border-color:${bg};color:${fg || '#fff'}"` : '';
          return `<span class="stop-route-badge" ${style}>${escHtml(r.name)}</span>`;
        }).join('')}</div>`
      : '';
    const routesJson = escAttr(JSON.stringify(s.routes || []));
    const isFav = isFavorite(String(s.stop_id));
    const favStar = isFav ? `<span class="stop-fav-star" title="Favorited">★</span>` : '';
    return `
      <div class="stop-item" onclick="selectStop('${s.stop_id}','${escAttr(s.stop_name)}','${s.stop_lat}','${s.stop_lon}',${s.is_terminal},JSON.parse(this.dataset.routes))" data-routes="${routesJson}">
        ${icon}
        <div class="stop-item-main">
          <div class="stop-item-top">
            <span class="stop-name">${escHtml(s.stop_name)}</span>
            ${favStar}
            ${platforms}
            ${distLabel}
          </div>
          ${routeBadges}
        </div>
      </div>`;
  }).join('');
  stopList.classList.add('visible');
}

// ── Select stop ──────────────────────────────────────────────────────────────
function renderStopHeaderRoutes(routes) {
  const routesEl = document.getElementById('stop-header-routes');
  if (routes && routes.length) {
    routesEl.innerHTML = routes.map(r => {
      const bg = resolveRouteColor(r.name, r.color) || r.color || '';
      const fg = r.text_color || (bg ? '#fff' : '');
      const style = bg ? `style="background:${bg};border-color:${bg};color:${fg || '#fff'}"` : '';
      return `<span class="stop-header-route-badge" ${style}>${escHtml(r.name)}</span>`;
    }).join('');
    routesEl.style.display = 'flex';
  } else {
    routesEl.innerHTML = '';
    routesEl.style.display = 'none';
  }
}

function selectStop(stopId, stopName, lat, lon, isTerminal = false, routes = []) {
  history.replaceState(null, '', `?stop=${encodeURIComponent(stopId)}`);
  currentStopId = stopId;
  currentStopRoutes = routes;
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
  lastArrivals = [];

  const list = document.getElementById('arrivals-list');
  list.innerHTML = `<div class="state-msg"><span class="icon">⏳</span><p>${t('fetchingData')}</p></div>`;

  stopList.classList.remove('visible');
  searchInput.value = stopName;
  searchInput.placeholder = 'Search for a bus stop…';

  document.getElementById('stop-header-name').textContent = stopName;
  renderStopHeaderRoutes(routes);

  // バックエンドから最新の routes を取得して更新（お気に入り等で routes が空の場合も対応）
  fetch(`${API}/api/stops/${encodeURIComponent(stopId)}`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data && data.routes && data.routes.length) {
        currentStopRoutes = data.routes;
        renderStopHeaderRoutes(data.routes);
        // お気に入りに保存済みならルート情報を最新に更新
        const favs = loadFavorites();
        const fi = favs.findIndex(f => f.stop_id === stopId);
        if (fi >= 0) {
          favs[fi].routes = data.routes;
          saveFavorites(favs);
        }
      }
    }).catch(() => {});
  document.getElementById('stop-header').classList.add('visible');
  renderFavBtn();
  renderFavorites();
  document.getElementById('main-panel').classList.add('visible');
  document.getElementById('mode-switch').style.display = '';

  setTimeout(() => map.invalidateSize(), 50);

  if (currentTab === 'route') {
    setTimeout(() => document.getElementById('stop-header').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

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
    const dp = demoMode ? '?demo=true' : '';
    const timetableParams = (!demoMode && timetableMode && timetableDate)
      ? `${dp ? '&' : '?'}date=${encodeURIComponent(timetableDate)}&from_time=${encodeURIComponent(timetableTime || '00:00')}`
      : '';
    const endpoint = currentIsTerminal
      ? `${API}/api/terminal/${stopId}/arrivals${dp}${timetableParams}`
      : currentIsNameGrouped
        ? `${API}/api/stops/multi/arrivals?ids=${currentGroupedStopIds.join(',')}${demoMode ? '&demo=true' : ''}${timetableMode && timetableDate ? `&date=${encodeURIComponent(timetableDate)}&from_time=${encodeURIComponent(timetableTime || '00:00')}` : ''}`
        : `${API}/api/stops/${stopId}/arrivals${dp}${timetableParams}`;
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastArrivals = data.arrivals || [];
    setRtUnavailableBanner(data.rt_available === false);
    if (currentIsNameGrouped && data.stop_directions) {
      for (const [sid, dir] of Object.entries(data.stop_directions)) {
        if (stopDirectionMap[sid] === undefined) stopDirectionMap[sid] = dir;
      }
    }
    list.classList.remove('refreshing');
    renderFilterBar();
    const filtered = getFilteredArrivals();
    renderArrivals(filtered, showAllArrivals);
    clearError();

    // 時刻表モードでは自動更新を停止
    if (timetableMode && autoRefreshEnabled) {
      clearTimeout(refreshTimer);
      document.getElementById('refresh-bar').classList.remove('visible');
      document.getElementById('auto-refresh-toggle').classList.remove('active');
      autoRefreshEnabled = false;
    }

    // 翌日便が含まれる場合は自動更新を停止し、5分おきに再チェック
    const hasTomorrow = lastArrivals.some(a => a.day_offset === 1);
    if (!timetableMode && hasTomorrow && autoRefreshEnabled) {
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
        showRoute(a.shape_id, a.trip_id, a.route_short_name, a.headsign || a.route_long_name, a.route_color, a.stop_id, a.vehicle_id || null);
      } else if (filtered.length > 0) {
        // 追跡中のバスが消えた場合、activeCardIndex をリセットしてから選択
        // （リセットなしだと activeCardIndex===0 のときトグルオフになる）
        activeCardIndex = null;
        onCardClick(0);
      }
    } else if (activeCardIndex === null && filtered.length > 0) {
      // バス停選択直後（activeCardIndex が null）は最初の便を自動選択
      onCardClick(0);
    }
  } catch {
    list.classList.remove('refreshing');
    setRtUnavailableBanner(false);
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
  if (!timetableMode) {
    const rtOnly = arrivals.filter(a => !a.is_static);
    arrivals = rtOnly.length > 0 ? rtOnly : arrivals; // RT便ゼロなら静的データをフォールバック表示
  }
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

  const alertRoutes = new Set(alertsCache.flatMap(a => a.route_short_names));

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
    const alertBadge = alertRoutes.has(a.route_short_name)
      ? `<span class="delay-badge alert-warn">⚠️</span>`
      : '';
    const lastStopBadge = a.is_last_stop
      ? `<span class="delay-badge last-stop">${t('lastStop')}</span>`
      : '';

    let arrivalTimeLabel = '';
    if (timetableMode) {
      const d = new Date(a.arrival_time * 1000);
      const todayStr = new Date().toDateString();
      const arrStr = d.toDateString();
      arrivalTimeLabel = arrStr === todayStr ? t('today') : d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    }
    const arrivalTimeHtml = timetableMode
      ? `<div class="minutes later">${clockTime}</div>
         <div class="minutes-label">${arrivalTimeLabel}</div>`
      : isTomorrow
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
            <span class="marquee-inner">${escHtml(headsign)}${delayBadge}${tomorrowBadge}${lastStopBadge}${alertBadge}</span>
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
  renderArrivals(filtered, showAllArrivals);
  const a = filtered[index];
  activeArrivalTripId = a.trip_id;
  renderRouteAlertPanel(a.route_short_name);
  showRoute(a.shape_id, a.trip_id, a.route_short_name, a.headsign || a.route_long_name, a.route_color, a.stop_id, a.vehicle_id || null);
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

// ── Timetable mode ────────────────────────────────────────────────────────────
function _clearTimetableState() {
  timetableMode = false;
  timetableDate = null;
  timetableTime = null;
  document.getElementById('timetable-banner').style.display = 'none';
  document.getElementById('timetable-picker').style.display = 'none';
  const livBtn = document.getElementById('mode-live-btn');
  const ttBtn = document.getElementById('mode-timetable-btn');
  if (livBtn) livBtn.classList.add('active');
  if (ttBtn) ttBtn.classList.remove('active');
  const lbl = document.getElementById('arrivals-section-label');
  if (lbl) { lbl.setAttribute('data-i18n', 'sectionNextBuses'); lbl.textContent = t('sectionNextBuses'); }
}

function switchToLiveMode() {
  clearTimetable();
}

function switchToTimetableMode() {
  document.getElementById('mode-live-btn').classList.remove('active');
  document.getElementById('mode-timetable-btn').classList.add('active');
  const lbl = document.getElementById('arrivals-section-label');
  if (lbl) { lbl.setAttribute('data-i18n', 'timetableMode'); lbl.textContent = t('timetableMode'); }

  const now = new Date();
  const yr = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const dy = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const dateInput = document.getElementById('timetable-date-input');
  const timeInput = document.getElementById('timetable-time-input');
  if (!dateInput.value) dateInput.value = `${yr}-${mo}-${dy}`;
  if (!timeInput.value) timeInput.value = `${hh}:${mm}`;
  document.getElementById('timetable-picker').style.display = 'flex';
  applyTimetable();
}

function applyTimetable() {
  const dateVal = document.getElementById('timetable-date-input').value;
  const timeVal = document.getElementById('timetable-time-input').value;
  if (!dateVal) return;
  timetableMode = true;
  timetableDate = dateVal;
  timetableTime = timeVal || '00:00';

  // 自動更新を無効化
  clearTimeout(refreshTimer);
  autoRefreshEnabled = false;
  document.getElementById('refresh-bar').classList.remove('visible');
  document.getElementById('auto-refresh-toggle').classList.remove('active');

  // バナー更新
  const banner = document.getElementById('timetable-banner');
  document.getElementById('timetable-banner-text').textContent = t('timetableBanner', dateVal, timetableTime);
  banner.style.display = 'flex';

  activeCardIndex = null;
  activeArrivalTripId = null;
  clearRoute();
  if (currentStopId) fetchArrivals(currentStopId);
}

function clearTimetable() {
  _clearTimetableState();
  // 自動更新を再開
  autoRefreshEnabled = true;
  document.getElementById('auto-refresh-toggle').classList.add('active');
  activeCardIndex = null;
  activeArrivalTripId = null;
  clearRoute();
  if (currentStopId) fetchArrivals(currentStopId);
}

function toggleDemoMode() {
  demoMode = !demoMode;
  const btn = document.getElementById('demo-mode-toggle');
  btn.classList.toggle('active', demoMode);
  document.getElementById('demo-banner').style.display = demoMode ? 'flex' : 'none';
  if (currentStopId) fetchArrivals(currentStopId);
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
function setRtUnavailableBanner(show) {
  const el = document.getElementById('rt-unavailable-banner');
  if (!el) return;
  el.textContent = show ? t('rtUnavailable') : '';
  el.classList.toggle('visible', show);
}

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

  const btn = document.getElementById('alert-btn');
  const badge = document.getElementById('alert-count-badge');
  const count = alertsCache.length;

  if (count > 0) {
    btn.style.display = '';
    badge.textContent = count;
  } else {
    btn.style.display = 'none';
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

  const FILTER_COLLAPSE_THRESHOLD = 8;
  const needsFilterCollapse = allTags.length > FILTER_COLLAPSE_THRESHOLD;
  const filterBar = allTags.length > 1 ? `
    <div class="alert-filter-wrap">
      <div class="alert-filter-bar${needsFilterCollapse ? ' collapsed' : ''}" id="alert-filter-bar">
        ${allTags.map(tag => `
          <button class="alert-filter-tag${alertFilterTag === tag ? ' active' : ''}"
                  onclick="setAlertFilter('${escAttr(tag)}')">${escHtml(tag)}</button>
        `).join('')}
      </div>
      ${needsFilterCollapse ? `
        <button class="alert-filter-toggle" id="alert-filter-toggle"
                onclick="toggleAlertFilterBar(${allTags.length})">▾ ${allTags.length}</button>
      ` : ''}
    </div>` : '';

  // フィルタ適用
  const filtered = alertFilterTag
    ? alertsCache.filter(a => a.route_short_names.includes(alertFilterTag))
    : alertsCache;

  const countLabel = alertFilterTag
    ? `<div class="alert-filter-count">${filtered.length} alert${filtered.length !== 1 ? 's' : ''} for ${escHtml(alertFilterTag)}</div>`
    : '';

  const ROUTE_COLLAPSE_THRESHOLD = 6;
  const items = filtered.length ? filtered.map((a, i) => {
    const names = a.route_short_names;
    let routeTags = '';
    if (names.length) {
      const makeTag = r => `<button class="alert-route-tag${alertFilterTag === r ? ' active' : ''}"
              onclick="setAlertFilter('${escAttr(r)}')">${escHtml(r)}</button>`;
      const needsCollapse = names.length > ROUTE_COLLAPSE_THRESHOLD;
      const visible = needsCollapse ? names.slice(0, ROUTE_COLLAPSE_THRESHOLD) : names;
      const hidden = needsCollapse ? names.slice(ROUTE_COLLAPSE_THRESHOLD) : [];
      routeTags = visible.map(makeTag).join('');
      if (needsCollapse) {
        routeTags += `<button class="alert-routes-toggle" id="alert-routes-toggle-${i}"
                  onclick="toggleAlertRoutes(${i}, ${hidden.length})">+${hidden.length}</button>
          <div class="alert-routes-extra hidden" id="alert-routes-extra-${i}">${hidden.map(makeTag).join('')}</div>`;
      }
    }
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

function toggleAlertFilterBar(totalCount) {
  const bar = document.getElementById('alert-filter-bar');
  const btn = document.getElementById('alert-filter-toggle');
  bar.classList.toggle('collapsed');
  btn.textContent = bar.classList.contains('collapsed') ? `▾ ${totalCount}` : '▴';
}

function toggleAlertRoutes(index, hiddenCount) {
  const extra = document.getElementById(`alert-routes-extra-${index}`);
  const btn   = document.getElementById(`alert-routes-toggle-${index}`);
  const expanding = extra.classList.contains('hidden');
  extra.classList.toggle('hidden', !expanding);
  btn.textContent = expanding ? '▴' : `+${hiddenCount}`;
}

// 起動時設定を取得（デモモードボタン表示制御）
fetch(`${API}/api/config`).then(r => r.json()).then(cfg => {
  document.getElementById('demo-mode-toggle').style.display = cfg.demo_enabled ? '' : 'none';
}).catch(() => {
  document.getElementById('demo-mode-toggle').style.display = 'none';
});

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

// ESC キーでモーダルを閉じる
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSettings();
});

// ユーザー操作でタイマーをリセット
['click', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
  document.addEventListener(evt, resetInactivityTimer, { passive: true });
});
resetInactivityTimer();

// 初期言語を適用
applyI18n();

// URLパラメータ ?stop=<stop_id> でバス停を初期選択
(function () {
  const stopId = new URLSearchParams(location.search).get('stop');
  if (!stopId) return;
  fetch(`${API}/api/stops/${encodeURIComponent(stopId)}`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data) selectStop(data.stop_id, data.stop_name, data.stop_lat, data.stop_lon, data.is_terminal || false, data.routes || []);
    })
    .catch(() => {});
})();