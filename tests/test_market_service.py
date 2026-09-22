"""Tests for persistence, tick advancement and the query helpers."""

from __future__ import annotations

import pytest

from tests.conftest import GUILD


async def test_companies_are_seeded_on_first_use(market):
    engine = await market.get_engine(GUILD)
    assert len(engine.companies) == 20

    rows = await market.db.fetchall("SELECT symbol FROM companies")
    assert len(rows) == 20


async def test_seeding_is_idempotent(market, market_config):
    await market.get_engine(GUILD)
    # Simulate a fresh process against the same database.
    from hera.services.market import MarketService

    await market.db.execute("DELETE FROM companies")
    fresh = MarketService(market.db, market_config)
    await fresh.get_engine(GUILD)
    count = await market.db.fetchval("SELECT COUNT(*) FROM companies")
    assert count == 20


async def test_tick_persists_prices_and_history(market):
    result = await market.tick(GUILD)
    assert result.tick == 1

    rows = await market.db.fetchall("SELECT symbol, price FROM price_history WHERE tick = 1")
    assert len(rows) == 20

    state = await market.db.fetchone("SELECT tick, index_value FROM market_state WHERE guild_id = ?", (GUILD,))
    assert int(state["tick"]) == 1
    assert float(state["index_value"]) > 0


async def test_state_survives_a_restart(market, market_config):
    for _ in range(5):
        await market.tick(GUILD)
    company = await market.get_company(GUILD, "NOVA")
    price = company.price
    tick = (await market.snapshot(GUILD)).tick

    # Simulate a process restart with a brand new service over the same file.
    from hera.services.market import MarketService

    fresh = MarketService(market.db, market_config)
    await fresh.get_engine(GUILD)
    reloaded = await fresh.get_company(GUILD, "NOVA")
    assert reloaded.price == pytest.approx(price)
    assert (await fresh.snapshot(GUILD)).tick == tick


async def test_history_is_bounded_by_the_configured_limit(market):
    for _ in range(30):
        await market.tick(GUILD)
    rows = await market.db.fetchall(
        "SELECT COUNT(*) AS n FROM price_history WHERE symbol = 'NOVA'"
    )
    assert int(rows[0]["n"]) <= market.config.history_limit


async def test_history_returns_oldest_first(market):
    for _ in range(10):
        await market.tick(GUILD)
    history = await market.history("NOVA", limit=10)
    ticks = [tick for tick, _ in history]
    assert ticks == sorted(ticks)
    assert len(history) == 10


async def test_resolve_symbol_accepts_ticker_name_and_prefix(market):
    assert (await market.resolve_symbol(GUILD, "nova")).symbol == "NOVA"
    assert (await market.resolve_symbol(GUILD, "Novadyne Systems")).symbol == "NOVA"
    assert (await market.resolve_symbol(GUILD, "novadyne")).symbol == "NOVA"
    assert await market.resolve_symbol(GUILD, "zzzz") is None
    assert await market.resolve_symbol(GUILD, "") is None


async def test_news_is_recorded_and_readable(market):
    for _ in range(40):
        await market.tick(GUILD)
    items = await market.news(GUILD, limit=5)
    assert len(items) <= 5
    assert all(item.headline for item in items)


async def test_index_history_reconstructs_a_series(market):
    for _ in range(15):
        await market.tick(GUILD)
    series = await market.index_history(GUILD, limit=15)
    assert series
    ticks = [tick for tick, _ in series]
    assert ticks == sorted(ticks)
    assert all(value > 0 for _, value in series)


async def test_guilds_have_independent_markets(market):
    other = GUILD + 1
    for _ in range(3):
        await market.tick(GUILD)
    await market.tick(other)

    assert (await market.snapshot(GUILD)).tick == 3
    assert (await market.snapshot(other)).tick == 1


async def test_dividends_are_reported_by_the_tick(market):
    market.config = type(market.config)(dividend_tick_interval=3)
    seen = {}
    for _ in range(120):
        result = await market.tick(GUILD)
        seen.update(result.dividends)
    assert seen, "at least one company should have paid a dividend"
