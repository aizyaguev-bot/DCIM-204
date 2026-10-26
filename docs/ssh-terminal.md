# Browser SSH terminal

From v2.41.0 an Operator can open a terminal to an allowed lab server in the browser. The VM connects to that server on
port 22 the same way `ssh root@server` does in the shell of the VM account that runs Lab Manager: with that account's own
SSH keys, then the site's own key (section 3a). No password is needed or asked for. Only servers the site already knows
(Ping Monitor servers and saved PDU/KVM labels) can be reached, and only while SSH is allowed for them (section 4). The
browser never chooses a host, a port or a key. Every session is logged without its contents.

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
| Operator | Everything a Viewer can, plus open terminals and see the public key and install command of the server they open (the full list of install commands is Admin-only) |
| Admin | Everything an Operator can, plus generate or rotate the key, choose which keys are used, allow every server or single servers, turn SSH off for a server, set remote users, accept host-key fingerprints, end all sessions and read the session log |

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

## 3a. Which keys a terminal uses (Admin → SSH → Keys)

The owner's servers already accept the VM account's own sign-in: on the VM, `ssh root@server` works without a password.
The site therefore signs in the same way. Admin → SSH → **Sign in with** offers three choices:

| Key source | How a terminal signs in |
|---|---|
| **This VM's ssh command (same as typing ssh on the VM)** (`"system"`, the default) | Lab Manager runs the VM's own OpenSSH client (`ssh`, found on `PATH`, or `SSH_CLIENT_PATH`) as the account that runs Lab Manager, inside a terminal (PTY), exactly as that account would in its shell: its `~/.ssh/config` and `/etc/ssh/ssh_config` (with their `Include` files), its key files, its ssh-agent, its Kerberos tickets, host-based sign-in and its `~/.ssh/known_hosts` all work as they do there (section 3b) |
| **VM account key files** (`"vm"`) | Lab Manager itself reads the key files that `IdentityFile` lines name for this server (section 3c), then `~/.ssh/id_ed25519`, `~/.ssh/id_ecdsa`, `~/.ssh/id_rsa` of the account running Lab Manager (each one that exists and can be used, and only once), then the Lab Manager key from section 3 |
| **Only the Lab Manager key** (`"site"`) | Only the Lab Manager key |

Every configuration saved before **This VM's ssh command** existed now uses it, with every lab server allowed (section
3b); servers an Admin turned off stay off. An Admin can still choose **VM account key files** or **Only the Lab Manager
key**, and that choice is kept.

### 3b. This VM's ssh command (`"system"`)

- **Zero clicks.** Every known server is allowed automatically: there is no "Allow every server" or "Check addresses
  again" step and no host-key confirmation. **SSH works for every lab server automatically; turn a server off in Admin →
  SSH if needed** (the per-server "turned off" setting, and the same-address rule, work as before).
- **Only lab networks.** So that an Operator cannot point the site at an arbitrary machine, a server is reached only when
  every address its saved host resolves to is inside the lab networks: the /24 (IPv4) or /64 (IPv6) around every saved
  PDU/KVM address and every Ping Monitor server target that is a literal IP, plus any networks listed in the optional
  setting `SSH_ALLOWED_NETWORKS` (comma-separated CIDRs, for example `SSH_ALLOWED_NETWORKS=10.20.0.0/16,fd00:1::/48`).
  The networks are recomputed at most every 60 seconds. A server outside them shows **Outside the lab networks (add it
  to SSH_ALLOWED_NETWORKS)**; a server whose name the VM cannot resolve is not allowed either. Loopback, link-local,
  multicast and the VM's own addresses stay refused (section 4).
- **The exact command.** No shell is involved; the arguments are fixed:
  `ssh -tt -p 22 -o BatchMode=yes -o ConnectTimeout=<SSH_CONNECT_TIMEOUT_SECONDS> -o ServerAliveInterval=30
  -o StrictHostKeyChecking=accept-new -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes
  -o PermitLocalCommand=no -o RequestTTY=force -l <user> -- <saved host>`. `BatchMode=yes` means it never asks for a
  password or passphrase. Agent, X11 and port forwarding are always off. The saved host string is passed after `--`,
  so the account's `~/.ssh/config` (`HostName`, `ProxyJump`, `IdentityFile`...) applies to it as in the shell.
- **The environment** of the ssh process is the service's own minus everything else: only `HOME`, `USER`, `LOGNAME`,
  `PATH`, `LANG`/`LC_*`, `TZ`, `SHELL`, `SSH_AUTH_SOCK`, `KRB5CCNAME`, `KRB5_CONFIG` and `XDG_RUNTIME_DIR` are kept,
  and `TERM=xterm-256color`. Lab Manager secrets, tokens and passwords never reach it. A service has no login session,
  so when `SSH_AUTH_SOCK` is not set Lab Manager looks for this account's own running ssh-agent (`$XDG_RUNTIME_DIR` or
  `/run/user/<uid>`, then `/tmp/ssh-*/agent.*`; sockets owned by this account only). A key that needs its passphrase
  works only through such an agent.
- **Host keys** are checked by the VM account's `~/.ssh/known_hosts` (`accept-new`: a new server is added on first
  connection; a changed key is refused). Admin → SSH shows "Host keys are checked by the VM account's known_hosts"; the
  site's own pins (sections 5 and 6) do not apply. If a server was reinstalled, remove its old line on the VM as the
  account that runs Lab Manager: `ssh-keygen -R <server>`.
- **Errors.** Nothing ssh prints on its own error output is shown or stored. A failure before the session starts (exit
  status 255) becomes one fixed reason: `auth_failed` (Permission denied), `refused` (Connection refused), `unreachable`
  (No route to host, Could not resolve hostname, Connection timed out), `host_key_changed` (REMOTE HOST IDENTIFICATION
  HAS CHANGED, Host key verification failed), `connect_timeout`, or `connection_failed`.
- **Limits.** The idle timeout, maximum length, session quotas, input rate limit, connection-attempt limit, audit log
  and Admin "end sessions" apply as for the other key sources. Closing the terminal sends SIGHUP and then SIGKILL to the
  whole ssh process group and always waits for it.
- **Linux only.** On a machine without a PTY (Windows development) or without an `ssh` command, the status reports
  `system_ssh: {"available": false, "reason": ...}` and a terminal closes with "The VM's ssh command is not available -
  an Admin can choose another key source in Admin -> SSH".
- **Which account.** It is the account that runs the Lab Manager service. If `ssh root@server` works for you on the VM
  as a different user, run the same command as the service account to check.

### 3c. VM account key files (`"vm"`)

- A key file protected by a passphrase is listed with the reason "The VM's key <name> needs its passphrase (ssh-agent);
  install the Lab Manager key once (Admin → SSH) or start Lab Manager with access to the agent" (or, when this account
  has a running ssh-agent, a pointer to **This VM's ssh command**, which uses it).
- A VM key protected by a passphrase, unreadable by the service account, readable by other users (the same rule OpenSSH
  applies), or not a private key is skipped. Admin → SSH lists each key file by name with its type and, for a skipped
  file, the reason. The service log records the same reason once per file, with the file name only. The site never asks
  for or uses a passphrase.
- With the VM account keys, a terminal works before the Lab Manager key is generated. If no key can be used at all, the
  terminal says `No SSH key is available: ...`.
- **`~/.ssh/config`: `IdentityFile` only.** Many servers are reached with a key that `~/.ssh/config` names, not one of
  the three default files. From that file (in the same folder as the default keys) the site uses only the
  `IdentityFile` lines, the way the VM account's `ssh root@server` picks them:
  - lines before the first `Host` count for every server; a `Host` block counts when one of its patterns matches the
    server's saved host or its name (`*`, `?`, several patterns, case-insensitive; a matching `!pattern` rules the
    block out); `Match` blocks never count;
  - `~/` and the tokens `%d` (home folder), `%u` (local user), `%h` (the saved host), `%r` (the remote user) and `%%`
    are expanded; an entry with any other token, `${...}`, `~user` or a relative path is listed with the reason and
    not used;
  - keys are offered in the file's order, each file once, at most 16 from the config, then the default files the
    config did not already name; a file that does not exist is left out;
  - each file goes through the same checks as a default key (a regular file, not readable by other users, not
    passphrase-protected, a private key), so an unusable file is skipped with its reason;
  - `/etc/ssh/ssh_config` is read after `~/.ssh/config`, the way ssh reads it, by the same rules;
  - `Include` is followed for `IdentityFile` lines only (relative paths from `~/.ssh` for the user config and from
    `/etc/ssh` for the system config, `~/` expanded, globs such as `ssh_config.d/*.conf` sorted; at most 8 levels and
    32 files; an `Include` inside a `Host` block that does not match is not followed);
  - every other line has no effect: `ProxyCommand`, `ProxyJump`, `LocalCommand`, `IdentityAgent`, `CertificateFile`,
    `HostName`, `Port`, `User` and the rest are never used or run;
  - a config that is writable by other users or owned by another account (OpenSSH refuses it too) is not read; Admin
    → SSH lists it as `config` with the reason, and the default files still work.
- The ssh-agent, agent forwarding, X11 forwarding, port forwarding, password and keyboard-interactive logins are never
  used. The host-key pinning (sections 5 and 6) and every address check (section 4) apply unchanged.
- The key files never leave the VM. The API, the audit log and the service log carry only the file name (for example
  `id_ed25519`, or `config:id_lab` for a file `~/.ssh/config` names) and the key type (for example `ssh-ed25519`),
  never key material or a path.
- Admin → SSH (no particular server) lists the keys of every `Host` block of the config; entries that depend on the
  server (`%h`, `%r`) are checked when a terminal to that server opens.
- **Who gets this access.** Every Operator who can open a terminal uses the VM account's server access. Choose **Lab
  Manager key only** if Operators must reach only the servers that have the restricted Lab Manager key installed
  (section 4).
- **Which servers get it.** The VM account's keys are offered only to a server an Admin allowed one by one, or to a saved
  host the Admin's last **Check addresses again** pass checked (section 4). Operators can add servers and change saved
  hosts in the inventory, so a new or changed address gets no keys and no connection until an Admin presses
  **Check addresses again** once.
- Tests point the key folder at a temporary fake home through the `SSH_VM_KEY_DIR` setting. On the VM, leave it unset:
  the default is `~/.ssh` of the account that runs Lab Manager.

## 4. Allow servers, then (optionally) install the Lab Manager key on each server

1. **Admin → SSH → Servers.** Set the default remote user (`root` unless changed) and any per-server users (POSIX names:
   lowercase letters, digits, `_` and `-`, at most 32).
2. **Allow every server with an address** is on by default, including for a configuration saved before this switch
   existed. It allows each known server for the **saved host an Admin's check saw**:
   - Turning the switch on, or pressing **Check addresses again** (both send `PUT /api/ssh/config` with
     `{"auto_allow": true}`), checks every saved host now and records the hosts that passed. A server whose host the
     VM cannot resolve, or that points to a loopback, link-local, multicast or VM address, is listed as skipped with the
     reason, and stays off until its address is fixed and the check runs again.
   - **New or changed servers need one Admin click.** Until an Admin presses **Check addresses again**, a server added
     to the inventory later, and a server whose saved host changed since the check, shows "Address changed" and
     cannot be opened: the terminal says `This server is new or its address changed since an Admin last checked the
     addresses ...`. After an upgrade, or on a new install, nothing is allowed this way before the first click.
   - Each connection still resolves and checks the address first.
   - Turning SSH off for a single server always wins: that server stays off whatever else is allowed. The site also
     remembers that server's host. Any other server with the same host (case and a trailing dot do not matter) is off
     too, and a connection is refused (`denied`) when its address is one the turned-off host resolves to. Another
     inventory name for the same machine therefore cannot get around it.
   - Turning the switch off leaves only the servers an Admin allowed one by one, and forgets the checked hosts.
3. **Allowing single servers** (when the switch is off) works as before. An approval is accepted only when:
   - the host matches the server's saved host;
   - it resolves to an address that is not loopback, link-local, multicast or one of the VM's own addresses.
4. **Install the Lab Manager key on a server** that does not accept the VM account's keys, or on every server when the key
   source is **Lab Manager key only**. Admin → SSH lists one command per server. Run it
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
5. `ssh-copy-id` is shown as a secondary helper only. It installs the key **without** the restrictions above and needs a
   password login to the server once. If you use it, edit the new line on the server afterwards and put the options in front
   of `ssh-ed25519`.

**Never install this key on the VM itself.** The site refuses the VM's own addresses as targets. An entry in the VM's
own `authorized_keys` would still let anyone holding the key log in to the VM.

## 5. First connection pins the host key

Operators open a server's terminal with its **SSH** button. The terminal page connects at once when SSH is available for
that server; after a session closes, **Reconnect** opens a new one. When SSH is not available, the page shows the reason and
does not connect. Lab Manager starts only the remote account's login shell: it never runs a command or writes anything on
the server by itself.

On the first connection the site records the key the server presents ("trust on first use"). The status line says:

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

## 6a. Why a connection failed

When a terminal cannot open, the browser receives one fixed reason and turns it into a sentence. The same reason is
written to the session log. The SSH library's own error text is never shown or stored.

| Reason | Meaning | Example text on the page |
|---|---|---|
| `unreachable` | The server did not answer, has no route, or the VM cannot resolve its name | `Opt106 did not answer. Check that it is powered on and connected to the network.` |
| `refused` | Nothing listens on port 22 | `Port 22 on Opt106 is closed. Check that the SSH service (sshd) is running on it.` |
| `auth_failed` | The server accepted none of the offered keys | `Opt106 did not accept the VM's keys or the Lab Manager key for root.` |
| `host_key_changed` | The server's host key differs from the pin (section 6) | `The host key of Opt106 changed. ...` |
| `denied` | The saved address points to a loopback, link-local, multicast or VM address, or to an address SSH is turned off for (section 4) | `Lab Manager did not allow this SSH session to Opt106. ...` |
| `connect_timeout` | The server answered but the SSH login did not finish in time | |
| `connection_failed` | Any other SSH failure | |

Refusals by the site itself (SSH turned off for the server, session limits, a missing CSRF token, no usable key) keep
their own fixed sentence. There is no password fallback: the page never asks for a server password.

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
| `SSH_MAX_CONNECT_ATTEMPTS_PER_MINUTE` | `12` | Terminal attempts per person per minute on all servers (sessions, failed connections and denials); checked before any lookup |
| `SSH_VM_KEY_DIR` | empty | Folder of the VM account keys (section 3a); empty means `~/.ssh` of the account running Lab Manager |

An open terminal re-checks its sign-in at least every 30 seconds. It closes when the user signs out, is disabled, loses
the Operator role or the login expires.

**What is logged.** Each terminal is recorded in the `ssh_sessions` table:

- who opened it (user and name);
- the browser's address;
- the server, its host and the address actually connected;
- the host-key fingerprint;
- the key source in use (`vm` or `site`), and the type and file name of the key the server accepted (for example
  `ssh-ed25519` and `id_ed25519`, `config:id_lab` for a file `~/.ssh/config` names, or `lab-manager` for the site
  key), never the key itself;
- start and end time, and why it ended (section 6a);
- how many bytes went each way.

Admin actions are logged in the same table: key generated or rotated, configuration changed (`config_updated`),
"allow every server" switched on or off (`auto_allow_on`, `auto_allow_off`), key source switched (`key_source_changed`),
fingerprint accepted, sessions ended, denied attempts, and connections that failed before a session started
(`connect_failed`, for example an unresolvable name). **Keystrokes and terminal output are never stored.** Admin → SSH → Sessions shows the newest
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

## 10. API summary (for the site's pages)

- `GET /api/ssh/status` (Viewer): `enabled`, `available`, `installed`, `key_exists`, `auto_allow`, and per server
  `key`, `name`, host-key state, `allowed`, `approval` (`explicit`, `auto`, `denied`, `skipped`, `address_changed`,
  `none`, or with key source `system` also `outside` and `unresolved`). Operators also get `default_user`, `key_source`
  (`system`, `vm` or `site`), `system_ssh` (`{"available", "reason"}`), and per server `host`, `approved_host`, `user` and
  `not_allowed_reason`. Admins also get `config_revision` (the value for `If-Match`).
- `GET /api/ssh/config` (Admin): `default_user`, `per_server_user`, `targets`, `denied`, `auto_allow`, `key_source`,
  `auto_skipped`, `auto_hosts` (the saved hosts the last check allowed), `denied_hosts` (the host of each
  turned-off server, recorded when it was turned off; these three are kept by the site and ignored in a `PUT`) and `vm_keys` (`[{"name": "id_ed25519", "type": "ssh-ed25519", "usable": true,
  "reason": ""}]`, existing files only, by name; a key that `~/.ssh/config` names is `"config:<file name>"`, and an
  unusable config itself is a row named `"config"`). The `ETag` covers the saved settings only.
- `PUT /api/ssh/config` (Admin, `If-Match` required): any subset of `default_user`, `per_server_user`, `targets`, `denied`,
  `auto_allow` and `key_source`; fields left out keep their saved values. `{"auto_allow": true}` alone re-runs the address
  check. The answer is the same shape as `GET`, plus `skipped: [{key, name, host, reason}]` when servers were left out.
- `WS /api/ssh/<server>/terminal` (Operator): the first message carries the CSRF token. The server sends
  `{"type": "status", "state": "connecting" | "connected" | "closed", "reason": ...}` and `{"type": "output", "data": ...}`.
  A failed connection closes with one of the reasons in section 6a. There is no password message.
- `GET /api/ssh/key`: the public key with install and revoke commands. Without `?server=<key>` it lists every server
  and is Admin-only. An Operator must name the server (`?server=<key>`, as the terminal page does). The VM's source
  address per host is looked up in parallel with a 15-second total limit and remembered for 2 minutes. A row that
  could not be looked up shows `<VM IP>` with a reason.
- `GET /api/ssh/sessions` (Admin): the newest 200 log rows, including `key_source`, `key_type` and `key_name`.
