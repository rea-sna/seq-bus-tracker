import datetime
import os
import time

from fastapi import APIRouter, HTTPException, Request

from core.config import BRISBANE_TZ, DB_PATH
from core.db import get_db
from core.feeds import get_feed
from routers.deps import limiter

router = APIRouter()


@router.get("/api/trips/{trip_id:path}/stops")
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
        rt_unix = rt_times.get(sid)
        predicted_unix = rt_unix if rt_unix else None

        passed = False
        if rt_unix:
            passed = rt_unix < now
        elif row["arrival_secs"] is not None:
            try:
                today = datetime.datetime.now(BRISBANE_TZ).date()
                base  = datetime.datetime(today.year, today.month, today.day, tzinfo=BRISBANE_TZ)
                passed = (base.timestamp() + row["arrival_secs"]) < now
            except Exception:
                pass

        stops_list.append({
            "stop_id":        sid,
            "stop_name":      row["stop_name"] or "",
            "stop_lat":       float(row["stop_lat"] or 0.0),
            "stop_lon":       float(row["stop_lon"] or 0.0),
            "static_time":    row["arrival_time"] or "",
            "predicted_unix": predicted_unix,
            "passed":         passed,
        })

    return {"trip_id": trip_id, "stops": stops_list}
