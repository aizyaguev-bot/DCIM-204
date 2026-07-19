"""
Adds Rack-06 and Rack-07 as DCIM-only racks (no PDU polling).
  cd ~/DCIM-204/backend && python3 fix_racks_6_7.py
"""
import asyncio, sys, os, uuid
sys.path.insert(0, os.path.dirname(__file__))

from app.database import init_db, AsyncSessionLocal
from app.models import Device
from sqlalchemy import select

RACKS = ["Rack-06", "Rack-07"]

async def main():
    await init_db()
    async with AsyncSessionLocal() as db:
        for rack in RACKS:
            result = await db.execute(
                select(Device).where(Device.rack == rack, Device.kind == "rack")
            )
            if not result.scalar_one_or_none():
                db.add(Device(
                    id=str(uuid.uuid4()),
                    kind="rack",
                    name=rack,
                    model="Compute",
                    ip="0.0.0.0",
                    rack=rack,
                    port_count=0,
                    labels_json="{}",
                    username_enc="",
                    password_enc="",
                ))
                print(f"Added {rack} as DCIM-only")
            else:
                print(f"{rack} already exists, skipped")
        await db.commit()
    print("Done.")

asyncio.run(main())
