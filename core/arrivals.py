import datetime
import os

from core import state
from core.config import BRISBANE_TZ, DB_PATH
from core.db import get_db


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
