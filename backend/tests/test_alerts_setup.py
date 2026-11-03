"""Env editing, relay-reply capture and isolated alert simulation."""
import importlib.util
import json
import os
import smtplib
import stat
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("alerts_setup", Path(__file__).resolve().parents[2] / "scripts" / "alerts-setup.py")
alerts_setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alerts_setup)


def valid(**extra):
    values = {
        "SMTP_HOST": "mail.example.test",
        "SMTP_PORT": "587",
        "SMTP_SECURITY": "starttls",
        "EMAIL_ALERTS_FROM": "dcim@example.test",
        "EMAIL_ALERTS_TO": "aizyaguev@nvidia.com",
    }
    values.update(extra)
    return values


def test_env_edit_keeps_comments_export_form_and_mode(tmp_path):
    path = tmp_path / ".env"
    path.write_text("# keep me\nexport SMTP_HOST=old\nEMAIL_VOLTAGE_MAX=250\n", encoding="utf-8")
    os.chmod(path, 0o640)
    before = stat.S_IMODE(path.stat().st_mode)
    alerts_setup.write_env(tmp_path, {"SMTP_HOST": "mail.example.test", "SMTP_PORT": "25"})
    text = path.read_text(encoding="utf-8")
    assert "# keep me" in text
    assert "export SMTP_HOST=mail.example.test" in text
    assert "EMAIL_VOLTAGE_MAX=250" in text
    assert "SMTP_PORT=25" in text
    assert stat.S_IMODE(path.stat().st_mode) == before
    backups = list((tmp_path / ".monitor-backups").glob("*-env/.env"))
    assert backups and "export SMTP_HOST=old" in backups[0].read_text(encoding="utf-8")


@pytest.mark.parametrize("password", [
    "plain-Pass_1", "abc #def", "with space", "pa$word", "it's", 'say "hi"', "back\\slash", "a'b\"c\\d", "",
    "two\\\\back", "\\\\\\", "trail\\", "it's\\", "q\\'x", 'd\\"q', " #lead", "a\\nb",
])
def test_env_values_round_trip_through_backend_dotenv_parser(tmp_path, password):
    from dotenv import dotenv_values
    (tmp_path / ".env").write_text("export SMTP_PASSWORD=old\n", encoding="utf-8")
    alerts_setup.write_env(tmp_path, {"SMTP_PASSWORD": password, "SMTP_USERNAME": password})
    assert dotenv_values(tmp_path / ".env")["SMTP_PASSWORD"] == password
    assert dotenv_values(tmp_path / ".env")["SMTP_USERNAME"] == password
    assert alerts_setup.read_env(tmp_path)["SMTP_PASSWORD"] == password


@pytest.mark.parametrize("value", ["line\nbreak", "pa${HOME}x", "it's ${HOME}", "a #b\\", " lead\\", "'q\\"])
def test_unrepresentable_env_values_are_refused_without_writing(tmp_path, value):
    path = tmp_path / ".env"
    path.write_text("SMTP_PASSWORD=old\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match=r"\.env"):
        alerts_setup.write_env(tmp_path, {"SMTP_PASSWORD": value})
    assert path.read_text(encoding="utf-8") == "SMTP_PASSWORD=old\n"


def test_existing_multiline_binding_is_replaced_completely(tmp_path):
    from dotenv import dotenv_values
    path = tmp_path / ".env"
    path.write_text('# keep\nSMTP_PASSWORD="first\nsecond"\nOTHER=1\n', encoding="utf-8")
    alerts_setup.write_env(tmp_path, {"SMTP_PASSWORD": "new"})
    text = path.read_text(encoding="utf-8")
    assert text == "# keep\nSMTP_PASSWORD=new\nOTHER=1\n"
    assert dotenv_values(path) == {"SMTP_PASSWORD": "new", "OTHER": "1"}


def test_env_temp_file_is_private_and_removed(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("SMTP_HOST=old\n", encoding="utf-8")
    modes = []
    real_copymode = alerts_setup.shutil.copymode

    def checked_copymode(source, target):
        modes.append(stat.S_IMODE(os.stat(target).st_mode))  # written, not yet given the final mode
        return real_copymode(source, target)

    monkeypatch.setattr(alerts_setup.shutil, "copymode", checked_copymode)
    alerts_setup.write_env(tmp_path, {"SMTP_HOST": "mail.example.test"})
    assert len(modes) == 1
    if os.name == "posix":
        assert modes == [0o600]

    def failing_replace(source, target):
        raise OSError("disk full")

    monkeypatch.setattr(alerts_setup.os, "replace", failing_replace)
    with pytest.raises(OSError):
        alerts_setup.write_env(tmp_path, {"SMTP_HOST": "other.example.test"})
    assert not list(tmp_path.glob(".env-alerts-*"))
    assert "SMTP_HOST=mail.example.test" in (tmp_path / ".env").read_text(encoding="utf-8")


def test_configure_invalidates_previous_test_record(tmp_path):
    alerts_setup.write_env(tmp_path, valid(SMTP_USERNAME="relay-user", SMTP_PASSWORD="first"))
    settings = alerts_setup.load_settings(tmp_path)
    record = alerts_setup.record_path(tmp_path)
    record.parent.mkdir(exist_ok=True)
    record.write_text(json.dumps({"config_hash": alerts_setup.config_hash(settings)}), encoding="utf-8")
    assert alerts_setup.cmd_configure(
        tmp_path, "mail.example.test", 587, "starttls", "dcim@example.test",
        username="relay-user", password="second") == 0
    assert not record.exists()
    assert alerts_setup.cmd_enable(tmp_path) == 1


def test_symlink_env_is_refused(tmp_path):
    target = tmp_path / "real.env"
    target.write_text("SMTP_HOST=old\n", encoding="utf-8")
    link = tmp_path / ".env"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlinks are not available")
    with pytest.raises(RuntimeError, match="symlink"):
        alerts_setup.write_env(tmp_path, {"SMTP_HOST": "mail.example.test"})
    assert "SMTP_HOST=old" in target.read_text(encoding="utf-8")


def test_enable_refuses_without_matching_test_and_preserves_thresholds(tmp_path):
    env = tmp_path / ".env"
    env.write_text("EMAIL_VOLTAGE_MAX=250\nEMAIL_ALERTS_ENABLED=false\n", encoding="utf-8")
    alerts_setup.write_env(tmp_path, valid())
    assert alerts_setup.cmd_enable(tmp_path) == 1
    text = env.read_text(encoding="utf-8")
    assert "EMAIL_ALERTS_ENABLED=true" not in text
    assert "EMAIL_VOLTAGE_MAX=250" in text
    settings = alerts_setup.load_settings(tmp_path)
    record = {"config_hash": "0" * 64}
    destination = tmp_path / ".monitor-backups"
    destination.mkdir(exist_ok=True)
    (destination / alerts_setup.RECORD_NAME).write_text(json.dumps(record), encoding="utf-8")
    assert alerts_setup.cmd_enable(tmp_path) == 1
    (destination / alerts_setup.RECORD_NAME).write_text(json.dumps({"config_hash": alerts_setup.config_hash(settings)}), encoding="utf-8")
    assert alerts_setup.cmd_enable(tmp_path, minute_probes=True) == 0
    text = env.read_text(encoding="utf-8")
    assert "EMAIL_ALERTS_ENABLED=true" in text
    assert "EMAIL_ALERTS_MINUTE_PROBES=true" in text
    assert "EMAIL_VOLTAGE_MAX=250" in text


def test_test_mail_prints_relay_reply_without_password(tmp_path, monkeypatch, capsys):
    secret = "smtp-secret-value"
    alerts_setup.write_env(tmp_path, valid(SMTP_USERNAME="relay-user", SMTP_PASSWORD=secret))

    class FakeSMTP:
        def __init__(self, host, port, timeout=15, context=None):
            self.host = host

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def starttls(self, context=None):
            return None

        def login(self, username, password):
            assert password == secret

        def data(self, message):
            return (250, b"2.0.0 Ok queued as ABC123 credential=synthetic-relay-secret")

        def send_message(self, message, from_addr=None, to_addrs=None):
            self.data(message.as_bytes())

    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    assert alerts_setup.cmd_test_mail(tmp_path) == 0
    output = capsys.readouterr().out
    assert "Accepted by mail relay: 250" in output
    assert "ABC123" in output
    assert "not the same as inbox delivery" in output
    assert secret not in output
    assert "synthetic-relay-secret" not in output
    record = json.loads((tmp_path / ".monitor-backups" / alerts_setup.RECORD_NAME).read_text(encoding="utf-8"))
    assert record["config_hash"] == alerts_setup.config_hash(alerts_setup.load_settings(tmp_path))
    assert secret not in json.dumps(record)


def test_check_does_not_print_password(tmp_path, capsys):
    secret = "smtp-secret-value"
    alerts_setup.write_env(tmp_path, valid(SMTP_PASSWORD=secret, EMAIL_WATTS_MAX="2500"))
    assert alerts_setup.cmd_check(tmp_path) == 0
    output = capsys.readouterr().out
    assert secret not in output
    assert "password present: yes" in output
    assert "2500" in output


def test_verify_assessment_requires_a_healthy_worker():
    healthy = {
        "service": "running", "timezone": "Asia/Jerusalem",
        "email_alerts": {"enabled": True, "ready": True, "problems": [], "minute_probes": True, "worker": "healthy", "pending": 0, "recent": []},
    }
    assert alerts_setup.assess_overview(healthy, True) == []
    assert alerts_setup.assess_overview({**healthy, "service": "disabled"}, True)


def test_simulation_passes(tmp_path):
    assert alerts_setup.run_simulation(tmp_path / "simulate.db") == 0
