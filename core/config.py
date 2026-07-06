import datetime as _dt
import os

_BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

GTFS_DIR = os.path.join(_BASE_DIR, "gtfs")
DB_PATH  = os.path.join(GTFS_DIR, "gtfs.db")
GTFS_URL = "https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip"

TRIP_UPDATES_URL = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Bus"
SEQ_COMBINED_URL = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ"
SEQ_ALERTS_URL   = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/Alerts"
VEHICLE_POS_URL  = "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus"

# ブリスベンは UTC+10 固定（サマータイムなし）
BRISBANE_TZ = _dt.timezone(_dt.timedelta(hours=10))
