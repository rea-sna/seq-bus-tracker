// ── Search ──
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
let _searchController = null;

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
  if (_searchController) _searchController.abort();
  _searchController = new AbortController();
  try {
    const res = await fetch(`${API}/api/routes/search?q=${encodeURIComponent(q)}`, { signal: _searchController.signal });
    renderRouteList(await res.json());
  } catch (e) {
    if (e.name === 'AbortError') return;
    showError(t('serverError'));
  }
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
  if (_searchController) _searchController.abort();
  _searchController = new AbortController();
  try {
    const res = await fetch(`${API}/api/stops/search?q=${encodeURIComponent(q)}`, { signal: _searchController.signal });
    renderStopList(await res.json());
  } catch (e) {
    if (e.name === 'AbortError') return;
    showError(t('serverError'));
  }
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
