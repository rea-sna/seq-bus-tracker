# SEQ Bus Tracker

南東クイーンズランド（SEQ）のリアルタイムバス到着情報Webアプリです。TranslinkのGTFS・GTFS-RTフィードを使用しています。

[English version available here →](README.en.md)

---

## 機能

- リアルタイム到着情報（遅延・早着バッジ付き）
- バス停名検索・GPS周辺バス停検索
- 路線図のインタラクティブ表示（ネオントレースアニメーション）
- 停車駅タイムライン（通過済み・これから）
- ターミナル対応（複数ホームをまとめて表示）
- お気に入り登録
- 30秒ごとの自動更新
- リアルタイムデータがない場合の静的時刻フォールバック（翌日便対応）
- モバイル対応・ダークテーマ

---

## 技術スタック

| レイヤー | 技術 |
|---|---|
| バックエンド | Python / FastAPI |
| フロントエンド | Vanilla JS / Leaflet.js |
| データ | Translink GTFS Static + GTFS-RT |
| デプロイ | Heroku / Render |

---

## データソース

### GTFS Static（静的時刻表）

| 項目 | 内容 |
|---|---|
| 提供元 | Translink（クイーンズランド州交通・道路局） |
| ライセンス | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja) |
| ダウンロードURL | `https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip` |
| カバー範囲 | 南東クイーンズランド（SEQ）バス網 |
| サイズ | 約225 MB（ZIP） |
| 使用ファイル | `stops.txt` / `routes.txt` / `trips.txt` / `stop_times.txt` / `shapes.txt` / `calendar.txt` / `calendar_dates.txt` |
| 更新タイミング | Translinkが随時更新。初回起動時に自動ダウンロード |

### GTFS Realtime（リアルタイムフィード）

| 項目 | 内容 |
|---|---|
| 提供元 | Translink Open Data |
| ライセンス | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja) |
| フォーマット | Protocol Buffers（GTFS-RT仕様） |
| 認証 | 不要 |
| Trip Updates | `https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Bus` |
| Vehicle Positions | `https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus` |
| 更新頻度 | 約30〜60秒ごと |

### 地図タイル

| 項目 | 内容 |
|---|---|
| 提供元 | [CARTO](https://carto.com/)（CartoDB経由） |
| 帰属 | © [OpenStreetMap](https://www.openstreetmap.org/) contributors, © CARTO |
| ライセンス | [ODbL（OpenStreetMapデータ）](https://opendatacommons.org/licenses/odbl/) |

---

## セットアップ

### 必要環境

- Python 3.9 以上

### インストール

```bash
pip install -r requirements.txt
```

### 起動

```bash
uvicorn main:app --reload --port 8000 --host 0.0.0.0
```

初回起動時、GTFSスタティックデータ（約225 MB）が自動的にダウンロード・展開されます。回線速度によっては5〜10分かかります。

起動後、ブラウザで `http://localhost:8000` を開いてください。

> **注意**: GPS位置情報の取得にはHTTPS接続が必要です（iPhoneのSafari等）。ローカル環境でテストする場合は [ngrok](https://ngrok.com/) などのHTTPSトンネルをご利用ください。

---

## APIエンドポイント

| メソッド | パス | 説明 | レート制限 |
|---|---|---|---|
| GET | `/api/stops/search?q=` | バス停名で検索 | 60回/分 |
| GET | `/api/stops/nearby?lat=&lon=&radius=&limit=` | GPS座標から近いバス停を取得 | 20回/分 |
| GET | `/api/stops/{stop_id}/arrivals` | バス停のリアルタイム到着情報（次の15本） | 30回/分 |
| GET | `/api/stops/{stop_id}` | バス停の詳細情報 | 60回/分 |
| GET | `/api/terminal/{parent_id}/arrivals` | ターミナルの全ホーム到着情報 | 30回/分 |
| GET | `/api/shapes/{shape_id:path}` | ルート形状座標 | 30回/分 |
| GET | `/api/trips/{trip_id:path}/stops` | trip経由バス停一覧（予測時刻・通過済みフラグ付き） | 30回/分 |

レート制限はIPアドレスベース（[slowapi](https://github.com/laurentS/slowapi) 使用）。全体デフォルト: 200回/分。

---

## デプロイ

### Heroku

```bash
heroku create your-app-name
git push heroku main
```

`Procfile` が同梱されています。GTFSデータは起動時に自動ダウンロードされます。

### Render

| 設定 | 値 |
|---|---|
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |

> **注意**: Renderの無料プランはアイドル後にスリープし、復帰時にGTFS（約225 MB）を再ダウンロードします。安定運用には有料プランを推奨します。

---

## ディレクトリ構成

```
├── main.py              # FastAPI バックエンド（全APIエンドポイント）
├── requirements.txt     # Python依存パッケージ
├── Procfile             # Heroku起動コマンド
├── gtfs/                # GTFSスタティックデータ（自動DL・git管理外）
└── static/
    ├── index.html
    ├── style.css
    └── app.js
```

---

## ライセンス

コード: [MIT](https://opensource.org/licenses/MIT)

データ: Translink Open Data、[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.ja) ライセンスの下で提供。
帰属表示: © State of Queensland (Translink), 2024

---

## 開発について

このアプリは [Claude Sonnet 4.6](https://www.anthropic.com/claude) (Anthropic) との対話を通じて開発されました。
