# Email alerts

Alerts are implemented but **disabled by default**. The recipient defaults to
`aizyaguev@nvidia.com`. Mail relay details and an approved sender must be supplied
before enabling delivery. Electrical limits are only needed for electrical alerts.
No real message is sent during the automated tests or isolated design preview.

## Configure on the existing Linux VM

Merge the applicable entries from `.env.alerts.example` into the existing project
`.env`; preserve the existing authentication, encryption key and database settings.
Set `SMTP_HOST`, `SMTP_PORT` and `EMAIL_ALERTS_FROM` using the organization's relay
configuration. Set `SMTP_USERNAME` and `SMTP_PASSWORD` only if required. Keep the
password on the VM, not in source control or chat. Restart the backend after changes.

`SMTP_SECURITY` supports `starttls` (default), `ssl` (implicit TLS, usually port 465),
or `plain` for an approved internal relay. TLS validates server certificates.
SMTP username/password authentication is refused over `plain`.

Set `EMAIL_ALERTS_ENABLED=true` when ready. `PING_MONITOR_ENABLED` must also be true.
The Ping Monitor page displays the recipient, missing configuration, worker state,
configured electrical thresholds and recent delivery results. "Accepted by mail
relay" means SMTP accepted the message; it does not prove inbox delivery.

## Network alerts

An alert is queued after failed ICMP observations span **strictly more than 300
seconds**. A shorter outage does not send mail. Each incident sends one alert and
one recovery message after a reply; repeated failed checks do not send reminders.
DNS/local probe errors are unknown, not evidence that the server recovered or failed.
Address/revision changes reset confirmation. Paused and unconfigured targets are skipped.

- `EMAIL_ALERTS_MINUTE_PROBES=false`: use the existing Jerusalem-time schedule,
  every five minutes from 07:00–20:00 and every thirty minutes overnight. Detection
  is delayed, and short outages can be entirely missed. Two exactly five-minute
  observations are not yet **more than** five minutes.
- `EMAIL_ALERTS_MINUTE_PROBES=true`: add lightweight ICMP probes about every minute,
  24/7, with eight probes in parallel. The first notification normally follows
  around six minutes after the first failed observation. Actual outage onset can
  precede that first observation. Slow rounds or an unavailable backend add delay.
  This option does not alter the scheduled historical samples or PDU/KVM refreshes.

Before confirmation, a missed observation window or probe error restarts the
confirmation period. Confirmed episodes persist across restarts; an unknown result
never sends a recovery. Sampling cannot establish continuous downtime between checks.

## PDU and KVM API availability alerts

Enabled PDU/KVM devices also send one alert when failed API checks span strictly
more than five minutes, followed by one recovery email when a fresh check succeeds.
Timeouts, rejected credentials and unusable API responses count as API-check failures;
they are not proof that a server is down, an outlet is off, or a console works.
Messages identify the device, address, rack and a sanitized failure reason.

These observations use the existing five/thirty-minute device schedule and
"Check all now". The extra minute probes only check server ICMP, not device APIs.
Consequently device alerts can take two or more checks and are delayed at night;
short failures between checks can be missed. A gap longer than the expected next
check plus two minutes restarts an unconfirmed episode. Reconfiguration of an
address or credentials restarts confirmation, and disabled devices are skipped.
Confirmation and queued mail persist across backend restarts; repeated failures
in the same episode do not send additional messages.

## Electrical alerts

Configure any of `EMAIL_VOLTAGE_MIN/MAX` (V), `EMAIL_CURRENT_MIN/MAX` (A) and
`EMAIL_WATTS_MIN/MAX` (W). Unset bounds are disabled; no limits are guessed from
the design's example charts or the UI's estimated capacity bar. Bounds must be
finite, nonnegative, and min must be below max.

Rules apply to each inlet on each enabled PDU. They evaluate fresh scheduled device
reads (the existing five/thirty-minute schedule) and "Check all now". A value strictly
outside a bound queues an alert immediately at observation time. A later valid value
back inside that bound queues recovery. Each inlet/bound has its own episode.
There is no hysteresis; a reading that repeatedly crosses the boundary can create
new episodes. Per-outlet, per-phase and individual per-device thresholds are not
provided by these global settings.

Missing/invalid readings are `null`, not zero. The driver requires both `valid` and
`available` on each [Xerus NumericSensor reading](https://help.servertech.com/json-rpc/4.3.0/structsensors_1_1NumericSensor_1_1Reading.html).
It reads all returned inlets and rejects nonfinite values. Outlet watt sums and
watts/voltage current estimates are not used for electrical alerts. No device power
or threshold settings are changed.

## Delivery and persistence

Three additive tables hold condition state, queued messages and the worker lease.
Existing device/inventory/history tables are not altered. Multiple backend workers
share one alert sender/probe lease, renewed during long rounds.

Messages and incident state commit together. The outbox retries failed sends with
backoff (30 seconds up to 30 minutes), persists across restarts, and sends oldest
first so a recovery cannot overtake its pending alert. A failing oldest message
delays subsequent mail. Sent records are retained for 90 days; unsent records remain.
Messages use a stable Message-ID, but SMTP is at-least-once: an ambiguous acceptance
or a process crash after acceptance may cause a duplicate on retry.

If the monitoring VM loses its own network, it cannot email until the mail relay is
reachable again. A stopped VM cannot observe failures. An external monitor would be
needed for notifications independent of that VM. Re-enabling delivery also resumes
previously queued mail; check observation timestamps on delayed messages.

## Validation

`backend/tests/test_alerts.py` exercises outage/API confirmation, short failures, restart,
unknown readings, all-inlet evaluation, pause/edit races, worker leases, SMTP retry,
TLS and configuration validation, using test databases and mocked mail/hardware.
A real relay/inbox delivery check is still needed after VM configuration.
