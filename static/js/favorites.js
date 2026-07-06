// ── Favorites ──
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
