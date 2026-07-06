// ── Server overlay ────────────────────────────────────────────────────────────
const _originalFetch = window.fetch.bind(window);
let _serverOverlayType = null;
let _statusPollTimer = null;

// /api/ 呼び出しに対して 503・ネットワークエラーを一元検出するラッパー
window.fetch = async function(input, init) {
  const url = typeof input === 'string' ? input : (input?.url || '');
  const isApi = url.includes('/api/') && !url.includes('/api/status');

  let res;
  try {
    res = await _originalFetch(input, init);
  } catch (e) {
    if (isApi && e.name !== 'AbortError') {
      showServerOverlay('offline');
    }
    throw e;
  }

  if (isApi && res.status === 503) {
    showServerOverlay('loading');
    _startStatusPolling();
    const err = new Error('Service unavailable');
    err.isServerUnavailable = true;
    throw err;
  }

  if (_serverOverlayType && isApi && res.ok) {
    hideServerOverlay();
  }

  return res;
};

function showServerOverlay(type) {
  _serverOverlayType = type;
  const overlay = document.getElementById('server-overlay');
  const icon    = document.getElementById('server-overlay-icon');
  const title   = document.getElementById('server-overlay-title');
  const msg     = document.getElementById('server-overlay-msg');
  const retry   = document.getElementById('server-overlay-retry');
  if (!overlay) return;

  if (type === 'loading' || type === 'updating') {
    icon.innerHTML  = '<div class="server-overlay-spinner"></div>';
    title.textContent = t(type === 'updating' ? 'serverUpdating' : 'serverLoading');
    msg.textContent   = t(type === 'updating' ? 'serverUpdatingMsg' : 'serverLoadingMsg');
    retry.style.display = 'none';
    _startStatusPolling();
  } else {
    icon.textContent  = '🔌';
    title.textContent = t('serverOffline');
    msg.textContent   = t('serverOfflineMsg');
    retry.style.display = '';
    retry.textContent   = t('serverRetry');
  }

  overlay.classList.add('visible');
}

function hideServerOverlay() {
  _serverOverlayType = null;
  clearInterval(_statusPollTimer);
  _statusPollTimer = null;
  const overlay = document.getElementById('server-overlay');
  if (overlay) overlay.classList.remove('visible');
}

function _startStatusPolling() {
  if (_statusPollTimer) return;
  _statusPollTimer = setInterval(async () => {
    try {
      const res = await _originalFetch(`${API}/api/status`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.status === 'ready') {
        clearInterval(_statusPollTimer);
        _statusPollTimer = null;
        hideServerOverlay();
        if (typeof fetchArrivals === 'function' && typeof currentStopId !== 'undefined' && currentStopId) {
          fetchArrivals(currentStopId);
        }
      } else {
        showServerOverlay(data.status);
      }
    } catch { /* まだ offline のまま */ }
  }, 5000);
}

async function retryServerConnection() {
  const btn = document.getElementById('server-overlay-retry');
  if (btn) btn.textContent = t('serverChecking');
  try {
    const res = await _originalFetch(`${API}/api/status`);
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'ready') {
        hideServerOverlay();
        if (typeof fetchArrivals === 'function' && typeof currentStopId !== 'undefined' && currentStopId) {
          fetchArrivals(currentStopId);
        }
      } else {
        showServerOverlay(data.status);
      }
    } else {
      showServerOverlay('offline');
    }
  } catch {
    showServerOverlay('offline');
  }
}

// 起動時ヘルスチェック
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await _originalFetch(`${API}/api/status`);
    if (res.ok) {
      const data = await res.json();
      if (data.status !== 'ready') showServerOverlay(data.status);
    } else {
      showServerOverlay('loading');
    }
  } catch {
    showServerOverlay('offline');
  }
});

// ── Timezone (常にブリスベン時間で表示。端末側のTZ設定は無視する) ───────────────
const BRISBANE_TZ = 'Australia/Brisbane';

// 現在時刻をブリスベン時間の年月日時分秒に分解して取得
function nowInBrisbane() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BRISBANE_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return {
    year: +get('year'), month: +get('month'), day: +get('day'),
    hour: +get('hour'), minute: +get('minute'), second: +get('second'),
  };
}

// Date を "HH:MM"（ブリスベン時間）にフォーマット
function formatBrisbaneTime(date) {
  return date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: BRISBANE_TZ });
}

// Date を "YYYY-MM-DD"（ブリスベン時間）にフォーマット。日付比較のキーとして使う
function brisbaneDateKey(date) {
  return date.toLocaleDateString('en-CA', { timeZone: BRISBANE_TZ });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setRtUnavailableBanner(show) {
  const el = document.getElementById('rt-unavailable-banner');
  if (!el) return;
  el.textContent = show ? t('rtUnavailable') : '';
  el.classList.toggle('visible', show);
}

function showError(msg) {
  if (_serverOverlayType) return;
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
