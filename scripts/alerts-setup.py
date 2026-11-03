#!/usr/bin/env python3
"""Configure SMTP, send one relay test, and enable Lab Manager email alerts.

Secrets stay in the project .env. This script never prints a password, and it
never guesses a mail relay. Electrical thresholds are left untouched.
"""
import argparse
import asyncio
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import smtplib
import sys
import tempfile
import time
from types import SimpleNamespace
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
ENV_KEYS = {
    "to": "EMAIL_ALERTS_TO",
    "from": "EMAIL_ALERTS_FROM",
    "host": "SMTP_HOST",
    "port": "SMTP_PORT",
    "security": "SMTP_SECURITY",
    "username": "SMTP_USERNAME",
    "password": "SMTP_PASSWORD",
    "enabled": "EMAIL_ALERTS_ENABLED",
    "minute": "EMAIL_ALERTS_MINUTE_PROBES",
}
LINE_RE = re.compile(r"^(\s*)(?:(export)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")
RECORD_NAME = "alerts-test-ok.json"


def project_dir(value):
    root = Path(value or ROOT).resolve()
    backend = str(root / "backend")
    if backend not in sys.path:
        sys.path.insert(0, backend)
    return root


BARE_VALUE_RE = re.compile(r"^[A-Za-z0-9_@%+=:,./-]*$")


def parse_env(text):
    # Same parser as the backend (pydantic-settings -> python-dotenv), so a value
    # verified here is exactly the value the service will load.
    from io import StringIO
    from dotenv import dotenv_values
    return {key: value or "" for key, value in dotenv_values(stream=StringIO(text)).items()}


def env_value(value):
    """Serialize a value so python-dotenv reads it back unchanged."""
    if "\n" in value or "\r" in value:
        raise RuntimeError("values containing line breaks are not supported in .env")
    if "${" in value:
        # python-dotenv expands ${...} in every quoting style and has no escape for it.
        raise RuntimeError("values containing ${ cannot be stored safely in .env")
    if BARE_VALUE_RE.match(value):
        return value
    if value.endswith("\\"):
        # In quotes a final backslash reads as an escaped closing quote; unquoted
        # values are read verbatim unless they start with a quote or hold " #".
        if value[0] not in "'\"" and not value[0].isspace() and not re.search(r"\s#", value):
            return value
        raise RuntimeError("values ending in a backslash cannot contain spaces before # or start with a quote or space in .env")
    if "'" not in value:
        # python-dotenv decodes \\ and \' inside single quotes.
        return "'" + value.replace("\\", "\\\\") + "'"
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render_env(text, updates):
    # Replace whole dotenv bindings, so a quoted value spanning several lines
    # is replaced completely instead of leaving its continuation behind.
    from io import StringIO
    from dotenv.parser import parse_stream
    newline = "\r\n" if "\r\n" in text else "\n"
    seen = set()
    rendered = []
    for binding in parse_stream(StringIO(text)):
        chunk = binding.original.string
        if binding.error or binding.key not in updates:
            rendered.append(chunk)
            continue
        body = chunk.lstrip()
        leading = chunk[:len(chunk) - len(body)]
        match = LINE_RE.match(body.splitlines()[0])
        export = "export " if match and match.group(2) else ""
        ending = re.search(r"(\r\n|\n|\r)?$", chunk).group(1) or ""
        rendered.append(f"{leading}{export}{binding.key}={env_value(updates[binding.key])}{ending}")
        seen.add(binding.key)
    missing = [key for key in updates if key not in seen]
    if missing:
        if rendered and not rendered[-1].endswith(("\n", "\r")):
            rendered[-1] += newline
        for key in missing:
            rendered.append(f"{key}={env_value(updates[key])}{newline}")
    return "".join(rendered)


def backup_env(root, original):
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    destination = root / ".monitor-backups" / f"{stamp}-env"
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(destination, 0o700)
    saved = destination / ".env"
    saved.write_bytes(original)
    os.chmod(saved, 0o600)
    return destination


def write_env(root, updates):
    path = root / ".env"
    if path.is_symlink():
        raise RuntimeError(".env is a symlink; refusing to edit it")
    original = path.read_bytes() if path.exists() else b""
    updated = render_env(original.decode("utf-8"), {str(k): str(v) for k, v in updates.items()}).encode("utf-8")
    backup_env(root, original)
    # mkstemp creates the file exclusively with mode 0600 before secrets are written.
    handle, name = tempfile.mkstemp(dir=root, prefix=".env-alerts-", suffix=".tmp")
    temporary = Path(name)
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(updated)
        if path.exists():
            shutil.copymode(path, temporary)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
    return path


def read_env(root):
    path = root / ".env"
    if path.is_symlink():
        raise RuntimeError(".env is a symlink; refusing to read it for editing")
    if not path.exists():
        return {}
    return parse_env(path.read_text(encoding="utf-8"))


def _optional_float(values, key):
    raw = values.get(key)
    if raw is None or str(raw).strip() == "":
        return None
    return float(raw)


def settings_from_values(values):
    from pydantic import SecretStr, ValidationError
    from app.config import Settings
    try:
        return Settings(
            _env_file=None,
            email_alerts_enabled=_flag(values.get("EMAIL_ALERTS_ENABLED", "false")),
            email_alerts_minute_probes=_flag(values.get("EMAIL_ALERTS_MINUTE_PROBES", "false")),
            email_alerts_to=values.get("EMAIL_ALERTS_TO") or "aizyaguev@nvidia.com",
            email_alerts_from=values.get("EMAIL_ALERTS_FROM") or "",
            smtp_host=values.get("SMTP_HOST") or "",
            smtp_port=int(values.get("SMTP_PORT") or 587),
            smtp_security=values.get("SMTP_SECURITY") or "starttls",
            smtp_username=values.get("SMTP_USERNAME") or "",
            smtp_password=SecretStr(values.get("SMTP_PASSWORD") or ""),
            email_voltage_min=_optional_float(values, "EMAIL_VOLTAGE_MIN"),
            email_voltage_max=_optional_float(values, "EMAIL_VOLTAGE_MAX"),
            email_current_min=_optional_float(values, "EMAIL_CURRENT_MIN"),
            email_current_max=_optional_float(values, "EMAIL_CURRENT_MAX"),
            email_watts_min=_optional_float(values, "EMAIL_WATTS_MIN"),
            email_watts_max=_optional_float(values, "EMAIL_WATTS_MAX"),
            ping_monitor_enabled=True,
            ping_monitor_timezone="Asia/Jerusalem",
        )
    except (ValidationError, ValueError) as exc:
        raise RuntimeError("Mail settings are invalid") from exc


def _flag(value):
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def load_settings(root):
    return settings_from_values(read_env(root))


def config_hash(settings):
    material = "|".join([
        settings.smtp_host, str(settings.smtp_port), settings.smtp_security,
        settings.email_alerts_from, settings.email_alerts_to, settings.smtp_username,
    ])
    return hashlib.sha256(material.encode()).hexdigest()


def record_path(root):
    return root / ".monitor-backups" / RECORD_NAME


def public_summary(settings):
    from app.alerts import mail_problems, power_rules
    return {
        "recipient": settings.email_alerts_to,
        "sender": settings.email_alerts_from,
        "smtp_host": settings.smtp_host,
        "smtp_port": settings.smtp_port,
        "smtp_security": settings.smtp_security,
        "username_present": bool(settings.smtp_username),
        "password_present": bool(settings.smtp_password.get_secret_value()),
        "problems": mail_problems(settings),
        "enabled": settings.email_alerts_enabled,
        "minute_probes": settings.email_alerts_minute_probes,
        "power_rules": [{"metric": metric, "side": side, "value": value} for metric, side, value in power_rules(settings)],
    }


def print_summary(settings):
    summary = public_summary(settings)
    print(f"recipient: {summary['recipient']}")
    print(f"sender: {summary['sender']}")
    print(f"smtp: {summary['smtp_host']}:{summary['smtp_port']} {summary['smtp_security']}")
    print(f"username present: {'yes' if summary['username_present'] else 'no'}")
    print(f"password present: {'yes' if summary['password_present'] else 'no'}")
    print(f"enabled: {summary['enabled']}")
    print(f"minute probes: {summary['minute_probes']}")
    print("problems: " + (", ".join(summary["problems"]) if summary["problems"] else "none"))
    print("power rules: " + (json.dumps(summary["power_rules"]) if summary["power_rules"] else "none"))


def failure_hint(exc):
    name = type(exc).__name__
    if name in {"SMTPAuthenticationError", "SMTPNotSupportedError"}:
        return "auth rejected"
    if name == "SMTPSenderRefused":
        return "sender rejected"
    if name == "SMTPRecipientsRefused":
        return "recipient refused"
    if name in {"ConnectionRefusedError", "SMTPConnectError"}:
        return "connection refused"
    if name in {"TimeoutError", "SMTPTimeoutError"} or "timeout" in name.lower():
        return "timeout"
    if "SSL" in name or "certificate" in name.lower():
        return "TLS"
    return "delivery failed"


def message_id_for(row, settings):
    domain = settings.email_alerts_from.split("@")[-1] or "localhost"
    return f"<dcim-{row.id}@{domain}>"


def send_test_message(settings, recipient=None):
    from app.alerts import send_email
    row = SimpleNamespace(
        id=uuid4().hex,
        recipient=recipient or settings.email_alerts_to,
        subject="DCIM-204 mail relay test",
        body="Lab Manager relay test.\nAcceptance by the mail relay is not the same as inbox delivery.\n",
        created_at=time.time(),
    )
    captured = {}
    original = smtplib.SMTP.data

    def wrapped(self, message):
        reply = original(self, message)
        captured["reply"] = reply
        return reply

    smtplib.SMTP.data = wrapped
    try:
        send_email(row, settings)
    except Exception as exc:
        print(f"Test mail failed: {type(exc).__name__}: {failure_hint(exc)}")
        print("Acceptance by the mail relay is not the same as inbox delivery.")
        return None
    finally:
        smtplib.SMTP.data = original
    reply = captured.get("reply")
    if not reply:
        print("Test mail failed: SMTP reply was not captured")
        return None
    code, raw = reply if isinstance(reply, tuple) else (reply, b"")
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    # Relay-controlled text is not printed; only a recognizable queue id is.
    queued = re.search(r"\bqueued as\s+([A-Za-z0-9._-]{1,64})\b", text, re.IGNORECASE)
    print(f"Accepted by mail relay: {code}" + (f" (queued as {queued.group(1)})" if queued else ""))
    print("Acceptance by the mail relay is not the same as inbox delivery.")
    print(f"Search the mailbox for subject {row.subject!r} and Message-ID {message_id_for(row, settings)}")
    return {"code": code, "subject": row.subject, "message_id": message_id_for(row, settings)}


def save_success(root, settings, result):
    destination = root / ".monitor-backups"
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(destination, 0o700)
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "config_hash": config_hash(settings),
        "subject": result["subject"],
        "message_id": result["message_id"],
        "smtp_code": result["code"],
    }
    path = record_path(root)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.chmod(path, 0o600)
    return payload


def assess_overview(data, minute_expected):
    problems = []
    if data.get("timezone") != "Asia/Jerusalem":
        problems.append("timezone is not Asia/Jerusalem")
    if data.get("service") not in {"scheduled", "running"}:
        problems.append("ping monitor is not scheduled or running")
    alerts = data.get("email_alerts") or {}
    if not alerts.get("enabled"):
        problems.append("email alerts are not enabled")
    if alerts.get("problems"):
        problems.append("mail configuration has problems")
    if not alerts.get("ready"):
        problems.append("email alerts are not ready")
    if bool(alerts.get("minute_probes")) != bool(minute_expected):
        problems.append("minute probes do not match the requested setting")
    if alerts.get("worker") not in {"running", "healthy"}:
        problems.append("alert worker is not running")
    return problems


def recent_lines(data):
    alerts = data.get("email_alerts") or {}
    lines = [f"pending: {alerts.get('pending')}"]
    for row in (alerts.get("recent") or [])[:10]:
        lines.append(f"{row.get('sent_at') or 'pending'} attempts={row.get('attempts')} error={row.get('error') or '-'} {row.get('subject')}")
    return lines


async def _episode(observe, rows_for, label):
    checks = []
    for stamp in range(1000, 1301, 60):
        await observe(stamp, False)
    checks.append((f"{label} exactly 300s sends nothing", len(await rows_for()) == 0))
    await observe(1360, False)
    checks.append((f"{label} continued failure sends one", len(await rows_for()) == 1))
    await observe(1420, False)
    checks.append((f"{label} repeated failure stays one", len(await rows_for()) == 1))
    await observe(1480, True)
    rows = await rows_for()
    checks.append((f"{label} recovery sends one more", len(rows) == 2 and any("recovered" in row.subject for row in rows)))
    return checks


async def _simulate(path):
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app import alerts, ping_monitor
    from app.config import Settings
    from app.database import Base
    from app.models import AlertEmail, Device, PingTarget

    original = alerts.get_settings
    engine = create_async_engine(f"sqlite+aiosqlite:///{Path(path).as_posix()}")
    checks = []
    sent = []
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        settings = Settings(
            _env_file=None, email_alerts_enabled=True, email_alerts_minute_probes=True,
            smtp_host="mail.example.test", email_alerts_from="dcim@example.test",
            email_alerts_to="aizyaguev@nvidia.com", ping_monitor_enabled=True,
            ping_monitor_timezone="Asia/Jerusalem",
        )
        alerts.get_settings = lambda: settings

        async def queued(prefix):
            async with factory() as db:
                return (await db.execute(select(AlertEmail).where(AlertEmail.condition_key.startswith(prefix)))).scalars().all()

        async with factory() as db:
            db.add(PingTarget(id="sim-net", name="Simulation", source_key="server:sim", host="192.0.2.1", revision=0))
            db.add(Device(id="sim-pdu", name="Simulation PDU", kind="pdu", ip="192.0.2.10", rack="R1"))
            await db.commit()

        async def observe_net(stamp, recovered):
            async with factory() as db:
                target = await db.get(PingTarget, "sim-net")
                status = "up" if recovered else "down"
                await alerts.observe_network(db, target, ping_monitor.ProbeResult(status, detail="isolated simulation"), stamp, minute=True)
                await db.commit()

        async def observe_api(stamp, recovered):
            async with factory() as db:
                device = await db.get(Device, "sim-pdu")
                await alerts.observe_device_api(db, device, recovered, "Connection timeout: isolated simulation.", stamp)
                await db.commit()

        checks.extend(await _episode(observe_net, lambda: queued("network:"), "network"))
        checks.extend(await _episode(observe_api, lambda: queued("device-api:"), "device API"))
        await alerts.ensure_worker(factory)
        async with factory() as db:
            claimed = await alerts.claim_worker(db, "simulate", time.time())
        checks.append(("worker lease claimed", bool(claimed)))
        if claimed:
            def capture(row, _settings):
                sent.append(row.subject)
            await alerts.deliver("simulate", factory, sender=capture)
            checks.append(("queued mail handed to the sender", len(sent) == 4))
    finally:
        alerts.get_settings = original
        await engine.dispose()
    return checks


def run_simulation(database=None):
    project_dir(ROOT)
    path = Path(database) if database else Path(tempfile.mkdtemp(prefix="dcim-alerts-")) / "simulate.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + path.as_posix()
    checks = asyncio.run(_simulate(path))
    failed = False
    for name, ok in checks:
        print(("PASS " if ok else "FAIL ") + name)
        failed = failed or not ok
    return 1 if failed else 0


def cmd_check(root):
    print_summary(load_settings(project_dir(root)))
    return 0


def cmd_configure(root, host, port, security, sender, recipient=None, username=None, password=None):
    root = project_dir(root)
    values = read_env(root)
    values.update({
        "SMTP_HOST": host,
        "SMTP_PORT": str(port),
        "SMTP_SECURITY": security,
        "EMAIL_ALERTS_FROM": sender,
    })
    updates = {
        "SMTP_HOST": host,
        "SMTP_PORT": str(port),
        "SMTP_SECURITY": security,
        "EMAIL_ALERTS_FROM": sender,
    }
    if recipient is not None:
        values["EMAIL_ALERTS_TO"] = recipient
        updates["EMAIL_ALERTS_TO"] = recipient
    if username is not None:
        values["SMTP_USERNAME"] = username
        updates["SMTP_USERNAME"] = username
    if password is not None:
        values["SMTP_PASSWORD"] = password
        updates["SMTP_PASSWORD"] = password
    settings = settings_from_values(values)
    from app.alerts import mail_problems
    problems = mail_problems(settings)
    if problems:
        print("Refusing to write mail settings: " + "; ".join(problems))
        return 1
    write_env(root, updates)
    # The record does not cover the password, so any configure needs a new test.
    record_path(root).unlink(missing_ok=True)
    print("Mail settings written. Alerts remain disabled until test-mail and enable.")
    return 0


def cmd_test_mail(root, recipient=None):
    root = project_dir(root)
    settings = load_settings(root)
    from app.alerts import mail_problems
    problems = mail_problems(settings)
    if problems:
        print("Refusing to send: " + "; ".join(problems))
        return 1
    result = send_test_message(settings, recipient)
    if not result:
        return 1
    save_success(root, settings, result)
    return 0


def cmd_enable(root, minute_probes=True, restart=False):
    root = project_dir(root)
    settings = load_settings(root)
    from app.alerts import mail_problems
    problems = mail_problems(settings)
    if problems:
        print("Refusing to enable: " + "; ".join(problems))
        return 1
    path = record_path(root)
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        record = None
    if not record or record.get("config_hash") != config_hash(settings):
        print("Refusing to enable: no successful test mail matches the current mail configuration")
        return 1
    write_env(root, {
        "EMAIL_ALERTS_ENABLED": "true",
        "EMAIL_ALERTS_MINUTE_PROBES": "true" if minute_probes else "false",
    })
    print("Email alerts enabled in .env. Restart the backend so the worker starts.")
    if restart:
        import importlib.util
        spec = importlib.util.spec_from_file_location("lab_service", Path(__file__).resolve().parent / "lab-service.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.cmd_restart(root)
    return 0


def cmd_disable(root):
    write_env(project_dir(root), {"EMAIL_ALERTS_ENABLED": "false"})
    print("Email alerts disabled in .env. Restart the backend to stop the worker.")
    return 0


def cmd_verify(root):
    root = project_dir(root)
    import importlib.util
    spec = importlib.util.spec_from_file_location("monitoring_installer", Path(__file__).resolve().parent / "install-monitoring.py")
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)
    snippet = tool.AUTHENTICATED_HEALTH + r'''
def check(headers, accounts):
    request = urllib.request.Request("http://127.0.0.1:8000/api/monitoring", headers=headers)
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)
print(json.dumps(asyncio.run(authenticated_health(check))))
'''
    python = root / "backend" / ".venv" / "bin" / "python"
    import subprocess
    try:
        data = json.loads(subprocess.check_output([str(python), "-c", snippet], cwd=root / "backend", text=True, stderr=subprocess.DEVNULL, timeout=15))
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError):
        print("Could not read the local monitoring overview")
        return 1
    settings = load_settings(root)
    problems = assess_overview(data, settings.email_alerts_minute_probes)
    for line in recent_lines(data):
        print(line)
    if problems:
        print("Not healthy: " + "; ".join(problems))
        return 1
    print("Alert worker is healthy")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Configure and verify Lab Manager email alerts")
    parser.add_argument("--project", default=str(ROOT))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    configure = sub.add_parser("configure")
    configure.add_argument("--smtp-host", required=True)
    configure.add_argument("--smtp-port", required=True, type=int)
    configure.add_argument("--smtp-security", required=True, choices=("starttls", "ssl", "plain"))
    configure.add_argument("--from", dest="sender", required=True)
    configure.add_argument("--to", dest="recipient")
    configure.add_argument("--smtp-username")
    password = configure.add_mutually_exclusive_group()
    password.add_argument("--password-from-env", action="store_true")
    password.add_argument("--password-prompt", action="store_true")
    test = sub.add_parser("test-mail")
    test.add_argument("--to", dest="recipient")
    enable = sub.add_parser("enable")
    probes = enable.add_mutually_exclusive_group()
    probes.add_argument("--minute-probes", dest="minute_probes", action="store_true")
    probes.add_argument("--no-minute-probes", dest="minute_probes", action="store_false")
    enable.set_defaults(minute_probes=True)
    enable.add_argument("--restart", action="store_true")
    sub.add_parser("disable")
    sub.add_parser("verify")
    sub.add_parser("simulate")
    args = parser.parse_args(argv)
    if args.command == "check":
        return cmd_check(args.project)
    if args.command == "configure":
        secret = None
        if args.password_from_env:
            secret = os.environ.get("DCIM_SMTP_PASSWORD")
            if not secret:
                print("DCIM_SMTP_PASSWORD is not set")
                return 1
        elif args.password_prompt:
            import getpass
            secret = getpass.getpass("SMTP password: ")
        return cmd_configure(args.project, args.smtp_host, args.smtp_port, args.smtp_security, args.sender,
                             args.recipient, args.smtp_username, secret)
    if args.command == "test-mail":
        return cmd_test_mail(args.project, args.recipient)
    if args.command == "enable":
        return cmd_enable(args.project, args.minute_probes, args.restart)
    if args.command == "disable":
        return cmd_disable(args.project)
    if args.command == "verify":
        return cmd_verify(args.project)
    if args.command == "simulate":
        return run_simulation()
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
