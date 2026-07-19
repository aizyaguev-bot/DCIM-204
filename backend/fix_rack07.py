"""
Run once on VDI to remove duplicate Rack-07 entries.
  cd ~/DCIM-204/backend && python3 fix_rack07.py
"""
import asyncio, sys, os
sys.path.insert(0, os.path.dirname(__file__))

from app.database import init_db, AsyncSessionLocal
from app.models import Device
from sqlalchemy import select

async def main():
    await init_db()
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Device).where(Device.rack == "Rack-07"))
        all_rack7 = result.scalars().all()

        print(f"Found {len(all_rack7)} device(s) with rack=Rack-07:")
        for d in all_rack7:
            print(f"  {d.id}  kind={d.kind}  name={d.name}  ip={d.ip}")

        # Keep one kind="rack" entry, delete all others
        kept = False
        for d in all_rack7:
            if d.kind == "rack" and not kept:
                kept = True
                print(f"Keeping: {d.id} ({d.name})")
            else:
                await db.delete(d)
                print(f"Deleted: {d.id} ({d.name}, kind={d.kind})")

        await db.commit()
        print("Done.")

asyncio.run(main())
