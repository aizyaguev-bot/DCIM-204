"""seed.py (install.bat runs it on every install) fills only an empty devices table (v2 spec D.5): once the lab has
devices it adds and changes nothing, so a deleted device never comes back and labels, names, addresses and racks edited
in Lab Manager are never overwritten."""
import importlib.util
import json
import pathlib

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models import Device

SEED = pathlib.Path(__file__).resolve().parents[1] / "seed.py"


@pytest.fixture
async def seed(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("seed_under_test", SEED)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'seed.db'}")
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def init_db():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(module, "init_db", init_db)
    monkeypatch.setattr(module, "AsyncSessionLocal", factory)
    module.factory = factory
    yield module
    await engine.dispose()


async def rows(factory):
    async with factory() as db:
        return {d.id: (d.name, d.ip, d.rack, d.labels_json) for d in (await db.execute(select(Device))).scalars()}


async def test_an_empty_database_gets_the_lab_devices(seed, capsys):
    assert await seed.main() is True
    assert set(await rows(seed.factory)) == {d["id"] for d in seed.DEVICES}
    assert "Done. All devices seeded." in capsys.readouterr().out


async def test_a_database_with_devices_is_left_exactly_as_it_is(seed, capsys):
    await seed.main()
    async with seed.factory() as db:
        dev = await db.get(Device, "pdu-rack01")
        dev.name, dev.ip, dev.labels_json = "PDU 01 renamed", "192.0.2.77", json.dumps({"13": "OPT999"})
        await db.delete(await db.get(Device, "pdu-rack02"))   # deleted in Lab Manager
        await db.commit()
    before = await rows(seed.factory)
    capsys.readouterr()
    assert await seed.main() is False
    assert await rows(seed.factory) == before
    assert "pdu-rack02" not in before
    assert capsys.readouterr().out.strip() == "Devices already exist: nothing seeded (seed.py only fills an empty database)"
