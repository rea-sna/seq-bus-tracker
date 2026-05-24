"""
Translink Bus Arrival API - FastAPI Backend
-------------------------------------------
Run:
    uvicorn main:app --reload --port 8000
"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from routers.deps import limiter
from routers import stops, arrivals, routes, vehicles, alerts, admin, trips
from core.loader import download_gtfs_if_needed, build_gtfs_db, _update_gtfs
from core.state import _load_gtfs_to_memory

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="Translink Bus API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(stops.router)
app.include_router(arrivals.router)
app.include_router(routes.router)
app.include_router(trips.router)
app.include_router(vehicles.router)
app.include_router(alerts.router)
app.include_router(admin.router)

# ── Scheduler ─────────────────────────────────────────────────────────────────
_scheduler = BackgroundScheduler(timezone="Australia/Brisbane")


@app.on_event("startup")
async def start_scheduler():
    _scheduler.add_job(
        _update_gtfs,
        CronTrigger(day_of_week="mon", hour=3, minute=0, timezone="Australia/Brisbane"),
        id="gtfs_weekly_update",
        replace_existing=True,
    )
    _scheduler.start()
    print("📅 GTFS weekly update scheduled — every Monday 03:00 Brisbane time")


@app.on_event("shutdown")
async def stop_scheduler():
    _scheduler.shutdown(wait=False)


# ── GTFS initialization ───────────────────────────────────────────────────────
download_gtfs_if_needed()
build_gtfs_db()
try:
    _load_gtfs_to_memory()
except Exception as _e:
    print(f"⚠️  GTFS load failed: {_e}")

# ── Static files ──────────────────────────────────────────────────────────────
_static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(_static_dir):
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
