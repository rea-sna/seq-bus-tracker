import time

import requests
from fastapi import APIRouter, HTTPException, Request

from core import state
from core.feeds import get_seq_feed, get_alerts_feed
from routers.deps import limiter

router = APIRouter()

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


@router.get("/api/alerts")
@limiter.limit("20/minute")
def get_alerts(request: Request):
    """GTFS-RT ServiceAlerts を返す（アクティブな警報のみ）。SEQ combined + SEQ/Alerts をマージ"""
    entities: dict = {}
    for fetch_fn in (get_seq_feed, get_alerts_feed):
        try:
            feed = fetch_fn()
            for ent in feed.entity:
                if ent.HasField("alert") and ent.id not in entities:
                    entities[ent.id] = ent
        except requests.RequestException:
            pass

    if not entities:
        raise HTTPException(502, "Translink API error: both alert feeds failed")

    now = time.time()
    alerts = []

    for entity in entities.values():
        if not entity.HasField("alert"):
            continue
        alert = entity.alert

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

        route_ids = []
        stop_ids  = []
        for ie in alert.informed_entity:
            if ie.route_id:
                route_ids.append(ie.route_id)
            if ie.stop_id:
                stop_ids.append(ie.stop_id)

        route_short_names = []
        for rid in route_ids:
            if state.bus_routes_df is not None and rid in state.bus_routes_df.index:
                rsn = str(state.bus_routes_df.loc[rid].get("route_short_name", "") or "")
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
