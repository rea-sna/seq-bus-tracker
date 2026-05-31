// ── Helpers ──
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
