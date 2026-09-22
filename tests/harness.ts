/**
 * Shared test harness: a throwaway database plus the three services wired
 * together exactly as the bot wires them.
 *
 * The RNG is seeded so price paths are reproducible; tests that assert on exact
 * numbers depend on that.
 */
import { Random } from '../hera/market/random';
import { Database } from '../hera/database';
import { economyDefaults, marketDefaults, tradingDefaults } from '../hera/config';
import type { MarketConfig, TradingConfig } from '../hera/config';
import { EconomyService } from '../hera/services/economy';
import { MarketService } from '../hera/services/market';
import { TradingService } from '../hera/services/trading';

export const GUILD = '424242';

export function testMarketConfig(overrides: Partial<MarketConfig> = {}): MarketConfig {
  return { ...marketDefaults, tickSeconds: 300, sessionTicks: 24, historyLimit: 40, ...overrides };
}

export function testTradingConfig(overrides: Partial<TradingConfig> = {}): TradingConfig {
  return { ...tradingDefaults, ...overrides };
}

export interface Harness {
  db: Database;
  economy: EconomyService;
  market: MarketService;
  trading: TradingService;
  marketConfig: MarketConfig;
  fund(userId: string, amount?: number): void;
  close(): void;
}

/** Build every service over one in-memory database. */
export function makeHarness(): Harness {
  const db = new Database(':memory:');
  const marketConfig = testMarketConfig();
  const economy = new EconomyService(db);
  // A seeded RNG keeps price paths reproducible across runs.
  const market = new MarketService(db, marketConfig, new Random(1234));
  const trading = new TradingService(db, economy, market, testTradingConfig());

  return {
    db,
    economy,
    market,
    trading,
    marketConfig,
    fund(userId: string, amount = 5_000_000): void {
      economy.getAccount(userId, GUILD);
      economy.credit(userId, GUILD, amount, { kind: 'test_funding', note: 'fixture' });
    },
    close(): void {
      db.close();
    },
  };
}

export { economyDefaults };
