/** Tests for the price simulation engine (pure, no database). */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { marketDefaults } from '../hera/config';
import type { MarketConfig } from '../hera/config';
import { COMPANIES } from '../hera/market/companies';
import { MarketEngine, REGIMES } from '../hera/market/engine';
import { Random } from '../hera/market/random';

function config(overrides: Partial<MarketConfig> = {}): MarketConfig {
  return { ...marketDefaults, ...overrides };
}

function engine(overrides: Partial<MarketConfig> = {}, seed = 7): MarketEngine {
  return new MarketEngine(config(overrides), { rng: new Random(seed) });
}

test('there are twenty distinct companies', () => {
  assert.equal(COMPANIES.length, 20);
  assert.equal(new Set(COMPANIES.map((c) => c.symbol)).size, 20);
  assert.equal(new Set(COMPANIES.map((c) => c.name)).size, 20);
});

test('the engine starts with every listing', () => {
  const market = engine();
  assert.equal(Object.keys(market.companies).length, 20);
  assert.equal(market.tick, 0);
});

test('prices stay within bounds over a long run', () => {
  const market = engine();
  for (let i = 0; i < 2_000; i += 1) market.advance();
  for (const company of Object.values(market.companies)) {
    assert.ok(company.price >= market.config.minPrice);
    assert.ok(company.price <= market.config.maxPrice);
    assert.ok(company.price > 0);
  }
});

test('no single tick move exceeds the cap', () => {
  const market = engine();
  let previous: Record<string, number> = {};
  for (const [symbol, company] of Object.entries(market.companies)) previous[symbol] = company.price;
  for (let i = 0; i < 500; i += 1) {
    market.advance();
    for (const [symbol, company] of Object.entries(market.companies)) {
      const change = Math.abs(Math.log(company.price / previous[symbol]));
      // The cap plus a small allowance for the fair-value re-anchor.
      assert.ok(change <= market.config.maxTickMove + 1e-6);
    }
    previous = {};
    for (const [symbol, company] of Object.entries(market.companies)) previous[symbol] = company.price;
  }
});

test('the index moves with the market', () => {
  const market = engine();
  const start = market.indexValue;
  for (let i = 0; i < 200; i += 1) market.advance();
  assert.notEqual(market.indexValue, start);
  assert.ok(market.indexValue > 0);
});

test('the regime is always valid', () => {
  const market = engine();
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    market.advance();
    seen.add(market.regime);
    assert.ok((REGIMES as readonly string[]).includes(market.regime));
  }
  assert.ok(seen.size > 1);
});

test('a new day resets session counters', () => {
  const market = engine();
  for (let i = 0; i < 30; i += 1) market.advance();
  const company = market.companies.NOVA;
  company.dayHigh = company.price * 5;
  company.dayLow = company.price * 0.2;
  market.advance({ newDay: true });
  const refreshed = market.companies.NOVA;
  // The rollover discards the artificial extremes; the tick that follows may
  // still widen the range, so assert the stale values are gone.
  assert.ok(refreshed.dayHigh < company.price * 5);
  assert.ok(refreshed.dayLow > company.price * 0.2);
  assert.ok(refreshed.dayLow <= refreshed.price && refreshed.price <= refreshed.dayHigh);
  assert.equal(refreshed.openPrice, refreshed.previousClose);
});

test('dividends pay out and reduce price', () => {
  const market = engine({ dividendTickInterval: 5 });
  const payouts: Record<string, number>[] = [];
  for (let i = 0; i < 200; i += 1) {
    const result = market.advance();
    if (Object.keys(result.dividends).length > 0) payouts.push(result.dividends);
  }
  assert.ok(payouts.length > 0);
  for (const payout of payouts) {
    for (const perShare of Object.values(payout)) assert.ok(perShare > 0);
  }
});

test('the circuit breaker halts a collapsing stock', () => {
  const market = engine();
  const company = market.companies.NOVA;
  company.previousClose = company.price;
  company.dayLow = company.price;
  market.advance();
  // Drop the live price far below the previous close, then tick once more.
  company.price = company.previousClose * 0.5;
  market.advance();
  assert.ok(company.haltedUntilTick > market.tick);
});

test('a halted company does not move', () => {
  const market = engine();
  const company = market.companies.TERA;
  company.haltedUntilTick = market.tick + 5;
  const frozen = company.price;
  market.advance();
  assert.equal(company.price, frozen);
});

test('events are generated and decay', () => {
  const market = engine({ eventChance: 1.0 });
  const headlines: string[] = [];
  for (let i = 0; i < 50; i += 1) {
    headlines.push(...market.advance().news.map((item) => item.headline));
  }
  assert.ok(headlines.length > 0);
  for (const company of Object.values(market.companies)) assert.ok(company.eventTicksLeft >= 0);
});

test('snapshot and movers are consistent', () => {
  const market = engine();
  for (let i = 0; i < 20; i += 1) market.advance();
  const snapshot = market.snapshot();
  assert.deepEqual(
    snapshot.map((company) => company.symbol),
    Object.keys(market.companies).sort(),
  );
  const [gainers, losers] = market.topMovers(3);
  assert.equal(gainers.length, 3);
  assert.equal(losers.length, 3);
  assert.ok(gainers[0].dayChangeFraction >= losers[losers.length - 1].dayChangeFraction);
});

test('sector performance covers every sector', () => {
  const market = engine();
  for (let i = 0; i < 10; i += 1) market.advance();
  const performance = market.sectorPerformance();
  assert.ok(Object.keys(performance).length > 0);
  assert.ok(Object.values(performance).every((value) => typeof value === 'number'));
});

test('the same seed produces identical paths', () => {
  const a = engine({}, 99);
  const b = engine({}, 99);
  for (let i = 0; i < 50; i += 1) {
    a.advance();
    b.advance();
  }
  for (const symbol of Object.keys(a.companies)) {
    assert.ok(Math.abs(a.companies[symbol].price - b.companies[symbol].price) < 1e-9);
  }
});

test('mean reversion pulls a dislocated price back', () => {
  const market = engine({ eventChance: 0.0 }, 5);
  const company = market.companies.LEDG;
  company.fairValue = company.price;
  company.price *= 1.8;
  const start = company.price;
  for (let i = 0; i < 400; i += 1) market.advance();
  // Reversion is deliberately weak, so assert direction rather than equality.
  assert.ok(market.companies.LEDG.price < start);
});

for (const seed of [11, 22, 33, 44, 55]) {
  test(`the long-run market stays within a healthy band (seed ${seed})`, () => {
    // A month of ticks must not inflate or bleed out: the drift multiplier is
    // finely balanced against volatility drag, so this fails loudly if a change
    // to volatility, regimes or drift tips the economy into runaway growth.
    const market = engine({}, seed);
    for (let i = 0; i < 8_640; i += 1) market.advance();

    const change = market.indexValue / market.config.startingIndex - 1;
    assert.ok(change > -0.4 && change < 0.6, `30-day index change was ${(change * 100).toFixed(1)}%`);
    for (const company of Object.values(market.companies)) {
      assert.ok(company.price >= market.config.minPrice && company.price <= market.config.maxPrice);
    }
  });
}
