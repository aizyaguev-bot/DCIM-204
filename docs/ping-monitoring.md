# Server ping monitoring

Open **Ping Monitor**, or `/?tab=monitoring`, in Lab Manager.

## Schedule and operation

- Every day, 07:00 through 19:55: checks every 5 minutes.
- At 20:00, 20:30, and each half hour through 06:30: checks every 30 minutes.
- At 07:00 the daytime schedule resumes. Timezone: `Asia/Jerusalem`, including DST.
- The first installation checks immediately; later restarts catch up a missed round
  once, without inventing historical results. The regular schedule uses wall-clock
  boundaries, not the time a browser was opened.
- **Check all now** queues an additional round without changing the regular slots.
- The backend process must remain running and have network access to the servers.
  Closing the browser does not stop monitoring. If the monitoring machine stops,
  it cannot observe outages during that gap; overdue results are marked as such.

## Server discovery and addresses

Each round refreshes PDU/KVM labels and imports named servers from those labels,
plus items of type `computer` or `server` in the shared rack inventory. Discovery
does not use a PDU/KVM management IP as the connected server's IP. It does not
scan subnets or require server credentials. Port-label refreshes are read-only.

Duplicate names are folded case-insensitively. `Optn84 (2)` and `Optn84` refer to
the same host; descriptive OPT suffixes such as `(SSD)` are stripped. Default
`Port 1` / `Outlet 1` labels are ignored. Names that cannot be DNS hostnames, such
as `Opt (unlabeled)`, appear as **Needs address** and are not probed.

Valid names are used as DNS hostnames by default. The Lab Manager host must resolve
them to the intended server. Choose **Details**, enter an IP or hostname, and save
to override any address. Computer inventory `ip`/`hostname` fields are imported
when a monitoring target is first created. Later discovery preserves overrides.
Use **Add server** for machines without port labels or computer inventory entries.

Discovery retains imported targets and history even if an inventory entry is
removed or renamed. Pause an old target in **Details** when retiring/renaming it.
This prevents a failed device discovery from silently removing monitoring.
Pausing or changing an address closes an open incident with that reason, without
claiming the old address recovered. Old checks retain the address actually tested.

## Results and retention

### PDU and KVM columns

Each scheduled round also reads each enabled PDU/KVM once, with up to eight devices
in parallel and a twelve-second deadline per device. **Check all now** refreshes
these observations too. Port associations use the same normalized server names as
discovery, with current saved labels taking precedence. A matching rack or a device
management address alone never establishes a server-to-port association.

All matching feeds/ports are displayed, including multiple PDU outlets for a server.
Each entry identifies the device and outlet/port number. **Details** shows its check
time and explanation. The **Needs attention** filter includes failed, missing,
disabled, unverified and overdue connections even when the server answers ping.

- PDU **Power on/off/cycling** describes the actual reported outlet state. It is not
  inferred from the PDU management interface responding or a nonzero watt reading.
- KVM **Port active/idle** requires a recognized live state and explicit port number
  from the device API. It does not test a working video/keyboard console session.
- Older KVMs may expose only configured ports. **Configured · unverified** means
  the device responded and lists the port, but live console health is unknown.
  A static fallback list or an unknown state displays **Port unverified**, never green.
- **Check failed** can mean a network, authentication or API failure. The previous
  success is not reused. **Not linked** means no matching port label was found;
  configure the correct server name on its PDU/KVM port in the existing device UI.
- After a missed schedule plus two minutes, a device observation becomes **Overdue**.
  Associations learned from live labels survive device check failures. Changing a
  device address requires a new check; disabling it does not show an old success.

Latest device observations persist in a separate additive database table, shared
by all workers and retained across restarts. The history and failure/recovery log
remain **ICMP-only**; PDU/KVM observations are latest snapshots, not incident history.
These three signals help investigate failures but cannot establish 100% server or
application health. The monitoring code performs no power operations.

### Ping observations

One ICMP echo request is sent per target per round, with a 3-second reply timeout
and a 10-second total subprocess/DNS timeout. Up to 8 probes run concurrently.

- **Reachable**: an ICMP echo reply was received; RTT is shown when available.
- **No reply**: timeout or an ICMP destination error; starts/continues an incident.
- **Probe error**: DNS, missing ping utility, local permissions or process failure.
  This neither opens a server outage nor marks an existing one recovered.
- **Overdue**: the next expected check is more than two minutes late. The previous
  result remains in history, without being presented as current health.
- **Paused / Needs address / Awaiting check** are shown explicitly.

Every result persists in the existing database for 30 days. Closed incidents are
kept for 90 days; open incidents are retained. A successful check closes an incident
as recovered. The log shows the first and last failed checks and first successful
check; the CSV also includes the previous successful check. The page shows the
latest 200 incidents and 200 checks per target; CSV exports the latest 10,000
incidents, with UTC ISO timestamps for comparison with other logs.

These are observations, not exact continuous downtime: an outage can start after
the previous successful probe and end before the next one. Failures lasting a few
minutes can fall entirely between probes, particularly during the 30-minute night
schedule. An ICMP failure alone does not prove a server crashed; network or firewall
changes can also prevent replies. Optional email notifications, including an
additional one-minute probe mode, are described in [Email alerts](email-alerts.md).
They are disabled until configured. Incidents and current states remain visible
in the tab and CSV regardless of email configuration.

## Installation / update

### Existing Linux VM: automatic installer

Download `scripts/install-monitoring.py` from the exact full commit SHA being
installed, then run it with the application's existing Python environment:

```bash
backend/.venv/bin/python /path/to/install-monitoring.py FULL_COMMIT_SHA --project "$PWD"
```

The installer validates a clean/compatible checkout, fetches that immutable commit,
and checks Python dependencies, Israel timezone data, a real local ICMP reply,
API startup and the built frontend before stopping the running application.
It does not require Node, sudo, system Python or an automatic package upgrade.
On a Linux VM with system timezone data, a separate `tzdata` installation is not
needed. If the existing environment lacks a required dependency, preflight stops
and reports the failure while the current backend remains running.

After preflight it stops only a matching uvicorn process owned by the current user
in this project's backend directory, saves `.env`, databases, runtime JSON and
live Twin data in private `.monitor-backups/`, fast-forwards the code and starts
the backend detached from SSH. It checks the deployed version and authenticated
monitor health, and rolls back its source update if startup/health fails. It reuses
the barcode install lock to prevent concurrent deployments. Existing VM reboot
startup configuration is left in place; this script does not create a boot service.
Local source changes, diverged history or an unrelated process on port 8000 cause
installation to stop without overwriting those changes or stopping that process.
The release must include the commit currently deployed on the VM, including any
barcode updates installed from another branch. If this ancestry check fails, use
an integrated release; do not reset the VM to an older version to bypass it.
For a locally modified npm lockfile, the optional `--backup-frontend-lock` flag
saves its exact contents in the private backup before installing the reviewed
lockfile. Other local source edits still prevent installation.

For the v3 design and real user accounts, also pass `--enable-accounts`. The
installer verifies account-mode startup and sign-in with an isolated test admin
before changing the running site. It then enables accounts using the existing
site password for the first admin and checks version, inventory and monitoring
through an authenticated session. The previous `.env` is restored on failure.
The lab's deployment URL is http://ftlab.nvidia.com:8000/; open Dashboard after
installation. See [user accounts](user-accounts.md) for roles and sign-in.

If installation reports `The old backend has not stopped`, the graceful shutdown
timed out before any application files changed. The optional
`--finish-stuck-shutdown` takes a consistent online SQLite snapshot and copies the
runtime configuration into the private backup's `before-stop/` directory before
sending any shutdown signal. After a normal 20-second shutdown attempt, it
rechecks process ownership, the project's backend directory, uvicorn arguments
and process start time, and finishes stopping only that verified process. It
still aborts if the snapshot fails, the process no longer matches, or port 8000
remains occupied. Normal post-shutdown backups and rollback checks remain in use.
Newly started backends limit uvicorn's wait for connections and background
requests during shutdown to 10 seconds.

### Manual installation

Update this application's code and built frontend on the existing Lab Manager
host. Stop the backend before updating, and retain its `.env`, database and runtime
JSON files. This feature adds tables with `create_all`; it does not reseed devices
or replace existing inventory. Back up the database as part of the normal update.

Using the application's Python environment from the project root:

```sh
python -m pip install -r backend/requirements.txt
```

If installing from source instead of the included `frontend/dist` build:

```sh
cd frontend
npm ci
npm run build
```

Restart the existing backend service. On Windows, the existing `start.bat` starts
it; on the configured Linux deployment, restart the `lab-manager` service. Do not
run `seed.py` to install this feature over a live database.

Configuration in the existing `.env` (both values have these defaults):

```dotenv
PING_MONITOR_ENABLED=true
PING_MONITOR_TIMEZONE=Asia/Jerusalem
```

Windows uses the built-in PowerShell/.NET ICMP implementation with numeric status
codes, so localized ping text and misleading process exit codes cannot appear as
successful replies. Child processes have no visible windows. Linux requires the
system `ping` utility (`iputils-ping` on Debian/Ubuntu) to be available to the backend
service account; Linux permissions/capabilities must allow that account to ping.
The `tzdata` Python dependency provides timezone data on Windows. These are standard
[Windows ICMP](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/ping)
and [Python timezone](https://docs.python.org/3/library/zoneinfo.html) mechanisms.

Multiple workers sharing the database use an atomic, renewable lease so scheduled
rounds do not duplicate each other. A crashed worker's lease expires in two minutes.
Do not start separate monitoring deployments with separate database copies for the
same lab unless duplicate checks are intended.

## Validation

```sh
cd backend
python -m pytest tests/ --ignore=tests/test_kvm_regression.py
```

`test_kvm_regression.py` requires the live lab; run it on the deployment host when
applicable. After deployment, use **Check all now**, verify a known server, and
confirm there are no **Needs address**, **Probe error** or **Overdue** entries left
unexplained. The implementation was tested locally; lab DNS/ICMP connectivity must
be verified from the real monitoring host.
