import datetime
import os
import time

import requests
from fastapi import APIRouter, HTTPException, Request

from core import state
from core.config import BRISBANE_TZ, DB_PATH
from core.db import get_db
from core.feeds import get_feed
from routers.deps import limiter

router = APIRouter()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _demo_now() -> float:
    """デモ用基準時刻: 今日のブリスベン時間 08:00"""
    today = datetime.datetime.now(BRISBANE_TZ).date()
    return datetime.datetime(today.year, today.month, today.day, 8, 0, 0,
                             tzinfo=BRISBANE_TZ).timestamp()


def _dedup_arrivals(arrivals: list) -> list:
    """trip_id の重複を排除する（arrival_time ソート済みを前提に先着優先）"""
    seen: set = set()
    out = []
    for a in arrivals:
        if a["trip_id"] not in seen:
            seen.add(a["trip_id"])
            out.append(a)
    return out


def _parse_timetable_ts(date_str: str, time_str: str):
    """date='YYYY-MM-DD', time_str='HH:MM' → Brisbane Unix timestamp"""
    try:
        target_date = datetime.date.fromisoformat(date_str) if date_str else datetime.datetime.now(BRISBANE_TZ).date()
        parts = (time_str or "00:00").split(":")
        h, m = int(parts[0]), int(parts[1])
        return datetime.datetime(target_date.year, target_date.month, target_date.day,
                                 h, m, 0, tzinfo=BRISBANE_TZ).timestamp()
    except Exception:
        return None


def get_static_arrivals(stop_id_list: list, now: float, day_offset: int = 0,
                        limit: int = 15, base_date=None):
    """
    SQLiteから静的時刻を取得し、到着情報リストを返す。
    day_offset=0 → base_date当日、day_offset=1 → base_date翌日
    base_date が None の場合はブリスベン現在日を使用。
    """
    if not os.path.exists(DB_PATH):
        return []

    DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    if base_date is None:
        base_date = datetime.datetime.now(BRISBANE_TZ).date()
    target_date = base_date + datetime.timedelta(days=day_offset)
    target_str  = target_date.strftime("%Y%m%d")
    day_name    = DAY_NAMES[target_date.weekday()]
    base_ts     = datetime.datetime(target_date.year, target_date.month, target_date.day,
                                    tzinfo=BRISBANE_TZ).timestamp()

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
    seen_trip_ids: set = set()
    seen_slots: set = set()
    for row in rows:
        arr_ts  = base_ts + row["arrival_secs"]
        if arr_ts <= now:
            continue
        trip_id = row["trip_id"]
        if trip_id in seen_trip_ids:
            continue
        slot = (str(row["stop_id"]), str(row["route_id"]), str(row["direction_id"] or ""), row["arrival_secs"])
        if slot in seen_slots:
            continue
        seen_trip_ids.add(trip_id)
        seen_slots.add(slot)
        stop_id = str(row["stop_id"])
        is_last_stop = state.last_stop_by_trip.get(trip_id) == stop_id
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
        if len(arrivals) >= limit:
            break

    return arrivals


def _route_info(trip_id: str):
    """trips_dict と bus_routes_df から route 表示情報を返す"""
    trip = state.trips_dict.get(trip_id)
    if trip is None:
        return None, "?", "", "", ""
    route_id = trip["route_id"]
    headsign = trip["trip_headsign"]
    if state.bus_routes_df is not None and route_id in state.bus_routes_df.index:
        row = state.bus_routes_df.loc[route_id]
        rc  = str(row.get("route_color",      "") or "")
        rtc = str(row.get("route_text_color", "") or "")
        return (
            trip,
            str(row["route_short_name"]),
            str(row.get("route_long_name", "") or ""),
            f"#{rc}"  if rc  else "",
            f"#{rtc}" if rtc else "",
        )
    return trip, "?", "", "", ""


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
