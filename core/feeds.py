import threading
import time

import requests
from google.transit import gtfs_realtime_pb2

from core.config import TRIP_UPDATES_URL, SEQ_COMBINED_URL, SEQ_ALERTS_URL, VEHICLE_POS_URL

_feed_cache: dict    = {"data": None, "expires": 0.0}
_feed_lock           = threading.Lock()

_vehicle_cache: dict = {"data": None, "expires": 0.0}
_vehicle_lock        = threading.Lock()

_seq_cache: dict     = {"data": None, "expires": 0.0}
_seq_lock            = threading.Lock()

_alerts_cache: dict  = {"data": None, "expires": 0.0}
_alerts_lock         = threading.Lock()


def _fetch_feed(url: str) -> gtfs_realtime_pb2.FeedMessage:
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(resp.content)
    return feed


def get_feed() -> gtfs_realtime_pb2.FeedMessage:
    """TripUpdates フィード（30秒TTL）"""
    with _feed_lock:
        if time.time() < _feed_cache["expires"] and _feed_cache["data"] is not None:
            return _feed_cache["data"]
        feed = _fetch_feed(TRIP_UPDATES_URL)
        _feed_cache["data"] = feed
        _feed_cache["expires"] = time.time() + 30
        return feed


def get_vehicle_feed() -> gtfs_realtime_pb2.FeedMessage:
    """VehiclePositions フィード（15秒TTL）"""
    with _vehicle_lock:
        if time.time() < _vehicle_cache["expires"] and _vehicle_cache["data"] is not None:
            return _vehicle_cache["data"]
        feed = _fetch_feed(VEHICLE_POS_URL)
        _vehicle_cache["data"] = feed
        _vehicle_cache["expires"] = time.time() + 15
        return feed


def get_seq_feed() -> gtfs_realtime_pb2.FeedMessage:
    """SEQ combined フィード（60秒TTL、サービスアラート用）"""
    with _seq_lock:
        if time.time() < _seq_cache["expires"] and _seq_cache["data"] is not None:
            return _seq_cache["data"]
        feed = _fetch_feed(SEQ_COMBINED_URL)
        _seq_cache["data"] = feed
        _seq_cache["expires"] = time.time() + 60
        return feed


def get_alerts_feed() -> gtfs_realtime_pb2.FeedMessage:
    """SEQ/Alerts フィード（60秒TTL）"""
    with _alerts_lock:
        if time.time() < _alerts_cache["expires"] and _alerts_cache["data"] is not None:
            return _alerts_cache["data"]
        feed = _fetch_feed(SEQ_ALERTS_URL)
        _alerts_cache["data"] = feed
        _alerts_cache["expires"] = time.time() + 60
        return feed
