# Browser SSH terminal

From v2.41.0 an Operator can open a terminal to an approved lab server in the browser. The VM connects to that server
with the site's own SSH key (ed25519, port 22). Only servers the site already knows (Ping Monitor servers and saved PDU/KVM
labels) can be reached, and only after an Admin approves them. The browser never chooses a host or a port. Every session
is logged without its contents.

All commands below run on the VM as the account that owns `~/DCIM-204`, unless a step says "on the server".

## 1. Before you start

- **User accounts must be on** (`ACCOUNTS_ENABLED=true`). In shared-password mode the API answers
  `SSH terminal requires user accounts`.
- **The site runs on plain HTTP.** Everything typed into the terminal (including any `sudo` password) and everything the
  server prints travels between the browser and the VM unencrypted, so anyone on that network path could read or change it.
  The terminal therefore stays off until the owner accepts this risk. Add this line to the VM's `.env`:

  ```bash
  SSH_ALLOW_INSECURE_TRANSPORT=true
  ```

  Then restart the site with `backend/.venv/bin/python scripts/lab-service.py restart`. Without the line, the terminal is
  refused with a message that names the setting. The planned fix is HTTPS for the site. Once that is in place, remove the line.
- **The SSH package (`asyncssh`) must be installed** in the VM's venv. The installer adds it automatically (see section 9).
  Until it is installed, Admin → SSH shows `SSH support is not installed on the server`. The rest of the site keeps working.

## 2. Who can do what

| Role | Can |
|---|---|
| Viewer | See whether SSH is available, the server list and the host-key state |
| Operator | Everything a Viewer can, plus see the public key and install commands, and open terminals |
| Admin | Everything an Operator can, plus generate or rotate the key, approve servers and remote users, accept host-key fingerprints, end all sessions and read the session log |

Generating or rotating the key, accepting a fingerprint and ending all sessions each ask for the Admin's password again.

Every Operator signs in to a server as the same remote account. The server cannot tell Operators apart, so the site's session
log is the only per-person record.

## 3. Generate the key (Admin → SSH)

Press **Generate key** and confirm with your password. The key is created on the VM in `~/DCIM-204/backend/ssh/`. The
folder is mode 0700 and the private key is mode 0600. The key comment has the fixed form `dcim-204-<yyyymmdd>-<6 hex>`,
for example `dcim-204-20261021-3fa9c1`; write it down, because revoking by comment uses it (section 7).

The private key is not encrypted on disk. Three safeguards protect it:

- It is never in Git, never sent by the API, and never copied into installer backups (`.monitor-backups/`). A test checks
  the backup rule.
- The `from="<VM IP>"` option (section 4) means a stolen copy is useless from any other machine.
- You never copy it anywhere else.

## 4. Approve servers, then install the public key on each server

1. **Admin → SSH → Servers.** Set the default remote user and any per-server users (POSIX names: lowercase letters,
   digits, `_` and `-`, at most 32). Approve each server that may be reached. An approval is accepted only when:
   - the host matches the server's saved host;
   - it resolves to an address that is not loopback, link-local, multicast or one of the VM's own addresses.
2. **Install the public key on each approved server** (primary method). Admin → SSH lists one command per server. Run it
   **on that server**, as the remote user, from the KVM console or your usual admin access. It appends one restricted line to
   `~/.ssh/authorized_keys`:

   ```text
   from="<VM IP>",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc ssh-ed25519 AAAA... dcim-204-20261021-3fa9c1
   ```

   - `from="<VM IP>"`: the key works only for connections from the VM. The site fills in the VM's address.
   - `no-agent-forwarding`, `no-port-forwarding`, `no-X11-forwarding`: the session cannot be used as a tunnel or to reach
     other machines.
   - `no-user-rc`: `~/.ssh/rc` is not run at login.

   Copy the command exactly as the site shows it. It creates `~/.ssh` (0700) and sets `authorized_keys` to 0600.

   Before you run it, check that the `from=` address is the VM address the servers actually see. `hostname -I` on the VM
   lists all of the VM's addresses. If the site picked a container or bridge address, put the right address in the command;
   otherwise the server refuses the key.
3. `ssh-copy-id` is shown as a secondary helper only. It installs the key **without** the restrictions above and needs a
   password login to the server once. If you use it, edit the new line on the server afterwards and put the options in front
   of `ssh-ed25519`.

**Never install this key on the VM itself.** The site refuses the VM's own addresses as targets. An entry in the VM's
own `authorized_keys` would still let anyone holding the key log in to the VM.

## 5. First connection pins the host key

Operators open a server's terminal with its **SSH** button and an explicit **Connect** click. On the first connection the site
records the key the server presents ("trust on first use"). The status line says:

```text
new host key pinned SHA256:... (unconfirmed; compare using the KVM console)
```

The pin stays **unconfirmed** until an Admin checks it:

1. On that server's KVM console run:

   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

   If the site pinned a different algorithm, use `ssh_host_ecdsa_key.pub` or `ssh_host_rsa_key.pub` instead.
2. Compare the `SHA256:` value with the fingerprint shown in Admin → SSH.
3. If they match, press **Confirm key…** and confirm with your password. The pin becomes confirmed.
4. If they differ, do not use the terminal for that server. Another machine answered at that name or address: a DNS or
   IP mistake, or someone in the middle. Fix the server's saved host first.

## 6. When the host key changes

Pins are kept per server. Any key or algorithm that differs from the pin counts as a change. The site then refuses to
connect and shows:

```text
Host key changed; an Admin must confirm the offered fingerprint
```

The offered fingerprint is recorded but not trusted. This is expected after a server is reinstalled or its SSH host keys are
regenerated. If neither happened, treat it as a possible interception and do not continue.

There is no blind "forget" button. To move to the new key, an Admin:

1. Checks the new fingerprint on the server's KVM console, as in section 5.
2. Presses **Accept new key…** for the offered value in Admin → SSH and confirms with their password.

The replacement succeeds only if both fingerprints still match what the Admin saw: the old pin, and the offered value the
site recorded. If anything changed in between, the request is refused and the page must be reloaded. The new pin is
confirmed immediately.

## 7. Revoke or rotate the key

**Remove the key from a server.** Admin → SSH lists a revoke command for every server, for the current key and for earlier
keys. It removes the line by matching the key itself. To remove it by its fixed comment instead, run this **on the
server**, replacing the comment with yours:

```bash
cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak
grep -v ' dcim-204-20261021-3fa9c1$' ~/.ssh/authorized_keys.bak > ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
grep -c 'dcim-204-' ~/.ssh/authorized_keys   # 0 when no DCIM-204 key is left
```

**Replace the key on the site.** Use **Admin → SSH → Replace key…**:

- It asks for your password, and it applies only to the fingerprint you are looking at.
- Tick "end sessions" to close open terminals at the same time.
- The old key's fingerprint and comment stay listed, with their revoke commands.
- Install the new key (section 4) on every server that should stay reachable, and run the revoke command for the old key on
  each of them.

**Stop everything at once.** **Admin → SSH → End N open sessions…** closes every open terminal. To switch the feature off, set
`SSH_TERMINAL_ENABLED=false` in `.env` and run `backend/.venv/bin/python scripts/lab-service.py restart`.

## 8. Limits and logging

| `.env` setting | Default | Meaning |
|---|---|---|
| `SSH_TERMINAL_ENABLED` | `true` | Master switch |
| `SSH_ALLOW_INSECURE_TRANSPORT` | `false` | Must be `true` while the site is on plain HTTP (section 1) |
| `SSH_CONNECT_TIMEOUT_SECONDS` | `10` | Time to reach the server |
| `SSH_IDLE_TIMEOUT_SECONDS` | `1800` | Closes a terminal with no keystrokes for 30 minutes |
| `SSH_MAX_SESSION_SECONDS` | `3600` | Hard limit on one terminal's lifetime |
| `SSH_MAX_SESSIONS_PER_USER` | `4` | Open terminals per person |
| `SSH_MAX_SESSIONS_TOTAL` | `20` | Open terminals on the whole site |

An open terminal re-checks its sign-in at least every 30 seconds. It closes when the user signs out, is disabled, loses
the Operator role or the login expires.

**What is logged.** Each terminal is recorded in the `ssh_sessions` table:

- who opened it (user and name);
- the browser's address;
- the server, its host and the address actually connected;
- the host-key fingerprint;
- start and end time, and why it ended;
- how many bytes went each way.

Admin actions are logged in the same table: key generated or rotated, configuration changed, fingerprint accepted, sessions
ended, and denied attempts. **Keystrokes and terminal output are never stored.** Admin → SSH → Sessions shows the newest
200 entries.

## 9. How the SSH package gets onto the VM

`scripts/install-monitoring.py` is run by `scripts/vm-auto-update.py` for every release, or by hand as in
`docs/vm-runbook.md`. Before its smoke test, while the old site keeps running, it compares the release's
`backend/requirements.txt` with the VM's `backend/.venv`:

- **Nothing missing.** A local check that cannot reach any index prints
  `Backend Python packages already match backend/requirements.txt.` and the step ends.
- **Something missing**, for example `asyncssh==2.17.0` or `anthropic==1.15.0`. Only those packages are **added**:
  1. Every package already in the venv is pinned to its current version.
  2. pip downloads from the fixed index `https://pypi.org/simple`: wheels only, no `pip.conf` or `PIP_*` settings, no
     trusted-host exceptions. This download is the dry run.
  3. The installer inspects the downloaded files. If any installed package would change version, it installs nothing.
  4. Otherwise it installs exactly the new wheels, offline and with `--no-deps`.

  On success it prints `Backend Python packages added: asyncssh 2.17.0, ...`.
- **A different version is already installed.** That package is never upgraded or downgraded automatically. The
  installer prints a `NOTE: ... these stay as they are` line.
- **The proxy.** The download uses the proxy and CA settings saved by `vm-auto-update.py install`. They are passed to pip
  only, as environment variables; the backend never sees them. A setting that may contain credentials is never saved or
  used.
- **Time limits.** The download stops after 10 minutes and the local install after 3. pip's whole process group is then
  stopped.
- **Failure is never fatal.** If anything in this step fails, the installer prints `WARNING: backend Python packages were
  not added: <reason>. The update continues; ...` and installs the release anyway. The SSH terminal then reports
  `SSH support is not installed on the server`, and the AI assistant stays in demo mode with the reason `sdk_missing`. The
  next release tries again.
- **Logs.** pip's output, with any `user:password@` removed, is kept in `.monitor-backups/<backup>/pip.log`. The package
  list before the step is in `python-packages-before.txt` in the same folder. Downloaded wheels are not kept. Auto-update
  runs also print these lines in `.monitor-backups/auto-update/<UTC time>-<commit>.log`.

To add the packages by hand with the same guarantee (installed versions stay pinned), run on the VM:

```bash
cd ~/DCIM-204
backend/.venv/bin/python -m pip list --format=freeze > .monitor-backups/pinned-now.txt
backend/.venv/bin/python -m pip install -c .monitor-backups/pinned-now.txt asyncssh==2.17.0
backend/.venv/bin/python scripts/lab-service.py restart
```

If pip refuses because a pinned package would have to change, stop there: that change needs a reviewed release.
