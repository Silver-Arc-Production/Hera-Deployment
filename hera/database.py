"""SQLite schema and connection management.

A single aiosqlite connection is shared for the process and guarded by an
asyncio lock. SQLite is more than enough for a Discord bot's write volume and
keeps deployment to a single file, but it serialises writes -- so every
multi-statement mutation goes through :meth:`Database.transaction`.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Iterable, Sequence

import aiosqlite

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
    user_id             INTEGER NOT NULL,
    guild_id            INTEGER NOT NULL,
    wallet              INTEGER NOT NULL DEFAULT 0,
    bank                INTEGER NOT NULL DEFAULT 0,
    bank_capacity       INTEGER NOT NULL DEFAULT 50000,
    bank_level          INTEGER NOT NULL DEFAULT 1,
    daily_streak        INTEGER NOT NULL DEFAULT 0,
    last_daily          REAL,
    last_work           REAL,
    last_rob            REAL,
    created_at          REAL NOT NULL DEFAULT (unixepoch('subsec')),
    updated_at          REAL NOT NULL DEFAULT (unixepoch('subsec')),
    PRIMARY KEY (user_id, guild_id)
);

-- Every balance mutation is journalled so balances can be audited or rebuilt.
CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    guild_id    INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    note        TEXT,
    created_at  REAL NOT NULL DEFAULT (unixepoch('subsec'))
);
CREATE INDEX IF NOT EXISTS idx_transactions_user
    ON transactions (user_id, guild_id, id DESC);

CREATE TABLE IF NOT EXISTS companies (
    symbol          TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    sector          TEXT NOT NULL,
    description     TEXT NOT NULL,
    price           REAL NOT NULL,
    previous_close  REAL NOT NULL,
    open_price      REAL NOT NULL,
    day_high        REAL NOT NULL,
    day_low         REAL NOT NULL,
    volatility      REAL NOT NULL,
    drift           REAL NOT NULL,
    beta            REAL NOT NULL DEFAULT 1.0,
    shares_outstanding INTEGER NOT NULL,
    market_cap      REAL NOT NULL,
    dividend_yield  REAL NOT NULL DEFAULT 0.0,
    halted_until_tick INTEGER NOT NULL DEFAULT 0,
    active_event    TEXT,
    event_ticks_left INTEGER NOT NULL DEFAULT 0,
    event_magnitude REAL NOT NULL DEFAULT 0.0,
    last_dividend_tick INTEGER NOT NULL DEFAULT 0,
    listed          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS price_history (
    symbol  TEXT NOT NULL,
    tick    INTEGER NOT NULL,
    price   REAL NOT NULL,
    PRIMARY KEY (symbol, tick)
);
CREATE INDEX IF NOT EXISTS idx_price_history_symbol_tick
    ON price_history (symbol, tick DESC);

CREATE TABLE IF NOT EXISTS positions (
    user_id         INTEGER NOT NULL,
    guild_id        INTEGER NOT NULL,
    symbol          TEXT NOT NULL,
    quantity        INTEGER NOT NULL DEFAULT 0,
    average_cost    REAL NOT NULL DEFAULT 0.0,
    realized_pnl    INTEGER NOT NULL DEFAULT 0,
    updated_at      REAL NOT NULL DEFAULT (unixepoch('subsec')),
    PRIMARY KEY (user_id, guild_id, symbol)
);

-- Short positions are tracked separately from longs so both can coexist.
CREATE TABLE IF NOT EXISTS short_positions (
    user_id         INTEGER NOT NULL,
    guild_id        INTEGER NOT NULL,
    symbol          TEXT NOT NULL,
    quantity        INTEGER NOT NULL DEFAULT 0,
    average_price   REAL NOT NULL DEFAULT 0.0,
    collateral      INTEGER NOT NULL DEFAULT 0,
    realized_pnl    INTEGER NOT NULL DEFAULT 0,
    opened_tick     INTEGER NOT NULL DEFAULT 0,
    updated_at      REAL NOT NULL DEFAULT (unixepoch('subsec')),
    PRIMARY KEY (user_id, guild_id, symbol)
);

CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    guild_id        INTEGER NOT NULL,
    symbol          TEXT NOT NULL,
    side            TEXT NOT NULL,
    quantity        INTEGER NOT NULL,
    limit_price     REAL NOT NULL,
    filled_quantity INTEGER NOT NULL DEFAULT 0,
    average_fill    REAL,
    status          TEXT NOT NULL DEFAULT 'open',
    created_tick    INTEGER NOT NULL,
    expires_tick    INTEGER,
    created_at      REAL NOT NULL DEFAULT (unixepoch('subsec')),
    updated_at      REAL NOT NULL DEFAULT (unixepoch('subsec'))
);
CREATE INDEX IF NOT EXISTS idx_orders_open
    ON orders (guild_id, symbol, status);

CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    guild_id    INTEGER NOT NULL,
    symbol      TEXT NOT NULL,
    direction   TEXT NOT NULL,
    threshold   REAL NOT NULL,
    note        TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  REAL NOT NULL DEFAULT (unixepoch('subsec'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_active
    ON alerts (guild_id, symbol, active);

CREATE TABLE IF NOT EXISTS market_state (
    guild_id    INTEGER PRIMARY KEY,
    tick        INTEGER NOT NULL DEFAULT 0,
    regime      TEXT NOT NULL DEFAULT 'neutral',
    regime_ticks_left INTEGER NOT NULL DEFAULT 40,
    index_value REAL NOT NULL DEFAULT 1000.0,
    previous_index REAL NOT NULL DEFAULT 1000.0,
    updated_at  REAL NOT NULL DEFAULT (unixepoch('subsec'))
);

CREATE TABLE IF NOT EXISTS market_news (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    INTEGER NOT NULL,
    tick        INTEGER NOT NULL,
    symbol      TEXT,
    headline    TEXT NOT NULL,
    impact      REAL NOT NULL DEFAULT 0.0,
    created_at  REAL NOT NULL DEFAULT (unixepoch('subsec'))
);
CREATE INDEX IF NOT EXISTS idx_market_news_guild
    ON market_news (guild_id, id DESC);

CREATE TABLE IF NOT EXISTS watchlists (
    user_id     INTEGER NOT NULL,
    guild_id    INTEGER NOT NULL,
    symbol      TEXT NOT NULL,
    created_at  REAL NOT NULL DEFAULT (unixepoch('subsec')),
    PRIMARY KEY (user_id, guild_id, symbol)
);
"""


class Database:
    """Thin async wrapper around a single shared SQLite connection."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._conn: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()

    async def connect(self) -> None:
        if self._conn is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database.connect() must be awaited before use")
        return self._conn

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[aiosqlite.Connection]:
        """Serialise a multi-statement mutation behind the connection lock."""
        async with self._lock:
            try:
                yield self.conn
            except Exception:
                await self.conn.rollback()
                raise
            else:
                await self.conn.commit()

    async def execute(self, sql: str, params: Sequence[Any] = ()) -> None:
        async with self.transaction() as conn:
            await conn.execute(sql, params)

    async def executemany(self, sql: str, rows: Iterable[Sequence[Any]]) -> None:
        async with self.transaction() as conn:
            await conn.executemany(sql, rows)

    async def fetchone(self, sql: str, params: Sequence[Any] = ()) -> aiosqlite.Row | None:
        async with self.conn.execute(sql, params) as cursor:
            return await cursor.fetchone()

    async def fetchall(self, sql: str, params: Sequence[Any] = ()) -> list[aiosqlite.Row]:
        async with self.conn.execute(sql, params) as cursor:
            return list(await cursor.fetchall())

    async def fetchval(self, sql: str, params: Sequence[Any] = (), default: Any = None) -> Any:
        row = await self.fetchone(sql, params)
        return row[0] if row is not None else default
