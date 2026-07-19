"""
Run once on VDI to set up Rack-06 and Rack-07 sharing one PDU.
  cd ~/DCIM-204/backend && python3 fix_racks_6_7.py
"""
import asyncio, sys, os, uuid
sys.path.insert(0, os.path.dirname(__file__))

from app.database import init_db, AsyncSessionLocal
from app.models import Device
from app.crypto import encrypt
from app.config import get_settings
from sqlalchemy import select

async def main():
    settings = get_settings()
    await init_db()
    async with AsyncSessionLocal() as db:

        # 1. Ensure Rack-06 kind="rack" exists (DCIM placeholder)
        r = await db.execute(select(Device).where(Device.rack=="Rack-06", Device.kind=="rack"))
        if not r.scalar_one_or_none():
            db.add(Device(id=str(uuid.uuid4()), kind="rack", name="Rack-06",
                model="Compute", ip="0.0.0.0", rack="Rack-06",
                port_count=0, labels_json="{}", username_enc="", password_enc=""))
            print("Added Rack-06 DCIM placeholder")
        else:
            print("Rack-06 placeholder already exists")

        # 2. Ensure Rack-07 kind="rack" exists (DCIM placeholder)
        r = await db.execute(select(Device).where(Device.rack=="Rack-07", Device.kind=="rack"))
        if not r.scalar_one_or_none():
            db.add(Device(id=str(uuid.uuid4()), kind="rack", name="Rack-07",
                model="Compute", ip="0.0.0.0", rack="Rack-07",
                port_count=0, labels_json="{}", username_enc="", password_enc=""))
            print("Added Rack-07 DCIM placeholder")
        else:
            print("Rack-07 placeholder already exists")

        # 3. Re-add the shared PDU under Rack-06, with notes marking Rack-07 as shared
        r = await db.execute(select(Device).where(Device.id=="pdu-rack06"))
        pdu = r.scalar_one_or_none()
        if pdu:
            pdu.notes = "shared:Rack-07"
            print(f"Updated pdu-rack06 notes → shared:Rack-07")
        else:
            db.add(Device(
                id="pdu-rack06",
                kind="pdu",
                name="PDU-Rack-06/07",
                model="Raritan PDU",
                ip="10.7.30.201",
                rack="Rack-06",
                notes="shared:Rack-07",
                port_count=0,
                labels_json="{}",
                username_enc=encrypt(settings.pdu_username),
                password_enc=encrypt(settings.pdu_password),
            ))
            print("Re-added pdu-rack06 (PDU-Rack-06/07) with shared:Rack-07")

        await db.commit()
    print("Done. Rack-06 and Rack-07 now share pdu-rack06.")

asyncio.run(main())
