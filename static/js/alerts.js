// ── Service Alerts ──
let alertsCache = [];
let alertFilterTag = null; // 選択中のルートタグフィルタ（null = 全表示）
let alertSortKey = null;   // null | 'route' | 'cause' | 'effect'

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
  alertSortKey = null;
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

function _routeSortKey(name) {
  const n = parseInt(name, 10);
  return isNaN(n) ? name : String(n).padStart(6, '0');
}

function getSortedAlerts(alerts) {
  if (!alertSortKey) return alerts;
  return [...alerts].sort((a, b) => {
    if (alertSortKey === 'route') {
      const ra = a.route_short_names.map(_routeSortKey).sort()[0] || 'zzz';
      const rb = b.route_short_names.map(_routeSortKey).sort()[0] || 'zzz';
      return ra.localeCompare(rb);
    }
    if (alertSortKey === 'cause') {
      return (a.cause || '').localeCompare(b.cause || '');
    }
    if (alertSortKey === 'effect') {
      return (a.effect || '').localeCompare(b.effect || '');
    }
    return 0;
  });
}

function setAlertSort(key) {
  alertSortKey = alertSortKey === key ? null : key;
  renderAlertPanel();
}

function renderAlertPanel() {
  const list = document.getElementById('alert-panel-list');
  if (!alertsCache.length) {
    list.innerHTML = `<div class="alert-empty">${t('alertNone')}</div>`;
    document.getElementById('alert-sort-bar').innerHTML = '';
    return;
  }

  // ソートバーをヘッダーに描画
  const sortKeys = ['route', 'cause', 'effect'];
  const sortLabels = { route: t('alertSortRoute'), cause: t('alertSortCause'), effect: t('alertSortEffect') };
  document.getElementById('alert-sort-bar').innerHTML = `
    <div class="alert-sort-bar">
      <span class="alert-sort-label">Sort:</span>
      ${sortKeys.map(k => `
        <button class="alert-sort-btn${alertSortKey === k ? ' active' : ''}" onclick="setAlertSort('${k}')">${sortLabels[k]}</button>
      `).join('')}
    </div>`;

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

  // フィルタ適用 → ソート適用
  const filtered = getSortedAlerts(alertFilterTag
    ? alertsCache.filter(a => a.route_short_names.includes(alertFilterTag))
    : alertsCache);

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
