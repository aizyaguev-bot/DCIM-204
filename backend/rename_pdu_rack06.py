"""
Run once on VDI to rename PDU-Rack-06 to PDU-Rack-06/07 on Dashboard.
  cd ~/DCIM-204/backend && python3 rename_pdu_rack06.py
"""
import asyncio, sys, os
sys.path.insert(0, os.path.dirname(__file__))

from app.database import init_db, AsyncSessionLocal
from app.models import Device

async def main():
    await init_db()
    async with AsyncSessionLocal() as db:
        dev = await db.get(Device, "pdu-rack06")
        if dev:
            old = dev.name
            dev.name = "PDU-Rack-06/07"
            await db.commit()
            print(f"Renamed '{old}' → '{dev.name}'")
        else:
            print("pdu-rack06 not found")

asyncio.run(main())
