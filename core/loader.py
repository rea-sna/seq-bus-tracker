import os
import threading
import zipfile

import pandas as pd
import requests

from core.config import GTFS_DIR, DB_PATH, GTFS_URL
from core.db import _arrival_secs

_gtfs_update_lock = threading.Lock()


def _download_gtfs_zip(zip_path: str):
    """GTFSをダウンロードする"""
    response = requests.get(GTFS_URL, stream=True, timeout=300)
    response.raise_for_status()
    with open(zip_path, "wb") as f:
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            f.write(chunk)


def download_gtfs_if_needed():
    """gtfs/stops.txt がなければTranslinkからダウンロードして展開する"""
    if os.path.exists(os.path.join(GTFS_DIR, "stops.txt")):
        return
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    os.makedirs(GTFS_DIR, exist_ok=True)
    zip_path = os.path.join(GTFS_DIR, "gtfs.zip")
    print("Downloading GTFS from Translink...")
    try:
        _download_gtfs_zip(zip_path)
        print("Extracting GTFS...")
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(GTFS_DIR)
        os.remove(zip_path)
        print("GTFS ready")
    except Exception as e:
        if os.path.exists(zip_path):
            os.remove(zip_path)
        raise RuntimeError(f"Failed to download GTFS: {e}") from e


def build_gtfs_db():
    """GTFS CSVファイルからSQLite DBを構築する（DB未存在時のみ実行）"""
    import sqlite3
    if os.path.exists(DB_PATH):
        return
    print("Building GTFS SQLite database...")
    conn = sqlite3.connect(DB_PATH)
    try:
        stops = pd.read_csv(f"{GTFS_DIR}/stops.txt", dtype=str).fillna("")
        stops.to_sql("stops", conn, if_exists="replace", index=False)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_stops_parent ON stops(parent_station)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_stops_name ON stops(stop_name)")

        routes = pd.read_csv(f"{GTFS_DIR}/routes.txt", dtype=str).fillna("")
        bus_routes = routes[routes["route_type"] == "3"].copy()
        bus_routes.to_sql("routes", conn, if_exists="replace", index=False)

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

        print("  Importing stop_times (large file)...")
        conn.execute("""CREATE TABLE stop_times (
            trip_id TEXT, stop_id TEXT, stop_sequence INTEGER,
            arrival_time TEXT, arrival_secs INTEGER
        )""")
        total_st = 0
        for chunk in pd.read_csv(
            f"{GTFS_DIR}/stop_times.txt",
            dtype={"trip_id": str, "stop_id": str, "arrival_time": str,
                   "departure_time": str, "stop_sequence": int},
            usecols=["trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time"],
            chunksize=200_000,
        ):
            chunk = chunk[chunk["trip_id"].isin(bus_trip_ids_set)].copy()
            # arrival_time が空の場合（始発駅等）は departure_time で代替
            mask = chunk["arrival_time"].isna() | (chunk["arrival_time"] == "")
            chunk.loc[mask, "arrival_time"] = chunk.loc[mask, "departure_time"]
            chunk["arrival_secs"] = chunk["arrival_time"].apply(_arrival_secs)
            chunk = chunk.dropna(subset=["arrival_secs"])
            chunk["arrival_secs"] = chunk["arrival_secs"].astype(int)
            chunk.drop(columns=["departure_time"], inplace=True)
            chunk.to_sql("stop_times", conn, if_exists="append", index=False)
            total_st += len(chunk)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_st_stop ON stop_times(stop_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_st_trip ON stop_times(trip_id)")
        print(f"  {total_st} stop_times rows imported")

        shapes_path = f"{GTFS_DIR}/shapes.txt"
        if os.path.exists(shapes_path):
            print("  Importing shapes...")
            pd.read_csv(
                shapes_path,
                dtype={"shape_id": str, "shape_pt_sequence": int},
                usecols=["shape_id", "shape_pt_sequence", "shape_pt_lat", "shape_pt_lon"],
            ).to_sql("shapes", conn, if_exists="replace", index=False)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_shapes ON shapes(shape_id, shape_pt_sequence)")

        cal_path = f"{GTFS_DIR}/calendar.txt"
        if os.path.exists(cal_path):
            pd.read_csv(cal_path, dtype=str).fillna("").to_sql(
                "calendar", conn, if_exists="replace", index=False
            )

        cal_dates_path = f"{GTFS_DIR}/calendar_dates.txt"
        if os.path.exists(cal_dates_path):
            pd.read_csv(cal_dates_path, dtype=str).fillna("").to_sql(
                "calendar_dates", conn, if_exists="replace", index=False
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_caldates ON calendar_dates(date, exception_type)")

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


def _update_gtfs():
    """GTFSスタティックデータを再ダウンロードしてDBとメモリを更新する（週1回実行）"""
    from core.state import _load_gtfs_to_memory
    if not _gtfs_update_lock.acquire(blocking=False):
        print("⚠️  GTFS update already in progress, skipping")
        return
    try:
        print("🔄 GTFS weekly update started...")
        for fname in ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt",
                      "shapes.txt", "calendar.txt", "calendar_dates.txt"]:
            p = os.path.join(GTFS_DIR, fname)
            if os.path.exists(p):
                os.remove(p)

        zip_path = os.path.join(GTFS_DIR, "gtfs.zip")
        print("  Downloading GTFS...")
        _download_gtfs_zip(zip_path)
        print("  Extracting GTFS...")
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(GTFS_DIR)
        os.remove(zip_path)

        if os.path.exists(DB_PATH):
            os.remove(DB_PATH)
        build_gtfs_db()
        _load_gtfs_to_memory()
        print("✅ GTFS weekly update completed")

    except Exception as e:
        print(f"❌ GTFS weekly update failed: {e}")
    finally:
        _gtfs_update_lock.release()
