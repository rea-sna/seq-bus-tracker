# SEQ Bus Tracker — 最適化ポイント

## 優先度: 高

---

### 1. GTFSリアルタイムフィードのキャッシュ（バックエンド）

**現状の問題**  
`/api/stops/{id}/arrivals` と `/api/trips/{id}/stops` と `/api/terminal/{id}/arrivals` がそれぞれ独立してTranslink APIを叩いている。1ユーザーがバス停を開くだけで最大3回のリクエストが発生する。

**改善策**  
フィードを30秒間インメモリにキャッシュする。

```python
import threading

_feed_cache = {"data": None, "expires": 0}
_feed_lock  = threading.Lock()

def get_feed():
    with _feed_lock:
        if time.time() < _feed_cache["expires"] and _feed_cache["data"]:
            return _feed_cache["data"]
        resp = requests.get(TRIP_UPDATES_URL, timeout=10)
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(resp.content)
        _feed_cache["data"]    = feed
        _feed_cache["expires"] = time.time() + 30
        return feed
```

**効果**  
Translink APIへのリクエストが最大1/3に削減。レスポンスも高速化。

---

### 2. `get_static_arrivals` のループをベクトル化（バックエンド）

**現状の問題**  
`for _, row in st.iterrows()` で行単位のループを回している。`stop_times.txt` は数十万行あるため遅い。

**改善策**  
pandasのベクトル演算に置き換える。

```python
# 時刻文字列を秒数に変換（ベクトル化）
def time_str_to_seconds(s: pd.Series) -> pd.Series:
    parts = s.str.split(":", expand=True).astype(float)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]

st["arr_ts"] = base_ts + time_str_to_seconds(
    st["arrival_time"].where(st["arrival_time"] != "", st["departure_time"])
)
st = st[st["arr_ts"] > now].sort_values("arr_ts").head(15)
```

**効果**  
静的時刻フォールバックの処理速度が大幅に改善（数百ms → 数十ms）。

---

### 3. `bus_trips_df` と `bus_routes_df` をインデックス化（バックエンド）

**現状の問題**  
`bus_trips_df[bus_trips_df["trip_id"] == trip_id]` のように毎回全行をスキャンしている。

**改善策**  
起動時にインデックスを作成する。

```python
# load_gtfs() の末尾に追加
bus_trips  = bus_trips.set_index("trip_id")
bus_routes = bus_routes.set_index("route_id")

# 参照時
trip_row  = bus_trips_df.loc[trip_id]   # O(1)
route_row = bus_routes_df.loc[route_id] # O(1)
```

**効果**  
リアルタイムフィードのパース処理がO(n)からO(1)に改善。

---

## 優先度: 中

---

### 4. フロントエンドのAPIリクエスト重複排除

**現状の問題**  
カードをクリックすると `showRoute()` と `renderTimeline()` がそれぞれ `/api/trips/{id}/stops` を叩いている（2回）。

**改善策**  
`showRoute` 内で取得したtripデータを `renderTimeline` に引数として渡す。

```javascript
// showRoute内でstopsを取得したら、そのデータをrenderTimelineに渡す
const stData = await stRes.json();
renderTimeline(stData, lineColor, platformStopId); // fetchしない版
```

**効果**  
カード選択時のAPIリクエストが2回→1回に削減。

---

### 5. shapes.txt のメモリ使用量削減（バックエンド）

**現状の問題**  
`shapes.txt` は全shape・全座標点を丸ごとメモリに展開している。SEQのshapes.txtは特に大きい（数百MB相当）。

**改善策**  
shape_idをキーにした辞書形式で保持し、floatをnp.float32に落とす。

```python
import numpy as np

shapes_dict = {}
for shape_id, group in shapes_df.groupby("shape_id"):
    coords = group[["shape_pt_lat","shape_pt_lon"]].values.astype(np.float32)
    shapes_dict[shape_id] = coords
```

**効果**  
メモリ使用量を約50%削減。shape検索もO(1)に。

---

### 6. 検索のデバウンス調整（フロントエンド）

**現状の問題**  
現在の検索デバウンスが短い場合、入力のたびにAPIリクエストが飛ぶ。

**改善策**  
デバウンスを300msに統一し、最小文字数を2文字に固定する。

```javascript
let searchDebounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    if (searchInput.value.trim().length >= 2) fetchStops(searchInput.value.trim());
  }, 300);
});
```

**効果**  
不要なAPIリクエストを削減。サーバー負荷低減。

---

## 優先度: 低（将来対応）

---

### 7. GTFSの自動更新（バックエンド）

**現状の問題**  
GTFSは`gtfs/stops.txt`が存在する限り再ダウンロードしない。TranslinkはGTFSを定期更新するため、古いデータのまま動き続ける。

**改善策**  
週1回自動更新するスケジューラを追加する（`APScheduler`使用）。

```python
from apscheduler.schedulers.background import BackgroundScheduler

def refresh_gtfs():
    import shutil
    shutil.rmtree(GTFS_DIR, ignore_errors=True)
    download_gtfs_if_needed()
    global stops_df, bus_routes_df, bus_trips_df, stop_times_df
    stops_df, bus_routes_df, bus_trips_df, stop_times_df, *_ = load_gtfs()

scheduler = BackgroundScheduler()
scheduler.add_job(refresh_gtfs, "interval", weeks=1)
scheduler.start()
```

---

### 8. VehiclePositions の活用（バックエンド）

**現状の問題**  
現在はTripUpdatesのみ使用しており、バスの現在位置を地図に表示していない。

**改善策**  
`VehiclePositions` フィードを取得し、選択中のtripのバスアイコンを地図に重ねる。

```
VehiclePositions: https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus
```

---

### 9. Service Worker によるオフラインキャッシュ（フロントエンド）

**現状の問題**  
ネットワークが不安定な環境（ブリスベンの郊外路線など）でアクセスすると、静的ファイルも再取得する。

**改善策**  
Service Workerで `index.html` / `style.css` / `app.js` をキャッシュする。GTFSやリアルタイムデータはキャッシュしない。

---

## まとめ

| # | 内容 | 優先度 | 難易度 | 効果 |
|---|------|--------|--------|------|
| 1 | RTフィードキャッシュ | 高 | 低 | Translink APIリクエスト1/3 |
| 2 | iterrows→ベクトル化 | 高 | 中 | 静的フォールバック高速化 |
| 3 | DataFrameインデックス化 | 高 | 低 | フィードパース高速化 |
| 4 | APIリクエスト重複排除 | 中 | 中 | カード選択2req→1req |
| 5 | shapesメモリ削減 | 中 | 中 | RAM使用量約50%削減 |
| 6 | 検索デバウンス調整 | 中 | 低 | 不要リクエスト削減 |
| 7 | GTFS自動更新 | 低 | 中 | データ鮮度維持 |
| 8 | VehiclePositions活用 | 低 | 高 | バスリアルタイム位置表示 |
| 9 | Service Worker | 低 | 中 | オフライン対応 |
