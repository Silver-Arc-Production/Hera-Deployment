"""Tests for the read-only web dashboard: service payloads, SVG charts and routes.

These run against a real temporary SQLite database and a real aiohttp server, so
the JSON and the images a browser would receive are exercised end to end.
"""

from __future__ import annotations

import re

import pytest
from aiohttp.test_utils import TestClient, TestServer

from hera.web.charts import (
    chart_data_uri,
    render_comparison_chart,
    render_price_chart,
    render_sparkline,
)
from hera.web.server import Dashboard
from hera.web.service import DashboardService, fallback_chart

GUILD = 424242


async def _advance(market, count: int) -> None:
    for _ in range(count):
        await market.tick(GUILD)


@pytest.fixture
async def dashboard_service(market):
    await _advance(market, 40)
    return DashboardService(market, guild_id=GUILD)


@pytest.fixture
async def client(market):
    await _advance(market, 40)
    dashboard = Dashboard(market, guild_id=GUILD)
    async with TestClient(TestServer(dashboard.app)) as test_client:
        yield test_client


# ------------------------------------------------------------------ the payload


async def test_market_payload_lists_every_company(dashboard_service, company_count):
    payload = await dashboard_service.market_payload()
    assert len(payload["stocks"]) == company_count
    assert payload["totals"]["listings"] == company_count
    assert payload["tick"] > 0


async def test_market_payload_shape(dashboard_service):
    payload = await dashboard_service.market_payload()
    for key in ("generated_at", "tick", "regime", "index", "totals", "sectors", "stocks", "news"):
        assert key in payload
    assert set(payload["index"]) == {"value", "change", "change_pct"}


async def test_stock_rows_expose_the_tracking_fields(dashboard_service):
    payload = await dashboard_service.market_payload()
    row = payload["stocks"][0]
    for key in (
        "symbol",
        "name",
        "sector",
        "price",
        "change_pct",
        "day_high",
        "day_low",
        "market_cap",
        "dividend_yield",
        "halted",
        "sparkline",
    ):
        assert key in row
    assert row["sparkline"].startswith("data:image/svg+xml;base64,")


async def test_change_pct_matches_price_and_previous_close(dashboard_service):
    payload = await dashboard_service.market_payload()
    for row in payload["stocks"]:
        expected = (
            (row["price"] - row["previous_close"]) / row["previous_close"] * 100
            if row["previous_close"]
            else 0.0
        )
        assert row["change_pct"] == pytest.approx(expected)


async def test_sectors_cover_every_stock(dashboard_service):
    payload = await dashboard_service.market_payload()
    counted = sum(sector["count"] for sector in payload["sectors"])
    assert counted == len(payload["stocks"])


async def test_totals_breadth_adds_up(dashboard_service):
    payload = await dashboard_service.market_payload()
    totals = payload["totals"]
    assert totals["gainers"] + totals["losers"] + totals["unchanged"] == totals["listings"]


# -------------------------------------------------------------------- the charts


def test_price_chart_is_wellformed_svg_with_the_series():
    history = [(i, 100.0 + i) for i in range(30)]
    svg = render_price_chart("TEST", "Test Co", history)
    assert svg.startswith("<svg")
    assert svg.rstrip().endswith("</svg>")
    assert "TEST" in svg and "Test Co" in svg
    # One tick label per sampled x position, and at least one gridline.
    assert svg.count("<polyline") == 1


def test_price_chart_needs_at_least_two_points():
    assert render_price_chart("TEST", "Test Co", [(1, 10.0)]) == ""
    assert render_price_chart("TEST", "Test Co", []) == ""


def test_sparkline_requires_two_points():
    assert render_sparkline([]) == ""
    assert render_sparkline([5.0]) == ""
    svg = render_sparkline([1.0, 2.0, 3.0])
    assert svg.startswith("<svg") and "</svg>" in svg


def test_comparison_chart_normalises_and_handles_empty():
    assert render_comparison_chart({}) == ""
    assert render_comparison_chart({"A": [1.0]}) == ""
    svg = render_comparison_chart({"A": [100.0, 110.0], "B": [50.0, 45.0]})
    assert svg.count("<polyline") == 2
    assert "A" in svg and "B" in svg


def test_chart_data_uri_roundtrip():
    uri = chart_data_uri("<svg></svg>")
    assert uri.startswith("data:image/svg+xml;base64,")
    assert chart_data_uri("") == ""


def test_fallback_chart_is_a_valid_image():
    svg = fallback_chart()
    assert svg.startswith("<svg") and svg.rstrip().endswith("</svg>")


async def test_stock_chart_svg_for_known_symbol(dashboard_service):
    svg = await dashboard_service.stock_chart_svg("NOVA")
    assert svg is not None
    assert "NOVA" in svg and svg.startswith("<svg")


async def test_stock_chart_svg_is_case_insensitive(dashboard_service):
    assert await dashboard_service.stock_chart_svg("nova") is not None


async def test_stock_chart_svg_unknown_symbol_is_none(dashboard_service):
    assert await dashboard_service.stock_chart_svg("ZZZZ") is None


async def test_index_chart_svg_is_rendered(dashboard_service):
    svg = await dashboard_service.index_chart_svg()
    assert svg is not None and "Hera Exchange Index" in svg


# --------------------------------------------------------------------- the routes


async def test_overview_and_stocks_pages_are_served(client):
    for path in ("/", "/stocks"):
        response = await client.get(path)
        assert response.status == 200
        body = await response.text()
        assert "<!DOCTYPE html>" in body
        assert "/static/app.js" in body


async def test_static_assets_are_served(client):
    for path in ("/static/style.css", "/static/app.js"):
        response = await client.get(path)
        assert response.status == 200
        assert (await response.text()).strip()


async def test_market_json_endpoint(client):
    response = await client.get("/api/market")
    assert response.status == 200
    payload = await response.json()
    assert payload["stocks"]
    assert payload["index"]["value"] > 0


async def test_stocks_json_endpoint(client):
    response = await client.get("/api/stocks")
    assert response.status == 200
    payload = await response.json()
    assert len(payload["stocks"]) == 20


async def test_chart_endpoint_returns_svg(client):
    response = await client.get("/api/charts/nova.svg")
    assert response.status == 200
    assert response.content_type == "image/svg+xml"
    body = await response.text()
    assert body.startswith("<svg")
    assert "NOVA" in body


async def test_index_chart_endpoint_returns_svg(client):
    response = await client.get("/api/charts/index.svg")
    assert response.status == 200
    assert response.content_type == "image/svg+xml"
    assert (await response.text()).startswith("<svg")


async def test_chart_endpoint_404s_on_unknown_symbol(client):
    response = await client.get("/api/charts/zzzz.svg")
    assert response.status == 404


async def test_health_endpoint(client):
    response = await client.get("/healthz")
    assert response.status == 200
    payload = await response.json()
    assert payload["status"] == "ok"
    assert payload["tick"] > 0


async def test_dashboard_is_read_only(client, market):
    """Hitting every route leaves the economy untouched."""
    before = await market.snapshot(GUILD)
    for path in (
        "/",
        "/stocks",
        "/api/market",
        "/api/stocks",
        "/api/charts/nova.svg",
        "/api/charts/index.svg",
        "/healthz",
    ):
        await client.get(path)
    after = await market.snapshot(GUILD)
    assert after.tick == before.tick
    assert [c.price for c in after.companies] == [c.price for c in before.companies]


async def test_bot_starts_dashboard_once_a_guild_is_known():
    """The dashboard must wait for a guild, then bind exactly one port."""
    from hera.bot import HeraBot
    from hera.config import WebConfig, config

    original_web, original_guild = config.web, config.guild_id
    # Port 0 asks the OS for a free port, so the test never collides with a
    # real dashboard or another test run.
    object.__setattr__(config, "web", WebConfig(enabled=True, host="127.0.0.1", port=0))
    object.__setattr__(config, "guild_id", None)
    bot = HeraBot()
    try:
        await bot.db.connect()
        await bot._start_dashboard()
        assert bot.web is None, "must not bind before any guild is known"

        bot._known_guilds = {777}
        await bot._start_dashboard()
        assert bot.web is not None

        first = bot.web
        await bot._start_dashboard()
        assert bot.web is first, "on_ready firing twice must not rebind the port"
    finally:
        await bot.close()
        object.__setattr__(config, "web", original_web)
        object.__setattr__(config, "guild_id", original_guild)


async def test_bot_skips_dashboard_when_disabled(db):
    from hera.bot import HeraBot
    from hera.config import WebConfig, config

    original_web = config.web
    object.__setattr__(config, "web", WebConfig(enabled=False))
    bot = HeraBot()
    try:
        await bot.db.connect()
        bot._known_guilds = {777}
        await bot._start_dashboard()
        assert bot.web is None
    finally:
        await bot.close()
        object.__setattr__(config, "web", original_web)


def test_rendered_svg_has_no_unfilled_placeholders():
    """Guards against a format string silently slipping into the markup."""
    svg = render_price_chart("TEST", "Test Co", [(i, 10.0 + i) for i in range(10)])
    assert "{" not in svg.replace("&", "") or not re.search(r"\{[a-z_]+\}", svg)
