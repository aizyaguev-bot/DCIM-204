# Serving the twin from the Lab Manager backend (recommended)

Copy the `lab-twin` folder next to `frontend/` in the DCIM-204 repo and mount it **before** the SPA catch-all in `backend/app/main.py`:

```python
TWIN_DIR = pathlib.Path(__file__).parent.parent.parent / "lab-twin"

# Serve built React frontend if it exists
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")
    if TWIN_DIR.exists():
        app.mount("/twin", StaticFiles(directory=str(TWIN_DIR), html=True), name="twin")   # <-- add this line

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        ...
```

Then open `http://<vm>:8000/twin/`. Same origin → no CORS, the shared Basic-auth password is reused, and the twin auto-connects (it probes `/api/version` on load).

The twin only calls endpoints that already exist:

| Purpose | Endpoint |
|---|---|
| devices, labels | `GET /api/devices/` |
| OPT → U slot / order | `GET /api/rack-slots`, `GET /api/rack-positions` |
| OPT → network switch | `GET /api/switch-assignments` |
| owners, rack equipment, chillers, rack overrides | `GET /api/opt-owners`, `/api/rack-items`, `/api/chillers`, `/api/rack-overrides` |
| live power / env | `GET /api/pdus/{id}/status` (15 s poll) |
| **power control** | `POST /api/pdus/{id}/outlets/{n}/power` `{action: on|off|cycle}` |
| KVM ports | `GET /api/kvms/{id}/status` |
| **KVM console** | `POST …/ports/{p}/mark-in-use` → opens `/api/kvms/{id}/autologin?port={p}` |

No device IPs or credentials are ever stored in the twin; everything goes through the backend exactly like the React UI.

## Running from a local folder instead

`start-twin.bat` serves the folder on `http://localhost:8090` (Python 3.12 is already on the box). Then click **⚙ Backend**, enter `http://<vm>:8000` and the shared password. The backend already sends `Access-Control-Allow-Origin: *`.
