import os

from fastapi import APIRouter, BackgroundTasks

from core.loader import _gtfs_update_lock, _update_gtfs

router = APIRouter()


@router.post("/api/admin/update-gtfs")
def admin_update_gtfs(background_tasks: BackgroundTasks):
    """GTFSデータを手動で更新する（ローカル開発用）"""
    if not _gtfs_update_lock.acquire(blocking=False):
        return {"status": "already_running"}
    _gtfs_update_lock.release()
    background_tasks.add_task(_update_gtfs)
    return {"status": "started"}


@router.get("/api/status")
def get_status():
    from core import state
    return {"status": state.gtfs_status}


@router.get("/api/config")
def get_config():
    return {
        "demo_enabled": os.environ.get("DEMO_MODE_ENABLED", "").lower() in ("1", "true", "yes"),
    }
