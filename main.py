"""
Translink Bus Arrival API - FastAPI Backend
-------------------------------------------
Setup:
    pip install fastapi uvicorn requests gtfs-realtime-bindings pandas slowapi

GTFS Static files required in ./gtfs/ directory:
    stops.txt, routes.txt, trips.txt
    Download from: https://www.data.qld.gov.au/dataset/general-transit-feed-specification-gtfs-translink

Run:
    uvicorn main:app --reload --port 8000
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from google.transit import gtfs_realtime_pb2
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
import pandas as pd
import numpy as np
import requests
import sqlite3
import threading
import time
import os
import gc

limiter = Limiter(key_func=get_remote_address, default_limits=["200/minute"])
app = FastAPI(title="Translink Bus API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

# ── GTFS Static data ──────────────────────────────────────────────────────────
GTFS_DIR = os.path.join(os.path.dirname(__file__), "gtfs")
DB_PATH  = os.path.join(GTFS_DIR, "gtfs.db")
GTFS_URL = "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip"


def download_gtfs_if_needed():
    """gtfs/stops.txt がなければTranslinkからダウンロードして展開する"""
    if os.path.exists(os.path.join(GTFS_DIR, "stops.txt")):
        return
    # 再ダウンロード時はDBも削除して再構築
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    import zipfile
    os.makedirs(GTFS_DIR, exist_ok=True)
    zip_path = os.path.join(GTFS_DIR, "gtfs.zip")
    print("Downloading GTFS from Translink...")
    try:
        response = requests.get(GTFS_URL, stream=True, timeout=300)
        response.raise_for_status()
        with open(zip_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                f.write(chunk)
        print("Extracting GTFS...")
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(GTFS_DIR)
        os.remove(zip_path)
        print("GTFS ready")
    except Exception as e:
        if os.path.exists(zip_path):
            os.remove(zip_path)
        raise RuntimeError(f"Failed to download GTFS: {e}") from e


download_gtfs_if_needed()


# ── Thread-local SQLite connection ────────────────────────────────────────────
_db_local = threading.local()
_db_generation = 0  # GTFSリロード時にインクリメント → スレッドローカル接続を自動再接続させる


def get_db() -> sqlite3.Connection:
    """スレッドローカルなSQLite接続を返す（世代が変わると自動再接続）"""
    if (not hasattr(_db_local, "conn") or _db_local.conn is None
            or getattr(_db_local, "generation", -1) != _db_generation):
        if hasattr(_db_local, "conn") and _db_local.conn is not None:
            try:
                _db_local.conn.close()
            except Exception:
                pass
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        _db_local.conn = conn
        _db_local.generation = _db_generation
    return _db_local.conn


def _arrival_secs(time_str: str):
    """'HH:MM:SS' を深夜0時からの秒数に変換（25時間表記対応）"""
    try:
        p = time_str.split(":")
        return int(p[0]) * 3600 + int(p[1]) * 60 + int(p[2])
    except Exception:
        return None


def build_gtfs_db():
    """GTFS CSVファイルからSQLite DBを構築する（DB未存在時のみ実行）"""
    if os.path.exists(DB_PATH):
        return
    print("Building GTFS SQLite database...")
    conn = sqlite3.connect(DB_PATH)
    try:
        # stops
        stops = pd.read_csv(f"{GTFS_DIR}/stops.txt", dtype=str).fillna("")
        stops.to_sql("stops", conn, if_exists="replace", index=False)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_stops_parent ON stops(parent_station)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_stops_name ON stops(stop_name)")

        # routes (バスのみ)
        routes = pd.read_csv(f"{GTFS_DIR}/routes.txt", dtype=str).fillna("")
        bus_routes = routes[routes["route_type"] == "3"].copy()
        bus_routes.to_sql("routes", conn, if_exists="replace", index=False)

        # trips (バスのみ)
        trips = pd.read_csv(
            f"{GTFS_DIR}/trips.txt", dtype=str,
            usecols=lambda c: c in ["route_id", "service_id", "trip_id",
                                    "trip_headsign", "shape_id", "direction_id"]
        ).fillna("")
        bus_route_ids_set = set(bus_routes["route_id"])
        bus_trips = trips[trips["route_id"].isin(bus_route_ids_set)].copy()
        bus_trip_ids_set = set(bus_trips["trip_id"])
        bus_trips.to_sql("trips", conn, if_exists="replace", index=False)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trips_route   ON trips(route_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_trips_service ON trips(service_id)")

        # stop_times (バスのみ・チャンク処理・arrival_secs 追加)
        print("  Importing stop_times (large file)...")
        conn.execute("""CREATE TABLE stop_times (
            trip_id TEXT, stop_id TEXT, stop_sequence INTEGER,
            arrival_time TEXT, arrival_secs INTEGER
        )""")
        total_st = 0
        for chunk in pd.read_csv(
            f"{GTFS_DIR}/stop_times.txt",
            dtype={"trip_id": str, "stop_id": str, "arrival_time": str, "stop_sequence": int},
            usecols=["trip_id", "stop_id", "stop_sequence", "arrival_time"],
            chunksize=200_000,
        ):
            chunk = chunk[chunk["trip_id"].isin(bus_trip_ids_set)].copy()
            chunk["arrival_secs"] = chunk["arrival_time"].apply(_arrival_secs)
            chunk = chunk.dropna(subset=["arrival_secs"])
            chunk["arrival_secs"] = chunk["arrival_secs"].astype(int)
            chunk.to_sql("stop_times", conn, if_exists="append", index=False)
            total_st += len(chunk)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_st_stop ON stop_times(stop_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_st_trip ON stop_times(trip_id)")
        print(f"  {total_st} stop_times rows imported")

        # shapes
        shapes_path = f"{GTFS_DIR}/shapes.txt"
        if os.path.exists(shapes_path):
            print("  Importing shapes...")
            pd.read_csv(
                shapes_path,
                dtype={"shape_id": str, "shape_pt_sequence": int},
                usecols=["shape_id", "shape_pt_sequence", "shape_pt_lat", "shape_pt_lon"],
            ).to_sql("shapes", conn, if_exists="replace", index=False)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_shapes ON shapes(shape_id, shape_pt_sequence)")

        # calendar
        cal_path = f"{GTFS_DIR}/calendar.txt"
        if os.path.exists(cal_path):
            pd.read_csv(cal_path, dtype=str).fillna("").to_sql(
                "calendar", conn, if_exists="replace", index=False
            )

        # calendar_dates
        cal_dates_path = f"{GTFS_DIR}/calendar_dates.txt"
        if os.path.exists(cal_dates_path):
            pd.read_csv(cal_dates_path, dtype=str).fillna("").to_sql(
                "calendar_dates", conn, if_exists="replace", index=False
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_caldates ON calendar_dates(date, exception_type)")

        # last_stops テーブル（trip_id → 最終 stop_id）
        print("  Computing last stops...")
        conn.execute("""
            CREATE TABLE last_stops AS
            SELECT st.trip_id, st.stop_id AS last_stop_id
            FROM stop_times st
            INNER JOIN (
                SELECT trip_id, MAX(stop_sequence) AS max_seq
                FROM stop_times GROUP BY trip_id
            ) mx ON st.trip_id = mx.trip_id AND st.stop_sequence = mx.max_seq
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_last_stops ON last_stops(trip_id)")

        # stop_routes テーブル（stop_id → ユニーク路線リスト）
        print("  Computing stop routes...")
        conn.execute("""
            CREATE TABLE stop_routes AS
            SELECT DISTINCT st.stop_id, r.route_short_name, r.route_color, r.route_text_color
            FROM stop_times st
            JOIN trips t ON st.trip_id = t.trip_id
            JOIN routes r ON t.route_id = r.route_id
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_stop_routes ON stop_routes(stop_id)")

        conn.commit()
        print("GTFS DB built.")

        # 大容量CSVを削除してディスクを節約（DBに取り込み済み）
        for fname in ["stop_times.txt", "shapes.txt"]:
            p = os.path.join(GTFS_DIR, fname)
            if os.path.exists(p):
                os.remove(p)
                print(f"  Deleted {fname} (imported to DB)")

    except Exception as e:
        conn.close()
        if os.path.exists(DB_PATH):
            os.remove(DB_PATH)
        raise RuntimeError(f"Failed to build GTFS DB: {e}") from e

    conn.close()


build_gtfs_db()

# ── 近傍バス停検索用 numpy 配列（起動時に初期化） ────────────────────────────
_stops_lat_arr: np.ndarray = np.array([], dtype=np.float32)
_stops_lon_arr: np.ndarray = np.array([], dtype=np.float32)

# グローバル変数の初期化（_load_gtfs_to_memory で上書きされる）
stops_df = bus_routes_df = None
trips_dict: dict = {}
stop_routes_dict: dict = {}
last_stop_by_trip: dict = {}


def _load_gtfs_to_memory():
    """DBからグローバル変数へGTFSデータをロードする（起動時・週次更新時に呼び出す）"""
    global stops_df, bus_routes_df, trips_dict, last_stop_by_trip, stop_routes_dict
    global _stops_lat_arr, _stops_lon_arr, _db_generation

    boot = sqlite3.connect(DB_PATH)
    boot.row_factory = sqlite3.Row
    try:
        # stops（小さいので全件メモリに保持）
        new_stops_df = pd.read_sql("SELECT * FROM stops", boot)
        new_stops_df["stop_lat"] = pd.to_numeric(new_stops_df["stop_lat"], errors="coerce").astype("float32").fillna(0.0)
        new_stops_df["stop_lon"] = pd.to_numeric(new_stops_df["stop_lon"], errors="coerce").astype("float32").fillna(0.0)
        for _col in ["location_type", "parent_station", "platform_code"]:
            if _col in new_stops_df.columns:
                new_stops_df[_col] = new_stops_df[_col].astype("category")

        # routes（小さいのでメモリに保持）
        new_bus_routes_df = pd.read_sql("SELECT * FROM routes", boot).set_index("route_id")

        # trips を辞書化（リアルタイム処理で O(1) アクセス）
        _trip_rows = boot.execute(
            "SELECT trip_id, route_id, trip_headsign, shape_id, direction_id FROM trips"
        ).fetchall()
        new_trips_dict = {
            r["trip_id"]: {
                "route_id":      r["route_id"]      or "",
                "trip_headsign": r["trip_headsign"]  or "",
                "shape_id":      r["shape_id"]       or "",
                "direction_id":  r["direction_id"]   or "",
            }
            for r in _trip_rows
        }
        del _trip_rows

        # last_stop_by_trip（終着駅フィルタ用）
        _ls_rows = boot.execute("SELECT trip_id, last_stop_id FROM last_stops").fetchall()
        new_last_stop_by_trip = {r["trip_id"]: r["last_stop_id"] for r in _ls_rows}
        del _ls_rows

        # stop_routes_dict（バス停カード表示用）
        _sr_rows = boot.execute(
            "SELECT stop_id, route_short_name, route_color, route_text_color FROM stop_routes"
        ).fetchall()
        _sr_tmp: dict = {}
        for r in _sr_rows:
            sid  = str(r["stop_id"])
            name = str(r["route_short_name"])
            if sid not in _sr_tmp:
                _sr_tmp[sid] = {}
            if name not in _sr_tmp[sid]:
                rc  = str(r["route_color"]      or "")
                rtc = str(r["route_text_color"] or "")
                _sr_tmp[sid][name] = {
                    "name":       name,
                    "color":      f"#{rc}"  if rc  else "",
                    "text_color": f"#{rtc}" if rtc else "",
                }
        new_stop_routes_dict = {
            sid: sorted(
                routes.values(),
                key=lambda r: (not r["name"].isdigit(),
                               r["name"].zfill(6) if r["name"].isdigit() else r["name"])
            )
            for sid, routes in _sr_tmp.items()
        }
        del _sr_tmp, _sr_rows

    finally:
        boot.close()

    # アトミックにグローバル変数を更新
    stops_df          = new_stops_df
    bus_routes_df     = new_bus_routes_df
    trips_dict        = new_trips_dict
    last_stop_by_trip = new_last_stop_by_trip
    stop_routes_dict  = new_stop_routes_dict
    _stops_lat_arr    = new_stops_df["stop_lat"].values
    _stops_lon_arr    = new_stops_df["stop_lon"].values
    _db_generation   += 1  # スレッドローカルのDB接続を次回アクセス時に再接続させる

    gc.collect()
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass

    print(f"✅ GTFS loaded — {len(stops_df)} stops, {len(bus_routes_df)} bus routes, {len(trips_dict)} trips")


try:
    _load_gtfs_to_memory()
except Exception as _e:
    print(f"⚠️  GTFS load failed: {_e}")


# ── GTFS週次自動更新 ──────────────────────────────────────────────────────────
_gtfs_update_lock = threading.Lock()


def _update_gtfs():
    """GTFSスタティックデータを再ダウンロードしてDBとメモリを更新する（週1回実行）"""
    if not _gtfs_update_lock.acquire(blocking=False):
        print("⚠️  GTFS update already in progress, skipping")
        return
    try:
        import zipfile
        print("🔄 GTFS weekly update started...")

        # 古いCSVを削除（DB再構築のため）
        for fname in ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt",
                      "shapes.txt", "calendar.txt", "calendar_dates.txt"]:
            p = os.path.join(GTFS_DIR, fname)
            if os.path.exists(p):
                os.remove(p)

        # ダウンロード
        zip_path = os.path.join(GTFS_DIR, "gtfs.zip")
        print("  Downloading GTFS...")
        response = requests.get(GTFS_URL, stream=True, timeout=300)
        response.raise_for_status()
        with open(zip_path, "wb") as f:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                f.write(chunk)
        print("  Extracting GTFS...")
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(GTFS_DIR)
        os.remove(zip_path)

        # 旧DBを削除して再構築
        if os.path.exists(DB_PATH):
            os.remove(DB_PATH)
        build_gtfs_db()

        # メモリ上のグローバル変数を再ロード
        _load_gtfs_to_memory()
        print("✅ GTFS weekly update completed")

    except Exception as e:
        print(f"❌ GTFS weekly update failed: {e}")
    finally:
        _gtfs_update_lock.release()


_scheduler = BackgroundScheduler(timezone="Australia/Brisbane")


@app.on_event("startup")
async def start_scheduler():
    _scheduler.add_job(
        _update_gtfs,
        CronTrigger(day_of_week="mon", hour=3, minute=0, timezone="Australia/Brisbane"),
        id="gtfs_weekly_update",
        replace_existing=True,
    )
    _scheduler.start()
    print("📅 GTFS weekly update scheduled — every Monday 03:00 Brisbane time")


@app.on_event("shutdown")
async def stop_scheduler():
    _scheduler.shutdown(wait=False)

# ── Timezone ──────────────────────────────────────────────────────────────────
# ブリスベンは UTC+10 固定（サマータイムなし）
import datetime as _dt
BRISBANE_TZ = _dt.timezone(_dt.timedelta(hours=10))

# ── Realtime endpoints ────────────────────────────────────────────────────────
TRIP_UPDATES_URL = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Bus"
SEQ_COMBINED_URL = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ"
SEQ_ALERTS_URL   = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/Alerts"
VEHICLE_POS_URL  = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus"

# ── GTFS-RT feed cache (30s TTL) ─────────────────────────────────────────────
_feed_cache: dict = {"data": None, "expires": 0.0}
_feed_lock = threading.Lock()


def get_feed() -> gtfs_realtime_pb2.FeedMessage:
    with _feed_lock:
        if time.time() < _feed_cache["expires"] and _feed_cache["data"] is not None:
            return _feed_cache["data"]
        resp = requests.get(TRIP_UPDATES_URL, timeout=10)
        resp.raise_for_status()
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(resp.content)
        _feed_cache["data"] = feed
        _feed_cache["expires"] = time.time() + 30
        return feed


# ── VehiclePositions feed cache (15s TTL) ────────────────────────────────────
_vehicle_cache: dict = {"data": None, "expires": 0.0}
_vehicle_lock = threading.Lock()


def get_vehicle_feed() -> gtfs_realtime_pb2.FeedMessage:
    with _vehicle_lock:
        if time.time() < _vehicle_cache["expires"] and _vehicle_cache["data"] is not None:
            return _vehicle_cache["data"]
        resp = requests.get(VEHICLE_POS_URL, timeout=10)
        resp.raise_for_status()
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(resp.content)
        _vehicle_cache["data"] = feed
        _vehicle_cache["expires"] = time.time() + 15
        return feed


# ── SEQ combined feed cache (60s TTL, for alerts) ────────────────────────────
_seq_cache: dict = {"data": None, "expires": 0.0}
_seq_lock = threading.Lock()
_alerts_cache: dict = {"data": None, "expires": 0.0}
_alerts_lock = threading.Lock()


def _fetch_feed(url: str) -> gtfs_realtime_pb2.FeedMessage:
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(resp.content)
    return feed


def get_seq_feed() -> gtfs_realtime_pb2.FeedMessage:
    with _seq_lock:
        if time.time() < _seq_cache["expires"] and _seq_cache["data"] is not None:
            return _seq_cache["data"]
        feed = _fetch_feed(SEQ_COMBINED_URL)
        _seq_cache["data"] = feed
        _seq_cache["expires"] = time.time() + 60
        return feed


def get_alerts_feed() -> gtfs_realtime_pb2.FeedMessage:
    with _alerts_lock:
        if time.time() < _alerts_cache["expires"] and _alerts_cache["data"] is not None:
            return _alerts_cache["data"]
        feed = _fetch_feed(SEQ_ALERTS_URL)
        _alerts_cache["data"] = feed
        _alerts_cache["expires"] = time.time() + 60
        return feed


CAUSE_NAMES = {
    1: "Unknown cause", 2: "Other cause", 3: "Technical problem", 4: "Strike",
    5: "Demonstration", 6: "Accident", 7: "Holiday", 8: "Weather",
    9: "Maintenance", 10: "Construction", 11: "Police activity", 12: "Medical emergency",
}
EFFECT_NAMES = {
    1: "No service", 2: "Reduced service", 3: "Significant delays",
    4: "Detour", 5: "Additional service", 6: "Modified service",
    7: "Other effect", 8: "Unknown effect", 9: "Stop moved", 10: "No effect",
}


def _get_translated_text(translated) -> str:
    if not translated.translation:
        return ""
    for t in translated.translation:
        if t.language in ("en", "en-AU", "en-au", ""):
            return t.text
    return translated.translation[0].text


def _merge_routes(stop_id_list: list) -> list:
    """複数 stop_id の路線情報を統合してソート済みリストで返す"""
    seen: dict = {}
    for sid in stop_id_list:
        for r in stop_routes_dict.get(str(sid), []):
            if r["name"] not in seen:
                seen[r["name"]] = r
    return sorted(seen.values(), key=lambda r: (not r["name"].isdigit(), r["name"].zfill(6) if r["name"].isdigit() else r["name"]))


# ── Demo mode helper ──────────────────────────────────────────────────────────
def _demo_now() -> float:
    """デモ用基準時刻: 今日のブリスベン時間 08:00"""
    import datetime
    today = datetime.datetime.now(BRISBANE_TZ).date()
    return datetime.datetime(today.year, today.month, today.day, 8, 0, 0,
                             tzinfo=BRISBANE_TZ).timestamp()


# ── Static timetable fallback helper ─────────────────────────────────────────
def get_static_arrivals(stop_id_list: list, now: float, day_offset: int = 0):
    """
    SQLiteから静的時刻を取得し、到着情報リストを返す。
    day_offset=0 → 今日、day_offset=1 → 明日
    """
    import datetime
    if not os.path.exists(DB_PATH):
        return []

    DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    target_date = datetime.datetime.now(BRISBANE_TZ).date() + datetime.timedelta(days=day_offset)
    target_str  = target_date.strftime("%Y%m%d")
    day_name    = DAY_NAMES[target_date.weekday()]
    base_ts     = datetime.datetime(target_date.year, target_date.month, target_date.day,
                                    tzinfo=BRISBANE_TZ).timestamp()

    conn = get_db()

    # 有効なservice_idを取得
    active_ids: set = set()
    try:
        for r in conn.execute(
            f"SELECT service_id FROM calendar WHERE start_date<=? AND end_date>=? AND {day_name}='1'",
            (target_str, target_str)
        ).fetchall():
            active_ids.add(r[0])
        for r in conn.execute(
            "SELECT service_id FROM calendar_dates WHERE date=? AND exception_type='1'",
            (target_str,)
        ).fetchall():
            active_ids.add(r[0])
        for r in conn.execute(
            "SELECT service_id FROM calendar_dates WHERE date=? AND exception_type='2'",
            (target_str,)
        ).fetchall():
            active_ids.discard(r[0])
    except Exception:
        pass  # calendar テーブルがない場合は全trip対象

    stop_ph = ",".join("?" * len(stop_id_list))

    if active_ids:
        svc_ph = ",".join("?" * len(active_ids))
        rows = conn.execute(f"""
            SELECT st.trip_id, st.stop_id, st.arrival_time, st.arrival_secs,
                   t.route_id, t.trip_headsign, t.shape_id, t.direction_id,
                   r.route_short_name, r.route_long_name, r.route_color, r.route_text_color
            FROM stop_times st
            JOIN trips t  ON st.trip_id  = t.trip_id
            JOIN routes r ON t.route_id  = r.route_id
            WHERE st.stop_id IN ({stop_ph})
              AND t.service_id IN ({svc_ph})
            ORDER BY st.arrival_secs
        """, [*stop_id_list, *active_ids]).fetchall()
    else:
        rows = conn.execute(f"""
            SELECT st.trip_id, st.stop_id, st.arrival_time, st.arrival_secs,
                   t.route_id, t.trip_headsign, t.shape_id, t.direction_id,
                   r.route_short_name, r.route_long_name, r.route_color, r.route_text_color
            FROM stop_times st
            JOIN trips t  ON st.trip_id = t.trip_id
            JOIN routes r ON t.route_id = r.route_id
            WHERE st.stop_id IN ({stop_ph})
            ORDER BY st.arrival_secs
        """, stop_id_list).fetchall()

    arrivals = []
    for row in rows:
        arr_ts  = base_ts + row["arrival_secs"]
        if arr_ts <= now:
            continue
        trip_id = row["trip_id"]
        stop_id = str(row["stop_id"])
        is_last_stop = last_stop_by_trip.get(trip_id) == stop_id
        rc  = str(row["route_color"]      or "")
        rtc = str(row["route_text_color"] or "")
        arrivals.append({
            "trip_id":          trip_id,
            "stop_id":          stop_id,
            "platform_code":    "",
            "route_short_name": str(row["route_short_name"] or "?"),
            "route_long_name":  str(row["route_long_name"]  or ""),
            "headsign":         str(row["trip_headsign"]    or ""),
            "arrival_time":     arr_ts,
            "minutes_until":    max(0, int((arr_ts - now) / 60)),
            "delay_seconds":    0,
            "shape_id":         str(row["shape_id"]         or ""),
            "route_color":      f"#{rc}"  if rc  else "",
            "route_text_color": f"#{rtc}" if rtc else "",
            "direction_id":     str(row["direction_id"]     or ""),
            "is_static":        True,
            "day_offset":       day_offset,
            "is_last_stop":     is_last_stop,
        })
        if len(arrivals) >= 15:
            break

    return arrivals


# ── API routes ────────────────────────────────────────────────────────────────

@app.get("/api/stops/search")
@limiter.limit("60/minute")
def search_stops(request: Request, q: str = ""):
    """
    バス停名で検索。parent_stationでグループ化し、
    ターミナルは1件にまとめて配下のホーム情報を含めて返す。
    """
    if stops_df is None:
        raise HTTPException(503, "GTFS data not loaded")
    if len(q) < 1:
        return []

    has_parent   = "parent_station" in stops_df.columns
    has_loc_type = "location_type"  in stops_df.columns
    has_platform = "platform_code"  in stops_df.columns
    has_stopcode = "stop_code"      in stops_df.columns

    mask = (
        stops_df["stop_name"].str.contains(q, case=False, na=False) |
        stops_df["stop_id"].astype(str).str.contains(q, case=False, na=False)
    )
    if has_stopcode:
        mask = mask | stops_df["stop_code"].astype(str).str.contains(q, case=False, na=False)
    matched = stops_df[mask].copy()

    results = []
    seen_parents = set()
    individual_by_name = {}  # stop_name -> list of rows

    for _, row in matched.iterrows():
        parent = row.get("parent_station", "") if has_parent else ""
        loc    = row.get("location_type",  "") if has_loc_type else ""

        if loc == "1":
            continue

        if parent:
            if parent in seen_parents:
                continue
            seen_parents.add(parent)

            siblings = stops_df[stops_df["parent_station"] == parent].copy()
            parent_row = stops_df[stops_df["stop_id"] == parent]
            if not parent_row.empty:
                station_name = parent_row.iloc[0]["stop_name"]
                station_lat  = float(parent_row.iloc[0]["stop_lat"])
                station_lon  = float(parent_row.iloc[0]["stop_lon"])
            else:
                station_name = row["stop_name"]
                station_lat  = float(row["stop_lat"])
                station_lon  = float(row["stop_lon"])

            platforms = []
            for _, sib in siblings.iterrows():
                if sib.get("location_type", "") == "1":
                    continue
                pf = sib.get("platform_code", "") if has_platform else ""
                sc = sib.get("stop_code",     "") if has_stopcode else ""
                platforms.append({
                    "stop_id":       sib["stop_id"],
                    "stop_name":     sib["stop_name"],
                    "stop_lat":      float(sib["stop_lat"]),
                    "stop_lon":      float(sib["stop_lon"]),
                    "platform_code": pf or sc,
                })

            results.append({
                "stop_id":         parent,
                "stop_name":       station_name,
                "stop_lat":        station_lat,
                "stop_lon":        station_lon,
                "is_terminal":     True,
                "is_name_grouped": False,
                "stop_ids":        [],
                "platforms":       platforms,
                "routes":          _merge_routes([sib["stop_id"] for _, sib in siblings.iterrows()]),
            })
        else:
            name = row["stop_name"]
            if name not in individual_by_name:
                individual_by_name[name] = []
            individual_by_name[name].append(row)

    for name, rows in individual_by_name.items():
        if len(rows) == 1:
            row = rows[0]
            results.append({
                "stop_id":         str(row["stop_id"]),
                "stop_name":       str(row["stop_name"]),
                "stop_lat":        float(row["stop_lat"]),
                "stop_lon":        float(row["stop_lon"]),
                "is_terminal":     False,
                "is_name_grouped": False,
                "stop_ids":        [],
                "platforms":       [],
                "routes":          _merge_routes([row["stop_id"]]),
            })
        else:
            lats = [float(r["stop_lat"]) for r in rows]
            lons = [float(r["stop_lon"]) for r in rows]
            results.append({
                "stop_id":         str(rows[0]["stop_id"]),
                "stop_name":       name,
                "stop_lat":        sum(lats) / len(lats),
                "stop_lon":        sum(lons) / len(lons),
                "is_terminal":     False,
                "is_name_grouped": True,
                "stop_ids":        [str(r["stop_id"]) for r in rows],
                "platforms":       [],
                "routes":          _merge_routes([r["stop_id"] for r in rows]),
            })

    return [r for r in results if r.get("routes")][:20]


@app.get("/api/stops/nearby")
@limiter.limit("20/minute")
def get_nearby_stops(request: Request, lat: float, lon: float, radius: int = 500, limit: int = 10):
    """現在地から半径radius(m)以内のバス停を近い順に返す"""
    if stops_df is None:
        raise HTTPException(503, "GTFS data not loaded")

    p = np.pi / 180.0
    R = 6371000.0
    dlat = (_stops_lat_arr - lat) * p
    dlon = (_stops_lon_arr - lon) * p
    a = (np.sin(dlat / 2.0) ** 2
         + np.cos(lat * p) * np.cos(_stops_lat_arr * p) * np.sin(dlon / 2.0) ** 2)
    all_dists = 2.0 * R * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))

    sid_to_dist = dict(zip(stops_df["stop_id"].values, all_dists))

    has_parent   = "parent_station" in stops_df.columns
    has_loc_type = "location_type"  in stops_df.columns
    has_platform = "platform_code"  in stops_df.columns
    has_stopcode = "stop_code"      in stops_df.columns

    if has_loc_type:
        not_parent_mask = (stops_df["location_type"] != "1").values
    else:
        not_parent_mask = np.ones(len(stops_df), dtype=bool)
    within_radius_mask = all_dists <= radius
    candidate_df = stops_df[not_parent_mask & within_radius_mask]

    results = []
    seen_parents = set()
    individual_by_name = {}

    for _, row in candidate_df.iterrows():
        parent = row.get("parent_station", "") if has_parent else ""
        if parent:
            if parent in seen_parents:
                continue
            seen_parents.add(parent)
            parent_row = stops_df[stops_df["stop_id"] == parent]
            if not parent_row.empty:
                station_name = str(parent_row.iloc[0]["stop_name"])
                station_lat  = float(parent_row.iloc[0]["stop_lat"])
                station_lon  = float(parent_row.iloc[0]["stop_lon"])
            else:
                station_name = str(row["stop_name"])
                station_lat  = float(row["stop_lat"])
                station_lon  = float(row["stop_lon"])
            dist = float(sid_to_dist.get(str(parent),
                         sid_to_dist.get(str(row["stop_id"]), 0.0)))

            siblings = stops_df[stops_df["parent_station"] == parent]
            platforms = []
            for _, sib in siblings.iterrows():
                if str(sib.get("location_type", "")) == "1":
                    continue
                pf = sib.get("platform_code", "") if has_platform else ""
                sc = sib.get("stop_code",     "") if has_stopcode else ""
                platforms.append({
                    "stop_id":       str(sib["stop_id"]),
                    "stop_name":     str(sib["stop_name"]),
                    "stop_lat":      float(sib["stop_lat"]),
                    "stop_lon":      float(sib["stop_lon"]),
                    "platform_code": str(pf or sc),
                })
            results.append({
                "stop_id":         str(parent),
                "stop_name":       station_name,
                "stop_lat":        station_lat,
                "stop_lon":        station_lon,
                "is_terminal":     True,
                "is_name_grouped": False,
                "stop_ids":        [],
                "platforms":       platforms,
                "routes":          _merge_routes([str(sib["stop_id"]) for _, sib in siblings.iterrows()]),
                "distance_m":      round(dist),
            })
        else:
            name = str(row["stop_name"])
            dist = float(sid_to_dist.get(str(row["stop_id"]), 0.0))
            if name not in individual_by_name:
                individual_by_name[name] = []
            individual_by_name[name].append((row, dist))

    for name, rows_dists in individual_by_name.items():
        if len(rows_dists) == 1:
            row, dist = rows_dists[0]
            results.append({
                "stop_id":         str(row["stop_id"]),
                "stop_name":       str(row["stop_name"]),
                "stop_lat":        float(row["stop_lat"]),
                "stop_lon":        float(row["stop_lon"]),
                "is_terminal":     False,
                "is_name_grouped": False,
                "stop_ids":        [],
                "platforms":       [],
                "routes":          _merge_routes([row["stop_id"]]),
                "distance_m":      round(dist),
            })
        else:
            min_dist = min(d for _, d in rows_dists)
            lats = [float(r["stop_lat"]) for r, _ in rows_dists]
            lons = [float(r["stop_lon"]) for r, _ in rows_dists]
            results.append({
                "stop_id":         str(rows_dists[0][0]["stop_id"]),
                "stop_name":       name,
                "stop_lat":        sum(lats) / len(lats),
                "stop_lon":        sum(lons) / len(lons),
                "is_terminal":     False,
                "is_name_grouped": True,
                "stop_ids":        [str(r["stop_id"]) for r, _ in rows_dists],
                "platforms":       [],
                "routes":          _merge_routes([r["stop_id"] for r, _ in rows_dists]),
                "distance_m":      round(min_dist),
            })

    results.sort(key=lambda x: x["distance_m"])
    return [r for r in results if r.get("routes")][:limit]


@app.get("/api/terminal/{parent_id}/arrivals")
@limiter.limit("30/minute")
def get_terminal_arrivals(request: Request, parent_id: str, demo: bool = False):
    """ターミナルの全ホームをまとめて取得し、platform_codeを付与して返す"""
    if stops_df is None or not trips_dict:
        raise HTTPException(503, "GTFS data not loaded")

    has_parent   = "parent_station" in stops_df.columns
    has_platform = "platform_code"  in stops_df.columns
    has_stopcode = "stop_code"      in stops_df.columns

    if has_parent:
        children = stops_df[stops_df["parent_station"] == parent_id]
    else:
        children = stops_df[stops_df["stop_id"] == parent_id]

    platform_map = {}
    for _, r in children.iterrows():
        pf = r.get("platform_code", "") if has_platform else ""
        sc = r.get("stop_code",     "") if has_stopcode else ""
        platform_map[r["stop_id"]] = pf or sc or r["stop_name"]

    child_ids = set(platform_map.keys())
    if not child_ids:
        raise HTTPException(404, "Terminal not found")

    now = _demo_now() if demo else time.time()
    arrivals = []

    if demo:
        for day_offset in [0, 1]:
            static = get_static_arrivals(list(child_ids), now, day_offset)
            for a in static:
                a["platform_code"] = platform_map.get(a["stop_id"], "")
                a["is_demo"] = True
            if static:
                arrivals = static
                break
        return {"arrivals": arrivals[:20], "rt_available": True}

    rt_available = True
    try:
        feed = get_feed()
    except requests.RequestException:
        rt_available = False
        for day_offset in [0, 1]:
            static = get_static_arrivals(list(child_ids), now, day_offset)
            for a in static:
                a["platform_code"] = platform_map.get(a["stop_id"], "")
                arrivals.append(a)
            if static:
                break
        arrivals.sort(key=lambda x: x["arrival_time"])
        return {"arrivals": arrivals[:20], "rt_available": False}

    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        for stu in entity.trip_update.stop_time_update:
            if str(stu.stop_id) not in child_ids:
                continue
            delay = 0
            if stu.HasField("arrival") and stu.arrival.time:
                arrival_time = stu.arrival.time
                delay = stu.arrival.delay if stu.arrival.HasField("delay") else 0
            elif stu.HasField("departure") and stu.departure.time:
                arrival_time = stu.departure.time
                delay = stu.departure.delay if stu.departure.HasField("delay") else 0
            else:
                continue
            if arrival_time < now - 90:
                continue

            trip_id = entity.trip_update.trip.trip_id
            if trip_id not in trips_dict:
                continue
            is_last_stop = last_stop_by_trip.get(trip_id) == str(stu.stop_id)
            trip = trips_dict[trip_id]

            route_id = trip["route_id"]
            headsign = trip["trip_headsign"]
            if bus_routes_df is not None and route_id in bus_routes_df.index:
                route_row        = bus_routes_df.loc[route_id]
                route_short      = route_row["route_short_name"]
                route_long       = route_row["route_long_name"]
                route_color      = route_row.get("route_color",      "") or ""
                route_text_color = route_row.get("route_text_color", "") or ""
            else:
                route_short, route_long, route_color, route_text_color = "?", "", "", ""

            arrivals.append({
                "trip_id":          trip_id,
                "vehicle_id":       entity.trip_update.vehicle.id or "",
                "stop_id":          str(stu.stop_id),
                "platform_code":    platform_map.get(str(stu.stop_id), ""),
                "route_short_name": route_short,
                "route_long_name":  route_long,
                "headsign":         headsign,
                "arrival_time":     arrival_time,
                "minutes_until":    max(0, int((arrival_time - now) / 60)),
                "delay_seconds":    delay,
                "shape_id":         trip["shape_id"],
                "route_color":      f"#{route_color}"      if route_color      else "",
                "route_text_color": f"#{route_text_color}" if route_text_color else "",
                "direction_id":     trip["direction_id"],
                "is_last_stop":     is_last_stop,
            })

    arrivals.sort(key=lambda x: x["arrival_time"])

    # RT便が20件未満なら静的データで補完
    if len(arrivals) < 20:
        rt_trip_ids = {a["trip_id"] for a in arrivals}
        for day_offset in [0, 1]:
            static = get_static_arrivals(list(child_ids), now, day_offset)
            for a in static:
                if a["trip_id"] not in rt_trip_ids:
                    a["platform_code"] = platform_map.get(a["stop_id"], "")
                    arrivals.append(a)
            if static:
                break
        arrivals.sort(key=lambda x: x["arrival_time"])

    return {"arrivals": arrivals[:20], "rt_available": rt_available}


@app.get("/api/stops/multi/arrivals")
@limiter.limit("30/minute")
def get_multi_stop_arrivals(request: Request, ids: str, demo: bool = False):
    """同名バス停グループの全stop_idの到着情報を返す"""
    if stops_df is None or not trips_dict:
        raise HTTPException(503, "GTFS data not loaded")

    stop_id_list = [s.strip() for s in ids.split(",") if s.strip()]
    if not stop_id_list:
        raise HTTPException(400, "No stop IDs provided")

    now = _demo_now() if demo else time.time()
    arrivals = []
    child_ids = set(stop_id_list)

    if demo:
        for day_offset in [0, 1]:
            arrivals = get_static_arrivals(stop_id_list, now, day_offset)
            if arrivals:
                for a in arrivals:
                    a["is_demo"] = True
                break
        stop_directions: dict = {}
        if trips_dict and os.path.exists(DB_PATH):
            conn = get_db()
            for sid in stop_id_list:
                try:
                    row = conn.execute("""
                        SELECT t.direction_id, COUNT(*) AS cnt
                        FROM stop_times st
                        JOIN trips t ON st.trip_id = t.trip_id
                        WHERE st.stop_id=?
                        GROUP BY t.direction_id ORDER BY cnt DESC LIMIT 1
                    """, (sid,)).fetchone()
                    if row:
                        stop_directions[sid] = str(row["direction_id"] or "")
                except Exception:
                    pass
        return {"arrivals": arrivals[:20], "stop_directions": stop_directions, "rt_available": True}

    rt_available = True
    try:
        feed = get_feed()
    except requests.RequestException:
        rt_available = False
        for day_offset in [0, 1]:
            static = get_static_arrivals(stop_id_list, now, day_offset)
            if static:
                arrivals = static
                break
        arrivals.sort(key=lambda x: x["arrival_time"])
        return {"arrivals": arrivals[:20], "stop_directions": {}, "rt_available": False}

    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        for stu in entity.trip_update.stop_time_update:
            if str(stu.stop_id) not in child_ids:
                continue
            delay = 0
            if stu.HasField("arrival") and stu.arrival.time:
                arrival_time = stu.arrival.time
                delay = stu.arrival.delay if stu.arrival.HasField("delay") else 0
            elif stu.HasField("departure") and stu.departure.time:
                arrival_time = stu.departure.time
                delay = stu.departure.delay if stu.departure.HasField("delay") else 0
            else:
                continue
            if arrival_time < now - 90:
                continue

            trip_id = entity.trip_update.trip.trip_id
            if trip_id not in trips_dict:
                continue
            is_last_stop = last_stop_by_trip.get(trip_id) == str(stu.stop_id)
            trip = trips_dict[trip_id]

            route_id = trip["route_id"]
            headsign = trip["trip_headsign"]
            if bus_routes_df is not None and route_id in bus_routes_df.index:
                route_row        = bus_routes_df.loc[route_id]
                route_short      = route_row["route_short_name"]
                route_long       = route_row["route_long_name"]
                route_color      = route_row.get("route_color",      "") or ""
                route_text_color = route_row.get("route_text_color", "") or ""
            else:
                route_short, route_long, route_color, route_text_color = "?", "", "", ""

            arrivals.append({
                "trip_id":          trip_id,
                "vehicle_id":       entity.trip_update.vehicle.id or "",
                "stop_id":          str(stu.stop_id),
                "platform_code":    "",
                "route_short_name": route_short,
                "route_long_name":  route_long,
                "headsign":         headsign,
                "arrival_time":     arrival_time,
                "minutes_until":    max(0, int((arrival_time - now) / 60)),
                "delay_seconds":    delay,
                "shape_id":         trip["shape_id"],
                "route_color":      f"#{route_color}"      if route_color      else "",
                "route_text_color": f"#{route_text_color}" if route_text_color else "",
                "direction_id":     trip["direction_id"],
                "is_last_stop":     is_last_stop,
            })

    arrivals.sort(key=lambda x: x["arrival_time"])

    # RT便が20件未満なら静的データで補完
    if len(arrivals) < 20:
        rt_trip_ids = {a["trip_id"] for a in arrivals}
        for day_offset in [0, 1]:
            static = get_static_arrivals(stop_id_list, now, day_offset)
            for a in static:
                if a["trip_id"] not in rt_trip_ids:
                    arrivals.append(a)
            if static:
                break
        arrivals.sort(key=lambda x: x["arrival_time"])

    stop_directions: dict = {}
    if trips_dict and os.path.exists(DB_PATH):
        conn = get_db()
        for sid in stop_id_list:
            try:
                row = conn.execute("""
                    SELECT t.direction_id, COUNT(*) AS cnt
                    FROM stop_times st
                    JOIN trips t ON st.trip_id = t.trip_id
                    WHERE st.stop_id=?
                    GROUP BY t.direction_id ORDER BY cnt DESC LIMIT 1
                """, (sid,)).fetchone()
                if row:
                    stop_directions[sid] = str(row["direction_id"] or "")
            except Exception:
                pass

    return {"arrivals": arrivals[:20], "stop_directions": stop_directions, "rt_available": rt_available}


@app.get("/api/stops/{stop_id}/arrivals")
@limiter.limit("30/minute")
def get_arrivals(request: Request, stop_id: str, demo: bool = False):
    """指定バス停の次のバス一覧（リアルタイム）"""
    if not trips_dict:
        raise HTTPException(503, "GTFS data not loaded")

    now = _demo_now() if demo else time.time()
    arrivals = []

    if demo:
        for day_offset in [0, 1]:
            arrivals = get_static_arrivals([stop_id], now, day_offset)
            if arrivals:
                for a in arrivals:
                    a["is_demo"] = True
                break
        return {"arrivals": arrivals[:15], "rt_available": True}

    rt_available = True
    try:
        feed = get_feed()
    except requests.RequestException:
        rt_available = False
        for day_offset in [0, 1]:
            arrivals = get_static_arrivals([stop_id], now, day_offset)
            if arrivals:
                break
        arrivals.sort(key=lambda x: x["arrival_time"])
        return {"arrivals": arrivals[:15], "rt_available": False}

    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue

        for stu in entity.trip_update.stop_time_update:
            if str(stu.stop_id) != str(stop_id):
                continue

            delay = 0
            if stu.HasField("arrival") and stu.arrival.time:
                arrival_time = stu.arrival.time
                delay = stu.arrival.delay if stu.arrival.HasField("delay") else 0
            elif stu.HasField("departure") and stu.departure.time:
                arrival_time = stu.departure.time
                delay = stu.departure.delay if stu.departure.HasField("delay") else 0
            else:
                continue

            if arrival_time < now - 90:
                continue

            trip_id = entity.trip_update.trip.trip_id
            if trip_id not in trips_dict:
                continue
            is_last_stop = last_stop_by_trip.get(trip_id) == str(stop_id)
            trip = trips_dict[trip_id]

            route_id = trip["route_id"]
            headsign = trip["trip_headsign"]
            if bus_routes_df is not None and route_id in bus_routes_df.index:
                route_row        = bus_routes_df.loc[route_id]
                route_short      = route_row["route_short_name"]
                route_long       = route_row["route_long_name"]
                route_color      = route_row.get("route_color",      "") or ""
                route_text_color = route_row.get("route_text_color", "") or ""
            else:
                route_short, route_long, route_color, route_text_color = "?", "", "", ""

            arrivals.append({
                "trip_id":          trip_id,
                "vehicle_id":       entity.trip_update.vehicle.id or "",
                "stop_id":          stop_id,
                "platform_code":    "",
                "route_short_name": route_short,
                "route_long_name":  route_long,
                "headsign":         headsign,
                "arrival_time":     arrival_time,
                "minutes_until":    max(0, int((arrival_time - now) / 60)),
                "delay_seconds":    delay,
                "shape_id":         trip["shape_id"],
                "route_color":      f"#{route_color}"      if route_color      else "",
                "route_text_color": f"#{route_text_color}" if route_text_color else "",
                "direction_id":     trip["direction_id"],
                "is_last_stop":     is_last_stop,
            })

    arrivals.sort(key=lambda x: x["arrival_time"])

    # RT便が15件未満なら静的データで補完
    if len(arrivals) < 15:
        rt_trip_ids = {a["trip_id"] for a in arrivals}
        for day_offset in [0, 1]:
            static = get_static_arrivals([stop_id], now, day_offset)
            for a in static:
                if a["trip_id"] not in rt_trip_ids:
                    arrivals.append(a)
            if static:
                break
        arrivals.sort(key=lambda x: x["arrival_time"])

    return {"arrivals": arrivals[:15], "rt_available": rt_available}


@app.get("/api/stops/{stop_id}")
@limiter.limit("60/minute")
def get_stop(request: Request, stop_id: str):
    """バス停の詳細情報"""
    if stops_df is None:
        raise HTTPException(503, "GTFS data not loaded")
    row = stops_df[stops_df["stop_id"] == str(stop_id)]
    if row.empty:
        raise HTTPException(404, "Stop not found")
    r = row.iloc[0]
    parent   = str(r.get("parent_station", "") or "")
    loc_type = str(r.get("location_type",  "") or "")
    if parent:
        sib_ids = stops_df[stops_df["parent_station"] == parent]["stop_id"].tolist()
        routes = _merge_routes(sib_ids)
    elif loc_type == "1":
        child_ids = stops_df[stops_df["parent_station"] == str(stop_id)]["stop_id"].tolist()
        routes = _merge_routes(child_ids) if child_ids else _merge_routes([str(r["stop_id"])])
    else:
        routes = _merge_routes([str(r["stop_id"])])
    is_terminal = loc_type == "1"
    return {
        "stop_id":     r["stop_id"],
        "stop_name":   r["stop_name"],
        "stop_lat":    float(r["stop_lat"]),
        "stop_lon":    float(r["stop_lon"]),
        "routes":      routes,
        "is_terminal": is_terminal,
    }


@app.get("/api/trips/{trip_id:path}/stops")
@limiter.limit("30/minute")
def get_trip_stops(request: Request, trip_id: str):
    """trip_idが通過するバス停の一覧を返す（静的時刻＋リアルタイム予測時刻＋通過済みフラグ付き）"""
    if not os.path.exists(DB_PATH):
        raise HTTPException(503, "GTFS data not loaded")

    conn = get_db()
    rows = conn.execute("""
        SELECT st.stop_id, st.stop_sequence, st.arrival_time, st.arrival_secs,
               s.stop_name, s.stop_lat, s.stop_lon
        FROM stop_times st
        LEFT JOIN stops s ON s.stop_id = st.stop_id
        WHERE st.trip_id = ?
        ORDER BY st.stop_sequence
    """, (trip_id,)).fetchall()

    if not rows:
        raise HTTPException(404, f"Trip not found: {trip_id}")

    # リアルタイム予測時刻を取得（キャッシュ使用）
    rt_times: dict = {}
    try:
        feed = get_feed()
        for entity in feed.entity:
            if not entity.HasField("trip_update"):
                continue
            if entity.trip_update.trip.trip_id != trip_id:
                continue
            for stu in entity.trip_update.stop_time_update:
                t = 0
                if stu.HasField("arrival") and stu.arrival.time:
                    t = stu.arrival.time
                elif stu.HasField("departure") and stu.departure.time:
                    t = stu.departure.time
                if t:
                    rt_times[str(stu.stop_id)] = t
            break
    except Exception:
        pass

    now = time.time()
    stops_list = []
    for row in rows:
        sid = str(row["stop_id"])
        static_time_str = row["arrival_time"] or ""
        rt_unix = rt_times.get(sid)
        predicted_unix = rt_unix if rt_unix else None

        passed = False
        if rt_unix:
            passed = rt_unix < now
        elif row["arrival_secs"] is not None:
            try:
                import datetime
                today = datetime.datetime.now(BRISBANE_TZ).date()
                base = datetime.datetime(today.year, today.month, today.day, tzinfo=BRISBANE_TZ)
                passed = (base.timestamp() + row["arrival_secs"]) < now
            except Exception:
                pass

        stops_list.append({
            "stop_id":        sid,
            "stop_name":      row["stop_name"] or "",
            "stop_lat":       float(row["stop_lat"] or 0.0),
            "stop_lon":       float(row["stop_lon"] or 0.0),
            "static_time":    static_time_str,
            "predicted_unix": predicted_unix,
            "passed":         passed,
        })

    return {"trip_id": trip_id, "stops": stops_list}


@app.get("/api/vehicles/{vehicle_id}/position")
@limiter.limit("60/minute")
def get_vehicle_position_by_id(request: Request, vehicle_id: str):
    """vehicle_id でバス車両の現在位置を返す（折り返し前の追跡用）"""
    try:
        feed = get_vehicle_feed()
    except requests.RequestException as e:
        raise HTTPException(502, f"Translink API error: {e}")

    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        vp = entity.vehicle
        if vp.vehicle.id != vehicle_id:
            continue
        pos = vp.position
        return {
            "lat":             float(pos.latitude),
            "lon":             float(pos.longitude),
            "bearing":         float(pos.bearing),
            "speed":           float(pos.speed),
            "timestamp":       int(vp.timestamp) if vp.timestamp else None,
            "current_stop_id": vp.stop_id or None,
            "current_status":  int(vp.current_status),
            "current_trip_id": vp.trip.trip_id or None,
        }

    return None


@app.get("/api/trips/{trip_id:path}/vehicle")
@limiter.limit("60/minute")
def get_vehicle_position(request: Request, trip_id: str):
    """指定tripのバス車両の現在位置を返す（VehiclePositions）"""
    try:
        feed = get_vehicle_feed()
    except requests.RequestException as e:
        raise HTTPException(502, f"Translink API error: {e}")

    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        vp = entity.vehicle
        if vp.trip.trip_id != trip_id:
            continue
        pos = vp.position
        return {
            "lat":             float(pos.latitude),
            "lon":             float(pos.longitude),
            "bearing":         float(pos.bearing),
            "speed":           float(pos.speed),
            "timestamp":       int(vp.timestamp) if vp.timestamp else None,
            "current_stop_id": vp.stop_id or None,
            "current_status":  int(vp.current_status),
        }

    return None


@app.get("/api/alerts")
@limiter.limit("20/minute")
def get_alerts(request: Request):
    """GTFS-RT ServiceAlerts を返す（アクティブな警報のみ）。SEQ combined + SEQ/Alerts をマージ"""
    entities: dict = {}  # entity.id → entity（重複排除）
    for fetch_fn in (get_seq_feed, get_alerts_feed):
        try:
            feed = fetch_fn()
            for ent in feed.entity:
                if ent.HasField("alert") and ent.id not in entities:
                    entities[ent.id] = ent
        except requests.RequestException:
            pass  # 片方が失敗しても続行

    if not entities:
        raise HTTPException(502, "Translink API error: both alert feeds failed")

    now = time.time()
    alerts = []

    for entity in entities.values():
        if not entity.HasField("alert"):
            continue
        alert = entity.alert

        if alert.active_period:
            active = False
            for period in alert.active_period:
                start = period.start if period.start else 0
                end   = period.end   if period.end   else float("inf")
                if start <= now <= end:
                    active = True
                    break
            if not active:
                continue

        route_ids = []
        stop_ids  = []
        for ie in alert.informed_entity:
            if ie.route_id:
                route_ids.append(ie.route_id)
            if ie.stop_id:
                stop_ids.append(ie.stop_id)

        route_short_names = []
        for rid in route_ids:
            if bus_routes_df is not None and rid in bus_routes_df.index:
                rsn = str(bus_routes_df.loc[rid].get("route_short_name", "") or "")
                if rsn:
                    route_short_names.append(rsn)

        header      = _get_translated_text(alert.header_text)
        description = _get_translated_text(alert.description_text)
        if not header and not description:
            continue

        alerts.append({
            "id":                entity.id,
            "header":            header,
            "description":       description,
            "cause":             CAUSE_NAMES.get(alert.cause, ""),
            "effect":            EFFECT_NAMES.get(alert.effect, ""),
            "route_short_names": sorted(set(route_short_names)),
            "stop_ids":          sorted(set(stop_ids)),
        })

    return alerts


@app.get("/api/routes/search")
@limiter.limit("60/minute")
def search_routes(request: Request, q: str = ""):
    """路線番号・路線名で検索"""
    if bus_routes_df is None:
        raise HTTPException(503, "GTFS data not loaded")
    if len(q) < 1:
        return []
    mask = (
        bus_routes_df["route_short_name"].str.contains(q, case=False, na=False) |
        bus_routes_df["route_long_name"].str.contains(q, case=False, na=False)
    )
    matched = bus_routes_df[mask].reset_index()
    results = []
    for _, row in matched.iterrows():
        rc  = str(row.get("route_color",      "") or "")
        rtc = str(row.get("route_text_color", "") or "")
        results.append({
            "route_id":         row["route_id"],
            "route_short_name": row["route_short_name"],
            "route_long_name":  str(row.get("route_long_name", "") or ""),
            "route_color":      f"#{rc}"  if rc  else "",
            "route_text_color": f"#{rtc}" if rtc else "",
        })
    return results[:30]


@app.get("/api/routes/{route_id}/stops")
@limiter.limit("30/minute")
def get_route_stops(request: Request, route_id: str, direction: int = 0):
    """路線の代表便のバス停一覧を方向別に返す"""
    if not trips_dict or not os.path.exists(DB_PATH):
        raise HTTPException(503, "GTFS data not loaded")

    conn = get_db()

    trip_rows = conn.execute(
        "SELECT trip_id, trip_headsign, direction_id FROM trips WHERE route_id=?",
        (route_id,)
    ).fetchall()
    if not trip_rows:
        raise HTTPException(404, "Route not found")

    dir_trips = [r for r in trip_rows if str(r["direction_id"]) == str(direction)]
    if not dir_trips:
        dir_trips = trip_rows

    dir_trip_ids = [r["trip_id"] for r in dir_trips]
    ph = ",".join("?" * len(dir_trip_ids))

    best = conn.execute(f"""
        SELECT trip_id, COUNT(*) AS cnt FROM stop_times
        WHERE trip_id IN ({ph}) GROUP BY trip_id ORDER BY cnt DESC LIMIT 1
    """, dir_trip_ids).fetchone()
    if not best:
        raise HTTPException(404, "No stops found")

    best_trip_id = best["trip_id"]
    stops_rows = conn.execute("""
        SELECT st.stop_id, s.stop_name, s.stop_lat, s.stop_lon
        FROM stop_times st
        LEFT JOIN stops s ON s.stop_id = st.stop_id
        WHERE st.trip_id=?
        ORDER BY st.stop_sequence
    """, (best_trip_id,)).fetchall()

    best_trip = next((r for r in dir_trips if r["trip_id"] == best_trip_id), None)
    headsign = str(best_trip["trip_headsign"] or "") if best_trip else ""

    direction_headsigns: dict = {}
    for d in ["0", "1"]:
        d_trips = [r for r in trip_rows if str(r["direction_id"]) == d]
        if d_trips:
            direction_headsigns[d] = str(d_trips[0]["trip_headsign"] or "")

    return {
        "headsign":            headsign,
        "direction_headsigns": direction_headsigns,
        "stops": [
            {
                "stop_id":   str(r["stop_id"]),
                "stop_name": str(r["stop_name"] or ""),
                "stop_lat":  float(r["stop_lat"] or 0.0),
                "stop_lon":  float(r["stop_lon"] or 0.0),
                "routes":    _merge_routes([str(r["stop_id"])]),
            }
            for r in stops_rows
        ],
    }


@app.get("/api/shapes/{shape_id:path}")  # :path でスラッシュを含むIDも受け取れる
@limiter.limit("30/minute")
def get_shape(request: Request, shape_id: str):
    """ルート形状の座標列を返す"""
    if not os.path.exists(DB_PATH):
        raise HTTPException(404, "shapes not loaded")
    conn = get_db()
    rows = conn.execute("""
        SELECT shape_pt_lat, shape_pt_lon FROM shapes
        WHERE shape_id=? ORDER BY shape_pt_sequence
    """, (shape_id,)).fetchall()
    if not rows:
        raise HTTPException(404, f"Shape not found: {shape_id}")
    return {"shape_id": shape_id, "coords": [[r["shape_pt_lat"], r["shape_pt_lon"]] for r in rows]}


# ── App config ────────────────────────────────────────────────────────────────
@app.get("/api/config")
def get_config():
    return {
        "demo_enabled": os.environ.get("DEMO_MODE_ENABLED", "").lower() in ("1", "true", "yes"),
    }


# ── Static files (frontend) ───────────────────────────────────────────────────
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
