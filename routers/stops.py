import datetime

import numpy as np
from fastapi import APIRouter, HTTPException, Request

from core import state
from core.config import BRISBANE_TZ, DB_PATH
from core.db import get_db
from routers.deps import limiter

router = APIRouter()


@router.get("/api/stops/search")
@limiter.limit("60/minute")
def search_stops(request: Request, q: str = ""):
    """
    バス停名で検索。parent_stationでグループ化し、
    ターミナルは1件にまとめて配下のホーム情報を含めて返す。
    """
    if state.stops_df is None:
        raise HTTPException(503, "GTFS data not loaded")
    if len(q) < 1:
        return []

    df = state.stops_df
    has_parent   = "parent_station" in df.columns
    has_loc_type = "location_type"  in df.columns
    has_platform = "platform_code"  in df.columns
    has_stopcode = "stop_code"      in df.columns

    mask = (
        df["stop_name"].str.contains(q, case=False, na=False) |
        df["stop_id"].astype(str).str.contains(q, case=False, na=False)
    )
    if has_stopcode:
        mask = mask | df["stop_code"].astype(str).str.contains(q, case=False, na=False)
    matched = df[mask].copy()

    results = []
    seen_parents = set()
    individual_by_name = {}

    for row in matched.to_dict('records'):
        parent = row.get("parent_station", "") if has_parent else ""
        loc    = row.get("location_type",  "") if has_loc_type else ""

        if loc == "1":
            continue

        if parent:
            if parent in seen_parents:
                continue
            seen_parents.add(parent)

            siblings = df[df["parent_station"] == parent].copy()
            parent_row = df[df["stop_id"] == parent]
            if not parent_row.empty:
                station_name = parent_row.iloc[0]["stop_name"]
                station_lat  = float(parent_row.iloc[0]["stop_lat"])
                station_lon  = float(parent_row.iloc[0]["stop_lon"])
            else:
                station_name = row["stop_name"]
                station_lat  = float(row["stop_lat"])
                station_lon  = float(row["stop_lon"])

            platforms = []
            for sib in siblings.to_dict('records'):
                if sib.get("location_type", "") == "1":
                    continue
                pf = sib.get("platform_code", "") if has_platform else ""
                platforms.append({
                    "stop_id":       sib["stop_id"],
                    "stop_name":     sib["stop_name"],
                    "stop_lat":      float(sib["stop_lat"]),
                    "stop_lon":      float(sib["stop_lon"]),
                    "platform_code": pf,
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
                "routes":          state._merge_routes(siblings["stop_id"].tolist()),
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
                "routes":          state._merge_routes([row["stop_id"]]),
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
                "routes":          state._merge_routes([r["stop_id"] for r in rows]),
            })

    return [r for r in results if r.get("routes")][:20]


@router.get("/api/stops/nearby")
@limiter.limit("20/minute")
def get_nearby_stops(request: Request, lat: float, lon: float, radius: int = 500, limit: int = 10):
    """現在地から半径radius(m)以内のバス停を近い順に返す"""
    if state.stops_df is None:
        raise HTTPException(503, "GTFS data not loaded")

    df = state.stops_df
    p = np.pi / 180.0
    R = 6371000.0
    dlat = (state._stops_lat_arr - lat) * p
    dlon = (state._stops_lon_arr - lon) * p
    a = (np.sin(dlat / 2.0) ** 2
         + np.cos(lat * p) * np.cos(state._stops_lat_arr * p) * np.sin(dlon / 2.0) ** 2)
    all_dists = 2.0 * R * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))

    sid_to_dist = dict(zip(df["stop_id"].values, all_dists))

    has_parent   = "parent_station" in df.columns
    has_loc_type = "location_type"  in df.columns
    has_platform = "platform_code"  in df.columns

    if has_loc_type:
        not_parent_mask = (df["location_type"] != "1").values
    else:
        not_parent_mask = np.ones(len(df), dtype=bool)
    within_radius_mask = all_dists <= radius
    candidate_df = df[not_parent_mask & within_radius_mask]

    results = []
    seen_parents = set()
    individual_by_name = {}

    for row in candidate_df.to_dict('records'):
        parent = row.get("parent_station", "") if has_parent else ""
        if parent:
            if parent in seen_parents:
                continue
            seen_parents.add(parent)
            parent_row = df[df["stop_id"] == parent]
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

            siblings = df[df["parent_station"] == parent]
            platforms = []
            for sib in siblings.to_dict('records'):
                if str(sib.get("location_type", "")) == "1":
                    continue
                pf = sib.get("platform_code", "") if has_platform else ""
                platforms.append({
                    "stop_id":       str(sib["stop_id"]),
                    "stop_name":     str(sib["stop_name"]),
                    "stop_lat":      float(sib["stop_lat"]),
                    "stop_lon":      float(sib["stop_lon"]),
                    "platform_code": str(pf),
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
                "routes":          state._merge_routes(siblings["stop_id"].astype(str).tolist()),
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
                "routes":          state._merge_routes([row["stop_id"]]),
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
                "routes":          state._merge_routes([r["stop_id"] for r, _ in rows_dists]),
                "distance_m":      round(min_dist),
            })

    results.sort(key=lambda x: x["distance_m"])
    return [r for r in results if r.get("routes")][:limit]


@router.get("/api/stops/{stop_id}/timetable")
@limiter.limit("30/minute")
def get_stop_timetable(request: Request, stop_id: str, route_id: str, date: str = None):
    """指定バス停×路線の1日分の時刻表を返す"""
    import os as _os
    if not _os.path.exists(DB_PATH):
        raise HTTPException(503, "GTFS data not loaded")

    DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    if date:
        try:
            target_date = datetime.datetime.strptime(date, "%Y-%m-%d").date()
        except ValueError:
            target_date = datetime.datetime.now(BRISBANE_TZ).date()
    else:
        target_date = datetime.datetime.now(BRISBANE_TZ).date()

    target_str = target_date.strftime("%Y%m%d")
    day_name   = DAY_NAMES[target_date.weekday()]
    conn = get_db()

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
        pass

    if active_ids:
        svc_ph = ",".join("?" * len(active_ids))
        rows = conn.execute(f"""
            SELECT st.arrival_time, st.arrival_secs,
                   t.trip_id, t.trip_headsign, t.direction_id
            FROM stop_times st
            JOIN trips t ON st.trip_id = t.trip_id
            WHERE st.stop_id = ?
              AND t.route_id = ?
              AND t.service_id IN ({svc_ph})
            ORDER BY st.arrival_secs
        """, [stop_id, route_id, *active_ids]).fetchall()
    else:
        rows = conn.execute("""
            SELECT st.arrival_time, st.arrival_secs,
                   t.trip_id, t.trip_headsign, t.direction_id
            FROM stop_times st
            JOIN trips t ON st.trip_id = t.trip_id
            WHERE st.stop_id = ?
              AND t.route_id = ?
            ORDER BY st.arrival_secs
        """, [stop_id, route_id]).fetchall()

    seen_trip_ids: set = set()
    departures = []
    for row in rows:
        trip_id = row["trip_id"]
        if trip_id in seen_trip_ids:
            continue
        seen_trip_ids.add(trip_id)
        parts = (row["arrival_time"] or "00:00:00").split(":")
        h = int(parts[0]) % 24
        departures.append({
            "time":     f"{h:02d}:{parts[1]}",
            "headsign": str(row["trip_headsign"] or ""),
        })

    return {"date": target_str, "departures": departures, "is_fallback": not bool(active_ids)}


@router.get("/api/stops/{stop_id}")
@limiter.limit("60/minute")
def get_stop(request: Request, stop_id: str):
    """バス停の詳細情報"""
    if state.stops_df is None:
        raise HTTPException(503, "GTFS data not loaded")
    row = state.stops_df[state.stops_df["stop_id"] == str(stop_id)]
    if row.empty:
        raise HTTPException(404, "Stop not found")
    r = row.iloc[0]
    parent   = str(r.get("parent_station", "") or "")
    loc_type = str(r.get("location_type",  "") or "")
    if parent:
        sib_ids = state.stops_df[state.stops_df["parent_station"] == parent]["stop_id"].tolist()
        routes = state._merge_routes(sib_ids)
    elif loc_type == "1":
        child_ids = state.stops_df[state.stops_df["parent_station"] == str(stop_id)]["stop_id"].tolist()
        routes = state._merge_routes(child_ids) if child_ids else state._merge_routes([str(r["stop_id"])])
    else:
        routes = state._merge_routes([str(r["stop_id"])])
    return {
        "stop_id":     r["stop_id"],
        "stop_name":   r["stop_name"],
        "stop_lat":    float(r["stop_lat"]),
        "stop_lon":    float(r["stop_lon"]),
        "routes":      routes,
        "is_terminal": loc_type == "1",
    }
