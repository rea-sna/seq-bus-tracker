# SEQ Bus Tracker — CLAUDE.md

## プロジェクト概要

TranslinkのGTFS-RT（Queensland SEQ）を使ったリアルタイムバス到着情報Webアプリ。
このファイルおよび、Readmeは適宜アップデートを行ってください。
また、コードは適宜最適化を行ってください。ただし、最適化を行う場合には、必ずユーザーに確認を行い承諾を得てください。

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
| GET | `/api/alerts` | アクティブなサービスアラート一覧 | 20/分 |

**GTFS-RT エンドポイント（Translink、APIキー不要）**

- TripUpdates: `https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Bus`
- VehiclePositions: `https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus`

---

## 主要な実装詳細

### バックエンド（main.py）

**グローバル変数（GTFS読み込み済みDataFrame）**

```python
stops_df          # 全バス停
bus_routes_df     # バス路線（route_type==3のみ）。route_id がインデックス
bus_trips_df      # バス便。trip_id がインデックス
stop_times_df     # 停車時刻
shapes_dict       # shape_id → np.float32配列 の辞書（メモリ削減済み）
calendar_df       # 運行カレンダー
calendar_dates_df # 運行例外日
last_stop_by_trip # trip_id → 最終stop_id の辞書（終着駅フィルタ用）
```

**GTFSリアルタイムフィードキャッシュ**

```python
_feed_cache  # TripUpdates フィード（30秒TTL）
_seq_cache   # SEQ combined フィード（60秒TTL、サービスアラート用）
```

各エンドポイントは `get_feed()` / `get_seq_feed()` 経由でキャッシュを使用。

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
showRoute(shapeId, tripId, routeShort, headsign, routeColor, platformStopId)  // 地図ルート表示 + タイムライン
renderTimeline(stData, lineColor, stopId)  // 停車駅タイムライン描画（stData はshowRoute内で取得済みデータを再利用）
findNearbyStops()         // GPS現在地から近いバス停を取得
resolveRouteColor(routeShort, routeColor)  // M1/M2は固定カラー、それ以外は routeColor を使用
```

**重要な実装上の注意点**

- `stopMarker` は `L.marker`（`L.circleMarker` ではない）→ `bringToFront()` は使えない。`setZIndexOffset(1000)` を使う
- `stop_id` の型比較は `String(s.stop_id) === String(stopId)` で統一（数値・文字列混在のため）
- `showRoute` 内で `/api/trips/{id}/stops` と `/api/shapes/{id}` を `Promise.all` で並列取得し、取得した `stData` を `renderTimeline` に渡す（重複リクエスト排除済み）
- 翌日便（`day_offset === 1`）が含まれる場合は自動更新を自動でOFF
- M1 / M2 路線は `METRO_COLOR`（`#5EC4BC`）で固定表示
- 地図タイルはOSのカラースキーム（ダーク/ライト）に自動追従

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

### 優先度: 低（将来対応）

#### 1. GTFS自動更新（週1回）

`APScheduler` でGTFSを週1回自動更新する。

#### 2. VehiclePositions の活用

選択中のtripのバスアイコンを地図上にリアルタイム表示する。

#### 3. Service Worker によるオフラインキャッシュ

`index.html` / `style.css` / `app.js` をキャッシュしてネットワーク不安定時でも動作させる。

---

## 実装済み最適化（記録用）

| 最適化 | 実装箇所 |
|---|---|
| GTFSリアルタイムフィードキャッシュ（TripUpdates 30s / SEQ combined 60s TTL） | `main.py: get_feed()`, `get_seq_feed()` |
| DataFrameインデックス化（`trip_id`, `route_id`） | `main.py: load_gtfs()` |
| `get_static_arrivals` のベクトル化（`iterrows` 排除） | `main.py: get_static_arrivals()` |
| APIリクエスト重複排除（`showRoute` + `renderTimeline` で共有） | `app.js: showRoute()` |
| shapes.txt メモリ削減（numpy dict + float32） | `main.py: shapes_dict` |

---

## 既知のバグ・注意事項

- `shapes.txt` の `shape_id` にスラッシュが含まれる場合あり → エンドポイントに `:path` 指定で対応済み
- GTFS の時刻は25時間表記（例: `25:30:00`）あり → `int(parts[0]) % 24` で表示用に変換
- Translink のリアルタイムフィードは数分遅延する場合がある
- iPhoneのSafariはHTTPSでないとGPS位置情報が取得できない → ngrokでHTTPSトンネルを使用するか、本番環境にデプロイして使う
