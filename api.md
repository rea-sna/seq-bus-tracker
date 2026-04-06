# SEQ Bus Tracker — API リファレンス

ベースURL: `http://localhost:8000`（ローカル）

レート制限はすべて IPアドレスベース（[slowapi](https://github.com/laurentS/slowapi) 使用）。  
全体デフォルト: **200回/分**。エンドポイントごとの個別制限は各セクションに記載。

---

## 目次

- [バス停検索](#バス停検索)
- [周辺バス停](#周辺バス停)
- [バス停詳細](#バス停詳細)
- [到着情報（単一バス停）](#到着情報単一バス停)
- [到着情報（複数バス停）](#到着情報複数バス停)
- [到着情報（ターミナル）](#到着情報ターミナル)
- [trip 経由バス停](#trip-経由バス停)
- [車両現在位置](#車両現在位置)
- [サービスアラート](#サービスアラート)
- [路線検索](#路線検索)
- [路線のバス停一覧](#路線のバス停一覧)
- [ルート形状座標](#ルート形状座標)
- [アプリ設定](#アプリ設定)

---

## バス停検索

```
GET /api/stops/search
```

バス停名・stop_id・stop_code でバス停を検索する。ターミナル（複数ホーム）は1件にまとめて返す。同名バス停は `is_name_grouped: true` でグループ化される。

**レート制限**: 60回/分

### クエリパラメータ

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `q` | string | ○ | 検索クエリ（1文字以上） |

### レスポンス

`Stop[]`（最大20件）

```json
[
  {
    "stop_id": "600029",
    "stop_name": "Queen St Stop 1",
    "stop_lat": -27.4679,
    "stop_lon": 153.0235,
    "is_terminal": false,
    "is_name_grouped": false,
    "stop_ids": [],
    "platforms": [],
    "routes": [
      {
        "route_id": "1234",
        "route_short_name": "66",
        "route_long_name": "City - Eight Mile Plains",
        "route_color": "#FF6600",
        "route_text_color": "#FFFFFF"
      }
    ]
  }
]
```

ターミナルの場合（`is_terminal: true`）:

```json
{
  "stop_id": "PARENT_ID",
  "stop_name": "Brisbane Transit Centre",
  "is_terminal": true,
  "platforms": [
    {
      "stop_id": "600030",
      "stop_name": "Brisbane Transit Centre, Platform 1",
      "stop_lat": -27.4678,
      "stop_lon": 153.0234,
      "platform_code": "1"
    }
  ],
  "routes": [...]
}
```

---

## 周辺バス停

```
GET /api/stops/nearby
```

GPS座標から指定半径内のバス停を近い順に返す。

**レート制限**: 20回/分

### クエリパラメータ

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `lat` | float | ○ | - | 緯度 |
| `lon` | float | ○ | - | 経度 |
| `radius` | int | - | `500` | 検索半径（メートル） |
| `limit` | int | - | `10` | 最大件数 |

### レスポンス

`Stop[]`（距離順）。各オブジェクトに `distance_m`（整数、メートル）が追加される。

```json
[
  {
    "stop_id": "600029",
    "stop_name": "Queen St Stop 1",
    "stop_lat": -27.4679,
    "stop_lon": 153.0235,
    "is_terminal": false,
    "is_name_grouped": false,
    "stop_ids": [],
    "platforms": [],
    "routes": [...],
    "distance_m": 120
  }
]
```

---

## バス停詳細

```
GET /api/stops/{stop_id}
```

バス停の基本情報と通過路線を返す。

**レート制限**: 60回/分

### パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| `stop_id` | string | バス停ID |

### レスポンス

```json
{
  "stop_id": "600029",
  "stop_name": "Queen St Stop 1",
  "stop_lat": -27.4679,
  "stop_lon": 153.0235,
  "routes": [...]
}
```

### エラー

| コード | 説明 |
|---|---|
| 404 | バス停が見つからない |
| 503 | GTFSデータ未ロード |

---

## 到着情報（単一バス停）

```
GET /api/stops/{stop_id}/arrivals
```

指定バス停の次のバス一覧を返す（最大15件）。GTFSリアルタイムが利用可能な場合はRT予測時刻、利用不可の場合は静的時刻でフォールバックする。

**レート制限**: 30回/分

### パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| `stop_id` | string | バス停ID |

### クエリパラメータ

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `demo` | bool | - | `false` | デモモード（静的時刻のみ使用） |

### レスポンス

```json
{
  "arrivals": [
    {
      "trip_id": "1234.T0.1-66-B-mjp-1.1.H",
      "stop_id": "600029",
      "platform_code": "",
      "route_short_name": "66",
      "route_long_name": "City - Eight Mile Plains",
      "headsign": "Eight Mile Plains",
      "arrival_time": 1712345678,
      "minutes_until": 5,
      "delay_seconds": 120,
      "shape_id": "1-66-B-mjp-1.1.H",
      "route_color": "#FF6600",
      "route_text_color": "#FFFFFF",
      "direction_id": "1",
      "day_offset": 0
    }
  ],
  "rt_available": true
}
```

#### フィールド説明

| フィールド | 型 | 説明 |
|---|---|---|
| `arrival_time` | int | Unix タイムスタンプ（秒） |
| `minutes_until` | int | 到着まであと何分（0以上） |
| `delay_seconds` | int | 遅延秒数（負=早着、0=定刻） |
| `day_offset` | int | `1` なら翌日便（静的フォールバック時のみ） |
| `rt_available` | bool | リアルタイムフィードの取得成否 |

---

## 到着情報（複数バス停）

```
GET /api/stops/multi/arrivals
```

複数の stop_id（同名バス停グループなど）の到着情報をまとめて返す（最大20件）。

**レート制限**: 30回/分

### クエリパラメータ

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `ids` | string | ○ | - | カンマ区切りの stop_id リスト（例: `600029,600030`） |
| `demo` | bool | - | `false` | デモモード |

### レスポンス

```json
{
  "arrivals": [...],
  "stop_directions": {
    "600029": "0",
    "600030": "1"
  },
  "rt_available": true
}
```

`stop_directions` は各 stop_id の主方向（`direction_id`）を示すマップ。

---

## 到着情報（ターミナル）

```
GET /api/terminal/{parent_id}/arrivals
```

ターミナル（複数ホームをもつ親バス停）の全ホームの到着情報をまとめて返す（最大20件）。各到着に `platform_code` が付与される。

**レート制限**: 30回/分

### パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| `parent_id` | string | ターミナルの親 stop_id |

### クエリパラメータ

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `demo` | bool | - | `false` | デモモード |

### レスポンス

```json
{
  "arrivals": [
    {
      "trip_id": "...",
      "stop_id": "600030",
      "platform_code": "1",
      "route_short_name": "66",
      "headsign": "Eight Mile Plains",
      "arrival_time": 1712345678,
      "minutes_until": 3,
      "delay_seconds": 0,
      "shape_id": "...",
      "route_color": "#FF6600",
      "route_text_color": "#FFFFFF",
      "direction_id": "1"
    }
  ],
  "rt_available": true
}
```

---

## trip 経由バス停

```
GET /api/trips/{trip_id}/stops
```

指定 trip が通過する全バス停を順番に返す。静的時刻・リアルタイム予測時刻・通過済みフラグが付与される。

**レート制限**: 30回/分  
**注意**: `trip_id` にスラッシュを含む場合があるため、パスパラメータは `:path` で受け取る。

### パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| `trip_id` | string（パス） | trip ID（スラッシュ含む場合あり） |

### レスポンス

```json
{
  "trip_id": "1234.T0.1-66-B-mjp-1.1.H",
  "stops": [
    {
      "stop_id": "600001",
      "stop_name": "City Hall",
      "stop_lat": -27.468,
      "stop_lon": 153.023,
      "static_time": "08:30:00",
      "predicted_unix": 1712345100,
      "passed": false
    }
  ]
}
```

#### フィールド説明

| フィールド | 型 | 説明 |
|---|---|---|
| `static_time` | string | GTFSの静的時刻文字列（例: `25:30:00` は翌1:30） |
| `predicted_unix` | int \| null | リアルタイム予測の Unix タイムスタンプ。RTなしの場合は `null` |
| `passed` | bool | 通過済みかどうか |

---

## 車両現在位置

```
GET /api/trips/{trip_id}/vehicle
```

指定 trip のバス車両の現在位置を VehiclePositions フィードから返す。

**レート制限**: 60回/分

### パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| `trip_id` | string（パス） | trip ID |

### レスポンス

車両が見つかった場合:

```json
{
  "lat": -27.4701,
  "lon": 153.0258,
  "bearing": 270.0,
  "speed": 8.3,
  "timestamp": 1712345600,
  "current_stop_id": "600029",
  "current_status": 2
}
```

`current_status` は GTFS-RT の `VehicleStopStatus` 列挙値（`0`=INCOMING_AT, `1`=STOPPED_AT, `2`=IN_TRANSIT_TO）。

車両が見つからない場合: `null` を返す。

### エラー

| コード | 説明 |
|---|---|
| 502 | Translink VehiclePositions フィード取得失敗 |

---

## サービスアラート

```
GET /api/alerts
```

アクティブなサービスアラートを返す。SEQ combined フィードと SEQ Alerts フィードをマージして重複排除する。現在時刻がアクティブ期間外のアラートは除外される。

**レート制限**: 20回/分

### レスポンス

`Alert[]`

```json
[
  {
    "id": "alert_123",
    "header": "Route 66 disruption",
    "description": "Buses will not service Queen St Stop 1 due to road works.",
    "cause": "CONSTRUCTION",
    "effect": "DETOUR",
    "route_short_names": ["66", "67"],
    "stop_ids": ["600029"]
  }
]
```

#### フィールド説明

| フィールド | 型 | 説明 |
|---|---|---|
| `cause` | string | アラートの原因（GTFS-RT Cause 列挙名） |
| `effect` | string | 影響の種類（GTFS-RT Effect 列挙名） |
| `route_short_names` | string[] | 影響を受ける路線の短縮名 |
| `stop_ids` | string[] | 影響を受けるバス停ID |

### エラー

| コード | 説明 |
|---|---|
| 502 | 両アラートフィードの取得失敗 |

---

## 路線検索

```
GET /api/routes/search
```

路線番号（route_short_name）または路線名（route_long_name）で路線を検索する。

**レート制限**: 60回/分

### クエリパラメータ

| パラメータ | 型 | 必須 | 説明 |
|---|---|---|---|
| `q` | string | ○ | 検索クエリ（1文字以上） |

### レスポンス

`Route[]`（最大30件）

```json
[
  {
    "route_id": "1-66-B-mjp-1",
    "route_short_name": "66",
    "route_long_name": "City - Eight Mile Plains",
    "route_color": "#FF6600",
    "route_text_color": "#FFFFFF"
  }
]
```

---

## 路線のバス停一覧

```
GET /api/routes/{route_id}/stops
```

指定路線の代表便が通過するバス停の一覧を方向別に返す。最も停車数の多い trip を代表便として選択する。

**レート制限**: 30回/分

### パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| `route_id` | string | 路線ID |

### クエリパラメータ

| パラメータ | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `direction` | int | - | `0` | 方向（`0` または `1`） |

### レスポンス

```json
{
  "headsign": "Eight Mile Plains",
  "direction_headsigns": {
    "0": "City",
    "1": "Eight Mile Plains"
  },
  "stops": [
    {
      "stop_id": "600001",
      "stop_name": "City Hall",
      "stop_lat": -27.468,
      "stop_lon": 153.023,
      "routes": [...]
    }
  ]
}
```

### エラー

| コード | 説明 |
|---|---|
| 404 | 路線が見つからない / バス停なし |
| 503 | GTFSデータ未ロード |

---

## ルート形状座標

```
GET /api/shapes/{shape_id}
```

ルートの地図描画用の座標列を返す。

**レート制限**: 30回/分  
**注意**: `shape_id` にスラッシュを含む場合があるため、パスパラメータは `:path` で受け取る。

### パスパラメータ

| パラメータ | 型 | 説明 |
|---|---|---|
| `shape_id` | string（パス） | shape ID（スラッシュ含む場合あり） |

### レスポンス

```json
{
  "shape_id": "1-66-B-mjp-1.1.H",
  "coords": [
    [-27.468, 153.023],
    [-27.470, 153.025]
  ]
}
```

`coords` は `[緯度, 経度]` の配列（shape_pt_sequence 順）。

### エラー

| コード | 説明 |
|---|---|
| 404 | shape が見つからない |

---

## アプリ設定

```
GET /api/config
```

フロントエンド向けのアプリ設定を返す。

**レート制限**: なし

### レスポンス

```json
{
  "demo_enabled": false
}
```

`demo_enabled` は環境変数 `DEMO_MODE_ENABLED` が `1` / `true` / `yes` のとき `true`。

---

## 共通エラーレスポンス

| コード | 説明 |
|---|---|
| 400 | リクエスト不正（パラメータ不足など） |
| 404 | リソースが見つからない |
| 429 | レート制限超過 |
| 503 | GTFSデータ未ロード（起動中またはDL中） |
