# Lab Manager

One pane of glass for the lab — control Raritan **PX4 PDUs** and view/launch **Dominion KX III / LX II KVMs** without juggling per-device browser tabs.

## Current state — Phase 1: UI mockup

The repo currently ships a **fully interactive UI mockup**. No backend, no installs needed — just a single HTML file you open in a browser. Use it to:

- See the dashboard layout for ~10–50 devices.
- Click outlets to toggle on/off/cycle (state persists in localStorage).
- Click KVM ports to open the live-viewer modal (simulated iframe stream).
- Add/remove devices via the **+ Add Device** form (also persisted locally).
- Decide what to change before we wire up the real Raritan APIs.

### Run the mockup

Open the file directly — no install, no terminal:

```
C:\Users\aizyaguev\lab-manager\mockup\index.html
```

Double-click it, or right-click → *Open with* → Edge / Chrome. That's it.

To reset the local state (re-load default mock devices), open the browser DevTools console (F12) and run:

```js
localStorage.clear(); location.reload();
```

To edit the seeded device list, open [`mockup/mock-data.js`](mockup/mock-data.js) — it's plain JS and reload picks it up after you clear localStorage.

---

## Phase 2 — real backend (planned)

| Layer | Choice | Why |
|---|---|---|
| Backend | Python **FastAPI** | Async, easy to talk to Raritan JSON-RPC + REST. |
| Frontend | React (Vite build) | Same components from the mockup, properly built. |
| DB | **PostgreSQL** | Encrypted device credentials at rest. |
| Crypto | Fernet, master key from `LAB_MANAGER_MASTER_KEY` env var | No plaintext passwords on disk. |
| Auth | **None** (network-trusted) | Internal lab network only — explicit decision. |

### Raritan integration plan

- **PX4 PDUs** — JSON-RPC v2 over HTTPS at `/bulk`. Methods like `org.raritan.outlets.Outlet.setPowerState` to toggle, `getPowerReading` for live watts/amps. PX4 also exposes a REST API; we'll use JSON-RPC for consistency with older PX gear if it ever shows up.
- **Dominion KX III** — REST API for port listing + status; HTML5 viewer embedded via iframe with a one-shot SSO token injected by the backend.
- **Dominion LX II** — Older, Java-era viewer. Live iframe embed will likely fail; the UI already falls back to "open native viewer in new tab" as a graceful degradation.

### Local install requirements (when Phase 2 starts)

Not installed on your Windows box as of today — you'll need:

- Python 3.11+ (from python.org)
- Node.js 20 LTS (from nodejs.org)
- PostgreSQL 16 (or we can swap to SQLite to drop this requirement)

Until then, the mockup is the working artifact.

---

## Project layout

```
lab-manager/
├── mockup/
│   ├── index.html      ← open this in a browser
│   └── mock-data.js    ← edit to change seeded devices
├── docs/               ← (reserved for design notes)
└── README.md
```

## Notes on the KVM viewer

The mockup's "live stream" inside the modal is a **simulation** rendered from an inline `srcdoc` — it shows the shape of what the real iframe will display once the backend is wired. For KX III the real version will iframe `https://<kvm-ip>/dom_kvm/connect?port=N&token=...`. For LX II we'll skip the iframe entirely and deep-link the native viewer in a new tab; the UI for that fallback is already in place.
