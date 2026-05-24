import requests
from fastapi import APIRouter, HTTPException, Request

from core.feeds import get_vehicle_feed
from routers.deps import limiter

router = APIRouter()


@router.get("/api/vehicles/{vehicle_id}/position")
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


@router.get("/api/trips/{trip_id:path}/vehicle")
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
