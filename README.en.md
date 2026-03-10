# SEQ Bus Tracker

Real-time bus arrival information for South East Queensland, powered by Translink's GTFS and GTFS-RT feeds.

[日本語版はこちら →](README.md)

---

## Features

- Real-time arrivals with delay / early badges
- Stop search by name and GPS-based nearby stop discovery
- Interactive route map with neon trace animation
- Stop timeline showing upcoming and passed stops
- Terminal/interchange support (multi-platform stops)
- Favourites for quick access to frequently used stops
- Auto-refresh every 30 seconds
- Static timetable fallback when real-time data is unavailable (including next-day buses)
- Mobile responsive, dark theme

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python / FastAPI |
| Frontend | Vanilla JS / Leaflet.js |
| Data | Translink GTFS Static + GTFS-RT |
| Deploy | Heroku / Render |

---

## Data Sources

### GTFS Static

| Item | Details |
|---|---|
| Provider | Translink (Queensland Department of Transport and Main Roads) |
| Licence | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Download URL | `https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip` |
| Coverage | South East Queensland (SEQ) bus network |
| Size | ~225 MB (ZIP) |
| Files used | `stops.txt`, `routes.txt`, `trips.txt`, `stop_times.txt`, `shapes.txt`, `calendar.txt`, `calendar_dates.txt` |
| Updates | Periodically by Translink; downloaded automatically on first startup |

### GTFS Realtime

| Item | Details |
|---|---|
| Provider | Translink Open Data |
| Licence | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Format | Protocol Buffers (GTFS-RT spec) |
| Authentication | None required |
| Trip Updates | `https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Bus` |
| Vehicle Positions | `https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus` |
| Update frequency | Approximately every 30–60 seconds |

### Map Tiles

| Item | Details |
|---|---|
| Provider | [CARTO](https://carto.com/) (via CartoDB) |
| Attribution | © [OpenStreetMap](https://www.openstreetmap.org/) contributors, © CARTO |
| Licence | [ODbL (OpenStreetMap data)](https://opendatacommons.org/licenses/odbl/) |

---

## Setup

### Requirements

- Python 3.9+

### Install

```bash
pip install -r requirements.txt
```

### Run

```bash
uvicorn main:app --reload --port 8000 --host 0.0.0.0
```

On first startup, GTFS static data (~225 MB) is automatically downloaded and extracted to `./gtfs/`. This takes approximately 5–10 minutes depending on your connection.

Open `http://localhost:8000` in your browser.

> **Note**: GPS location requires HTTPS (e.g. iPhone Safari). For local testing, use an HTTPS tunnel such as [ngrok](https://ngrok.com/).

---

## API Endpoints

| Method | Path | Description | Rate limit |
|---|---|---|---|
| GET | `/api/stops/search?q=` | Search stops by name | 60/min |
| GET | `/api/stops/nearby?lat=&lon=&radius=&limit=` | Stops near GPS coordinates | 20/min |
| GET | `/api/stops/{stop_id}/arrivals` | Real-time arrivals for a stop (next 15) | 30/min |
| GET | `/api/stops/{stop_id}` | Stop details | 60/min |
| GET | `/api/terminal/{parent_id}/arrivals` | Arrivals across all platforms of a terminal | 30/min |
| GET | `/api/shapes/{shape_id:path}` | Route shape coordinates | 30/min |
| GET | `/api/trips/{trip_id:path}/stops` | All stops for a trip with real-time predictions | 30/min |

Rate limiting is IP-based via [slowapi](https://github.com/laurentS/slowapi). Global default: 200 requests/minute.

---

## Deploy

### Heroku

```bash
heroku create your-app-name
git push heroku main
```

A `Procfile` is included. GTFS data is downloaded automatically on startup.

### Render

| Setting | Value |
|---|---|
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |

> **Note**: Free-tier Render instances sleep after inactivity and re-download GTFS (~225 MB) on wake. A paid plan is recommended for stable operation.

---

## Project Structure

```
├── main.py              # FastAPI backend (all API endpoints)
├── requirements.txt     # Python dependencies
├── Procfile             # Heroku start command
├── gtfs/                # GTFS static data (auto-downloaded, git-ignored)
└── static/
    ├── index.html
    ├── style.css
    └── app.js
```

---

## Licence

Code: [MIT](https://opensource.org/licenses/MIT)

Data: Translink Open Data, licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Attribution: © State of Queensland (Translink), 2024

---

## Built with

This app was developed in collaboration with [Claude Sonnet 4.6](https://www.anthropic.com/claude) (Anthropic).
