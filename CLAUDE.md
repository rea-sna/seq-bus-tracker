# SEQ Bus Tracker — CLAUDE.md

## プロジェクト概要

TranslinkのGTFS-RT（Queensland SEQ）を使ったリアルタイムバス到着情報Webアプリ。

- **バックエンド**: FastAPI（Python）
- **フロントエンド**: HTML / CSS / Vanilla JS（Leaflet.js）
- **データソース**: Translink GTFS Static + GTFS-RT

---

## ディレクトリ構成

```
project/
├── main.py                  # FastAPI バックエンド（全APIエンドポイント）
├── requirements.txt         # Python依存パッケージ
├── Procfile                 # Herokuデプロイ用
├── .gitignore               # gtfs/ を除外
├── OPTIMIZATION.md          # 最適化候補リスト
├── gtfs/                    # GTFSスタティックデータ（gitignore済み・起動時自動DL）
│   ├── stops.txt
│   ├── routes.txt
│   ├── trips.txt
│   ├── stop_times.txt
│   ├── shapes.txt
│   ├── calendar.txt
│   └── calendar_dates.txt
└── static/
    ├── index.html           # マークアップ
    ├── style.css            # スタイル（ダークテーマ、モバイル対応済み）
    └── app.js               # フロントエンドロジック
```

---

## セットアップ

```bash
pip install -r requirements.txt
uvicorn main:app --reload --port 8000 --host 0.0.0.0
```

GTFSデータは `gtfs/stops.txt` が存在しない場合、起動時に自動ダウンロード・展開される。

**GTFS URL**: `https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip`（約225MB）

---

## APIエンドポイント一覧

| メソッド | パス | 説明 | レート制限 |
|---|---|---|---|
| GET | `/api/stops/search?q=` | バス停名検索（2文字以上推奨） | 60/分 |
| GET | `/api/stops/nearby?lat=&lon=&radius=&limit=` | GPS現在地から近いバス停 | 20/分 |
| GET | `/api/stops/{stop_id}/arrivals` | リアルタイム到着情報（次の15本） | 30/分 |
| GET | `/api/stops/{stop_id}` | バス停詳細情報 | 60/分 |
| GET | `/api/terminal/{parent_id}/arrivals` | ターミナルの全ホーム到着情報 | 30/分 |
| GET | `/api/shapes/{shape_id:path}` | ルート形状座標（`:path`でスラッシュ含むID対応） | 30/分 |
| GET | `/api/trips/{trip_id:path}/stops` | trip経由バス停一覧（静的時刻・予測時刻・通過済みフラグ付き） | 30/分 |

**GTFS-RT エンドポイント（Translink、APIキー不要）**
- TripUpdates: `https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Bus`
- VehiclePositions: `https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus`

---

## 主要な実装詳細

### バックエンド（main.py）

**グローバル変数（GTFS読み込み済みDataFrame）**
```python
stops_df          # 全バス停
bus_routes_df     # バス路線（route_type==3のみ）
bus_trips_df      # バス便
stop_times_df     # 停車時刻
shapes_df         # ルート形状
calendar_df       # 運行カレンダー
calendar_dates_df # 運行例外日
```

**翌日便フォールバック（`get_static_arrivals()`）**
- リアルタイム便がゼロの場合、`stop_times.txt` から今日→明日の順に静的時刻で補完
- `calendar.txt` / `calendar_dates.txt` で当日の有効 `service_id` を判定
- 翌日便には `day_offset: 1` フラグを付与

**レート制限（slowapi）**
- IPアドレスベース
- 全体デフォルト: 200/分
- エンドポイント個別制限あり（上表参照）

### フロントエンド（app.js）

**グローバル状態変数**
```javascript
currentStopId      // 選択中バス停ID（ターミナルはparent_id）
currentIsTerminal  // ターミナルかどうか
currentStopLat/Lon // 選択中バス停の座標
activeCardIndex    // 選択中の到着カードインデックス
showAllArrivals    // モバイルで「もっと見る」状態
lastArrivals       // 最後に取得した到着データ配列
autoRefreshEnabled // 自動更新ON/OFF
```

**主要な関数**
```javascript
selectStop(stopId, stopName, lat, lon, isTerminal)  // バス停選択
fetchArrivals(stopId)     // 到着情報取得・描画
renderArrivals(arrivals)  // 到着カード描画
showRoute(shapeId, tripId, routeShort, headsign, routeColor, platformStopId)  // 地図ルート表示
renderTimeline(tripId, lineColor, stopId)  // 停車駅タイムライン描画
findNearbyStops()         // GPS現在地から近いバス停を取得
```

**重要な実装上の注意点**
- `stopMarker` は `L.marker`（`L.circleMarker` ではない）→ `bringToFront()` は使えない。`setZIndexOffset(1000)` を使う
- `stop_id` の型比較は `String(s.stop_id) === String(stopId)` で統一（数値・文字列混在のため）
- `renderTimeline` の引数: `renderTimeline(tripId, lineColor, platformStopId)` — `platformStopId` はカード選択中のバス停ID
- 翌日便（`day_offset === 1`）が含まれる場合は自動更新を自動でOFF

---

## デプロイ

### Render
```
Build Command: pip install -r requirements.txt
Start Command: uvicorn main:app --host 0.0.0.0 --port $PORT
```

### Heroku
```bash
heroku create seq-bus-tracker
git push heroku main
# Procfile に設定済み
```

**注意**: 初回起動時にGTFS（225MB）をダウンロードするため5〜10分かかる。
無料プラン（Render）はスリープ後に再ダウンロードが走るため有料プランを推奨。

---

## 未実装・次のタスク（優先度順）

### 優先度: 高

#### 1. GTFSリアルタイムフィードのキャッシュ
現状、`/arrivals` と `/trips/stops` が毎回別々にTranslink APIを叩いている（1ユーザーの操作で最大3リクエスト）。30秒間インメモリキャッシュを追加する。

```python
# main.py に追加
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

各エンドポイントの `requests.get(TRIP_UPDATES_URL, ...)` を `get_feed()` に置き換える。

#### 2. DataFrameのインデックス化
`bus_trips_df[bus_trips_df["trip_id"] == trip_id]` が毎回全行スキャンになっている。`load_gtfs()` の末尾で `set_index()` する。

```python
bus_trips  = bus_trips.set_index("trip_id")
bus_routes = bus_routes.set_index("route_id")
# 参照時: bus_trips_df.loc[trip_id]
```

#### 3. `get_static_arrivals` のベクトル化
`iterrows()` を pandas ベクトル演算に置き換えてフォールバック処理を高速化する。

### 優先度: 中

#### 4. APIリクエスト重複排除（フロントエンド）
カードクリック時に `showRoute()` と `renderTimeline()` がそれぞれ `/api/trips/{id}/stops` を叩いている（2回）。`showRoute` 内で取得したデータを `renderTimeline` に渡すように変更する。

#### 5. shapes.txt のメモリ削減
`shapes_df` を shape_id キーの辞書＋ `np.float32` に変換してメモリ使用量を約50%削減する。

### 優先度: 低（将来対応）

#### 6. GTFS自動更新（週1回）
`APScheduler` でGTFSを週1回自動更新する。

#### 7. VehiclePositions の活用
選択中のtripのバスアイコンを地図上にリアルタイム表示する。

#### 8. Service Worker によるオフラインキャッシュ
`index.html` / `style.css` / `app.js` をキャッシュしてネットワーク不安定時でも動作させる。

---

## 既知のバグ・注意事項

- `shapes.txt` の `shape_id` にスラッシュが含まれる場合あり → エンドポイントに `:path` 指定で対応済み
- GTFS の時刻は25時間表記（例: `25:30:00`）あり → `int(parts[0]) % 24` で表示用に変換
- Translink のリアルタイムフィードは数分遅延する場合がある
- iPhoneのSafariはHTTPSでないとGPS位置情報が取得できない → ngrokでHTTPSトンネルを使用するか、本番環境にデプロイして使う
