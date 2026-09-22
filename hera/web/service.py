"""Read-only views of the Hera exchange for the web dashboard.

This layer only reads. It never writes to the database, so the dashboard cannot
disturb a live market: it snapshots the same :class:`MarketService` the Discord
commands use and serialises it into plain dictionaries.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..services.market import MarketService
from ..ui.charts import DARK_BG, GRID, TEXT
from .charts import chart_data_uri, render_price_chart, render_sparkline

# How many ticks of history the tables and charts go back by default.
DEFAULT_HISTORY = 120


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class DashboardService:
    """Assembles JSON payloads from the market service.

    ``guild_id`` selects which server's market to show, because every guild runs
    an independent simulation.
    """

    def __init__(
        self,
        market: MarketService,
        *,
        guild_id: int,
        history_limit: int = DEFAULT_HISTORY,
    ) -> None:
        self.market = market
        self.guild_id = guild_id
        self.history_limit = history_limit

    async def market_payload(self) -> dict[str, Any]:
        snapshot = await self.market.snapshot(self.guild_id)
        companies = snapshot.companies

        rows: list[dict[str, Any]] = []
        for company in companies:
            history = await self.market.history(company.symbol, self.history_limit)
            prices = [value for _, value in history]
            rows.append(
                {
                    "symbol": company.symbol,
                    "name": company.name,
                    "sector": company.sector,
                    "description": company.description,
                    "price": company.price,
                    "previous_close": company.previous_close,
                    "open": company.open_price,
                    "day_high": company.day_high,
                    "day_low": company.day_low,
                    "change": company.price - company.previous_close,
                    "change_pct": company.day_change_fraction * 100,
                    "market_cap": company.market_cap,
                    "dividend_yield": company.dividend_yield,
                    "volatility": company.volatility,
                    "beta": company.beta,
                    "halted": company.is_halted,
                    "sector_beta": self.market_beta(company.sector),
                    "history_tick_start": history[0][0] if history else None,
                    "sparkline": chart_data_uri(render_sparkline(prices)),
                }
            )

        sectors = self._sectors(companies)
        gainers = sum(1 for row in rows if row["change_pct"] > 0)
        losers = sum(1 for row in rows if row["change_pct"] < 0)
        news = await self.market.news(self.guild_id, 8)

        return {
            "generated_at": _iso_now(),
            "tick": snapshot.tick,
            "regime": snapshot.regime,
            "index": {
                "value": snapshot.index_value,
                "change": snapshot.index_change,
                "change_pct": snapshot.index_change * 100,
            },
            "totals": {
                "listings": len(rows),
                "market_cap": sum(row["market_cap"] for row in rows),
                "gainers": gainers,
                "losers": losers,
                "unchanged": len(rows) - gainers - losers,
                "halted": sum(1 for row in rows if row["halted"]),
            },
            "sectors": sectors,
            "stocks": rows,
            "news": [
                {
                    "symbol": item.symbol,
                    "headline": item.headline,
                    "impact": item.impact,
                }
                for item in news
            ],
        }

    @staticmethod
    def market_beta(sector: str) -> float:
        from ..market.companies import SECTOR_BETA

        return SECTOR_BETA.get(sector, 1.0)

    @staticmethod
    def _sectors(companies) -> list[dict[str, Any]]:
        buckets: dict[str, list[float]] = {}
        for company in companies:
            buckets.setdefault(company.sector, []).append(company.day_change_fraction)
        return [
            {
                "sector": sector,
                "change_pct": sum(changes) / len(changes) * 100,
                "count": len(changes),
            }
            for sector, changes in sorted(buckets.items())
        ]

    async def stock_chart_svg(self, symbol: str, *, points: int = 160) -> str | None:
        """A full price chart for one listing, rendered as standalone SVG."""
        company = await self.market.get_company(self.guild_id, symbol)
        if company is None:
            return None
        history = await self.market.history(company.symbol, points)
        svg = render_price_chart(company.symbol, company.name, history)
        return svg or None

    async def index_chart_svg(self, *, points: int = 160) -> str | None:
        history = await self.market.index_history(self.guild_id, points)
        svg = render_price_chart("HERA", "Hera Exchange Index", history)
        return svg or None


def fallback_chart(message: str = "Not enough history yet") -> str:
    """A tiny placeholder so an empty chart is still a valid image."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 320" '
        'width="100%" height="320">'
        f'<rect width="900" height="320" fill="{DARK_BG}" rx="10"/>'
        f'<text x="450" y="160" fill="{TEXT}" font-size="16" text-anchor="middle">'
        f"{message}</text>"
        f'<line x1="72" y1="240" x2="878" y2="240" stroke="{GRID}" stroke-width="1"/>'
        "</svg>"
    )


__all__ = ["DashboardService", "DEFAULT_HISTORY", "fallback_chart"]
