# SEQ Bus Tracker — 最適化ポイント

## 実装済み

| # | 内容 | 実装箇所 |
|---|------|----------|
| 1 | RTフィードキャッシュ（TripUpdates 30s / SEQ combined 60s TTL） | `core/feeds.py: get_feed(), get_seq_feed()` |
| 2 | `get_static_arrivals` を SQLiteクエリに置き換え（`iterrows` 排除） | `core/arrivals.py: get_static_arrivals()` |
| 3 | trips を辞書化（`trips_dict`）して O(1) アクセス | `core/state.py: trips_dict` |
| 4 | `stop_times` / `shapes` / `calendar` を SQLite に移行 | `core/loader.py: build_gtfs_db()` |
| 5 | APIリクエスト重複排除（`showRoute` + `renderTimeline` でデータ共有） | `js/map.js: showRoute()` |
| 6 | 検索デバウンス（300ms・2文字以上） | `js/search.js` |
| 7 | GTFS週次自動更新（毎週月曜3時・ブリスベン時間） | `core/loader.py: _update_gtfs()`, APScheduler |
| 8 | VehiclePositions 活用（バスアイコン表示・折り返し前追跡） | `js/map.js: startVehicleTracking()`, `routers/vehicles.py` |
| 9 | `stop_routes` テーブルによるバス停→路線マッピング高速化 | `core/state.py: stop_routes_dict` |
| 10 | `stop_times` に `(stop_id, arrival_secs)` 複合インデックス追加 | `core/loader.py: build_gtfs_db()` |
| 11 | `stops.py` の `iterrows` を `to_dict('records')` + `.tolist()` に置き換え | `routers/stops.py: search_stops(), get_nearby_stops()` |
| 12 | `search.js` に AbortController を追加（`fetchStops` / `fetchRoutes`） | `js/search.js` |

---

## 未実装

### 1. `loadFavorites()` のインメモリキャッシュ化（優先度: 低）

**問題**  
`favorites.js` の `loadFavorites()` は呼び出しのたびに `localStorage.getItem` + `JSON.parse` を実行している。`renderFavorites()`・`isFavorite()`・`addFavorite()`・`removeFavorite()` それぞれで呼ばれるため、バス停選択のたびに複数回実行される。

**改善策**  
モジュール内にキャッシュ変数を持ち、追加・削除時のみ localStorage を書き直す。

```javascript
let _favsCache = null;
function loadFavorites() {
  if (_favsCache) return _favsCache;
  try { _favsCache = JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); }
  catch { _favsCache = []; }
  return _favsCache;
}
function saveFavorites(favs) {
  _favsCache = favs;
  localStorage.setItem(FAV_KEY, JSON.stringify(favs));
}
```

**効果**  
localStorage の読み取り・JSON パースの回数を削減。体感できるほどの差ではないが、コードがシンプルになる。

---

### 2. Service Worker によるオフラインキャッシュ（優先度: 低）

**問題**  
ネットワークが不安定な環境で静的ファイルを毎回再取得する。

**改善策**  
`index.html` / `style.css` / `js/` 以下のモジュールを Service Worker でキャッシュする。GTFSやリアルタイムデータはキャッシュしない。

---

### 3. 車両追跡ポーリング間隔の可変化（優先度: 低）

**問題**  
現在は距離に関わらず固定15秒間隔でポーリングしている。

**改善策**  
近さに応じてポーリング間隔を変える。

| 状況 | 現在 | 改善後 |
|------|------|--------|
| 遠い（4駅以上） | 15秒 | 60秒 |
| 近い（3駅以内） | 15秒 | 30秒 |
| 接近中・停車中 | 15秒 | 10秒 |

実装箇所: `js/map.js: startVehicleTracking()` の `setInterval` を `calcStopsAway` の結果で動的に変更。
