# Remote install (PXE) runbook

This guide is for the lab owner and for operators. It describes the **Remote install** page as the code
works today. Items marked **(planned)** are not built yet.

Remote install is **off by default**. When it is on, it starts in **simulation** and does not touch
real equipment. The real-KVM path has never been run against real hardware.

This guide contains no addresses, hostnames or passwords. Placeholders look like `<computer>`.

File references such as `runner.py:39` give the file and line. Short file names are in these folders:

| Folder | Files |
|---|---|
| `backend/app/pxe/` | `runner.py`, `parsers.py`, `rewrite.py`, `mapping.py`, `screen.py`, `sim_driver.py`, `raritan_driver.py` |
| `backend/app/` | `config.py`, `confirm.py`, `accounts.py`, `models.py`, `crypto.py`, `ping_monitor.py`, `routers/pxe.py` |
| `frontend/src/` | `App.jsx`, `components/Header.jsx`, `pages/RemoteInstallView.jsx` |
| `scripts/` | `lab-service.py`, `install-monitoring.py` |

---

## 1. What Remote install does

### Who can use it

- The **Remote install** tab appears only when `PXE_ENABLED=true`, and only for Operator and Admin
  accounts (`Header.jsx:9,18`, `App.jsx:384`). With user accounts on, every `/api/pxe/*` call needs
  the Operator role, and **Acknowledge** needs Admin (`accounts.py:82-83`).
- The server must have a password configured: either user accounts are on, or the shared Lab Manager
  password is set. Without one, the page says "Remote install requires a configured password", and
  creating, starting, installing and completing a job are all refused (`confirm.py:28-36`,
  `routers/pxe.py:109,175`).

### Step by step

| # | What the operator does | What the server does | Job state |
|---|---|---|---|
| 1 | Opens **Remote install**. | Lists the computers it found on KVM port labels (and the PDU outlets that carry the same label). A computer is listed only if at least one KVM port has its label. | — (`mapping.py:30-61`) |
| 2 | Picks a computer, the KVM port (only if the computer appears on more than one port), and a **Reboot method**. The default is **Ctrl+Alt+Del via KVM**. | Shows why a computer is not available (see "Computer list" in section 6). | — |
| 3 | Clicks **Reboot and open boot menu**, then enters a reason and the password. | Creates the job, checks the allowlist again, **opens the KVM console first**, takes a run slot, then reboots the computer using the chosen method. | `draft` → `rebooting` (`runner.py:817-853`) |
| 4 | Waits. | Watches the screen. When it sees a blank screen, the firmware screen or the boot menu, it presses F12, then keeps pressing F12 (at most every 0.5 s) until the boot menu can be read. | `rebooting` → `waiting_for_menu` (`runner.py:622-668`) |
| 5 | Chooses the network boot entry from the list on the page, next to the latest screenshot. | The options are read from the screen every time, never assumed in a fixed order. Only network entries (IPv4, IPv6, PXE, Network, NIC, LAN) can be chosen. The non-USB IPv4 entry is marked **Recommended**. Before pressing Enter, the server reads the menu again, moves the highlight and checks it. | `waiting_for_choice` (`parsers.py:124-141`, `runner.py:907-925`) |
| 6 | Waits. | Waits for the GRUB install menu. If it shows a countdown, it presses Up to stop it and checks that the countdown is gone. | `waiting_for_grub` (`runner.py:670-701`) |
| 7 | Chooses the install profile (GRUB entry). | Entries for the local drive, rescue, troubleshooting and memory test cannot be chosen. The server moves the highlight, checks it and presses `e` to edit the entry. | `waiting_for_grub_choice` (`parsers.py:125,144-149`) |
| 8 | Waits. | In the GRUB editor it replaces **only the host** of `inst.repo` and `inst.ks` on the `linux`/`linuxefi` line, then reads the screen again. The new text must match exactly; otherwise it presses Esc (which discards the edit) and stops. | `updating_urls` (`rewrite.py:140-164`, `runner.py:703-753`) |
| 9 | Reviews the before/after command line and clicks **Start install**. The password is required again. | Checks that the screen still shows the reviewed edit and that the review fingerprint (`rewrite_hash`) matches. It records that the install was sent, then presses Ctrl+X. | `ready_to_install` → `installing` (`runner.py:936-976`) |
| 10 | Waits. | When it sees the installer's start text, it moves the job on. | `installing` → `install_started` (`runner.py:755-767`) |
| 11 | When the install has finished, clicks **Mark as completed** (password required), or lets the job detect completion by itself. | It marks the job completed by itself only when the installed system's text login prompt appears after the installer's own reboot. | `install_started` → `completed` (`runner.py:769-791,1015-1023`) |

At any point before the install is sent, **Cancel job** stops the job. If a GRUB edit is on screen,
the server presses Esc first (`runner.py:978-994`). **Open console (manual takeover)** stops the
automation for good and opens the KVM console for that port (`runner.py:996-1013`). After a failure it
is offered only for a real console: a failed simulated job has no console, so takeover is refused with
409 and no event is logged (`runner.py:191,1003-1004`).

If you leave the page before the job has started, the page cancels it (`RemoteInstallView.jsx:345-350`).
A job that is not started within 15 minutes is cancelled with code `draft_expired`.

### The owner's fixed decisions and how the code applies them

- **Reboot defaults to the KVM's Ctrl+Alt+Del.** `kvm_cad` is the default method (`routers/pxe.py:53`).
  It sends Ctrl+Alt+Delete through the console (`runner.py:626-628`), and the operating system
  decides whether to restart. The other methods are **Manual** (you restart the computer yourself, and
  the job waits for the restart) and **PDU power cycle**.
- **PDU power cycle only after a separate, explicit confirmation.** It is never chosen automatically.
  It can be chosen only when a PDU outlet is mapped to the computer. When it is chosen, the page shows a
  red warning that names the outlets, and the reboot dialog is marked as dangerous and needs the
  password (`RemoteInstallView.jsx:110-114,582-588`). The power cycle turns off **every outlet that
  carries the computer's label**, waits 5 seconds and turns them back on. It refuses to run while the
  PDU is in maintenance mode (`raritan_driver.py:34,231-295`). If Ctrl+Alt+Del is ignored, the job does
  not switch to PDU by itself. A "Retry with PDU power cycle" offer is **(planned)**.
- **"Completed" means the installed system's login screen after its reboot, or a manual mark.** Seeing
  the installer start is not proof that the install finished (`runner.py:769-791`). A graphical login
  screen is not recognised: use **Mark as completed** (`parsers.py:120-121`).
- **Never a retry after Ctrl+X.** The server records `install_sent_at` and blocks the computer before it
  presses Ctrl+X (`runner.py:957-964`). After that, **Cancel job** is refused (`runner.py:981-982`) and
  **Start install** cannot be used again (`runner.py:188,940-941`). Any failure after that point keeps
  the computer **blocked** until an Admin clicks **Acknowledge (Admin)**, and only then can a new job be
  created for it (`runner.py:418-434,1025-1035`, `routers/pxe.py:192-194`).
- **No two installs at once.** The database allows only one active job per computer and per KVM port
  (`models.py:243-244`). `PXE_MAX_ACTIVE_JOBS` (default 1) also limits how many jobs run on the whole
  server at the same time (`runner.py:355-370`). A job counts as running from `rebooting` up to
  `install_started`; drafts and closed jobs do not count. While the limit is reached, every computer
  that has no job of its own shows **Another install is running** (`run_limit`), and both creating a
  job and starting a draft are refused with 409 "Another remote install is running; wait until it
  finishes". The refusal comes before a draft row is written and before the password is checked, so it
  costs no password attempt (`routers/pxe.py:75-82,161-162,195-196,239-243`).
- **The shared PXE menu is never changed.** The edit exists only in the GRUB editor for this one boot.
  Paths, file names, `POSTFILE`, the kernel line and the `initrd` line are kept byte for byte. If the old
  host also appears elsewhere on the line (for example in `POSTFILE`), it is left unchanged and the
  summary shows a warning (`rewrite.py:1-4,151-159`).

### Time limits per state

Each state has a deadline that starts when the job enters that state (`runner.py:39-45,405`). The page
shows the time left.

| State | Step | Limit | Failure code when it runs out |
|---|---|---|---|
| `draft` | Not started | 15 min | job cancelled, `draft_expired` |
| `rebooting` | Rebooting | 3 min | `reboot_timeout` |
| `waiting_for_menu` | Waiting for the boot menu (F12) | 2 min | `boot_menu_timeout` |
| `waiting_for_choice` | Waiting for your choice (boot entry) | 10 min | `user_timeout` |
| `waiting_for_grub` | Waiting for the GRUB menu | 3 min | `grub_timeout` |
| `waiting_for_grub_choice` | Waiting for your choice (profile) | 10 min | `user_timeout` |
| `updating_urls` | Updating addresses | 2 min | `rewrite_timeout` |
| `ready_to_install` | Waiting for **Start install** | 15 min | `user_timeout` |
| `installing` | Installing (waiting for the installer) | 5 min | `installer_timeout` |
| `install_started` | Installing (waiting for completion) | 4 h | `completion_timeout` |

The final states are `completed`, `failed`, `cancelled` and `manual_takeover` (`runner.py:31`).

The status labels in the current build are in Hebrew (`runner.py:46-49`, `frontend/src/api/pxe.js:60,82`). The
site's interface is supposed to be in English. English labels are **(planned)**: Rebooting → Waiting for
menu → Waiting for your choice → Updating addresses → Installing.

---

## 2. Simulation and the real KVM

### Settings

All settings go in the `.env` file in the project root (`config.py:8`). The server reads them once at
startup (`config.py:66-68`), so restart it after any change.

| Setting | Default | Meaning | Evidence |
|---|---|---|---|
| `PXE_ENABLED` | `false` | Master switch. When off, `/api/pxe/config` returns `{"enabled": false}`, every other `/api/pxe/*` endpoint returns 404, and the tab is hidden. | `config.py:41`, `routers/pxe.py:39-45,130-131` |
| `PXE_DRIVER` | `simulated` | `simulated` or `raritan`. Each job keeps the driver it was created with. | `config.py:42`, `runner.py:800` |
| `PXE_OLD_REPO_HOST` | the old repository name from the install plan | The host replaced in `inst.repo` and `inst.ks`. It must start with a letter or digit and contain only letters, digits, `.` and `-`. | `config.py:43`, `rewrite.py:12,132-133` |
| `PXE_NEW_REPO_HOST` | the new repository address from the install plan | The host written in its place. Only letters, digits, `.`, `:` and `-` are allowed, and it must differ from the old host. | `config.py:44`, `rewrite.py:13,134-137`, `screen.py:24` |
| `PXE_ALLOWED_COMPUTERS` | empty | Computers that may be installed, separated by commas, spaces or semicolons. Names are matched like monitor names: case-insensitive, and for OPT names a suffix such as `(SSD)` is ignored. **Required for `raritan`.** | `config.py:45`, `mapping.py:16-17`, `ping_monitor.py:71-82` |
| `PXE_MAX_ACTIVE_JOBS` | `1` (allowed 1–8) | How many jobs may run on the whole server at the same time. | `config.py:46`, `runner.py:355-370,826` |
| `PXE_TICK_SECONDS` | `0.5` (above 0, at most 5) | Pause between automatic steps. | `config.py:47`, `runner.py:250-252` |
| `PXE_SIM_TIME_SCALE` | `1.0` (above 0, at most 10) | Simulation only: multiplies the simulated computer's timings, so a value above 1 makes it slower. | `config.py:48`, `sim_driver.py:84-85` |
| `PXE_SIM_SCENARIO` | `happy` | Simulation only: the scenario used for new jobs. An unknown name falls back to `happy`. | `config.py:49`, `routers/pxe.py:189` |

The defaults of the two repository settings already match the install plan. Leave them unset unless
the owner approves different values.

### Simulation (`PXE_DRIVER=simulated`)

- Each job gets a simulated computer inside the server. It has a firmware screen, an F12 boot menu, PXE,
  a GRUB menu and editor, and an installer (`sim_driver.py`). No KVM is opened, no PDU outlet is
  switched, and no real computer receives a key (`runner.py:85-105`). In simulation, "PDU power cycle"
  only restarts the simulated computer (`runner.py:637`).
- Manual takeover opens no console in simulation (`runner.py:1010-1011`). A **failed** simulated job
  does not offer takeover at all: the request is refused with 409 "A simulated job has no console to
  open", and no "Console opened" event is logged (`runner.py:191,1003-1004`).
- With an empty `PXE_ALLOWED_COMPUTERS`, every listed computer is allowed in simulation
  (`routers/pxe.py:69-72`).
- Scenarios (`sim_driver.py:9-10`), with the result the automated tests check
  (`backend/tests/test_pxe_sim.py`):

| Scenario | What it simulates | Expected result |
|---|---|---|
| `happy` | Everything works. | `completed` |
| `missed_f12` | F12 is never received, so the operating system starts again. | `failed`, `boot_menu_timeout` |
| `no_pxe_entry` | The boot menu has no network entry. | `failed`, `no_pxe_entry` |
| `countdown_expires` | The GRUB countdown runs out before the stop key arrives. | `failed`, `grub_countdown_expired` |
| `grub_password` | GRUB asks for a password before editing. | `failed`, `grub_password` (Esc sent) |
| `missing_inst_ks` | The profile has no `inst.ks`. | `failed`, `missing_key` |
| `duplicate_inst_repo` | The profile has `inst.repo` twice. | `failed`, `ambiguous_key` |
| `ocr_noise` | Every other screen read is garbled and low-confidence. | `completed` (garbled reads are ignored) |
| `kvm_disconnect` | The KVM session drops at the GRUB menu. | `failed`, `kvm_disconnected`, computer blocked |
| `installer_error` | The installer drops to an emergency shell. | `failed`, `installer_error`, computer blocked |

### Real KVM (`PXE_DRIVER=raritan`)

- The server opens the same Raritan HTML5 console that the Consoles tab uses. It runs in a headless
  Chromium browser driven by Playwright, and signs in on the server side with the KVM credentials
  stored in Lab Manager. Passwords never reach the browser (`raritan_driver.py:298-358`).
- It reads the screen by OCR: the Tesseract program if it is installed, otherwise RapidOCR
  (`raritan_driver.py:209-228`). A read below 90% confidence is never acted on (`runner.py:55,450-456`).
- It can only press keys from a fixed list: F12, arrows, Enter, Esc, `e`, Ctrl+A/E/K/X, Delete,
  Backspace, Home, End and Ctrl+Alt+Delete. The only text it can type is a repository host
  (`screen.py:20-33`).
- A real job can start only when the console browser and a screen reader are installed
  (`raritan_driver.py:37-61`). Until then, creating or starting a job is refused with 503, the computer
  list shows "Remote install driver unavailable", and `/api/pxe/config` reports `"available": false`
  (`routers/pxe.py:133,163-164,173-174,233-234`).
- **The allowlist is mandatory.** With `raritan`, an empty `PXE_ALLOWED_COMPUTERS` allows **no**
  computer. The allowlist is checked when the list is shown, when a job is created and again when it is
  started (`routers/pxe.py:69-72,156,181,237`).

### Why it is off by default

Remote install reboots computers, can cut PDU power and starts an installer that may erase the disk.
The owner's rule is that no real hardware is touched until a dedicated computer has been chosen. The
real-KVM path has only been tested against simulated parts, and it has known blockers (section 5). So
there are three locks:

- `PXE_ENABLED=false`
- the driver defaults to `simulated`
- `raritan` refuses every computer that is not on the allowlist

---

## 3. Turning on simulation on the VM

This turns on the **Remote install** page in simulation on the backend that `scripts/lab-service.py`
manages, which is the live site on port 8000. Simulation never touches equipment, but the page becomes
visible to every Operator. Do this only with the owner's approval. Team testing uses a separate
instance, never the live port.

**Requirements:** a Lab Manager version that includes Remote install (CHANGELOG entry "Unreleased —
Remote PXE install" at the time of writing), and a configured password (user accounts or the shared
password).

1. If Remote install was already on, make sure no job is running. After a restart, every job that had not
   sent its install yet fails with code `interrupted` (`runner.py:510-538`). This applies to every restart
   and to turning the feature off.
2. On the VM, in the project folder from `docs/vm-runbook.md`, add these lines to the existing `.env`
   with an editor. Do not replace the device credentials that are already there, and do not print the
   file.

   ```
   PXE_ENABLED=true
   PXE_DRIVER=simulated
   PXE_SIM_SCENARIO=happy
   ```

   Leave `PXE_ALLOWED_COMPUTERS` empty to try any listed computer, or set it to limit the list.
   `PXE_MAX_ACTIVE_JOBS` stays at its default of 1.

3. Restart the backend with the existing service tool, as in the VM runbook:

   ```bash
   backend/.venv/bin/python scripts/lab-service.py restart
   backend/.venv/bin/python scripts/lab-service.py status
   ```

   `status` must show exactly one project PID (`lab-service.py:405-425,474-489`).

4. Check the configuration: sign in to the site as an Operator or Admin, then open `/api/pxe/config` on
   the site in the same browser. In shared-password mode the browser asks for the password. Expect:
   - `"enabled": true`, `"driver": "simulated"`, `"available": true`
   - `"password_mode"`: `"account"` or `"shared"`. If it says `"unavailable"`, no password is configured.
   - `"reboot_methods": ["kvm_cad", "manual", "pdu_cycle"]`, `"max_active_jobs": 1`, the `"timeouts"` from
     section 1, the list of `"scenarios"`, and `"default_scenario": "happy"`

   (`routers/pxe.py:127-137`). Then open the **Remote install** tab. It shows "Simulation mode — jobs
   run against a simulated computer" (`RemoteInstallView.jsx:567`).

**To turn it off:** set `PXE_ENABLED=false` (or remove the lines), then run `lab-service.py restart`
again. `/api/pxe/config` then returns `{"enabled": false}`.

---

## 4. Before a real-hardware trial

None of this has been done yet. Each item needs the owner's approval.

### 4.1 Prerequisites

1. **Run it as a separate instance, never on port 8000.** Use a separate copy of the project folder. It
   then has its own `.env` (`config.py:8`), its own database file `backend/lab_manager.db`
   (`config.py:50`) and its own screenshot folder `backend/pxe_screens/` (`runner.py:30`).
   `lab-service.py` manages only the backend on port 8000 (`install-monitoring.py:263-279`,
   `lab-service.py:365-380`), so it neither counts nor restarts the trial instance. Start the trial
   instance the same way the installer starts the live one (`install-monitoring.py:193-197`), on a port
   the owner chooses:

   ```bash
   cd <trial-folder>/backend
   .venv/bin/python -m uvicorn app.main:app --host <bind-address> --port <trial-port>
   ```

2. **Turn off monitoring and alerts on the trial instance**, so it does not send duplicate pings or
   emails: `PING_MONITOR_ENABLED=false` and `EMAIL_ALERTS_ENABLED=false` (`config.py:22,24`).
3. **Use a copy of the live database, never the live file.** The KVM console session exists only inside
   the process that started the job (`runner.py:862-864`), so two servers must never share one job
   table. Make the copy with SQLite's online backup rather than a plain file copy. Keep the same
   `LAB_MANAGER_MASTER_KEY`, because the stored KVM and PDU passwords are encrypted with it
   (`config.py:15`, `crypto.py:5-6`).
4. **Install the console browser and a screen reader** in the trial instance's own virtualenv. None of
   them is in `backend/requirements.txt`:
   - Playwright: `python -m pip install playwright`, then `python -m playwright install --with-deps chromium`
     (`--with-deps` installs system packages, which needs administrator rights on the VM)
   - Pillow (`raritan_driver.py:45-49`)
   - a screen reader: either the `tesseract` program on the PATH, or the Python packages
     `rapidocr_onnxruntime` and `numpy` (`raritan_driver.py:50-56,161-163`)

   Check: `/api/pxe/config` on the trial instance reports `"driver": "raritan"` and `"available": true`.
5. **`.env` of the trial instance**, with exactly one dedicated computer on the allowlist:

   ```
   PXE_ENABLED=true
   PXE_DRIVER=raritan
   PXE_ALLOWED_COMPUTERS=<computer>
   PXE_MAX_ACTIVE_JOBS=1
   PING_MONITOR_ENABLED=false
   EMAIL_ALERTS_ENABLED=false
   ```

   Also include the device credentials and `LAB_MANAGER_MASTER_KEY` from the live `.env`, plus the
   password mode (accounts or the shared password). Set `PXE_OLD_REPO_HOST` and `PXE_NEW_REPO_HOST` only
   if the owner approves values that differ from the code defaults.
6. **Merge the blocker fixes from section 5 first**: the OCR text grid, F12 timing, focusing the console
   without a click, and OCR that does not freeze the server.
7. **Console check without keys (planned).** A "Check console" action will open the console, take a
   screenshot, read it and close the console without pressing any key. Run it as the first step of the
   trial once it exists.

### 4.2 What the owner must choose first

1. The computer: its exact name as written on its KVM port label, and its rack.
2. The KVM unit and port number. The PDU unit and outlet numbers, and whether a PDU power cycle may be
   used as a fallback at all.
3. What runs on the computer now: Linux in text mode, Linux with a graphical desktop, or Windows. A
   graphical desktop or Windows may ignore Ctrl+Alt+Del.
4. Make and model. Whether F12 opens a one-time boot menu or boots from the network directly. Whether
   Fast Boot is off.
5. Which GRUB profile to install, with written consent that the disk may be erased.
6. How long the GRUB countdown lasts, and whether editing with `e` is password-protected.
7. Whether the new repository address serves the same paths as the old name, and whether `POSTFILE`
   should keep pointing to the old name.
8. The KVM mode (Private or PC-Share), any single-login limit, a dedicated KVM user for automation if
   possible, and a time window for the trial.

### 4.3 First-run checklist for the operator

1. **Before:** nobody is connected to that KVM unit or port. The port label matches the computer. Note
   what the screen shows now.
2. **Without keys:** run the console check (planned). If the picture, the text or the recognition is
   wrong, stop and send the screenshot to the team.
3. **Reboot:** use Ctrl+Alt+Del, the default. If the computer has not restarted after about a minute,
   cancel the job. Use a PDU power cycle only after a separate approval.
4. **Boot menu:** compare the options on the page with the screenshot, then choose the agreed network
   entry.
5. **GRUB:** check that the countdown stopped, then choose only the agreed profile.
6. **Summary:** check that both URLs point to the new address and that the paths, `POSTFILE` and
   `initrd` are unchanged. Only then click **Start install**.
7. **After Ctrl+X:** never retry. If something goes wrong, take over manually. The install is complete
   only when the login screen appears after the installer's reboot, or when you mark it manually.
8. **At the end:** collect the job's events and screenshots (`backend/pxe_screens/<job id>/`) for
   calibration. Up to 50 screenshots per job are kept, for at most 7 days (`runner.py:53-54,151-178`).

---

## 5. Known limitations today

These are open. Fixes are **(planned)** and not yet in the code.

- **The OCR text grid loses columns and indentation (planned).** Words are placed on a fixed 80 × 25
  grid and joined with single spaces. The GRUB frame is not removed, and a wrapped line is recognised
  only by its full length plus a trailing backslash (`raritan_driver.py:32-33,83-103`,
  `parsers.py:78-97`). A real GRUB menu and editor are drawn inside a frame with indentation, so a real
  job will most likely stop safely at
  `missing_linux_line` or `rewrite_verify`, after pressing Esc. Frame lines may also appear as menu
  options.
- **F12 timing depends on OCR speed (planned).** F12 is pressed only after the screen has been read (up
  to 3 reads per step). The first F12 waits until a blank screen, the firmware screen or the boot menu
  is recognised (`runner.py:452-456,643-668`). On a short firmware screen, F12 can come too late. Models
  where F12 boots from the network directly are not handled.
- **Opening the console clicks the console picture (planned).** The driver clicks the canvas once to
  focus it, and that click reaches the target computer (`raritan_driver.py:354`).
- **OCR freezes the whole server while it reads (planned).** It runs on the server's main loop
  (`raritan_driver.py:185-186,429-432`).
- **No "choose in the console, then resume" (planned).** When the screen cannot be read clearly, the job
  waits until the step's time limit and then fails. **Manual takeover** is final: automation cannot be
  resumed (`runner.py:450-456,996-1013`).
- **No PDU offer after Ctrl+Alt+Del is ignored (planned).** Start a new job with another method instead
  (section 6).
- **No console check without keys yet (planned).**
- **Status labels are in Hebrew** in this build. English is **(planned)**.
- Screen recognition is tuned to the simulator's text: the boot menu title and footer, the GRUB header
  and footer, and the installer messages (`parsers.py:35-121`). It needs calibration against real
  screenshots. A short GRUB countdown can run out before the menu is recognised.
- It is not yet known whether the Raritan web client passes Ctrl+Alt+Delete on to the computer
  (`raritan_driver.py:27`).
- A PDU power cycle switches every outlet that carries the computer's label (`mapping.py:49-50`). A
  wrong label switches the wrong computer, and nothing checks the computer's identity before power is
  cut.
- After a server restart, jobs that had not sent the install fail with `interrupted`. Jobs that had sent
  it are only watched against their deadline, and the console is no longer monitored (`runner.py:510-538`).

---

## 6. Troubleshooting

Find the code in the red **Failed** box on the job, after "Failed at …". The **Events** list shows each
step with its time.

**Blocked** means `needs_acknowledge`: `install_may_have_started` is set and the failed or taken-over job
still holds the computer. The computer cannot get a new job until an Admin clicks **Acknowledge (Admin)**
(`runner.py:418-434`, `routers/pxe.py:193-194`). A failure blocks the computer when the install was
already sent, or when the job was in `waiting_for_grub` (where an install entry could boot without any
key), unless the code says otherwise.

The job's failure box tells these two cases apart by `install_sent_at`. When it is set, the box says
"The install command may already have been sent." When it is not, it says "No install command was sent,
but the GRUB menu may have booted an entry on its own." Both go on with "Do not retry automatically —
check the console." The last sentence says a new job for the computer needs Admin acknowledgement, or,
after an Admin acknowledged the job, that the computer is released for new installs
(`frontend/src/api/pxe.js`, `blockedNotice`).

### Failure codes

| Code | Usually fails in | Meaning | What to do |
|---|---|---|---|
| `reboot_timeout` | `rebooting` | No restart was seen within 3 minutes. Ctrl+Alt+Del may have been ignored (Windows, a graphical desktop or a policy), or nobody restarted the computer for **Manual**. | Check the screenshot. Start a new job with **Manual** and restart the computer yourself, or, only with explicit approval and a mapped outlet, choose **PDU power cycle**. |
| `power_cycle_failed` | `rebooting` | The PDU switch failed, or the PDU is in maintenance mode. If outlets were already off, the server tried to turn them back on ("PDU power could not be restored" means that failed too). | Open the PDU page **now** and check the outlets. Restore power by hand if needed. |
| `boot_menu_timeout` | `waiting_for_menu` | The boot menu was not recognised within 2 minutes, or the system's login prompt appeared because F12 was missed. | Check that F12 opens a boot menu on this model and that Fast Boot is off. Start a new job. |
| `no_pxe_entry` | `waiting_for_menu` | The boot menu has no network entry. | Enable network (PXE) boot in the firmware and check the cable. |
| `user_timeout` | `waiting_for_choice`, `waiting_for_grub_choice`, `ready_to_install` | Nobody chose an entry or clicked **Start install** in time (10, 10 or 15 minutes). In `ready_to_install` the edit is discarded with Esc. | Start a new job when you are ready to follow it. |
| `grub_timeout` | `waiting_for_grub` | The GRUB menu did not appear within 3 minutes after the network entry was chosen. **Blocked.** | Take over and look at the screen (PXE/DHCP problem? an entry booted?). Then an Admin acknowledges. |
| `grub_countdown_expired` | `waiting_for_grub` | The GRUB countdown ran out before it could be stopped, and an entry booted. **Blocked** if a kernel or the installer started. Not blocked if the installed system came up. | Take over at once and check whether an installer is running. Report it: the countdown may be too short (section 5). |
| `no_install_entry` | `waiting_for_grub` | The GRUB menu has no entry that can be chosen. Not blocked. | Check the PXE menu. |
| `grub_password` | `waiting_for_grub_choice`, `updating_urls` | GRUB needs a superuser password to edit. Esc was sent. | Not supported. Talk to whoever owns the PXE menu. |
| `missing_linux_line`, `ambiguous_linux_line` | `updating_urls` | The editor text on screen has no `linux`/`linuxefi` line, or more than one. On real hardware this is most likely the OCR grid (section 5). Edit discarded. | Send the screenshot to the team. |
| `missing_key`, `ambiguous_key` | `updating_urls` | `inst.repo` or `inst.ks` is missing from the `linux` line, or appears more than once. Edit discarded. | This profile is not supported as it is. Choose another one or fix the menu. |
| `unbalanced_quote`, `unsupported_scheme`, `credentials_in_url` | `updating_urls` | A URL value has an unbalanced quote, is not http(s) or has no host, or contains a user name and password. Edit discarded. | Check the profile. |
| `unexpected_host` | `updating_urls` | After the change, `inst.repo` or `inst.ks` would still point to a third host. Edit discarded. | Check that `PXE_OLD_REPO_HOST` matches the host in the menu. |
| `unsupported_layout` | `updating_urls` | The hosts to replace are not on a single editor line. Edit discarded. | Send the screenshot to the team. |
| `invalid_configuration` | `updating_urls` | `PXE_OLD_REPO_HOST` or `PXE_NEW_REPO_HOST` is invalid, or both are the same. Edit discarded. | Fix `.env` and restart. |
| `rewrite_verify` | `updating_urls` | The text on screen after typing does not match the expected text, or the edit was interrupted. Edits discarded with Esc. | On real hardware, most likely the OCR grid. Send the screenshot. |
| `rewrite_timeout` | `updating_urls` | The GRUB editor was not recognised within 2 minutes. Esc was sent. | Look at the screenshot. |
| `install_send_failed` | `ready_to_install` | Pressing Ctrl+X failed, so the install **may** have started. **Blocked.** | Never retry by itself. Open the console, check, then an Admin acknowledges. |
| `installer_timeout` | `installing` | The installer start was not seen within 5 minutes after Ctrl+X. **Blocked.** | Open the console and check. |
| `installer_error` | `installing`, `install_started` | Emergency shell, a dracut timeout, "Could not fetch", or a kernel panic. Often the new repository or kickstart address is not reachable. **Blocked.** | Check that the new address serves the same paths. Check any `POSTFILE` warning. |
| `installer_not_started` | `installing` | A login prompt appeared instead of the installer. **Blocked.** | Check the console, then an Admin acknowledges. |
| `completion_timeout` | `install_started` | No login prompt after the installer's reboot within 4 hours (also used when the console was no longer monitored after a server restart). **Blocked.** | Check the computer. Mark the install as completed before the deadline if it has finished. After this failure, an Admin acknowledges to release the computer. |
| `kvm_disconnected` | any | The console session failed. One automatic reconnect was tried first (`runner.py:592-607`). **Blocked** in `waiting_for_grub` or after the install was sent. | Check that the KVM answers, that nobody else holds the port, and the single-login limits. |
| `interrupted` | any state before the install | The server restarted, or the console session was lost, before the install was sent. The job never resumes. **Blocked** in `waiting_for_grub`. | Start a new job. Do not restart the backend while jobs are running. |
| `internal_error` | any | Unexpected automation error. | Collect the events and screenshots and report them. |
| `draft_expired` | `draft` (job ends as `cancelled`) | The job was not started within 15 minutes. | Start a new job. |

### Computer list

| Status shown | Code | What to do |
|---|---|---|
| Another job is active | `active_job` | Open that job from the list, finish it or cancel it. |
| Waiting for Admin acknowledge | `needs_acknowledge` | An Admin opens the failed job, checks the computer and clicks **Acknowledge (Admin)**. |
| Not enabled for remote install | `not_allowlisted` | Add the computer to `PXE_ALLOWED_COMPUTERS` (with the owner's approval) and restart. |
| KVM port in use | `kvm_port_busy` | Another job holds that KVM port. |
| Another install is running | `run_limit` | `PXE_MAX_ACTIVE_JOBS` jobs are already running on the server. Wait until one finishes or is cancelled. Drafts do not count, and a computer with its own job shows that job instead. |
| Remote install driver unavailable | `driver_unavailable` | `raritan` without the browser or screen reader. See section 4.1, item 4. |

Sources: `routers/pxe.py:151-166`, `RemoteInstallView.jsx:22-28`.

### Common refusals

| Message | Code | What to do |
|---|---|---|
| "Remote install requires a configured password" | 403 | Turn on user accounts or set the shared password (`routers/pxe.py:175`). |
| "This computer is not allowed for remote install" | 403 | The computer is not on the allowlist. This is also checked at start (`routers/pxe.py:181-182,237-238`). |
| "Password is incorrect" / "Too many attempts. Try again in five minutes." | 403 / 429 | After 10 failed attempts within 5 minutes, wait (`confirm.py:20-21,83-85,107`). |
| "The Raritan console driver is not available in this phase" | 503 | See section 4.1, item 4 (`routers/pxe.py:173-174,233-234`). |
| "Unknown computer or no KVM port is mapped to it" / "… more than one KVM port; choose one" | 422 | Check the KVM port labels and choose the port (`routers/pxe.py:179-186`, `mapping.py:64-74`). |
| "No PDU outlet is mapped to this computer" | 422 | PDU power cycle needs a PDU outlet labelled with the computer's name (`routers/pxe.py:187-188`). |
| "A previous install may have started on this computer; an Admin must acknowledge it first" | 409 | See **Blocked** above (`routers/pxe.py:192-194`). |
| "Another install is active on this computer or KVM port" / "Another remote install is running; wait until it finishes" | 409 | One job per computer and KVM port, and at most `PXE_MAX_ACTIVE_JOBS` running jobs. The second message is returned at create and at start, before the password is checked (`runner.py:60,810`, `routers/pxe.py:195-196,239-243`). |
| "The menu on screen changed; review the options again" / "Highlight verification failed; nothing was selected" | 409 | The page reloads the options. Choose again (`runner.py:907-921`). |
| "The screen changed since the review; nothing was sent" | 409 | Ctrl+X was **not** sent. Review the reloaded summary (`runner.py:949-953`). |
| "No console session for this job on this server" | 409 | The server restarted, or another server process owns the job (`runner.py:862-864`). |
| "Screenshots can be refreshed every 2 seconds" | 429 | Wait 2 seconds (`runner.py:1043-1045`). |
| "KVM console session failed" | 502 | The console could not be opened or read (`runner.py:838-840`). |
