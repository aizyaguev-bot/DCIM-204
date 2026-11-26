# Lab assistant actions

This guide is for the lab owner, Admins and Operators. It describes the power and console actions that the
lab assistant can prepare (version 2.40.0), how to turn them on safely, and how to recover.

Assistant actions are **off by default** (`ASSISTANT_ACTIONS_ENABLED=false`) and work only with **user
accounts** on (`ACCOUNTS_ENABLED=true`). Installing this version changes nothing until the owner turns them on.

This guide contains no addresses, hostnames or passwords. Placeholders look like `<server>`, `<rack>`, `<pdu>`.

---

## 1. What the assistant can do

The assistant never switches anything itself. It works in four steps:

1. You ask in the assistant panel, in Hebrew or English, for example "reset `<server>` and open its KVM".
2. The assistant (the language model, or the rule-based demo mode) asks the server for a **proposal**. The server
   finds the targets from the outlet and port labels, reads every involved PDU **live** (read only) and stores
   the proposal. A card under the answer shows exactly which PDU outlets will switch, which stay on and why,
   and any warnings. The text of the answer never decides what switches: only the card does.
3. You review the card and confirm it with **your own account password**. Rack-wide and lab-wide actions also
   need a typed phrase.
4. The server checks everything again, runs the action and reads the PDUs back. An outlet counts as done only
   when the read-back shows the expected state.

| Example request (you type) | Action | What it does |
|---|---|---|
| `תעשה ריסט לשרת <server> ותפתח KVM` | `server_cycle` + console | All power feeds of the server off, wait, all back on. Then an **open KVM** button for the server. |
| `כבה את <server>` / `תדליק את <server>` | `server_off` / `server_on` | Every PDU outlet whose label is that server (all feeds, for example PSU1 and PSU2). |
| `תפתח לי KVM של <server>` | `open_console` | No power change. One **open KVM** button for each KVM port labelled with the server. |
| `תכניס את <pdu> לתחזוקה` | `pdu_shutdown` | One PDU into maintenance mode, exactly like the Maintenance column (protected outlets stay on). |
| (language model only) "turn outlet `<n>` on `<pdu>` off/on/reset" | `outlet_off` / `outlet_on` / `outlet_cycle` | One outlet by PDU and outlet number. |
| (language model only) "take `<pdu>` out of maintenance" | `pdu_restore` | Restore one PDU, exactly like **Restore power** in the Maintenance column. |
| `כבה את ארון <rack>` | `rack_shutdown` | Every PDU in the rack into maintenance mode, protected outlets kept on. Runs in the background. |
| `כבה חשמל לכל המעבדה` | `lab_shutdown` | Every PDU in the lab into maintenance mode, protected outlets kept on. Runs in the background. |
| `תחזיר חשמל` | `batch_restore` | Turns back on exactly what one rack or lab shutdown switched off, one PDU at a time. |

Rules for requests:

- **Name the target in your message.** The assistant proposes an action only for a server or rack that your
  message names (or that is open on your screen), and a lab-wide action only when your message says so
  explicitly, for example `כל המעבדה` or "whole lab". It never widens the scope. It prepares at most one
  proposal per question.
- **Demo mode** (no language model) recognises only the commands in the table above that are not marked
  "language model only". The command must start with the verb, name exactly one target, and contain no
  negation, condition or second action ("reset ... and open KVM" is the one allowed pair). Otherwise the
  assistant asks what you mean and prepares nothing.
- Questions such as "what happens if I turn off rack `<rack>`?" get a read-only answer, never a proposal.
- Viewers cannot request actions. The assistant explains which role is needed.

What the card shows:

- **Will switch**: PDU, rack, outlet number, outlet label, server name and the state read at proposal time.
- **Not included**, with a reason: `protected`, `maintenance` (the PDU was already in maintenance; it is not
  touched and not adopted), `disabled`, `unreachable` (the whole PDU), `already_off`, `already_on`,
  `unknown_state`, `not_in_batch`.
- **Warnings**: the server's KVM console is marked in use, a Remote install (PXE) job holds the server or its
  port, an outlet's state is unknown, or the lab-wide warning.
- The time left before the proposal expires (5 minutes by default).

A **reset** cuts power: the operating system does not shut down cleanly and unsaved work is lost. A soft
reboot (Ctrl+Alt+Del through the KVM) is not available yet (section 10).

---

## 2. Roles, confirmations and typed phrases

Every action needs user accounts. With the shared site password (`LAB_MANAGER_PASSWORD` without accounts) or no
password at all, the action tool is not offered and every action request is refused with `password_mode`.

| Action | Role | Confirmation | Runs | Needs `POWER_PROTECTED_OUTLETS` |
|---|---|---|---|---|
| `server_off`, `server_on`, `server_cycle` | Operator | password | at once, result in the card | no (a protected outlet is refused) |
| `outlet_off`, `outlet_on`, `outlet_cycle` | Operator | password | at once | no (a protected outlet is refused) |
| `pdu_shutdown` | Operator | password | at once | **yes** |
| `pdu_restore` | Operator | password | at once | no |
| `rack_shutdown` | **Admin** | password + phrase `<rack> OFF` | background, with progress | **yes** |
| `lab_shutdown` | **Admin** | password + phrase `LAB OFF` | background, with progress | **yes** |
| `batch_restore` | **Admin** | password + phrase `<rack> ON` or `LAB ON` | background, one PDU at a time | no |
| `open_console` | Operator | none (a click on **open KVM**) | no hardware change | no |

Typed phrases:

- They are plain ASCII so they can be typed on any keyboard. The card shows the exact phrase; copying and
  pasting it is fine.
- The match is exact and case-sensitive. Spaces at the start and end are ignored, spaces inside are not.
- `<rack>` is the rack name exactly as Lab Manager stores it on the PDUs, with the same capitals and dashes.
  A restore after a lab shutdown uses `LAB ON`; after a rack shutdown, `<rack> ON`.
- A wrong phrase is refused before the password is checked and does not use up a password attempt. It is
  recorded in the audit trail as `denied` (the typed text itself is never stored).

Password:

- It is the signed-in user's own account password, checked on the server. The model never sees it.
- Wrong passwords are limited to 10 in 5 minutes per user. This budget is shared with the Maintenance column
  and Remote install. Beyond it the server answers 429 "Too many attempts. Try again in five minutes."

Other rules:

- A proposal can be used **once**, only by the user who created it, and only until it expires
  (`ASSISTANT_ACTION_TTL_SECONDS`, default 300 seconds). An Admin can see everyone's proposals and can prepare
  a restore for any executed rack or lab shutdown, but cannot confirm another user's proposal.
- Your role is read from your current session when you confirm. A user demoted after creating a proposal can
  no longer confirm it.
- **Re-check before running.** After the password, the server compares the situation with the proposal. For a
  server, outlet or single-PDU action, any change refuses the whole action (status `refused`, nothing
  switched): different outlet labels, a changed PDU address, a PDU enabled or disabled, a PDU that entered or
  left maintenance, an outlet that can no longer be read, or (for off, reset and shutdown) an outlet on an
  involved PDU that turned on since the proposal. For a rack or lab shutdown,
  a PDU-level change (address, enabled, maintenance, labels, the list of PDUs in the scope) refuses the whole
  job, while an outlet switched on after the proposal is simply left on and reported as not included. Ask
  again for a fresh proposal.
- Only **one** rack, lab or restore job runs at a time. Another one is refused with `busy` and stays
  pending, so you can confirm it again when the first job has finished.
- Each user can have at most 3 pending proposals, and at most 1 pending rack or lab proposal.

---

## 3. Statuses and results

| Status | Meaning |
|---|---|
| `pending` | Waiting for your confirmation. |
| `ready` | `open_console`: nothing to run; click **open KVM**. |
| `executing` | Confirmed and running. Rack, lab and restore jobs show progress (PDUs done of total). |
| `succeeded` | Every outlet or PDU was confirmed by a live read-back. |
| `partial` | Some outlets or PDUs succeeded, others failed or could not be verified. The card lists each one. |
| `failed` | Nothing succeeded, or the job stopped with an internal error. PDUs already in maintenance stay restorable. |
| `refused` | The re-check found a change. Nothing was switched. |
| `cancelled` | You cancelled the proposal before confirming. |
| `expired` | Not confirmed in time. Nothing was switched. |
| `interrupted` | The backend restarted while the action was running (section 8). |

How the actions behave:

- **Reset** (`server_cycle`, `outlet_cycle`): switches every feed that was on at proposal time off, waits
  `ASSISTANT_ACTION_CYCLE_OFF_SECONDS` (default 5), then switches them all back on and reads them back. A feed
  that was already off stays off. If every feed is already off, the reset is refused (ask to turn the server on
  instead). If switching off fails part way, the server switches back on what it already switched off. If
  power cannot be restored, the card says so: open the PDU page and switch the outlets on there.
- **Rack and lab shutdown**: each PDU goes into maintenance mode in turn, through the same code as the
  Maintenance column. Its restore list (the outlets that were on) is saved before any outlet is switched, so
  a restore is always possible. PDUs already in maintenance, disabled or unreachable at proposal time are
  skipped. If a PDU that is next in line cannot be reached during the job, the job stops there; PDUs after it
  are left untouched and the status is `partial` or `failed`.
- **Restore** (`batch_restore`): only PDUs that this shutdown put into maintenance, and only while they are
  still in that same maintenance period. A PDU restored by hand, or put into maintenance again later by
  someone else, is not touched. Each PDU switches on exactly the outlets on its restore list, with
  `ASSISTANT_ACTION_RESTORE_STAGGER_SECONDS` (default 3) between PDUs to limit inrush current. A PDU whose
  outlets do not all come back stays in maintenance with only the outlets still off, so the restore can be
  repeated.
- **Open KVM**: the button opens the same console as the KVM page. It opens only on your click; if the
  browser blocks the new tab, the console opens inside the page. After a reset, the screen can stay black
  for about a minute while the server starts.

---

## 4. Protected outlets (`POWER_PROTECTED_OUTLETS`)

A lab-wide shutdown without exclusions would also cut power to whatever the site itself depends on. If the
Lab Manager VM, its network or the KVMs lose power, nobody can restore the lab remotely; someone has to go to
the lab. Protected outlets are never switched by assistant actions.

### 4.1 What to protect

Protect every outlet, on every power feed, that feeds:

- the physical host that runs the Lab Manager VM, and any storage it needs, if they are powered from a lab PDU;
- network switches between the users and the VM: uplink, core, top-of-rack and management switches;
- the firewall or router of the lab, if there is one;
- the KVM appliances (remote consoles);
- the switch that the PDUs' and KVMs' management ports are connected to;
- anything else that must never lose power without a person in the lab.

If a device has two power supplies, protect both outlets. A device that is not powered from a lab PDU (for
example a VM host in a separate data center) needs no entry.

### 4.2 Find the outlets

1. Open the **Power** tab and each PDU's page. Look at every outlet label for the devices in 4.1.
2. In a signed-in browser, open `/api/devices` on the site. For each PDU it shows the device `id`, `name`,
   `rack` and the saved outlet `labels` (`{"<outlet>": "<label>"}`). The `id` is the safest way to name a
   PDU in the setting.
3. The rack layout (and the 3D twin) shows where switches sit. The read-only assistant can also answer
   "which outlets feed `<switch>`?" from the stored dependencies, but labels can be wrong or missing.
4. **Confirm physically.** Labels are typed by people. Trace the power cords of the VM host, the switches and
   the KVMs to their PDU outlets, or ask whoever cabled the lab. An outlet still called `Outlet <n>` has no
   label: check what it feeds and label it in Lab Manager, so that impact lists stay readable.
5. Ask the virtualization or IT owner which physical host runs the Lab Manager VM and how it is powered. If
   nobody knows, do **not** write `none`.

### 4.3 Write the setting

Format: comma-separated entries `<PDU id or exact PDU name>:<outlet number>`.

```
POWER_PROTECTED_OUTLETS=<pdu-id-1>:4,<pdu-id-1>:5,<pdu-id-2>:12
```

- `none` (any case) states that nothing in the lab needs protection. Write it only when 4.1 found nothing.
- Empty (the default) means **not configured**: the assistant refuses PDU, rack and lab shutdowns with
  `protected_unset`.
- Prefer PDU ids: a name must match exactly one PDU and stops matching when the PDU is renamed. If a name
  contains a space or `#`, put the whole value in double quotes:
  `POWER_PROTECTED_OUTLETS="<PDU name>:12,<PDU name>:13"`.
- **One bad entry makes the whole list invalid**: an empty entry (two commas in a row or a trailing comma), an
  entry that is not `<PDU>:<number>`, one that names no PDU or a PDU name that two PDUs share, or one that names
  an outlet beyond the PDU's outlet count. A silently skipped entry
  could be the outlet that feeds the site, so nothing is guessed. While the list is invalid, PDU, rack and
  lab shutdowns by the assistant, and **Turn off all outlets** in the Maintenance column, are refused until
  it is fixed.
- Review the list after any PDU is added, removed, renamed, re-addressed or re-cabled.

### 4.4 Check the list without switching anything

After the restart in section 5:

1. As any signed-in user, open `/api/assistant/actions/config` on the site. `protected_configured` must be
   `true`. This does not prove that every entry is right.
2. As an Admin, type `כבה חשמל לכל המעבדה` in the assistant panel. Creating a proposal only reads the PDUs;
   it never switches anything. In the card, check that every outlet from 4.1 is listed as **not included,
   protected**, and that no infrastructure outlet is in the **will switch** list.
3. **Do not confirm.** Cancel the proposal (or let it expire after 5 minutes).

If the request is refused with `protected_unset`, the setting is empty or invalid: fix it and restart.

### 4.5 Effect on the Maintenance column and outlet buttons

The setting also applies outside the assistant, whether or not `ASSISTANT_ACTIONS_ENABLED` is on:

- **Turn off all outlets** in the Maintenance column keeps protected outlets on. They are not on the restore
  list, because they were never switched off.
- With an invalid list, **Turn off all outlets** is refused ("Protected outlets configuration is invalid").
- The **Off** and **Cycle** buttons of a protected outlet on the PDU page are refused. **On** still works.

With the setting empty, the Maintenance column and the outlet buttons behave exactly as before.

---

## 5. Turning actions on and off

### 5.1 Before you start

- Lab Manager 2.40.0 or later is installed (`/api/version`).
- User accounts are on, and the people who will use actions have the right roles (Operator for single
  servers, Admin for rack and lab).
- The protected outlets are reviewed (section 4). The owner approves turning actions on.
- Exactly one backend process runs (`backend/.venv/bin/python scripts/lab-service.py status` shows one
  project PID). Never start the backend with `--workers`: the per-PDU locks and the one-job-at-a-time rule
  live inside the process.
- No Remote install job, maintenance shutdown or restore is running: the restart below interrupts it.

### 5.2 Turn on

1. On the VM, in the project folder from `docs/vm-runbook.md`, add these lines to the existing `.env` with an
   editor (see `.env.assistant.example` for the comments). Do not replace the existing settings and do not
   print the file.

   ```
   ASSISTANT_ACTIONS_ENABLED=true
   POWER_PROTECTED_OUTLETS=<entries from section 4.3, or none>
   ```

   The other three settings (`ASSISTANT_ACTION_TTL_SECONDS`, `ASSISTANT_ACTION_CYCLE_OFF_SECONDS`,
   `ASSISTANT_ACTION_RESTORE_STAGGER_SECONDS`) can stay at their defaults. A value outside its range
   (30-3600, 1-60 and 0-60 seconds) stops the backend from starting.

2. Restart the backend with the existing service tool:

   ```bash
   backend/.venv/bin/python scripts/lab-service.py restart
   backend/.venv/bin/python scripts/lab-service.py status
   ```

   `status` must show exactly one project PID.

3. Sign in and open `/api/assistant/actions/config` on the site. Expect `"enabled": true`,
   `"password_mode": "account"`, `"protected_configured": true`, and `can_propose` / `can_admin` according to
   your role. `"password_mode": "shared"` or `"unavailable"` means user accounts are off: no action will run.
4. Do the check in section 4.4, then the first test in section 6.

### 5.3 Turn off

Set `ASSISTANT_ACTIONS_ENABLED=false` (or remove the line) and restart as in 5.2. Then the assistant no
longer offers actions, every action request answers 403 `disabled` (only `/api/assistant/actions/config`
still answers), and pending proposals can no longer be confirmed. PDUs that an assistant shutdown left in
maintenance stay in the Maintenance column and are restored there with **Restore power**.

Turning actions off does not remove protected outlets: keep `POWER_PROTECTED_OUTLETS` so the Maintenance
column keeps protecting them.

---

## 6. Safe first test on one non-critical server

Do this once, with the owner's approval, before anyone relies on actions. Steps 1, 2, 4 and 5 change no
power. Step 3 cuts real power to one server.

Choose a server that:

- nobody is using and that holds no work that can be lost;
- is not a VM host, storage, switch, firewall, KVM or anything from section 4.1;
- has every power feed labelled with its name on the PDU page, and a KVM port labelled with its name.

Steps:

1. **Read only.** Ask the assistant for the server's status. Check that it lists every PDU outlet you expect
   (both feeds for two power supplies) and its KVM port. Fix labels first if anything is missing.
2. **Console only.** Type `תפתח לי KVM של <server>`. The card has an **open KVM** button and asks for no
   password. Click it: the console opens. Nothing is switched.
3. **Reset.** Type `תעשה ריסט לשרת <server> ותפתח KVM`. In the card, compare each PDU name and outlet number
   with step 1. Only then confirm with your password. Expect `succeeded`, every outlet confirmed on, and an
   **open KVM** button: click it and watch the server start.
4. **Refusals, nothing switched.** Ask for another reset of the same server and type a wrong password: the
   card says the password is incorrect and the outlets do not change. Then cancel that proposal. Optionally
   let one proposal expire (5 minutes) and check that it can no longer be confirmed.
5. Check the trail: the assistant panel's recent actions show who did what, and section 9 shows the full
   event list.

Do not try a rack or lab shutdown on real equipment until the protected list has passed section 4.4, and
then only with the owner's explicit approval, preferably one rack of non-critical equipment, with a person in
the lab and the restore (section 7) done right after.

---

## 7. Restore after a rack or lab shutdown

The normal path, in the assistant (Admin):

1. Type `תחזיר חשמל`, or use the restore button on the executed shutdown's card or in the recent actions
   list. The assistant prepares a `batch_restore` proposal for your latest shutdown that can still be
   restored. An Admin can also restore a shutdown started by another Admin from its card.
2. The card lists exactly the PDUs and outlets that this shutdown switched off and that are still off.
   Outlets that were already off before the shutdown, protected outlets, and PDUs that someone else put
   into maintenance are not on it.
3. Type the phrase (`LAB ON`, or `<rack> ON`) and your password. The job restores one PDU at a time and
   shows progress.
4. If the result is `partial`, the PDUs that did not fully come back stay in maintenance with only the
   outlets still off. Ask for the restore again, or restore those PDUs from the Maintenance column.

The fallback, always available (Operator, also when actions are turned off or the job was interrupted): on
the **Power** tab, **Maintenance** column, click **Restore power** for each PDU and confirm with your password.
It switches on exactly the outlets on that PDU's restore list. Restore PDUs one at a time.

If the site itself went down (the protected list missed something), the remote path is gone: someone has to
restore power in the lab. Once the VM is back, every PDU's restore list is still in the database and the
Maintenance column restores it as usual.

Restoring outlet power does not always start the servers. Whether a server powers on when power returns
depends on its own power-restore setting. Check the Monitoring page, the PDU pages and the KVM consoles.

---

## 8. Restart during a job

Any backend restart stops a running action: `lab-service.py restart`, an installation (manual or automatic
update, which restarts the site after every new commit) or a VM reboot. A stopped action never resumes: a
rack or lab shutdown is not continued after the restart.

At startup, every proposal still `executing` is marked `interrupted` (event `interrupted` by `system`):

- **Rack or lab shutdown**: PDUs already processed are in maintenance with their restore lists and show in
  the Maintenance column. PDUs not reached yet were not touched. The interrupted card still offers the
  restore (section 7), and each PDU can be restored from the Maintenance column.
- **Restore**: PDUs not restored yet stay in maintenance. Ask for the restore again from the original
  shutdown, or use the Maintenance column.
- **Reset of a server or outlet**: outlets switched off less than 10 minutes before the restart are switched
  back on at startup. If that fails, or the action was older, open the PDU page and switch the server's
  outlets on there.
- **Off or on of a server or outlet**: check the PDU page; the outlets may have been switched only partly.

Avoid restarts and pushes to the deployment branch while a rack, lab or restore job runs.

---

## 9. Audit trail

Every step is recorded with the user name. No password and no typed phrase is ever stored, and events never
contain credentials or device addresses:

- `assistant_action_proposals`: one row per proposal: who created and who confirmed it, the action, the
  impact shown in the card, the status and the results. It also keeps the private snapshot used by the
  re-check (it includes PDU addresses), which is never sent to the browser or to the model.
- `assistant_action_events`: an append-only list of events per proposal: `proposed`, `denied` (wrong
  password or phrase), `throttled`, `confirmed`, `refused`, `executing`, `target` (one outlet result), `pdu`
  (one PDU result), `aborted`, `finished`, `cancelled`, `expired`, `interrupted`. The actor is the user name,
  or `system` for startup recovery. Events are kept for 365 days; `denied` and `throttled` events are capped
  separately (newest 2,000) so they never push out execution history.
- PDU shutdowns and restores done by an action are also written to the **maintenance log**, like the
  Maintenance column's own, with the user's name. The column shows the latest 15 entries.

Where to look:

- The assistant panel's recent actions list, and the cards themselves.
- `GET /api/assistant/actions/proposals` (your own; an Admin sees everyone's) and
  `GET /api/assistant/actions/proposals/<id>`.
- For the full event list, on the VM, from the project folder (read only; times are UTC; the database path
  is the default one):

  ```bash
  backend/.venv/bin/python - <<'EOF'
  import sqlite3
  db = sqlite3.connect("file:backend/lab_manager.db?mode=ro", uri=True)
  for row in db.execute("SELECT datetime(at, 'unixepoch'), proposal_id, actor, event, detail_json "
                        "FROM assistant_action_events ORDER BY id DESC LIMIT 50"):
      print(*row, sep="  ")
  for row in db.execute("SELECT id, datetime(created_at, 'unixepoch'), created_by, kind, status, confirmed_by "
                        "FROM assistant_action_proposals ORDER BY created_at DESC LIMIT 20"):
      print(*row, sep="  ")
  EOF
  ```

---

## 10. Limitations

- **Mapping by labels only.** A server's outlets are the PDU outlets whose label is the server's name. Names
  of the form `OPT<number>` match with any suffix in brackets, so `OPT<number> (PSU1)` and
  `OPT<number> (PSU2)` are one server. Any other name must be identical on every feed (case does not matter).
  A wrong, missing or duplicated label switches the wrong outlet or misses a feed; nothing checks which
  server is really plugged in. Always read the card before confirming.
- **Labels can change during a proposal.** Saving labels does not wait for a running power action; the
  re-check before running catches changes made between the proposal and the confirmation.
- **One backend process.** The per-PDU locks and the one-job-at-a-time rule are inside the process. A second
  backend process, or `--workers`, would remove these protections.
- **No soft reboot yet.** Reset is a hard power cycle. Ctrl+Alt+Del through the KVM needs a browser engine on
  the VM and is planned for a later version.
- **No stop button.** A confirmed rack, lab or restore job cannot be cancelled from the site (planned).
- **Automatic updates do not wait for a running job** (planned). A push during a job restarts the site and
  interrupts it (section 8).
- **Accounts only.** With the shared site password there are no individual users or roles, so actions are
  refused.
- The **KVM in-use mark** is only a hint. The card warns, but cannot tell who is on the console.
- The plain outlet buttons on the PDU page still need no password (unchanged in this version; whether they
  should is an owner decision still pending), except that protected outlets refuse **Off** and **Cycle**.
- Maintenance mode is not a physical lockout. Disconnect power physically before hands-on work.

---

## 11. Troubleshooting

Errors are JSON `{"detail": "<English text>", "code": "<code>", "details": ["<Hebrew reasons>"]}`. The card
shows a Hebrew message for each code.

| Code | Status | Meaning | What to do |
|---|---|---|---|
| `disabled` | 403 | Actions are turned off on this server. | Section 5.2. |
| `forbidden` | 403 | Your role does not allow this action (Viewer, or Operator for rack/lab/restore). | Ask an Admin. |
| `password_mode` | 403 | User accounts are off. | Turn on accounts (`docs/user-accounts.md`). |
| `phrase` | 403 | The typed phrase does not match. | Type the phrase exactly as shown in the card. |
| `password` | 403 | "Password is incorrect". Nothing was switched. | Use your own account password. |
| `throttled` | 429 | Too many wrong passwords in 5 minutes. | Wait for the time shown. |
| `not_found` | 404 | No such proposal, or it belongs to another user. | Ask the assistant again. |
| `not_resolved` | 404 | No server, PDU or KVM port matches the name. `details` lists the closest names. | Use the exact name from the PDU or KVM page. |
| `ambiguous` | 409 | Several servers or PDUs match. `details` lists them. | Use the full name, or the PDU id. |
| `protected` | 409 | The server or outlet action includes a protected outlet. | Switch it from the PDU page only if you are sure. |
| `protected_unset` | 409 | `POWER_PROTECTED_OUTLETS` is empty or invalid. | Section 4.3, then restart. |
| `no_targets` | 409 | Nothing left to switch in this scope (everything off, protected, in maintenance or unreachable), or nothing left to restore. | Check the PDU pages. |
| `drift` | 409 | The re-check found a change; status `refused`, nothing switched. `details` lists what changed. | Ask for a new proposal and review it. |
| `busy` | 409 | Another rack, lab or restore job is running, or you have too many pending proposals. | Wait, or cancel your other proposals. |
| `not_pending` | 409 | The proposal was already used, cancelled or refused. | Ask for a new one. |
| `expired` | 410 | Not confirmed in time. | Ask for a new one. |
| `invalid` | 400 / 409 | A malformed request, or a target PDU that is disabled, unreachable, already in maintenance, or not in maintenance for a restore. | Read `detail`; check the PDU page. |

A PDU shut down from the Maintenance column before an outlet was protected can have that outlet on its
restore list. If the assistant refuses to restore it, use **Restore power** in the Maintenance column.

---

## 12. API reference

All routes are under `/api/assistant/actions`. Actions work only with user accounts on; `GET /config` answers
in every mode. Writes need the CSRF header like every other write. Responses are not cached.

| Method and path | Role | Body / response |
|---|---|---|
| `GET /config` | Viewer | `{enabled, password_mode, protected_configured, can_propose, can_admin}`; works with actions off |
| `POST /proposals` | Operator | `{kind, server?, pdu?, outlet?, rack?, restore_of?, then_console?, reason?}` -> 201 proposal |
| `GET /proposals?limit=20` | Operator | `{items: [proposal]}`, own (Admin: all), newest first |
| `GET /proposals/<id>` | Operator | one proposal (owner or Admin) |
| `POST /proposals/<id>/execute` | Operator, plus the action's role | `{password, phrase?}` -> 200 final proposal, or 202 while a background job runs |
| `POST /proposals/<id>/cancel` | Operator (owner) | -> proposal with status `cancelled` |

The execute body may contain only `password` and `phrase`: what runs always comes from the stored proposal.
The chat answer (`POST /api/assistant/chat`) returns the proposals it prepared as `action_proposals`.
