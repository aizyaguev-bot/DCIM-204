"""
Run once on VDI to stop Rack-07 from double-polling Rack-06's PDU.
  cd ~/DCIM-204/backend && python3 fix_rack07.py
"""
import asyncio, sys, os, uuid
sys.path.insert(0, os.path.dirname(__file__))

from app.database import init_db, AsyncSessionLocal
from app.models import Device
from sqlalchemy import select

async def main():
    await init_db()
    async with AsyncSessionLocal() as db:
        # Remove the PDU entry for Rack-07 (was polling the wrong / shared IP)
        dev = await db.get(Device, "pdu-rack07")
        if dev:
            await db.delete(dev)
            print("Deleted pdu-rack07")
        else:
            print("pdu-rack07 not found (already removed?)")

        # Add Rack-07 as a DCIM-only rack (kind=rack, never polled, never on Dashboard)
        result = await db.execute(
            select(Device).where(Device.rack == "Rack-07", Device.kind == "rack")
        )
        if not result.scalar_one_or_none():
            db.add(Device(
                id=str(uuid.uuid4()),
                kind="rack",
                name="Rack-07",
                model="Compute",
                ip="0.0.0.0",
                rack="Rack-07",
                port_count=0,
                labels_json="{}",
                username_enc="",
                password_enc="",
            ))
            print("Added Rack-07 as DCIM-only (no polling)")
        else:
            print("Rack-07 DCIM-only entry already exists")

        await db.commit()
    print("Done.")

asyncio.run(main())
