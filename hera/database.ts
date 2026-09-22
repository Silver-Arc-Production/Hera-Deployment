/**
 * SQLite schema and connection management.
 *
 * Backed by Node's built-in ``node:sqlite`` module, so the deployment stays a
 * single file with no native build step. Writes are synchronous but local and
 * fast, which is more than enough for a Discord bot's volume; every
 * multi-statement mutation goes through :meth:`Database.transaction` so a
 * failure rolls the whole thing back.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
    user_id             TEXT NOT NULL,
    guild_id            TEXT NOT NULL,
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
    user_id     TEXT NOT NULL,
    guild_id    TEXT NOT NULL,
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
    user_id         TEXT NOT NULL,
    guild_id        TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    quantity        REAL NOT NULL DEFAULT 0.0,
    average_cost    REAL NOT NULL DEFAULT 0.0,
    realized_pnl    INTEGER NOT NULL DEFAULT 0,
    updated_at      REAL NOT NULL DEFAULT (unixepoch('subsec')),
    PRIMARY KEY (user_id, guild_id, symbol)
);

-- Short positions are tracked separately from longs so both can coexist.
CREATE TABLE IF NOT EXISTS short_positions (
    user_id         TEXT NOT NULL,
    guild_id        TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    quantity        REAL NOT NULL DEFAULT 0.0,
    average_price   REAL NOT NULL DEFAULT 0.0,
    collateral      INTEGER NOT NULL DEFAULT 0,
    realized_pnl    INTEGER NOT NULL DEFAULT 0,
    opened_tick     INTEGER NOT NULL DEFAULT 0,
    updated_at      REAL NOT NULL DEFAULT (unixepoch('subsec')),
    PRIMARY KEY (user_id, guild_id, symbol)
);

CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT NOT NULL,
    guild_id        TEXT NOT NULL,
    symbol          TEXT NOT NULL,
    side            TEXT NOT NULL,
    quantity        REAL NOT NULL,
    limit_price     REAL NOT NULL,
    filled_quantity REAL NOT NULL DEFAULT 0.0,
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
    user_id     TEXT NOT NULL,
    guild_id    TEXT NOT NULL,
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
    guild_id    TEXT PRIMARY KEY,
    tick        INTEGER NOT NULL DEFAULT 0,
    regime      TEXT NOT NULL DEFAULT 'neutral',
    regime_ticks_left INTEGER NOT NULL DEFAULT 40,
    index_value REAL NOT NULL DEFAULT 1000.0,
    previous_index REAL NOT NULL DEFAULT 1000.0,
    updated_at  REAL NOT NULL DEFAULT (unixepoch('subsec'))
);

CREATE TABLE IF NOT EXISTS market_news (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT NOT NULL,
    tick        INTEGER NOT NULL,
    symbol      TEXT,
    headline    TEXT NOT NULL,
    impact      REAL NOT NULL DEFAULT 0.0,
    created_at  REAL NOT NULL DEFAULT (unixepoch('subsec'))
);
CREATE INDEX IF NOT EXISTS idx_market_news_guild
    ON market_news (guild_id, id DESC);

CREATE TABLE IF NOT EXISTS watchlists (
    user_id     TEXT NOT NULL,
    guild_id    TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    created_at  REAL NOT NULL DEFAULT (unixepoch('subsec')),
    PRIMARY KEY (user_id, guild_id, symbol)
);
`;

/** Anything the statement binder accepts as a positional parameter. */
export type BindValue = string | number | bigint | null | Uint8Array;

export class Database {
  private readonly db: DatabaseSync;
  /** Nesting depth of :meth:`transaction`; only the outermost one commits. */
  private depth = 0;

  constructor(public readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Run a multi-statement mutation atomically. Nested calls join the outer
   * transaction so a service can compose helpers without double-committing.
   */
  transaction<T>(fn: () => T): T {
    const outermost = this.depth === 0;
    if (outermost) this.db.exec('BEGIN');
    this.depth += 1;
    try {
      const result = fn();
      this.depth -= 1;
      if (outermost) this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.depth -= 1;
      if (outermost) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // A failed BEGIN leaves nothing to roll back.
        }
      }
      throw error;
    }
  }

  /** Run a statement that does not return rows. */
  execute(sql: string, params: BindValue[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  /** Run a mutation and return the last inserted row id. */
  insert(sql: string, params: BindValue[] = []): number {
    const info = this.db.prepare(sql).run(...params);
    return Number(info.lastInsertRowid);
  }

  executemany(sql: string, rows: BindValue[][]): void {
    const statement = this.db.prepare(sql);
    for (const row of rows) statement.run(...row);
  }

  fetchone<T = Record<string, unknown>>(sql: string, params: BindValue[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  fetchall<T = Record<string, unknown>>(sql: string, params: BindValue[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  fetchval<T = unknown>(sql: string, params: BindValue[] = [], fallback: T | null = null): T | null {
    const row = this.fetchone<Record<string, unknown>>(sql, params);
    if (row === undefined) return fallback;
    const first = Object.values(row)[0];
    return (first as T) ?? fallback;
  }
}
