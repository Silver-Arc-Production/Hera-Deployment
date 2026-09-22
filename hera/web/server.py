"""The Hera web dashboard: a small read-only site beside the Discord bot.

The bot is a gateway client and binds no port, so this runs an embedded
``aiohttp`` server on the bot's own event loop, sharing its database and market
service. It is strictly read-only: it exposes JSON endpoints and two HTML pages,
and never mutates the economy.

Set ``WEB_ENABLED=true`` to serve it. ``WEB_BIND_HOST`` defaults to ``0.0.0.0``
because a container platform publishes the port from outside, and
``WEB_PORT`` defaults to ``8080``.
"""

from __future__ import annotations

import logging
from pathlib import Path

from aiohttp import web

from .service import DashboardService, fallback_chart

log = logging.getLogger("hera.web")

STATIC_DIR = Path(__file__).resolve().parent / "static"


class Dashboard:
    """Binds the dashboard routes to one guild's market."""

    def __init__(self, market, *, guild_id: int) -> None:
        self.service = DashboardService(market, guild_id=guild_id)
        self.app = web.Application()
        self._runner: web.AppRunner | None = None
        self._routes()

    def _routes(self) -> None:
        self.app.add_routes(
            [
                web.get("/", self.handle_index),
                web.get("/stocks", self.handle_stocks),
                web.get("/api/market", self.handle_api_market),
                web.get("/api/stocks", self.handle_api_stocks),
                web.get("/api/charts/{symbol}.svg", self.handle_api_chart),
                web.get("/api/charts/index.svg", self.handle_api_index_chart),
                web.get("/healthz", self.handle_health),
                web.static("/static", STATIC_DIR),
            ]
        )

    # -------------------------------------------------------------------- pages

    async def handle_index(self, request: web.Request) -> web.StreamResponse:
        return web.FileResponse(STATIC_DIR / "index.html")

    async def handle_stocks(self, request: web.Request) -> web.StreamResponse:
        return web.FileResponse(STATIC_DIR / "stocks.html")

    # --------------------------------------------------------------------- API

    async def handle_api_market(self, request: web.Request) -> web.Response:
        payload = await self.service.market_payload()
        return web.json_response(payload)

    async def handle_api_stocks(self, request: web.Request) -> web.Response:
        payload = await self.service.market_payload()
        return web.json_response(
            {
                "generated_at": payload["generated_at"],
                "tick": payload["tick"],
                "regime": payload["regime"],
                "index": payload["index"],
                "stocks": payload["stocks"],
            }
        )

    async def handle_api_chart(self, request: web.Request) -> web.Response:
        symbol = request.match_info["symbol"].upper()
        svg = await self.service.stock_chart_svg(symbol)
        if svg is None:
            return web.json_response({"error": f"no listing matches {symbol}"}, status=404)
        return web.Response(text=svg, content_type="image/svg+xml")

    async def handle_api_index_chart(self, request: web.Request) -> web.Response:
        svg = await self.service.index_chart_svg()
        return web.Response(
            text=svg or fallback_chart(), content_type="image/svg+xml"
        )

    async def handle_health(self, request: web.Request) -> web.Response:
        snapshot = await self.service.market.snapshot(self.service.guild_id)
        return web.json_response({"status": "ok", "tick": snapshot.tick})

    # ----------------------------------------------------------------- runtime

    async def start(self, *, host: str, port: int) -> None:
        """Bind the port on the running loop, alongside the Discord connection."""
        self._runner = web.AppRunner(self.app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, host, port)
        await site.start()
        log.info("dashboard listening on http://%s:%s", host, port)

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
