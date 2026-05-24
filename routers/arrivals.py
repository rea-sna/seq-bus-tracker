import datetime
import os
import time

import requests
from fastapi import APIRouter, HTTPException, Request

from core import state
from core.arrivals import (
    _demo_now, _dedup_arrivals, _parse_timetable_ts,
    get_static_arrivals, _route_info,
)
from core.config import BRISBANE_TZ, DB_PATH
from core.feeds import get_feed
from routers.deps import limiter

router = APIRouter()


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/api/terminal/{parent_id}/arrivals")
@limiter.limit("30/minute")
def get_terminal_arrivals(request: Request, parent_id: str, demo: bool = False,
                          date: str = None, from_time: str = None):
    """ターミナルの全ホームをまとめて取得し、platform_codeを付与して返す"""
    if state.stops_df is None or not state.trips_dict:
        raise HTTPException(503, "GTFS data not loaded")

    df = state.stops_df
    has_parent   = "parent_station" in df.columns
    has_platform = "platform_code"  in df.columns

    if has_parent:
        children = df[df["parent_station"] == parent_id]
    else:
        children = df[df["stop_id"] == parent_id]

    platform_map = {}
    for _, r in children.iterrows():
        pf = r.get("platform_code", "") if has_platform else ""
        platform_map[r["stop_id"]] = pf

    child_ids = set(platform_map.keys())
    if not child_ids:
        raise HTTPException(404, "Terminal not found")

    if (date or from_time) and not demo:
        ref_ts = _parse_timetable_ts(date or "", from_time or "")
        if ref_ts is None:
            raise HTTPException(400, "Invalid date or time format")
        ref_date = datetime.date.fromisoformat(date) if date else datetime.datetime.now(BRISBANE_TZ).date()
        arrivals: list = []
        seen_trip_ids: set = set()
        for offset in [0, 1]:
            for a in get_static_arrivals(list(child_ids), ref_ts, offset, limit=30, base_date=ref_date):
                if a["trip_id"] not in seen_trip_ids:
                    seen_trip_ids.add(a["trip_id"])
                    a["platform_code"] = platform_map.get(a["stop_id"], "")
                    arrivals.append(a)
            if len(arrivals) >= 15:
                break
        arrivals.sort(key=lambda x: x["arrival_time"])
        return {"arrivals": _dedup_arrivals(arrivals)[:30], "rt_available": False, "is_timetable": True}

    now = _demo_now() if demo else time.time()

    if demo:
        arrivals = []
        for day_offset in [0, 1]:
            static = get_static_arrivals(list(child_ids), now, day_offset)
            for a in static:
                a["platform_code"] = platform_map.get(a["stop_id"], "")
                a["is_demo"] = True
            if static:
                arrivals = static
                break
        return {"arrivals": _dedup_arrivals(arrivals)[:20], "rt_available": True}

    arrivals = []
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
        return {"arrivals": _dedup_arrivals(arrivals)[:20], "rt_available": False}

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
            trip, route_short, route_long, route_color, route_text_color = _route_info(trip_id)
            if trip is None:
                continue
            is_last_stop = state.last_stop_by_trip.get(trip_id) == str(stu.stop_id)
            arrivals.append({
                "trip_id":          trip_id,
                "vehicle_id":       entity.trip_update.vehicle.id or "",
                "stop_id":          str(stu.stop_id),
                "platform_code":    platform_map.get(str(stu.stop_id), ""),
                "route_short_name": route_short,
                "route_long_name":  route_long,
                "headsign":         trip["trip_headsign"],
                "arrival_time":     arrival_time,
                "minutes_until":    max(0, int((arrival_time - now) / 60)),
                "delay_seconds":    delay,
                "shape_id":         trip["shape_id"],
                "route_color":      route_color,
                "route_text_color": route_text_color,
                "direction_id":     trip["direction_id"],
                "is_last_stop":     is_last_stop,
            })

    arrivals = _dedup_arrivals(arrivals)
    arrivals.sort(key=lambda x: x["arrival_time"])

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


@router.get("/api/stops/multi/arrivals")
@limiter.limit("30/minute")
def get_multi_stop_arrivals(request: Request, ids: str, demo: bool = False,
                            date: str = None, from_time: str = None):
    """同名バス停グループの全stop_idの到着情報を返す"""
    if state.stops_df is None or not state.trips_dict:
        raise HTTPException(503, "GTFS data not loaded")

    stop_id_list = [s.strip() for s in ids.split(",") if s.strip()]
    if not stop_id_list:
        raise HTTPException(400, "No stop IDs provided")

    if (date or from_time) and not demo:
        ref_ts = _parse_timetable_ts(date or "", from_time or "")
        if ref_ts is None:
            raise HTTPException(400, "Invalid date or time format")
        ref_date = datetime.date.fromisoformat(date) if date else datetime.datetime.now(BRISBANE_TZ).date()
        arrivals: list = []
        seen_trip_ids: set = set()
        for offset in [0, 1]:
            for a in get_static_arrivals(stop_id_list, ref_ts, offset, limit=30, base_date=ref_date):
                if a["trip_id"] not in seen_trip_ids:
                    seen_trip_ids.add(a["trip_id"])
                    arrivals.append(a)
            if len(arrivals) >= 15:
                break
        arrivals.sort(key=lambda x: x["arrival_time"])
        return {"arrivals": _dedup_arrivals(arrivals)[:30], "stop_directions": {}, "rt_available": False, "is_timetable": True}

    now = _demo_now() if demo else time.time()
    child_ids = set(stop_id_list)

    if demo:
        arrivals = []
        for day_offset in [0, 1]:
            arrivals = get_static_arrivals(stop_id_list, now, day_offset)
            if arrivals:
                for a in arrivals:
                    a["is_demo"] = True
                break
        stop_directions: dict = {}
        if state.trips_dict and os.path.exists(DB_PATH):
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
        return {"arrivals": _dedup_arrivals(arrivals)[:20], "stop_directions": stop_directions, "rt_available": True}

    arrivals = []
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
        return {"arrivals": _dedup_arrivals(arrivals)[:20], "stop_directions": {}, "rt_available": False}

    rt_seen_trip_ids: set = set()

    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        if entity.trip_update.trip.schedule_relationship == 5:  # CANCELED
            rt_seen_trip_ids.add(entity.trip_update.trip.trip_id)
            continue
        for stu in entity.trip_update.stop_time_update:
            if str(stu.stop_id) not in child_ids:
                continue
            if stu.schedule_relationship == 1:  # SKIPPED
                rt_seen_trip_ids.add(entity.trip_update.trip.trip_id)
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
            trip, route_short, route_long, route_color, route_text_color = _route_info(trip_id)
            if trip is None:
                continue
            rt_seen_trip_ids.add(trip_id)
            is_last_stop = state.last_stop_by_trip.get(trip_id) == str(stu.stop_id)
            arrivals.append({
                "trip_id":          trip_id,
                "vehicle_id":       entity.trip_update.vehicle.id or "",
                "stop_id":          str(stu.stop_id),
                "platform_code":    "",
                "route_short_name": route_short,
                "route_long_name":  route_long,
                "headsign":         trip["trip_headsign"],
                "arrival_time":     arrival_time,
                "minutes_until":    max(0, int((arrival_time - now) / 60)),
                "delay_seconds":    delay,
                "shape_id":         trip["shape_id"],
                "route_color":      route_color,
                "route_text_color": route_text_color,
                "direction_id":     trip["direction_id"],
                "is_last_stop":     is_last_stop,
            })

    arrivals = _dedup_arrivals(arrivals)
    arrivals.sort(key=lambda x: x["arrival_time"])

    if len(arrivals) < 20:
        rt_trip_ids = {a["trip_id"] for a in arrivals} | rt_seen_trip_ids
        for day_offset in [0, 1]:
            static = get_static_arrivals(stop_id_list, now, day_offset)
            for a in static:
                if a["trip_id"] not in rt_trip_ids:
                    arrivals.append(a)
            if static:
                break
        arrivals.sort(key=lambda x: x["arrival_time"])

    stop_directions: dict = {}
    if state.trips_dict and os.path.exists(DB_PATH):
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


@router.get("/api/stops/{stop_id}/arrivals")
@limiter.limit("30/minute")
def get_arrivals(request: Request, stop_id: str, demo: bool = False,
                 date: str = None, from_time: str = None):
    """指定バス停の次のバス一覧（リアルタイム）"""
    if not state.trips_dict:
        raise HTTPException(503, "GTFS data not loaded")

    if (date or from_time) and not demo:
        ref_ts = _parse_timetable_ts(date or "", from_time or "")
        if ref_ts is None:
            raise HTTPException(400, "Invalid date or time format")
        ref_date = datetime.date.fromisoformat(date) if date else datetime.datetime.now(BRISBANE_TZ).date()
        arrivals: list = []
        seen_trip_ids: set = set()
        for offset in [0, 1]:
            for a in get_static_arrivals([stop_id], ref_ts, offset, limit=30, base_date=ref_date):
                if a["trip_id"] not in seen_trip_ids:
                    seen_trip_ids.add(a["trip_id"])
                    arrivals.append(a)
            if len(arrivals) >= 15:
                break
        arrivals.sort(key=lambda x: x["arrival_time"])
        return {"arrivals": arrivals[:30], "rt_available": False, "is_timetable": True}

    now = _demo_now() if demo else time.time()

    if demo:
        arrivals = []
        for day_offset in [0, 1]:
            arrivals = get_static_arrivals([stop_id], now, day_offset)
            if arrivals:
                for a in arrivals:
                    a["is_demo"] = True
                break
        return {"arrivals": _dedup_arrivals(arrivals)[:15], "rt_available": True}

    arrivals = []
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
        return {"arrivals": _dedup_arrivals(arrivals)[:15], "rt_available": False}

    rt_seen_trip_ids: set = set()

    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        if entity.trip_update.trip.schedule_relationship == 5:  # CANCELED
            rt_seen_trip_ids.add(entity.trip_update.trip.trip_id)
            continue
        for stu in entity.trip_update.stop_time_update:
            if str(stu.stop_id) != str(stop_id):
                continue
            if stu.schedule_relationship == 1:  # SKIPPED
                rt_seen_trip_ids.add(entity.trip_update.trip.trip_id)
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
            trip, route_short, route_long, route_color, route_text_color = _route_info(trip_id)
            if trip is None:
                continue
            rt_seen_trip_ids.add(trip_id)
            is_last_stop = state.last_stop_by_trip.get(trip_id) == str(stop_id)
            arrivals.append({
                "trip_id":          trip_id,
                "vehicle_id":       entity.trip_update.vehicle.id or "",
                "stop_id":          stop_id,
                "platform_code":    "",
                "route_short_name": route_short,
                "route_long_name":  route_long,
                "headsign":         trip["trip_headsign"],
                "arrival_time":     arrival_time,
                "minutes_until":    max(0, int((arrival_time - now) / 60)),
                "delay_seconds":    delay,
                "shape_id":         trip["shape_id"],
                "route_color":      route_color,
                "route_text_color": route_text_color,
                "direction_id":     trip["direction_id"],
                "is_last_stop":     is_last_stop,
            })

    arrivals = _dedup_arrivals(arrivals)
    arrivals.sort(key=lambda x: x["arrival_time"])

    if len(arrivals) < 15:
        rt_trip_ids = {a["trip_id"] for a in arrivals} | rt_seen_trip_ids
        for day_offset in [0, 1]:
            static = get_static_arrivals([stop_id], now, day_offset)
            for a in static:
                if a["trip_id"] not in rt_trip_ids:
                    arrivals.append(a)
            if static:
                break
        arrivals.sort(key=lambda x: x["arrival_time"])

    return {"arrivals": arrivals[:15], "rt_available": rt_available}
