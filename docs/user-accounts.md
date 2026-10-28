# User accounts and permissions

Account mode adds real server-side users, roles, profile/preferences and sessions.
It is opt-in to keep an existing VM's shared-password login working until both
frontend and backend are installed together. The HTML handoff's users and
passwords are not included. Accounts are stored in the same SQLite database as
devices, in new tables; existing device/inventory/monitoring data is preserved.

## Enable on the Linux VM after installation

The reviewed-release installer can enable accounts in the same transaction with
`--enable-accounts`. It tests account startup, real sign-in and authenticated APIs
in an isolated database before stopping the existing site. It preserves the
existing `.env` settings, backs up that file, sets `ACCOUNTS_ENABLED=true`, and
restores the previous configuration if deployment health checks fail. Health
checks use a local temporary session that expires in one minute and is deleted
after the check; users and passwords are not modified by those checks.

Merge `.env.accounts.example` into the existing project `.env`, set
`ACCOUNTS_ENABLED=true`, and restart the existing Lab Manager service. Keep the
existing `LAB_MANAGER_PASSWORD` configured for the first start. When the users
table is empty, it initializes one Admin using `ACCOUNTS_ADMIN_USERNAME` (default
`admin`) and that existing password. The password is hashed. Subsequent restarts
never reset users or passwords. If no initial password is configured, sign-in
reports that an administrator must initialize accounts; anonymous registration
cannot create the first account. Do not disable account mode as a logout method.

In account mode the old shared HTTP Basic password does not authorize API calls.
Sign in through the new page. All application API reads require a session, including
inventory/layout reads that were public in legacy mode. Disabling account mode
restores the prior shared-password behavior but leaves account data in place.

Use Admin → Users to create accounts. New users must change their temporary
password at first sign-in. Password resets generate a fresh temporary password,
shown once in a dialog and never stored in plaintext. Disabling an account,
changing its role, resetting its password or removing it revokes its sessions.
Admins cannot demote, disable, reset or remove themselves through user management;
they change their own password in Account settings. The last active admin is
protected by a database condition.

## Roles

- Viewer: reads device status, inventory, monitoring and history. Can manage their
  own profile/password/preferences. Cannot edit racks, change power, scan-write,
  change monitoring or open KVM sessions.
- Operator: Viewer access plus outlet actions, console access, label/mapping
  changes, inventory moves, rack layout/owners and monitoring configuration.
- Admin: Operator access plus device/rack creation/removal/configuration and
  account management. All role decisions are enforced on the server, including
  KVM GET console routes and WebSocket connection handshakes.

Account preferences control the start tab, refresh interval (5/15/30/60 seconds),
confirmation before individual power-off/cycle actions, and compact rack cards.
Compact mode hides only empty shelves 05–08 and shows them again during editing.
Changing UI refresh does not change the backend ping schedule. The standalone
Twin uses the same session, CSRF protection, role gate and refresh preferences.

Self-registration is disabled by default. If approved for the lab, enable
`ACCOUNTS_REGISTRATION_ENABLED=true` to expose Create account. Self-registration
can only create Viewers; a lab admin assigns elevated roles.

## Sessions and password storage

Passwords use salted scrypt (`N=16384, r=8, p=5`). Sessions use random opaque tokens
in HttpOnly, SameSite=Lax cookies; only token hashes are saved in SQLite. Session
duration defaults to 12 hours. Set `ACCOUNTS_SECURE_COOKIE=true` when using HTTPS;
HTTPS requests also set Secure automatically. The existing plain-HTTP VM requires
it false until HTTPS is configured. Mutations require a session-bound CSRF header
and reject foreign browser origins. Login/register are rate-limited by username
and client address. Changing a password revokes other sessions and rotates the
current cookie and CSRF token.

Implementation references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
[sessions](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html),
and [CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

## Local preview and installation state

The design preview connected to the current VM uses its existing login and only
forwards allowlisted reads. That VM cannot show new account-management or email
delivery APIs until the backend update is installed. These new features are tested
against a separate temporary database with simulated hardware. No test sends
production power commands, changes production users or sends real email.

The deployment URL is http://ftlab.nvidia.com:8000/ (the existing
`yokbvdiprd955` VM). After an initial account-enabled installation, sign in as
`admin` (or the configured `ACCOUNTS_ADMIN_USERNAME`) with the existing site
password, then create team users in Admin → Users.
