"""Shared pytest fixtures: a real temporary SQLite database and live services."""

from __future__ import annotations

import random

import pytest
import pytest_asyncio

from hera.config import EconomyConfig, MarketConfig, TradingConfig
from hera.database import Database
from hera.market.companies import COMPANIES
from hera.services.economy import EconomyService
from hera.services.market import MarketService
from hera.services.trading import TradingService

GUILD = 424242


@pytest_asyncio.fixture
async def db(tmp_path):
    database = Database(tmp_path / "test.db")
    await database.connect()
    yield database
    await database.close()


@pytest.fixture
def market_config():
    return MarketConfig(tick_seconds=300, session_ticks=24)


@pytest.fixture
def trading_config():
    return TradingConfig()


@pytest.fixture
def economy_config():
    return EconomyConfig()


@pytest_asyncio.fixture
async def economy(db):
    return EconomyService(db)


@pytest_asyncio.fixture
async def market(db, market_config):
    # Seeded RNG keeps price paths reproducible across runs.
    return MarketService(db, market_config, rng=random.Random(1234))


@pytest_asyncio.fixture
async def trading(db, economy, market, trading_config):
    return TradingService(db, economy, market, trading_config)


@pytest_asyncio.fixture
async def funded(economy):
    """An account with enough cash to trade comfortably."""

    async def _make(user_id: int, amount: int = 5_000_000) -> None:
        await economy.get_account(user_id, GUILD)
        await economy.credit(user_id, GUILD, amount, kind="test_funding", note="fixture")

    return _make


@pytest.fixture
def company_count() -> int:
    return len(COMPANIES)
