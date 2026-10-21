"""Read-only server connections from saved labels and existing status caches, with each server's rack and U slot
as the Locations page shows them."""
import csv
import io
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from .. import engineers, ping_monitor
from ..database import get_db
from ..models import Device, PingTarget
from . import kvms, pdus
from .devices import server_locations

router = APIRouter(prefix="/api/devices", tags=["connections"])


def natural_key(value):
    """Compare the full name, with numbered OPT names in numeric order."""
    return tuple(int(part) if index % 2 else part.casefold()
                 for index, part in enumerate(re.split(r"([0-9]+)", str(value))))


async def connection_summary(db: AsyncSession):
    # Only public device fields are loaded. Never request status or refresh a cache:
    # a stale cached observation is still useful for this inventory export.
    devices = (await db.scalars(select(Device).where(Device.kind.in_(("pdu", "kvm"))).options(
        load_only(Device.id, Device.name, Device.kind, Device.ip, Device.rack, Device.labels_json)
    ).order_by(Device.id))).all()
    targets = {target.source_key: target for target in (await db.scalars(select(PingTarget))).all()}
    owners = await engineers.owner_map(db)
    # Rack and U slot come from the Locations view itself (same files and rules), and every server it lists is
    # exported, including servers with no PDU outlet or KVM port (known from the rack layout or a ping monitor).
    located = {place["key"]: place for place in (await server_locations(db))["servers"]}
    servers = {}

    def server_row(key, name):
        target = targets.get("server:" + key)
        place = located.get(key) or {}
        return {
            "key": key,
            "name": place.get("name") or name,
            "rack": place.get("rack") or "",
            "slot": place.get("slot"),
            "server_ip": target.host if target else "",
            "owner": owners.get(key, ""),
            "ping_status": target.status if target else "unknown",
            "pdu": [],
            "kvm": [],
        }

    for device in devices:
        saved = device.labels
        labels = dict(saved) if isinstance(saved, dict) else {}
        cached = (pdus._cache if device.kind == "pdu" else kvms._cache).get(device.id)
        entries = (cached[1].outlets if device.kind == "pdu" else cached[1].ports) if cached else []
        states = {}
        for entry in entries:
            labels.setdefault(str(entry.number), entry.label)
            if device.kind == "pdu":
                states[str(entry.number)] = entry.state
        for port, label in sorted(labels.items(), key=lambda item: natural_key(item[0])):
            if not isinstance(label, str):
                continue
            identity = ping_monitor.server_identity(label)
            if identity is None:
                continue
            key, name, _ = identity
            if key not in servers:
                servers[key] = server_row(key, name)
            connection = {
                "device_id": device.id,
                "device_name": device.name,
                "device_ip": device.ip,
                "port": int(port) if str(port).isascii() and str(port).isdigit() else str(port),
                "label": label,
            }
            if device.kind == "pdu":
                connection.update(rack=device.rack, state=states.get(str(port), "unknown"))
            servers[key][device.kind].append(connection)
    for key, place in located.items():
        if key not in servers:
            servers[key] = server_row(key, place["name"])
    rows = sorted(servers.values(), key=lambda server: (natural_key(server["name"]), server["key"]))
    for server in rows:
        for kind in ("pdu", "kvm"):
            server[kind].sort(key=lambda item: (
                natural_key(item["device_name"]), natural_key(item["port"]), item["device_id"]
            ))
    return {"servers": rows, "generated_at": datetime.now(timezone.utc).isoformat()}


@router.get("/connections")
async def connections(response: Response, db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    return await connection_summary(db)


CSV_HEADERS = ("Server", "Rack", "U slot", "Server IP", "Owner", "Ping", "PDU outlets", "KVM ports")


def csv_cell(value):
    text = "" if value is None else str(value)
    return "'" + text if text.startswith(("=", "+", "-", "@", "\t", "\r")) else text


def connection_text(entries):
    return "; ".join(f"{entry['device_name']} ({entry['device_ip']}) #{entry['port']}" for entry in entries)


@router.get("/connections.csv")
async def connections_csv(db: AsyncSession = Depends(get_db)):
    summary = await connection_summary(db)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(CSV_HEADERS)
    for server in summary["servers"]:
        writer.writerow(csv_cell(value) for value in (
            server["name"], server["rack"], server["slot"], server["server_ip"], server["owner"],
            server["ping_status"], connection_text(server["pdu"]), connection_text(server["kvm"]),
        ))
    filename = f"lab-connections-{summary['generated_at'][:10]}.csv"
    return Response(output.getvalue().encode("utf-8-sig"), media_type="text/csv", headers={
        "Content-Disposition": f'attachment; filename={filename}',
        "Cache-Control": "no-store",
    })
