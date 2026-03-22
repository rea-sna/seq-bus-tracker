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
import pandas as pd
import numpy as np
import requests
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

GTFS_URL = "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip"
_SHAPES_CACHE_DIR = os.path.join(GTFS_DIR, "shapes_cache")
_shape_mem_cache: dict = {}   # 直近アクセスしたシェイプのオンメモリキャッシュ
_SHAPE_CACHE_MAX = 50

def _get_shape_coords(shape_id: str):
    """shape_idに対応する座標配列をディスクキャッシュから返す（最大50件をメモリに保持）"""
    if shape_id in _shape_mem_cache:
        return _shape_mem_cache[shape_id]
    path = os.path.join(_SHAPES_CACHE_DIR, shape_id.replace("/", "__") + ".npy")
    if not os.path.exists(path):
        return None
    coords = np.load(path)
    if len(_shape_mem_cache) >= _SHAPE_CACHE_MAX:
        _shape_mem_cache.pop(next(iter(_shape_mem_cache)))
    _shape_mem_cache[shape_id] = coords
    return coords

def download_gtfs_if_needed():
    """gtfs/stops.txt がなければTranslinkからダウンロードして展開する"""
    if os.path.exists(os.path.join(GTFS_DIR, "stops.txt")):
        return  # すでにある場合はスキップ
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
        # 失敗した場合は中途半端なファイルを削除
        if os.path.exists(zip_path):
            os.remove(zip_path)
        raise RuntimeError(f"Failed to download GTFS: {e}") from e

download_gtfs_if_needed()

def load_gtfs():
    # ── stops: 不要カラムを除外、lat/lon を float32 に変換 ──
    stops = pd.read_csv(
        f"{GTFS_DIR}/stops.txt",
        dtype=str,
        usecols=lambda c: c in ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon",
                                 "location_type", "parent_station", "platform_code"]
    ).fillna("")
    stops["stop_lat"] = pd.to_numeric(stops["stop_lat"], errors="coerce").astype("float32").fillna(0.0)
    stops["stop_lon"] = pd.to_numeric(stops["stop_lon"], errors="coerce").astype("float32").fillna(0.0)
    for col in ["location_type", "parent_station", "platform_code"]:
        if col in stops.columns:
            stops[col] = stops[col].astype("category")

    routes = pd.read_csv(f"{GTFS_DIR}/routes.txt", dtype=str).fillna("")

    trips = pd.read_csv(
        f"{GTFS_DIR}/trips.txt",
        dtype=str,
        usecols=lambda c: c in ["route_id", "service_id", "trip_id", "trip_headsign", "shape_id", "direction_id"]
    ).fillna("")

    # バスのみに絞る (route_type == "3")
    bus_routes = routes[routes["route_type"] == "3"].copy()
    bus_route_ids = set(bus_routes["route_id"])
    bus_trips = trips[trips["route_id"].isin(bus_route_ids)].copy()
    for col in ["route_id", "service_id", "trip_headsign", "shape_id"]:
        if col in bus_trips.columns:
            bus_trips[col] = bus_trips[col].astype("category")

    # ── stop_times: 必要カラムのみ・バス便のみ・category 型で省メモリ化 ──
    # arrival_time は 100% 存在するため departure_time は不要
    bus_trip_ids_set = set(bus_trips["trip_id"])
    stop_times = pd.read_csv(
        f"{GTFS_DIR}/stop_times.txt",
        dtype={"trip_id": str, "stop_id": str, "arrival_time": str, "stop_sequence": "int16"},
        usecols=["trip_id", "stop_id", "stop_sequence", "arrival_time"]
    ).fillna("")
    # バス以外の trip を除外してからカテゴリ化（エンコードを最小化）
    stop_times = stop_times[stop_times["trip_id"].isin(bus_trip_ids_set)].copy()
    for col in ["trip_id", "stop_id", "arrival_time"]:
        stop_times[col] = stop_times[col].astype("category")

    # calendar.txt と calendar_dates.txt を読む（翌日便の補完用）
    calendar_df = None
    calendar_dates_df = None
    cal_path = f"{GTFS_DIR}/calendar.txt"
    cal_dates_path = f"{GTFS_DIR}/calendar_dates.txt"
    if os.path.exists(cal_path):
        calendar_df = pd.read_csv(cal_path, dtype=str).fillna("")
    if os.path.exists(cal_dates_path):
        calendar_dates_df = pd.read_csv(cal_dates_path, dtype=str).fillna("")

    if "direction_id" in bus_trips.columns:
        bus_trips["direction_id"] = bus_trips["direction_id"].astype("category")
    bus_trips  = bus_trips.set_index("trip_id")
    bus_routes = bus_routes.set_index("route_id")
    return stops, bus_routes, bus_trips, stop_times, calendar_df, calendar_dates_df

# ── 近傍バス停検索用 numpy 配列（起動時に初期化） ────────────────────────────
_stops_lat_arr: np.ndarray = np.array([], dtype=np.float32)
_stops_lon_arr: np.ndarray = np.array([], dtype=np.float32)

try:
    stops_df, bus_routes_df, bus_trips_df, stop_times_df, calendar_df, calendar_dates_df = load_gtfs()
    # shapes.txt は任意（なくても動く）。ディスクに書き出してメモリを節約
    shapes_path = f"{GTFS_DIR}/shapes.txt"
    if os.path.exists(shapes_path):
        _shapes_raw = pd.read_csv(
            shapes_path,
            dtype={"shape_id": str, "shape_pt_sequence": int},
            usecols=["shape_id", "shape_pt_sequence", "shape_pt_lat", "shape_pt_lon"],
        )
        _shapes_raw = _shapes_raw.sort_values(["shape_id", "shape_pt_sequence"])
        os.makedirs(_SHAPES_CACHE_DIR, exist_ok=True)
        _n_shapes = 0
        for sid, grp in _shapes_raw.groupby("shape_id", sort=False):
            coords = grp[["shape_pt_lat", "shape_pt_lon"]].values.astype(np.float32)
            np.save(os.path.join(_SHAPES_CACHE_DIR, sid.replace("/", "__") + ".npy"), coords)
            _n_shapes += 1
        del _shapes_raw
        print(f"✅ GTFS loaded — {len(stops_df)} stops, {len(bus_routes_df)} bus routes, {_n_shapes} shapes (on-disk)")
    else:
        print(f"✅ GTFS loaded — {len(stops_df)} stops, {len(bus_routes_df)} bus routes (no shapes.txt)")
    # trip ごとの最終停留所を辞書化（終着駅フィルタ用）
    last_stop_by_trip: dict = (
        stop_times_df
        .sort_values("stop_sequence")
        .groupby("trip_id", observed=True)["stop_id"]
        .last()
        .to_dict()
    )
    # stop_id → 路線情報リスト の辞書（バス停カード表示用）
    _route_color_cols = [c for c in ["route_short_name", "route_color", "route_text_color"] if c in bus_routes_df.columns]
    _st_routes = (
        stop_times_df[["trip_id", "stop_id"]]
        .drop_duplicates()
        .merge(bus_trips_df[["route_id"]].reset_index(), on="trip_id", how="inner")
        .merge(bus_routes_df[_route_color_cols].reset_index(), on="route_id", how="inner")
    )
    def _build_stop_routes(grp):
        seen = {}
        for _, row in grp.iterrows():
            name = str(row["route_short_name"])
            if name not in seen:
                rc  = str(row.get("route_color",      "") or "")
                rtc = str(row.get("route_text_color", "") or "")
                seen[name] = {
                    "name":       name,
                    "color":      f"#{rc}"  if rc  else "",
                    "text_color": f"#{rtc}" if rtc else "",
                }
        return sorted(seen.values(), key=lambda r: (not r["name"].isdigit(), r["name"].zfill(6) if r["name"].isdigit() else r["name"]))
    stop_routes_dict: dict = {
        sid: _build_stop_routes(grp)
        for sid, grp in _st_routes.groupby("stop_id", observed=True)
    }
    del _st_routes
    # 近傍バス停検索用 numpy 配列を初期化
    _stops_lat_arr = stops_df["stop_lat"].values  # float32
    _stops_lon_arr = stops_df["stop_lon"].values  # float32
    # ロード時の一時メモリを解放（Linux では malloc_trim でOSへ返却）
    gc.collect()
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass
except FileNotFoundError as e:
    print(f"⚠️  GTFS files not found: {e}")
    stops_df = bus_routes_df = bus_trips_df = stop_times_df = None
    calendar_df = calendar_dates_df = None
    stop_routes_dict = {}
    last_stop_by_trip = {}

# ── Timezone ──────────────────────────────────────────────────────────────────
# ブリスベンは UTC+10 固定（サマータイムなし）
import datetime as _dt
BRISBANE_TZ = _dt.timezone(_dt.timedelta(hours=10))

# ── Realtime endpoints ────────────────────────────────────────────────────────
TRIP_UPDATES_URL     = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Bus"
SEQ_COMBINED_URL     = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ"
VEHICLE_POS_URL      = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus"

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

def get_seq_feed() -> gtfs_realtime_pb2.FeedMessage:
    with _seq_lock:
        if time.time() < _seq_cache["expires"] and _seq_cache["data"] is not None:
            return _seq_cache["data"]
        resp = requests.get(SEQ_COMBINED_URL, timeout=10)
        resp.raise_for_status()
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(resp.content)
        _seq_cache["data"] = feed
        _seq_cache["expires"] = time.time() + 60
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
    stop_times.txt から静的時刻を取得し、到着情報リストを返す。
    day_offset=0 → 今日、day_offset=1 → 明日
    """
    import datetime
    if stop_times_df is None or bus_trips_df is None:
        return []

    DAY_NAMES = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]
    target_date = datetime.datetime.now(BRISBANE_TZ).date() + datetime.timedelta(days=day_offset)
    target_str  = target_date.strftime("%Y%m%d")
    day_name    = DAY_NAMES[target_date.weekday()]
    base_ts     = datetime.datetime(target_date.year, target_date.month, target_date.day,
                                    tzinfo=BRISBANE_TZ).timestamp()

    # 運行サービスIDを取得
    active_service_ids = set()
    if calendar_df is not None and not calendar_df.empty:
        cal = calendar_df[
            (calendar_df["start_date"] <= target_str) &
            (calendar_df["end_date"]   >= target_str) &
            (calendar_df[day_name] == "1")
        ]
        active_service_ids.update(cal["service_id"].tolist())

    if calendar_dates_df is not None and not calendar_dates_df.empty:
        # exception_type=1: 追加, 2: 除外
        adds    = calendar_dates_df[(calendar_dates_df["date"] == target_str) & (calendar_dates_df["exception_type"] == "1")]
        removes = calendar_dates_df[(calendar_dates_df["date"] == target_str) & (calendar_dates_df["exception_type"] == "2")]
        active_service_ids.update(adds["service_id"].tolist())
        active_service_ids -= set(removes["service_id"].tolist())

    # 有効なtrip_idに絞る（bus_trips_dfはtrip_idがインデックス）
    if active_service_ids:
        valid_trips = bus_trips_df[bus_trips_df["service_id"].isin(active_service_ids)]
    else:
        valid_trips = bus_trips_df  # calendar がない場合は全trip対象

    valid_trip_ids = set(valid_trips.index)

    # 対象バス停の stop_times を取得
    st = stop_times_df[
        stop_times_df["stop_id"].isin([str(s) for s in stop_id_list]) &
        stop_times_df["trip_id"].isin(valid_trip_ids)
    ].copy()

    if st.empty:
        return []

    # ── ベクトル化: 時刻文字列を unix タイムスタンプに変換 ──
    # arrival_time は 100% 存在するため departure_time フォールバック不要
    time_col = st["arrival_time"]
    st = st[time_col != ""].copy()
    if st.empty:
        return []
    time_col = time_col[st.index]

    try:
        parts = time_col.str.split(":", expand=True)[[0, 1, 2]].apply(pd.to_numeric, errors="coerce")
        st["arr_ts"] = base_ts + parts[0] * 3600 + parts[1] * 60 + parts[2]
        st = st.dropna(subset=["arr_ts"])
    except Exception:
        return []

    st = st[st["arr_ts"] > now]
    if st.empty:
        return []

    # trip情報をmerge（インデックスをリセットしてtrip_idを列に戻す）
    trip_meta_cols = ["route_id", "trip_headsign"] + (["shape_id"] if "shape_id" in valid_trips.columns else []) + (["direction_id"] if "direction_id" in valid_trips.columns else [])
    trip_meta = valid_trips[trip_meta_cols].reset_index()
    st = st.merge(trip_meta, on="trip_id", how="inner")
    if st.empty:
        return []

    # route情報をmerge（インデックスをリセットしてroute_idを列に戻す）
    route_meta_cols = ["route_short_name", "route_long_name"] + [
        c for c in ["route_color", "route_text_color"] if c in bus_routes_df.columns
    ]
    route_meta = bus_routes_df[route_meta_cols].reset_index()
    st = st.merge(route_meta, on="route_id", how="left")
    # 終着駅フィルタ: 表示中のバス停がそのトリップの最終停留所なら除外
    if last_stop_by_trip:
        last_stops = st["trip_id"].map(last_stop_by_trip)
        st = st[last_stops != st["stop_id"]]

    st = st.sort_values("arr_ts").head(15)

    def _str(val, default=""):
        return str(val) if pd.notna(val) and val != "" else default

    arrivals = []
    for _, row in st.iterrows():
        arr_ts = float(row["arr_ts"])
        route_color      = _str(row.get("route_color"))
        route_text_color = _str(row.get("route_text_color"))
        shape_id         = _str(row.get("shape_id"))
        arrivals.append({
            "trip_id":          row["trip_id"],
            "stop_id":          str(row["stop_id"]),
            "platform_code":    "",
            "route_short_name": _str(row.get("route_short_name"), "?"),
            "route_long_name":  _str(row.get("route_long_name")),
            "headsign":         _str(row.get("trip_headsign")),
            "arrival_time":     arr_ts,
            "minutes_until":    max(0, int((arr_ts - now) / 60)),
            "delay_seconds":    0,
            "shape_id":         shape_id,
            "route_color":      f"#{route_color}"      if route_color      else "",
            "route_text_color": f"#{route_text_color}" if route_text_color else "",
            "direction_id":     _str(row.get("direction_id")),
            "is_static":        True,
            "day_offset":       day_offset,
        })

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
            # ── ホームがあるターミナル ──  (keep existing terminal logic exactly)
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
                "stop_id":        parent,
                "stop_name":      station_name,
                "stop_lat":       station_lat,
                "stop_lon":       station_lon,
                "is_terminal":    True,
                "is_name_grouped": False,
                "stop_ids":       [],
                "platforms":      platforms,
                "routes":         _merge_routes([sib["stop_id"] for _, sib in siblings.iterrows()]),
            })
        else:
            # Collect for name grouping
            name = row["stop_name"]
            if name not in individual_by_name:
                individual_by_name[name] = []
            individual_by_name[name].append(row)

    # Process name-grouped individual stops
    for name, rows in individual_by_name.items():
        if len(rows) == 1:
            row = rows[0]
            results.append({
                "stop_id":        str(row["stop_id"]),
                "stop_name":      str(row["stop_name"]),
                "stop_lat":       float(row["stop_lat"]),
                "stop_lon":       float(row["stop_lon"]),
                "is_terminal":    False,
                "is_name_grouped": False,
                "stop_ids":       [],
                "platforms":      [],
                "routes":         _merge_routes([row["stop_id"]]),
            })
        else:
            lats = [float(r["stop_lat"]) for r in rows]
            lons = [float(r["stop_lon"]) for r in rows]
            results.append({
                "stop_id":        str(rows[0]["stop_id"]),
                "stop_name":      name,
                "stop_lat":       sum(lats) / len(lats),
                "stop_lon":       sum(lons) / len(lons),
                "is_terminal":    False,
                "is_name_grouped": True,
                "stop_ids":       [str(r["stop_id"]) for r in rows],
                "platforms":      [],
                "routes":         _merge_routes([r["stop_id"] for r in rows]),
            })

    return [r for r in results if r.get("routes")][:20]


@app.get("/api/stops/nearby")
@limiter.limit("20/minute")
def get_nearby_stops(request: Request, lat: float, lon: float, radius: int = 500, limit: int = 10):
    """現在地から半径radius(m)以内のバス停を近い順に返す"""
    if stops_df is None:
        raise HTTPException(503, "GTFS data not loaded")

    # ── ベクトル化: 全バス停との距離を numpy で一括計算 ──
    p = np.pi / 180.0
    R = 6371000.0
    dlat = (_stops_lat_arr - lat) * p
    dlon = (_stops_lon_arr - lon) * p
    a = (np.sin(dlat / 2.0) ** 2
         + np.cos(lat * p) * np.cos(_stops_lat_arr * p) * np.sin(dlon / 2.0) ** 2)
    all_dists = 2.0 * R * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))

    # stop_id → 距離 マップ（親駅の距離参照用）
    sid_to_dist = dict(zip(stops_df["stop_id"].values, all_dists))

    has_parent   = "parent_station" in stops_df.columns
    has_loc_type = "location_type"  in stops_df.columns
    has_platform = "platform_code"  in stops_df.columns
    has_stopcode = "stop_code"      in stops_df.columns

    # 親駅(location_type=1)を除外し、半径内の候補に絞る
    if has_loc_type:
        not_parent_mask = (stops_df["location_type"] != "1").values
    else:
        not_parent_mask = np.ones(len(stops_df), dtype=bool)
    within_radius_mask = all_dists <= radius
    candidate_df = stops_df[not_parent_mask & within_radius_mask]

    results = []
    seen_parents = set()
    individual_by_name = {}  # stop_name -> list of (row, dist)

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
            # 親駅 stop_id の距離を使用（なければ子駅の距離で代替）
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
                "stop_id":        str(parent),
                "stop_name":      station_name,
                "stop_lat":       station_lat,
                "stop_lon":       station_lon,
                "is_terminal":    True,
                "is_name_grouped": False,
                "stop_ids":       [],
                "platforms":      platforms,
                "routes":         _merge_routes([str(sib["stop_id"]) for _, sib in siblings.iterrows()]),
                "distance_m":     round(dist),
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
                "stop_id":        str(row["stop_id"]),
                "stop_name":      str(row["stop_name"]),
                "stop_lat":       float(row["stop_lat"]),
                "stop_lon":       float(row["stop_lon"]),
                "is_terminal":    False,
                "is_name_grouped": False,
                "stop_ids":       [],
                "platforms":      [],
                "routes":         _merge_routes([row["stop_id"]]),
                "distance_m":     round(dist),
            })
        else:
            min_dist = min(d for _, d in rows_dists)
            lats = [float(r["stop_lat"]) for r, _ in rows_dists]
            lons = [float(r["stop_lon"]) for r, _ in rows_dists]
            results.append({
                "stop_id":        str(rows_dists[0][0]["stop_id"]),
                "stop_name":      name,
                "stop_lat":       sum(lats) / len(lats),
                "stop_lon":       sum(lons) / len(lons),
                "is_terminal":    False,
                "is_name_grouped": True,
                "stop_ids":       [str(r["stop_id"]) for r, _ in rows_dists],
                "platforms":      [],
                "routes":         _merge_routes([r["stop_id"] for r, _ in rows_dists]),
                "distance_m":     round(min_dist),
            })

    results.sort(key=lambda x: x["distance_m"])
    return [r for r in results if r.get("routes")][:limit]


@app.get("/api/terminal/{parent_id}/arrivals")
@limiter.limit("30/minute")
def get_terminal_arrivals(request: Request, parent_id: str, demo: bool = False):
    """ターミナルの全ホームをまとめて取得し、platform_codeを付与して返す"""
    if stops_df is None or bus_trips_df is None:
        raise HTTPException(503, "GTFS data not loaded")

    has_parent   = "parent_station" in stops_df.columns
    has_platform = "platform_code"  in stops_df.columns
    has_stopcode = "stop_code"      in stops_df.columns

    # 配下のホームstop_idを取得
    if has_parent:
        children = stops_df[stops_df["parent_station"] == parent_id]
    else:
        children = stops_df[stops_df["stop_id"] == parent_id]

    # stop_id → platform_code マップ
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
        # デモモード: 静的時刻表のみ使用
        for day_offset in [0, 1]:
            static = get_static_arrivals(list(child_ids), now, day_offset)
            for a in static:
                a["platform_code"] = platform_map.get(a["stop_id"], "")
                a["is_demo"] = True
            if static:
                arrivals = static
                break
        return arrivals[:20]

    # リアルタイムフィード取得（キャッシュ使用）
    try:
        feed = get_feed()
    except requests.RequestException as e:
        raise HTTPException(502, f"Translink API error: {e}")

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
            if trip_id not in bus_trips_df.index:
                continue
            # 終着駅（このホームがトリップの最終停留所）はスキップ
            if last_stop_by_trip.get(trip_id) == str(stu.stop_id):
                continue
            trip_row = bus_trips_df.loc[trip_id]

            route_id = trip_row["route_id"]
            headsign = trip_row.get("trip_headsign", "") or ""
            if route_id in bus_routes_df.index:
                route_row        = bus_routes_df.loc[route_id]
                route_short      = route_row["route_short_name"]
                route_long       = route_row["route_long_name"]
                route_color      = route_row.get("route_color",      "") or ""
                route_text_color = route_row.get("route_text_color", "") or ""
            else:
                route_short, route_long, route_color, route_text_color = "?", "", "", ""

            arrivals.append({
                "trip_id":          trip_id,
                "stop_id":          str(stu.stop_id),
                "platform_code":    platform_map.get(str(stu.stop_id), ""),
                "route_short_name": route_short,
                "route_long_name":  route_long,
                "headsign":         headsign,
                "arrival_time":     arrival_time,
                "minutes_until":    max(0, int((arrival_time - now) / 60)),
                "delay_seconds":    delay,
                "shape_id":         trip_row.get("shape_id", "") or "",
                "route_color":      f"#{route_color}"      if route_color      else "",
                "route_text_color": f"#{route_text_color}" if route_text_color else "",
                "direction_id":     str(trip_row.get("direction_id", "") or ""),
            })

    arrivals.sort(key=lambda x: x["arrival_time"])

    # リアルタイム便がない場合は静的時刻でフォールバック（今日→明日の順）
    if not arrivals:
        for day_offset in [0, 1]:
            static = get_static_arrivals(list(child_ids), now, day_offset)
            for a in static:
                a["platform_code"] = platform_map.get(a["stop_id"], "")
            if static:
                arrivals = static
                break

    return arrivals[:20]


@app.get("/api/stops/multi/arrivals")
@limiter.limit("30/minute")
def get_multi_stop_arrivals(request: Request, ids: str, demo: bool = False):
    """同名バス停グループの全stop_idの到着情報を返す"""
    if stops_df is None or bus_trips_df is None:
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
        # stop_directions は通常どおり算出
        stop_directions: dict = {}
        if stop_times_df is not None and "direction_id" in bus_trips_df.columns:
            for sid in stop_id_list:
                try:
                    trip_ids = stop_times_df[stop_times_df["stop_id"].isin([sid])]["trip_id"].astype(str).unique()
                    valid = bus_trips_df[bus_trips_df.index.isin(trip_ids)]
                    if not valid.empty:
                        dir_counts = valid["direction_id"].astype(str).value_counts()
                        if not dir_counts.empty:
                            stop_directions[sid] = str(dir_counts.index[0])
                except Exception:
                    pass
        return {"arrivals": arrivals[:20], "stop_directions": stop_directions}

    try:
        feed = get_feed()
    except requests.RequestException as e:
        raise HTTPException(502, f"Translink API error: {e}")

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
            if trip_id not in bus_trips_df.index:
                continue
            if last_stop_by_trip.get(trip_id) == str(stu.stop_id):
                continue
            trip_row = bus_trips_df.loc[trip_id]

            route_id = trip_row["route_id"]
            headsign = trip_row.get("trip_headsign", "") or ""
            if route_id in bus_routes_df.index:
                route_row        = bus_routes_df.loc[route_id]
                route_short      = route_row["route_short_name"]
                route_long       = route_row["route_long_name"]
                route_color      = route_row.get("route_color",      "") or ""
                route_text_color = route_row.get("route_text_color", "") or ""
            else:
                route_short, route_long, route_color, route_text_color = "?", "", "", ""

            arrivals.append({
                "trip_id":          trip_id,
                "stop_id":          str(stu.stop_id),
                "platform_code":    "",
                "route_short_name": route_short,
                "route_long_name":  route_long,
                "headsign":         headsign,
                "arrival_time":     arrival_time,
                "minutes_until":    max(0, int((arrival_time - now) / 60)),
                "delay_seconds":    delay,
                "shape_id":         trip_row.get("shape_id", "") or "",
                "route_color":      f"#{route_color}"      if route_color      else "",
                "route_text_color": f"#{route_text_color}" if route_text_color else "",
                "direction_id":     str(trip_row.get("direction_id", "") or ""),
            })

    arrivals.sort(key=lambda x: x["arrival_time"])

    if not arrivals:
        for day_offset in [0, 1]:
            arrivals = get_static_arrivals(stop_id_list, now, day_offset)
            if arrivals:
                break

    # 各 stop_id の主要 direction_id を静的データから導出
    stop_directions: dict = {}
    if stop_times_df is not None and "direction_id" in bus_trips_df.columns:
        for sid in stop_id_list:
            try:
                trip_ids = stop_times_df[stop_times_df["stop_id"].isin([sid])]["trip_id"].astype(str).unique()
                valid = bus_trips_df[bus_trips_df.index.isin(trip_ids)]
                if not valid.empty:
                    dir_counts = valid["direction_id"].astype(str).value_counts()
                    if not dir_counts.empty:
                        stop_directions[sid] = str(dir_counts.index[0])
            except Exception:
                pass

    return {"arrivals": arrivals[:20], "stop_directions": stop_directions}


@app.get("/api/stops/{stop_id}/arrivals")
@limiter.limit("30/minute")
def get_arrivals(request: Request, stop_id: str, demo: bool = False):
    """指定バス停の次のバス一覧（リアルタイム）"""
    if bus_trips_df is None:
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
        return arrivals[:15]

    # リアルタイムフィード取得（キャッシュ使用）
    try:
        feed = get_feed()
    except requests.RequestException as e:
        raise HTTPException(502, f"Translink API error: {e}")

    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue

        for stu in entity.trip_update.stop_time_update:
            if str(stu.stop_id) != str(stop_id):
                continue

            # 到着 or 出発時刻・遅延秒数を取得
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
                continue  # 過去の便はスキップ

            trip_id = entity.trip_update.trip.trip_id

            # ルート情報を付加（インデックスで O(1) 参照）
            if trip_id not in bus_trips_df.index:
                continue
            # 終着駅（このバス停がトリップの最終停留所）はスキップ
            if last_stop_by_trip.get(trip_id) == str(stop_id):
                continue
            trip_row = bus_trips_df.loc[trip_id]

            route_id = trip_row["route_id"]
            headsign = trip_row.get("trip_headsign", "") or ""
            if route_id in bus_routes_df.index:
                route_row        = bus_routes_df.loc[route_id]
                route_short      = route_row["route_short_name"]
                route_long       = route_row["route_long_name"]
                route_color      = route_row.get("route_color", "")      or ""
                route_text_color = route_row.get("route_text_color", "") or ""
            else:
                route_short, route_long, route_color, route_text_color = "?", "", "", ""

            arrivals.append({
                "trip_id":          trip_id,
                "stop_id":          stop_id,
                "platform_code":    "",
                "route_short_name": route_short,
                "route_long_name":  route_long,
                "headsign":         headsign,
                "arrival_time":     arrival_time,
                "minutes_until":    max(0, int((arrival_time - now) / 60)),
                "delay_seconds":    delay,
                "shape_id":         trip_row.get("shape_id", "") or "",
                "route_color":      f"#{route_color}"      if route_color      else "",
                "route_text_color": f"#{route_text_color}" if route_text_color else "",
                "direction_id":     str(trip_row.get("direction_id", "") or ""),
            })

    arrivals.sort(key=lambda x: x["arrival_time"])

    # リアルタイム便がない場合は静的時刻でフォールバック（今日→明日の順）
    if not arrivals:
        for day_offset in [0, 1]:
            arrivals = get_static_arrivals([stop_id], now, day_offset)
            if arrivals:
                break

    return arrivals[:15]


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
        # 子プラットホーム → 同じ親を持つ兄弟から集約
        sib_ids = stops_df[stops_df["parent_station"] == parent]["stop_id"].tolist()
        routes = _merge_routes(sib_ids)
    elif loc_type == "1":
        # 親station自体が渡された場合（ターミナル）→ 子プラットホームから集約
        child_ids = stops_df[stops_df["parent_station"] == str(stop_id)]["stop_id"].tolist()
        routes = _merge_routes(child_ids) if child_ids else _merge_routes([str(r["stop_id"])])
    else:
        routes = _merge_routes([str(r["stop_id"])])
    return {
        "stop_id":   r["stop_id"],
        "stop_name": r["stop_name"],
        "stop_lat":  float(r["stop_lat"]),
        "stop_lon":  float(r["stop_lon"]),
        "routes":    routes,
    }


@app.get("/api/trips/{trip_id:path}/stops")
@limiter.limit("30/minute")
def get_trip_stops(request: Request, trip_id: str):
    """trip_idが通過するバス停の一覧を返す（静的時刻＋リアルタイム予測時刻＋通過済みフラグ付き）"""
    if stop_times_df is None or stops_df is None:
        raise HTTPException(503, "GTFS data not loaded")

    # 静的 stop_times を sequence 順に取得
    trip_st = stop_times_df[stop_times_df["trip_id"] == trip_id].sort_values("stop_sequence")
    if trip_st.empty:
        raise HTTPException(404, f"Trip not found: {trip_id}")

    merged = trip_st.merge(
        stops_df[["stop_id", "stop_name", "stop_lat", "stop_lon"]],
        on="stop_id", how="left"
    )

    # リアルタイム予測時刻を取得（キャッシュ使用）
    rt_times: dict[str, int] = {}  # stop_id -> predicted unix timestamp
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
            break  # 対象tripが見つかったら終了
    except Exception:
        pass  # リアルタイム取得失敗時は静的時刻のみ

    now = time.time()

    stops_list = []
    for _, row in merged.iterrows():
        sid = str(row["stop_id"])
        static_time_str = row.get("arrival_time", "") if "arrival_time" in merged.columns else ""

        # リアルタイム予測があればそちらを優先
        rt_unix = rt_times.get(sid)
        predicted_unix = rt_unix if rt_unix else None

        # 通過済み判定: リアルタイム時刻が過去 or 静的時刻が現在より前
        passed = False
        if rt_unix:
            passed = rt_unix < now
        elif static_time_str:
            try:
                # GTFS時刻は "HH:MM:SS"（25時間表記あり）
                parts = static_time_str.split(":")
                h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
                import datetime
                today = datetime.datetime.now(BRISBANE_TZ).date()
                base = datetime.datetime(today.year, today.month, today.day, tzinfo=BRISBANE_TZ)
                static_unix = base.timestamp() + h*3600 + m*60 + s
                passed = static_unix < now
            except Exception:
                pass

        stops_list.append({
            "stop_id":        sid,
            "stop_name":      row.get("stop_name", ""),
            "stop_lat":       float(row.get("stop_lat", 0.0) or 0.0),
            "stop_lon":       float(row.get("stop_lon", 0.0) or 0.0),
            "static_time":    static_time_str,
            "predicted_unix": predicted_unix,
            "passed":         passed,
        })

    return {"trip_id": trip_id, "stops": stops_list}


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
            "lat":              float(pos.latitude),
            "lon":              float(pos.longitude),
            "bearing":          float(pos.bearing),
            "speed":            float(pos.speed),
            "timestamp":        int(vp.timestamp) if vp.timestamp else None,
            "current_stop_id":  vp.stop_id or None,
            "current_status":   int(vp.current_status),  # 0=INCOMING_AT 1=STOPPED_AT 2=IN_TRANSIT_TO
        }

    return None


@app.get("/api/alerts")
@limiter.limit("20/minute")
def get_alerts(request: Request):
    """GTFS-RT ServiceAlerts を返す（アクティブな警報のみ）"""
    try:
        feed = get_seq_feed()
    except requests.RequestException as e:
        raise HTTPException(502, f"Translink API error: {e}")

    now = time.time()
    alerts = []

    for entity in feed.entity:
        if not entity.HasField("alert"):
            continue
        alert = entity.alert

        # active_period フィルタ（設定がある場合のみ）
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

        # informed_entity から route/stop を収集
        route_ids = []
        stop_ids  = []
        for ie in alert.informed_entity:
            if ie.route_id:
                route_ids.append(ie.route_id)
            if ie.stop_id:
                stop_ids.append(ie.stop_id)

        # route_id → route_short_name に変換
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
    if bus_trips_df is None or stop_times_df is None or stops_df is None:
        raise HTTPException(503, "GTFS data not loaded")

    trips = bus_trips_df[bus_trips_df["route_id"] == route_id]
    if trips.empty:
        raise HTTPException(404, "Route not found")

    if "direction_id" in trips.columns:
        dir_trips = trips[trips["direction_id"].astype(str) == str(direction)]
        if dir_trips.empty:
            dir_trips = trips
    else:
        dir_trips = trips

    # 最も停留所数が多い便を代表便として選択
    trip_ids = set(dir_trips.index)
    st_sub = stop_times_df[stop_times_df["trip_id"].isin(trip_ids)]
    if st_sub.empty:
        raise HTTPException(404, "No stops found")
    best_trip_id = st_sub.groupby("trip_id", observed=True).size().idxmax()

    trip_st = stop_times_df[stop_times_df["trip_id"] == best_trip_id].sort_values("stop_sequence")
    merged = trip_st.merge(
        stops_df[["stop_id", "stop_name", "stop_lat", "stop_lon"]],
        on="stop_id", how="left"
    )

    trip_row = bus_trips_df.loc[best_trip_id]
    headsign = str(trip_row.get("trip_headsign", "") or "")

    # 両方向のheadsignを取得（方向切り替えUI用）
    direction_headsigns: dict = {}
    if "direction_id" in trips.columns:
        for d in ["0", "1"]:
            d_trips = trips[trips["direction_id"].astype(str) == d]
            if not d_trips.empty:
                sample = d_trips.iloc[0]
                direction_headsigns[d] = str(sample.get("trip_headsign", "") or "")

    return {
        "headsign":           headsign,
        "direction_headsigns": direction_headsigns,
        "stops": [
            {
                "stop_id":   str(row["stop_id"]),
                "stop_name": str(row["stop_name"]),
                "stop_lat":  float(row["stop_lat"]),
                "stop_lon":  float(row["stop_lon"]),
                "routes":    _merge_routes([str(row["stop_id"])]),
            }
            for _, row in merged.iterrows()
        ],
    }


@app.get("/api/shapes/{shape_id:path}")  # :path でスラッシュを含むIDも受け取れる
@limiter.limit("30/minute")
def get_shape(request: Request, shape_id: str):
    """ルート形状の座標列を返す"""
    if not os.path.isdir(_SHAPES_CACHE_DIR):
        raise HTTPException(404, "shapes.txt not loaded")
    coords_arr = _get_shape_coords(shape_id)
    if coords_arr is None:
        raise HTTPException(404, f"Shape not found: {shape_id}")
    return {"shape_id": shape_id, "coords": coords_arr.tolist()}


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