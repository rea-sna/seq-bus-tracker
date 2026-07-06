// ── Map ──
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
  startVehicleTracking(tripId, lineColor, vehicleId, routeShort);

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
  if (diff === 0) {
    // IN_TRANSIT_TO(2): current_stop_id は向かっている先のバス停なので、まだ到着していない
    if (pos.current_status === 2) return { approaching: true };
    return { atStop: true };
  }
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
    } else if (proximity.approaching) {
      proximityStr = `<span class="vehicle-proximity-badge vehicle-proximity-away" style="color:${color};border-color:${color}">${t('vehicleIncomingAt')}</span>`;
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

async function updateVehicleMarker(tripId, lineColor, vehicleId = null, routeShort = null) {
  try {
    const res = await fetch(`${API}/api/trips/${tripId}/vehicle`);
    let pos = res.ok ? await res.json() : null;
    let isPreTurnaround = false;

    // trip_idで見つからず vehicle_id がある場合、折り返し前の位置を検索
    if (!pos && vehicleId) {
      const res2 = await fetch(`${API}/api/vehicles/${encodeURIComponent(vehicleId)}/position`);
      if (res2.ok) {
        const p2 = await res2.json();
        // 別のtripを走行中、かつ同じ路線（replacementバス等の別路線は除外）の場合のみ表示
        if (p2 && p2.current_trip_id !== tripId &&
            (!routeShort || p2.current_route_short_name === routeShort)) {
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
        (proximity.atStop || proximity.approaching || proximity.stopsAway <= 3) &&
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

function startVehicleTracking(tripId, lineColor, vehicleId = null, routeShort = null) {
  stopVehicleTracking();
  updateVehicleMarker(tripId, lineColor, vehicleId, routeShort);
  vehicleRefreshTimer = setInterval(() => updateVehicleMarker(tripId, lineColor, vehicleId, routeShort), 15000);
}

function stopVehicleTracking() {
  if (vehicleRefreshTimer) { clearInterval(vehicleRefreshTimer); vehicleRefreshTimer = null; }
  if (vehicleMarker) { map.removeLayer(vehicleMarker); vehicleMarker = null; }
  updateVehiclePanel(null);
  vehicleZoomedAt2Stops = false;
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
        return formatBrisbaneTime(new Date(s.predicted_unix * 1000));
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
