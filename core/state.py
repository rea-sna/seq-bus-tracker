import gc
import sqlite3

import numpy as np
import pandas as pd

import core.db as _db_module
from core.config import DB_PATH

# 近傍バス停検索用 numpy 配列（起動時に初期化）
_stops_lat_arr: np.ndarray = np.array([], dtype=np.float32)
_stops_lon_arr: np.ndarray = np.array([], dtype=np.float32)

# グローバル変数（_load_gtfs_to_memory で上書きされる）
stops_df = None
bus_routes_df = None
trips_dict: dict = {}
stop_routes_dict: dict = {}
last_stop_by_trip: dict = {}
gtfs_status: str = "loading"


def _load_gtfs_to_memory():
    """DBからグローバル変数へGTFSデータをロードする（起動時・週次更新時に呼び出す）"""
    global stops_df, bus_routes_df, trips_dict, last_stop_by_trip, stop_routes_dict, gtfs_status
    global _stops_lat_arr, _stops_lon_arr

    boot = sqlite3.connect(DB_PATH)
    boot.row_factory = sqlite3.Row
    try:
        new_stops_df = pd.read_sql("SELECT * FROM stops", boot)
        new_stops_df["stop_lat"] = pd.to_numeric(new_stops_df["stop_lat"], errors="coerce").astype("float32").fillna(0.0)
        new_stops_df["stop_lon"] = pd.to_numeric(new_stops_df["stop_lon"], errors="coerce").astype("float32").fillna(0.0)
        for _col in ["location_type", "parent_station", "platform_code"]:
            if _col in new_stops_df.columns:
                new_stops_df[_col] = new_stops_df[_col].astype("category")

        new_bus_routes_df = pd.read_sql("SELECT * FROM routes", boot).set_index("route_id")

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

        _ls_rows = boot.execute("SELECT trip_id, last_stop_id FROM last_stops").fetchall()
        new_last_stop_by_trip = {r["trip_id"]: r["last_stop_id"] for r in _ls_rows}
        del _ls_rows

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

    stops_df          = new_stops_df
    bus_routes_df     = new_bus_routes_df
    trips_dict        = new_trips_dict
    last_stop_by_trip = new_last_stop_by_trip
    stop_routes_dict  = new_stop_routes_dict
    _stops_lat_arr    = new_stops_df["stop_lat"].values
    _stops_lon_arr    = new_stops_df["stop_lon"].values
    _db_module._db_generation += 1

    gtfs_status = "ready"
    gc.collect()
    try:
        import ctypes
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass

    print(f"✅ GTFS loaded — {len(stops_df)} stops, {len(bus_routes_df)} bus routes, {len(trips_dict)} trips")


def _merge_routes(stop_id_list: list) -> list:
    """複数 stop_id の路線情報を統合してソート済みリストで返す"""
    seen: dict = {}
    for sid in stop_id_list:
        for r in stop_routes_dict.get(str(sid), []):
            if r["name"] not in seen:
                seen[r["name"]] = r
    return sorted(
        seen.values(),
        key=lambda r: (not r["name"].isdigit(), r["name"].zfill(6) if r["name"].isdigit() else r["name"])
    )
