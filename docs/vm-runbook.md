# Lab Manager VM runbook

Run these commands on `yokbvdiprd955` as `aizyaguev`, from `~/DCIM-204`, with the existing virtualenv `backend/.venv/bin/python`. Do not switch the VM remote to `A7asaf-cloud/DCIM-204-Lab-Manager`. Do not reset or seed the database. Do not power-cycle lab equipment.

`<COMMIT>` is the full 40-character SHA of the reviewed revision being installed. The site stays `http://ftlab.nvidia.com:8000/`.

## 1. Pre-checks

The installed tree may not contain `scripts/lab-service.py` yet, so the pre-check uses the copy pinned to `<COMMIT>`:

```bash
cd ~/DCIM-204
release=<COMMIT>
git remote -v
git rev-parse HEAD
cat backend/version.txt
tools=$(mktemp -d)
for f in lab-service.py install-monitoring.py; do
  curl -fsSL "https://raw.githubusercontent.com/aizyaguev-bot/DCIM-204/$release/scripts/$f" -o "$tools/$f"
done
mkdir -p .monitor-backups
backend/.venv/bin/python "$tools/lab-service.py" --project "$PWD" status --json > .monitor-backups/before.json
```

`git remote -v` must show `https://github.com/aizyaguev-bot/DCIM-204`. Keep `before.json` so inventory counts can be compared after the install.

```bash
grep -o '"accounts_enabled": [a-z]*' .monitor-backups/before.json
```

## 2. Install

If the pre-check printed `"accounts_enabled": true`, keep account mode:

```bash
backend/.venv/bin/python "$tools/install-monitoring.py" "$release" --project "$PWD" --backup-frontend-lock --enable-accounts --finish-stuck-shutdown
git rev-parse HEAD
cat backend/version.txt
```

If it printed `false` (or nothing), run the same command without `--enable-accounts`, so the login mode stays unchanged.

The installer backs up live data to `.monitor-backups/`, smoke-tests the new tree, and restarts the one backend. It does not register boot startup.

## 3. Device API diagnosis

```bash
backend/.venv/bin/python scripts/diagnose-device-api.py --project ~/DCIM-204 --json ~/DCIM-204/.monitor-backups/device-api.json
```

This is read-only. A failed management-API check is not proof that a server or outlet is off. See `docs/device-api-diagnostics.md`.

## 4. Alert simulation

```bash
backend/.venv/bin/python scripts/alerts-setup.py simulate
```

Every line must say `PASS`. The simulation uses a temporary database and does not email anyone or touch the lab.

## 5. SMTP

Use a relay, sender and recipient that were already approved. Do not invent them.

```bash
backend/.venv/bin/python scripts/alerts-setup.py configure \
  --smtp-host <relay> --smtp-port <port> --smtp-security starttls \
  --from <approved-sender> --to aizyaguev@nvidia.com
# only if the relay requires authentication:
# DCIM_SMTP_PASSWORD='...' backend/.venv/bin/python scripts/alerts-setup.py configure ... --smtp-username <user> --password-from-env
backend/.venv/bin/python scripts/alerts-setup.py check
backend/.venv/bin/python scripts/alerts-setup.py test-mail
```

`Accepted by mail relay` means the relay returned success for DATA. Then look in the mailbox for the printed subject and Message-ID. Those are different facts.

Leave `EMAIL_VOLTAGE_*`, `EMAIL_CURRENT_*` and `EMAIL_WATTS_*` unset until thresholds are approved. Availability alerts do not need them.

## 6. Enable

```bash
backend/.venv/bin/python scripts/alerts-setup.py enable --restart
backend/.venv/bin/python scripts/alerts-setup.py verify
```

`enable` refuses to run until `check` is clean and the recorded test mail matches the current mail settings. Minute probes default on. PDU and KVM API alerts still follow the 5/30-minute device schedule, so detection within five minutes is not guaranteed. Minute probes cover server ICMP only.

## 7. Start after reboot

```bash
backend/.venv/bin/python scripts/lab-service.py install-boot
backend/.venv/bin/python scripts/lab-service.py status
```

`status` must show exactly one project PID. `install-boot` adds one managed `@reboot` line and exits without adding it when another boot mechanism already starts this project. `start` takes the installer lock, so a second trigger cannot launch a second backend.

## 8. Compare inventory

```bash
backend/.venv/bin/python scripts/lab-service.py status --json > .monitor-backups/after.json
```

Table row counts and JSON item counts in `after.json` should match `before.json`.

## 9. Automatic updates

Once a release containing `scripts/vm-auto-update.py` is installed (section 2), one command makes the VM install every new commit of `feat/lab-manager-v3-accounts` by itself, within about 5 minutes of a push:

```bash
cd ~/DCIM-204 && backend/.venv/bin/python scripts/vm-auto-update.py install
```

Run it as `aizyaguev`, never as root, from a shell that exports no `LAB_MANAGER_*`, `ACCOUNTS_*`, `DATABASE_URL`, `PDU_*`, `KVM_*`, `SMTP_*`, `EMAIL_*` or `PING_MONITOR_*` (they belong in `.env`; `install` names them and stops). It adds one crontab line marked `# DCIM-204 auto-update (managed)` that runs every 2 minutes; the `@reboot` line from section 7 and all other lines stay. It saves `PATH` and credential-free proxy/CA settings for the cron job (git 2.31 or newer is needed when a proxy or CA file is saved); a proxy setting that contains credentials is not saved. Running it again changes nothing.

Each run compares the branch commit on `github.com/aizyaguev-bot/DCIM-204` with `git rev-parse HEAD`. For a newer commit it downloads that commit's `lab-service.py` and `install-monitoring.py` and runs the installer exactly as in sections 1-2, with `--enable-accounts` only when accounts are on now. Every install restarts the site once. A commit counts as installed only when the installer exits 0, `HEAD` is that commit and a site that was up answers again; otherwise its installer runs again. A failed commit is retried after 30 minutes, at most 3 times, then skipped until a newer commit appears. If another installation is running, the next try waits 10 minutes. Nothing is installed in the first 5 minutes after a boot or with less than 1 GiB free. If a failed or stopped attempt leaves down a site that was up before, it runs `scripts/lab-service.py start`. An installer that is still running when its update run ends (the run was stopped, or the installer survived TERM and KILL) is never signalled by a later run: once it is past its 25-minute limit, `status` and `cron.log` report its PID and how late it is, so it can be stopped by hand.

```bash
backend/.venv/bin/python scripts/vm-auto-update.py status   # --json for all fields
backend/.venv/bin/python scripts/vm-auto-update.py remove   # removes only its own crontab line
ls -t .monitor-backups/auto-update/                          # cron.log, state.json, <UTC time>-<commit>.log per attempt (newest 20)
```

From the laptop, `http://ftlab.nvidia.com:8000/api/version` (public for GET, no sign-in) shows the first 7 characters of the installed commit.

Trust boundary: anyone who can push to this branch runs code on this VM within minutes. Keep GitHub branch protection on `feat/lab-manager-v3-accounts` (owner action).

Installer backups in `.monitor-backups/` (source, database and `.env` copies) are never deleted automatically; `status` shows their count and size and `paused` when free space is low. To prune by hand, review the list, then keep the newest five:

```bash
ls -1dt .monitor-backups/20*/ | tail -n +6
ls -1dt .monitor-backups/20*/ | tail -n +6 | xargs -r rm -rf --
```

Accepted risk: if an installer is stopped after 25 minutes, the temporary preflight server it started on a random local port can keep running until the next reboot. It never uses port 8000 or the live database.
