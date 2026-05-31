// ── Arrivals ──
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
  showTerminates = false;
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
  if (!showTerminates) {
    arr = arr.filter(a => !a.is_last_stop);
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
        html += `<button class="arrivals-filter-chip arrivals-filter-chip--platform${active}" onclick="setArrivalFilter('platform','${escAttr(p)}')">${escHtml(p)}</button>`;
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

  // Terminates toggle (show only when there are is_last_stop arrivals)
  const hasTerminates = lastArrivals.some(a => a.is_last_stop);
  if (hasTerminates) {
    const activeClass = showTerminates ? ' active' : '';
    html += `<div class="arrivals-filter-group arrivals-filter-terminates">
      <label class="switch-label${activeClass}" onclick="toggleHideTerminates()">
        <span class="switch-track"><span class="switch-knob"></span></span>
      </label>
      <span class="arrivals-filter-terminates-label">${t('filterHideTerminates')}</span>
    </div>`;
  }

  bar.innerHTML = html;
  bar.style.display = html ? 'block' : 'none';
}

function toggleHideTerminates() {
  showTerminates = !showTerminates;
  activeCardIndex = null;
  activeArrivalTripId = null;
  clearRoute();
  renderFilterBar();
  const filtered = getFilteredArrivals();
  renderArrivals(filtered, showAllArrivals);
  if (filtered.length > 0) onCardClick(0);
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
  // 前のリクエストをキャンセルしてレースコンディションを防ぐ
  if (_fetchController) _fetchController.abort();
  _fetchController = new AbortController();
  const { signal } = _fetchController;

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
    const res = await fetch(endpoint, { signal });
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
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (err.isServerUnavailable) return; // overlay が回復を管理するためリトライ抑制
    list.classList.remove('refreshing');
    setRtUnavailableBanner(false);
    showError(t('fetchError'));
    if (!isRefresh) list.innerHTML = '';
    // 失敗時も自動更新が有効なら30秒後にリトライ
    if (autoRefreshEnabled && currentStopId) {
      refreshTimer = setTimeout(() => { if (currentStopId) fetchArrivals(currentStopId); }, 30000);
    }
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

function updateFavBtn() {
  renderFavBtn();
}
