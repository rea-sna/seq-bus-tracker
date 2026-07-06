import sqlite3
import threading

from core.config import DB_PATH

_db_local = threading.local()
_db_generation = 0


def get_db() -> sqlite3.Connection:
    """スレッドローカルなSQLite接続を返す（世代が変わると自動再接続）"""
    if (not hasattr(_db_local, "conn") or _db_local.conn is None
            or getattr(_db_local, "generation", -1) != _db_generation):
        if hasattr(_db_local, "conn") and _db_local.conn is not None:
            try:
                _db_local.conn.close()
            except Exception:
                pass
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        _db_local.conn = conn
        _db_local.generation = _db_generation
    return _db_local.conn


def _arrival_secs(time_str: str):
    """'HH:MM:SS' を深夜0時からの秒数に変換（25時間表記対応）"""
    try:
        p = time_str.split(":")
        return int(p[0]) * 3600 + int(p[1]) * 60 + int(p[2])
    except Exception:
        return None
