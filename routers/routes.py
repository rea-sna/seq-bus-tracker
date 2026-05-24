import os

from fastapi import APIRouter, HTTPException, Request

from core import state
from core.config import DB_PATH
from core.db import get_db
from routers.deps import limiter

router = APIRouter()


@router.get("/api/routes/search")
@limiter.limit("60/minute")
def search_routes(request: Request, q: str = ""):
    """路線番号・路線名で検索"""
    if state.bus_routes_df is None:
        raise HTTPException(503, "GTFS data not loaded")
    if len(q) < 1:
        return []
    mask = (
        state.bus_routes_df["route_short_name"].str.contains(q, case=False, na=False) |
        state.bus_routes_df["route_long_name"].str.contains(q, case=False, na=False)
    )
    matched = state.bus_routes_df[mask].reset_index()
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


@router.get("/api/routes/{route_id}/stops")
@limiter.limit("30/minute")
def get_route_stops(request: Request, route_id: str, direction: int = 0):
    """路線の代表便のバス停一覧を方向別に返す"""
    if not state.trips_dict or not os.path.exists(DB_PATH):
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
    headsign  = str(best_trip["trip_headsign"] or "") if best_trip else ""
    shape_id  = (state.trips_dict.get(best_trip_id) or {}).get("shape_id") or ""

    direction_headsigns: dict = {}
    for d in ["0", "1"]:
        d_trips = [r for r in trip_rows if str(r["direction_id"]) == d]
        if d_trips:
            direction_headsigns[d] = str(d_trips[0]["trip_headsign"] or "")

    return {
        "headsign":            headsign,
        "shape_id":            shape_id,
        "direction_headsigns": direction_headsigns,
        "stops": [
            {
                "stop_id":   str(r["stop_id"]),
                "stop_name": str(r["stop_name"] or ""),
                "stop_lat":  float(r["stop_lat"] or 0.0),
                "stop_lon":  float(r["stop_lon"] or 0.0),
                "routes":    state._merge_routes([str(r["stop_id"])]),
            }
            for r in stops_rows
        ],
    }


@router.get("/api/shapes/{shape_id:path}")
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
