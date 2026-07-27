"""
Shared fixtures for unit tests.

Run from the backend/ directory:
    cd /opt/lab-manager/backend
    pip install -r requirements-test.txt
    python -m pytest tests/ -v
"""
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.routers.kvms as kvms_module
import app.routers.pdus as pdus_module
from app.database import Base, get_db
from app.routers import devices, kvms, pdus

TEST_DB_URL = "sqlite+aiosqlite:///:memory:"


@asynccontextmanager
async def _noop_lifespan(app):
    """Skip DB init and cache warmup — unit tests supply their own DB."""
    yield


# Minimal app: routers only, no startup side-effects
unit_app = FastAPI(lifespan=_noop_lifespan)
unit_app.include_router(devices.router)
unit_app.include_router(kvms.router)
unit_app.include_router(pdus.router)


@pytest.fixture
async def db_session():
    engine = create_async_engine(TEST_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    async with Session() as session:
        yield session
    await engine.dispose()


@pytest.fixture
async def client(db_session):
    async def _override():
        yield db_session

    unit_app.dependency_overrides[get_db] = _override
    async with AsyncClient(transport=ASGITransport(app=unit_app), base_url="http://test") as c:
        yield c
    unit_app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def clear_module_caches():
    """Reset all in-memory caches before and after each test."""
    kvms_module._cache.clear()
    kvms_module._in_use.clear()
    kvms_module._refreshing.clear()
    pdus_module._cache.clear()
    pdus_module._refreshing.clear()
    yield
    kvms_module._cache.clear()
    kvms_module._in_use.clear()
    kvms_module._refreshing.clear()
    pdus_module._cache.clear()
    pdus_module._refreshing.clear()
