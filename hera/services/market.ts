/**
 * Persists the market engine's state and drives ticks for a guild.
 *
 * One engine instance is kept per guild so multiple servers can run independent
 * markets without interfering with each other.
 */
import type { MarketConfig } from '../config';
import type { Database } from '../database';
import { COMPANIES } from '../market/companies';
import { CompanyState, MarketEngine, type NewsItem, type TickResult } from '../market/engine';
import type { Random } from '../market/random';

export interface MarketSnapshot {
  tick: number;
  regime: string;
  indexValue: number;
  indexChange: number;
  companies: CompanyState[];
}

interface CompanyRow {
  symbol: string;
  name: string;
  sector: string;
  description: string;
  price: number;
  previous_close: number;
  open_price: number;
  day_high: number;
  day_low: number;
  volatility: number;
  drift: number;
  beta: number;
  shares_outstanding: number;
  dividend_yield: number;
  halted_until_tick: number;
  active_event: string | null;
  event_ticks_left: number;
  event_magnitude: number;
  last_dividend_tick: number;
}

interface MarketStateRow {
  tick: number;
  regime: string;
  regime_ticks_left: number;
  index_value: number;
  previous_index: number;
}

export class MarketService {
  private readonly engines = new Map<string, MarketEngine>();

  constructor(
    private readonly db: Database,
    public readonly config: MarketConfig,
    private readonly rng?: Random,
  ) {}

  // ------------------------------------------------------------------ setup

  getEngine(guildId: string): MarketEngine {
    const existing = this.engines.get(guildId);
    if (existing) return existing;
    const engine = new MarketEngine(this.config, { rng: this.rng });
    this.load(guildId, engine);
    this.engines.set(guildId, engine);
    return engine;
  }

  private load(guildId: string, engine: MarketEngine): void {
    let rows = this.db.fetchall<CompanyRow>('SELECT * FROM companies WHERE listed = 1 ORDER BY symbol');
    if (rows.length === 0) {
      this.seedCompanies();
      rows = this.db.fetchall<CompanyRow>('SELECT * FROM companies WHERE listed = 1 ORDER BY symbol');
    }

    const companies: Record<string, CompanyState> = {};
    for (const row of rows) {
      const base = engine.companies[row.symbol];
      if (!base) continue;
      const state = new CompanyState({
        symbol: row.symbol,
        name: row.name,
        sector: row.sector,
        description: row.description,
        price: Number(row.price),
        volatility: Number(row.volatility),
        drift: Number(row.drift),
        beta: Number(row.beta),
        sharesOutstanding: Number(row.shares_outstanding),
        dividendYield: Number(row.dividend_yield),
      });
      state.previousClose = Number(row.previous_close);
      state.openPrice = Number(row.open_price);
      state.dayHigh = Number(row.day_high);
      state.dayLow = Number(row.day_low);
      state.fairValue = Number(row.price);
      state.haltedUntilTick = Number(row.halted_until_tick);
      state.activeEvent = row.active_event;
      state.eventTicksLeft = Number(row.event_ticks_left);
      state.eventMagnitude = Number(row.event_magnitude);
      state.lastDividendTick = Number(row.last_dividend_tick);
      companies[row.symbol] = state;
    }

    const stateRow = this.db.fetchone<MarketStateRow>(
      'SELECT * FROM market_state WHERE guild_id = ?',
      [guildId],
    );
    const tick = stateRow ? Number(stateRow.tick) : 0;
    const regime = stateRow ? stateRow.regime : 'neutral';
    const regimeTicksLeft = stateRow ? Number(stateRow.regime_ticks_left) : 40;
    const indexValue = stateRow ? Number(stateRow.index_value) : this.config.startingIndex;
    const previousIndex = stateRow ? Number(stateRow.previous_index) : indexValue;

    engine.loadState({
      tick,
      regime,
      regimeTicksLeft,
      indexValue,
      previousIndex,
      companies,
    });
    engine.previousIndex = previousIndex;
  }

  private seedCompanies(): void {
    this.db.transaction(() => {
      this.db.executemany(
        `INSERT INTO companies (
            symbol, name, sector, description, price, previous_close,
            open_price, day_high, day_low, volatility, drift, beta,
            shares_outstanding, market_cap, dividend_yield
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (symbol) DO NOTHING`,
        COMPANIES.map((seed) => [
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
          seed.sharesOutstanding,
          seed.price * seed.sharesOutstanding,
          seed.dividendYield ?? 0.0,
        ]),
      );
    });
  }

  // ------------------------------------------------------------------- ticks

  tick(guildId: string, options: { newDay?: boolean } = {}): TickResult {
    const engine = this.getEngine(guildId);
    const result = engine.advance({ newDay: options.newDay ?? false });
    this.persist(guildId, engine, result);
    return result;
  }

  private persist(guildId: string, engine: MarketEngine, result: TickResult): void {
    this.db.transaction(() => {
      this.db.executemany(
        `UPDATE companies SET
            price = ?, previous_close = ?, open_price = ?, day_high = ?, day_low = ?,
            market_cap = ?, halted_until_tick = ?, active_event = ?, event_ticks_left = ?,
            event_magnitude = ?, last_dividend_tick = ?
         WHERE symbol = ?`,
        Object.values(engine.companies).map((company) => [
          company.price,
          company.previousClose,
          company.openPrice,
          company.dayHigh,
          company.dayLow,
          company.marketCap,
          company.haltedUntilTick,
          company.activeEvent,
          company.eventTicksLeft,
          company.eventMagnitude,
          company.lastDividendTick,
          company.symbol,
        ]),
      );
      this.db.executemany(
        `INSERT INTO price_history (symbol, tick, price) VALUES (?, ?, ?)
         ON CONFLICT (symbol, tick) DO UPDATE SET price = excluded.price`,
        Object.values(engine.companies).map((company) => [company.symbol, engine.tick, company.price]),
      );
      this.db.execute(
        `INSERT INTO market_state
            (guild_id, tick, regime, regime_ticks_left, index_value, previous_index, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, unixepoch('subsec'))
         ON CONFLICT (guild_id) DO UPDATE SET
            tick = excluded.tick,
            regime = excluded.regime,
            regime_ticks_left = excluded.regime_ticks_left,
            index_value = excluded.index_value,
            previous_index = excluded.previous_index,
            updated_at = excluded.updated_at`,
        [
          guildId,
          engine.tick,
          engine.regime,
          engine.regimeTicksLeft,
          engine.indexValue,
          engine.previousIndex,
        ],
      );
      if (result.news.length > 0) {
        this.db.executemany(
          `INSERT INTO market_news (guild_id, tick, symbol, headline, impact) VALUES (?, ?, ?, ?, ?)`,
          result.news.map((item) => [guildId, engine.tick, item.symbol, item.headline, item.impact]),
        );
      }
    });
    this.pruneHistory(engine.tick);
  }

  /** Keep the history table bounded so the file does not grow forever. */
  private pruneHistory(tick: number): void {
    const cutoff = tick - this.config.historyLimit;
    if (cutoff <= 0) return;
    this.db.execute('DELETE FROM price_history WHERE tick < ?', [cutoff]);
  }

  // ------------------------------------------------------------------ queries

  snapshot(guildId: string): MarketSnapshot {
    const engine = this.getEngine(guildId);
    const indexChange =
      engine.previousIndex === 0
        ? 0.0
        : (engine.indexValue - engine.previousIndex) / engine.previousIndex;
    return {
      tick: engine.tick,
      regime: engine.regime,
      indexValue: engine.indexValue,
      indexChange,
      companies: engine.snapshot(),
    };
  }

  getCompany(guildId: string, symbol: string): CompanyState | undefined {
    return this.getEngine(guildId).companies[symbol.toUpperCase()];
  }

  /** Accept a ticker or a company name (prefix match) and return the match. */
  resolveSymbol(guildId: string, query: string): CompanyState | undefined {
    const engine = this.getEngine(guildId);
    const normalized = query.trim().toUpperCase();
    if (!normalized) return undefined;
    if (engine.companies[normalized]) return engine.companies[normalized];
    const companies = Object.values(engine.companies);
    for (const company of companies) {
      if (company.name.toUpperCase().startsWith(normalized)) return company;
    }
    for (const company of companies) {
      if (company.name.toUpperCase().includes(normalized)) return company;
    }
    return undefined;
  }

  history(symbol: string, limit = 100): [number, number][] {
    const rows = this.db.fetchall<{ tick: number; price: number }>(
      'SELECT tick, price FROM price_history WHERE symbol = ? ORDER BY tick DESC LIMIT ?',
      [symbol.toUpperCase(), limit],
    );
    return rows.reverse().map((row) => [Number(row.tick), Number(row.price)]);
  }

  news(guildId: string, limit = 8): NewsItem[] {
    const rows = this.db.fetchall<{ symbol: string | null; headline: string; impact: number }>(
      'SELECT symbol, headline, impact FROM market_news WHERE guild_id = ? ORDER BY id DESC LIMIT ?',
      [guildId, limit],
    );
    return rows.map((row) => ({
      symbol: row.symbol,
      headline: row.headline,
      impact: Number(row.impact),
    }));
  }

  /** Reconstruct the index from per-symbol history at each recorded tick. */
  indexHistory(guildId: string, limit = 100): [number, number][] {
    const rows = this.db.fetchall<{ tick: number; cap: number }>(
      `SELECT tick, SUM(h.price * c.shares_outstanding) AS cap
       FROM price_history h JOIN companies c ON c.symbol = h.symbol
       GROUP BY tick ORDER BY tick DESC LIMIT ?`,
      [limit],
    );
    if (rows.length === 0) return [];
    const caps = rows.reverse().map((row) => [Number(row.tick), Number(row.cap)] as [number, number]);
    const baseline = caps[0][1] || 1.0;
    return caps.map(([tick, cap]) => [tick, (this.config.startingIndex * cap) / baseline]);
  }
}
