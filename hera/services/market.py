"""Persists the market engine's state and drives ticks for a guild."""

from __future__ import annotations

import random
from dataclasses import dataclass

from ..config import MarketConfig
from ..database import Database
from ..market.companies import COMPANIES
from ..market.engine import CompanyState, MarketEngine, NewsItem, TickResult


@dataclass
class MarketSnapshot:
    tick: int
    regime: str
    index_value: float
    index_change: float
    companies: list[CompanyState]


class MarketService:
    """Owns ``companies``, ``price_history``, ``market_state`` and ``market_news``.

    One engine instance is kept per guild so multiple servers can run
    independent markets without interfering with each other.
    """

    def __init__(
        self,
        db: Database,
        market_config: MarketConfig,
        *,
        rng: random.Random | None = None,
    ) -> None:
        self.db = db
        self.config = market_config
        self._engines: dict[int, MarketEngine] = {}
        self._rng = rng

    # ------------------------------------------------------------------ setup

    async def get_engine(self, guild_id: int) -> MarketEngine:
        if guild_id in self._engines:
            return self._engines[guild_id]
        engine = MarketEngine(self.config, rng=self._rng)
        await self._load(guild_id, engine)
        self._engines[guild_id] = engine
        return engine

    async def _load(self, guild_id: int, engine: MarketEngine) -> None:
        rows = await self.db.fetchall(
            "SELECT * FROM companies WHERE listed = 1 ORDER BY symbol"
        )
        if not rows:
            await self._seed_companies()
            rows = await self.db.fetchall(
                "SELECT * FROM companies WHERE listed = 1 ORDER BY symbol"
            )

        companies: dict[str, CompanyState] = {}
        for row in rows:
            symbol = row["symbol"]
            base = engine.companies.get(symbol)
            if base is None:
                continue
            state = CompanyState(
                symbol=symbol,
                name=row["name"],
                sector=row["sector"],
                description=row["description"],
                price=float(row["price"]),
                previous_close=float(row["previous_close"]),
                open_price=float(row["open_price"]),
                day_high=float(row["day_high"]),
                day_low=float(row["day_low"]),
                fair_value=float(row["price"]),
                volatility=float(row["volatility"]),
                drift=float(row["drift"]),
                beta=float(row["beta"]),
                shares_outstanding=int(row["shares_outstanding"]),
                dividend_yield=float(row["dividend_yield"]),
                halted_until_tick=int(row["halted_until_tick"]),
                active_event=row["active_event"],
                event_ticks_left=int(row["event_ticks_left"]),
                event_magnitude=float(row["event_magnitude"]),
                last_dividend_tick=int(row["last_dividend_tick"]),
            )
            companies[symbol] = state

        state_row = await self.db.fetchone(
            "SELECT * FROM market_state WHERE guild_id = ?", (guild_id,)
        )
        tick = int(state_row["tick"]) if state_row else 0
        regime = state_row["regime"] if state_row else "neutral"
        regime_ticks_left = int(state_row["regime_ticks_left"]) if state_row else 40
        index_value = float(state_row["index_value"]) if state_row else self.config.starting_index
        previous_index = float(state_row["previous_index"]) if state_row else index_value

        engine.load_state(
            tick=tick,
            regime=regime,
            regime_ticks_left=regime_ticks_left,
            index_value=index_value,
            previous_index=previous_index,
            companies=companies,
        )
        engine.previous_index = previous_index
        # Re-anchor the index baseline so a restart does not produce a phantom jump.
        engine._initial_market_cap = sum(c.market_cap for c in companies.values()) or 1.0

    async def _seed_companies(self) -> None:
        async with self.db.transaction() as conn:
            await conn.executemany(
                """
                INSERT INTO companies (
                    symbol, name, sector, description, price, previous_close,
                    open_price, day_high, day_low, volatility, drift, beta,
                    shares_outstanding, market_cap, dividend_yield
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (symbol) DO NOTHING
                """,
                [
                    (
                        seed.symbol,
                        seed.name,
                        seed.sector,
                        seed.description,
                        seed.price,
                        seed.price,
                        seed.price,
                        seed.price,
                        seed.price,
                        seed.volatility,
                        seed.drift,
                        seed.beta,
                        seed.shares_outstanding,
                        seed.price * seed.shares_outstanding,
                        seed.dividend_yield,
                    )
                    for seed in COMPANIES
                ],
            )

    # ------------------------------------------------------------------- ticks

    async def tick(self, guild_id: int, *, new_day: bool = False) -> TickResult:
        engine = await self.get_engine(guild_id)
        result = engine.advance(new_day=new_day)
        await self._persist(guild_id, engine, result)
        return result

    async def _persist(self, guild_id: int, engine: MarketEngine, result: TickResult) -> None:
        async with self.db.transaction() as conn:
            await conn.executemany(
                """
                UPDATE companies SET
                    price = ?, previous_close = ?, open_price = ?, day_high = ?,
                    day_low = ?, market_cap = ?, halted_until_tick = ?,
                    active_event = ?, event_ticks_left = ?, event_magnitude = ?,
                    last_dividend_tick = ?
                WHERE symbol = ?
                """,
                [
                    (
                        company.price,
                        company.previous_close,
                        company.open_price,
                        company.day_high,
                        company.day_low,
                        company.market_cap,
                        company.halted_until_tick,
                        company.active_event,
                        company.event_ticks_left,
                        company.event_magnitude,
                        company.last_dividend_tick,
                        company.symbol,
                    )
                    for company in engine.companies.values()
                ],
            )
            await conn.executemany(
                """
                INSERT INTO price_history (symbol, tick, price) VALUES (?, ?, ?)
                ON CONFLICT (symbol, tick) DO UPDATE SET price = excluded.price
                """,
                [(c.symbol, engine.tick, c.price) for c in engine.companies.values()],
            )
            await conn.execute(
                """
                INSERT INTO market_state
                    (guild_id, tick, regime, regime_ticks_left, index_value, previous_index,
                     updated_at)
                VALUES (?, ?, ?, ?, ?, ?, unixepoch('subsec'))
                ON CONFLICT (guild_id) DO UPDATE SET
                    tick = excluded.tick,
                    regime = excluded.regime,
                    regime_ticks_left = excluded.regime_ticks_left,
                    index_value = excluded.index_value,
                    previous_index = excluded.previous_index,
                    updated_at = excluded.updated_at
                """,
                (
                    guild_id,
                    engine.tick,
                    engine.regime,
                    engine.regime_ticks_left,
                    engine.index_value,
                    engine.previous_index,
                ),
            )
            if result.news:
                await conn.executemany(
                    """
                    INSERT INTO market_news (guild_id, tick, symbol, headline, impact)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    [
                        (guild_id, engine.tick, item.symbol, item.headline, item.impact)
                        for item in result.news
                    ],
                )
        await self._prune_history(engine.tick)

    async def _prune_history(self, tick: int) -> None:
        """Keep the history table bounded so the file does not grow forever."""
        cutoff = tick - self.config.history_limit
        if cutoff <= 0:
            return
        await self.db.execute("DELETE FROM price_history WHERE tick < ?", (cutoff,))

    # ------------------------------------------------------------------ queries

    async def snapshot(self, guild_id: int) -> MarketSnapshot:
        engine = await self.get_engine(guild_id)
        index_change = (
            0.0
            if engine.previous_index == 0
            else (engine.index_value - engine.previous_index) / engine.previous_index
        )
        return MarketSnapshot(
            tick=engine.tick,
            regime=engine.regime,
            index_value=engine.index_value,
            index_change=index_change,
            companies=engine.snapshot(),
        )

    async def get_company(self, guild_id: int, symbol: str) -> CompanyState | None:
        engine = await self.get_engine(guild_id)
        return engine.companies.get(symbol.upper())

    async def resolve_symbol(self, guild_id: int, query: str) -> CompanyState | None:
        """Accept a ticker or a company name (prefix match) and return the match."""
        engine = await self.get_engine(guild_id)
        query = query.strip().upper()
        if not query:
            return None
        if query in engine.companies:
            return engine.companies[query]
        for company in engine.companies.values():
            if company.name.upper().startswith(query):
                return company
        for company in engine.companies.values():
            if query in company.name.upper():
                return company
        return None

    async def history(self, symbol: str, limit: int = 100) -> list[tuple[int, float]]:
        rows = await self.db.fetchall(
            "SELECT tick, price FROM price_history WHERE symbol = ? ORDER BY tick DESC LIMIT ?",
            (symbol.upper(), limit),
        )
        return [(int(row["tick"]), float(row["price"])) for row in reversed(rows)]

    async def news(self, guild_id: int, limit: int = 8) -> list[NewsItem]:
        rows = await self.db.fetchall(
            """
            SELECT symbol, headline, impact FROM market_news
            WHERE guild_id = ? ORDER BY id DESC LIMIT ?
            """,
            (guild_id, limit),
        )
        return [
            NewsItem(symbol=row["symbol"], headline=row["headline"], impact=float(row["impact"]))
            for row in rows
        ]

    async def index_history(self, guild_id: int, limit: int = 100) -> list[tuple[int, float]]:
        """Reconstruct the index from per-symbol history at each recorded tick."""
        rows = await self.db.fetchall(
            """
            SELECT tick, SUM(h.price * c.shares_outstanding) AS cap
            FROM price_history h
            JOIN companies c ON c.symbol = h.symbol
            GROUP BY tick
            ORDER BY tick DESC
            LIMIT ?
            """,
            (limit,),
        )
        if not rows:
            return []
        caps = [(int(row["tick"]), float(row["cap"])) for row in reversed(rows)]
        baseline = caps[0][1] or 1.0
        return [(tick, self.config.starting_index * cap / baseline) for tick, cap in caps]
