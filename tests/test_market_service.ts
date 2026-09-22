/** Tests for persistence, tick advancement and the query helpers. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { MarketService } from '../hera/services/market';
import { Random } from '../hera/market/random';
import { makeHarness, testMarketConfig, GUILD } from './harness';

test('companies are seeded on first use', () => {
  const h = makeHarness();
  const engine = h.market.getEngine(GUILD);
  assert.equal(Object.keys(engine.companies).length, 20);
  assert.equal(h.db.fetchall('SELECT symbol FROM companies').length, 20);
  h.close();
});

test('seeding is idempotent', () => {
  const h = makeHarness();
  h.market.getEngine(GUILD);
  // Simulate a fresh process against the same database.
  h.db.execute('DELETE FROM companies');
  const fresh = new MarketService(h.db, testMarketConfig(), new Random(1));
  fresh.getEngine(GUILD);
  assert.equal(Number(h.db.fetchval('SELECT COUNT(*) AS n FROM companies')), 20);
  h.close();
});

test('a tick persists prices and history', () => {
  const h = makeHarness();
  const result = h.market.tick(GUILD);
  assert.equal(result.tick, 1);
  assert.equal(h.db.fetchall('SELECT symbol FROM price_history WHERE tick = 1').length, 20);
  const state = h.db.fetchone<{ tick: number; index_value: number }>(
    'SELECT tick, index_value FROM market_state WHERE guild_id = ?',
    [GUILD],
  );
  assert.equal(Number(state!.tick), 1);
  assert.ok(Number(state!.index_value) > 0);
  h.close();
});

test('state survives a restart', () => {
  const h = makeHarness();
  for (let i = 0; i < 5; i += 1) h.market.tick(GUILD);
  const price = h.market.getCompany(GUILD, 'NOVA')!.price;
  const tick = h.market.snapshot(GUILD).tick;

  // Simulate a process restart with a brand new service over the same file.
  const fresh = new MarketService(h.db, testMarketConfig(), new Random(1));
  fresh.getEngine(GUILD);
  assert.ok(Math.abs(fresh.getCompany(GUILD, 'NOVA')!.price - price) < 1e-9);
  assert.equal(fresh.snapshot(GUILD).tick, tick);
  h.close();
});

test('history is bounded by the configured limit', () => {
  const h = makeHarness();
  for (let i = 0; i < 80; i += 1) h.market.tick(GUILD);
  const count = Number(
    h.db.fetchval("SELECT COUNT(*) AS n FROM price_history WHERE symbol = 'NOVA'"),
  );
  // The prune keeps everything at or after ``tick - limit``, so the store can
  // hold one entry more than the nominal limit.
  assert.ok(count <= h.market.config.historyLimit + 1, `kept ${count} rows`);
  h.close();
});

test('history returns oldest first', () => {
  const h = makeHarness();
  for (let i = 0; i < 10; i += 1) h.market.tick(GUILD);
  const history = h.market.history('NOVA', 10);
  const ticks = history.map(([tick]) => tick);
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
  assert.equal(history.length, 10);
  h.close();
});

test('resolveSymbol accepts ticker, name and prefix', () => {
  const h = makeHarness();
  assert.equal(h.market.resolveSymbol(GUILD, 'nova')!.symbol, 'NOVA');
  assert.equal(h.market.resolveSymbol(GUILD, 'Novadyne Systems')!.symbol, 'NOVA');
  assert.equal(h.market.resolveSymbol(GUILD, 'novadyne')!.symbol, 'NOVA');
  assert.equal(h.market.resolveSymbol(GUILD, 'zzzz'), undefined);
  assert.equal(h.market.resolveSymbol(GUILD, ''), undefined);
  h.close();
});

test('news is recorded and readable', () => {
  const h = makeHarness();
  for (let i = 0; i < 40; i += 1) h.market.tick(GUILD);
  const items = h.market.news(GUILD, 5);
  assert.ok(items.length <= 5);
  assert.ok(items.every((item) => item.headline));
  h.close();
});

test('index history reconstructs a series', () => {
  const h = makeHarness();
  for (let i = 0; i < 15; i += 1) h.market.tick(GUILD);
  const series = h.market.indexHistory(GUILD, 15);
  assert.ok(series.length > 0);
  const ticks = series.map(([tick]) => tick);
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
  assert.ok(series.every(([, value]) => value > 0));
  h.close();
});

test('guilds have independent markets', () => {
  const h = makeHarness();
  const other = String(Number(GUILD) + 1);
  for (let i = 0; i < 3; i += 1) h.market.tick(GUILD);
  h.market.tick(other);
  assert.equal(h.market.snapshot(GUILD).tick, 3);
  assert.equal(h.market.snapshot(other).tick, 1);
  h.close();
});

test('dividends are reported by the tick', () => {
  const h = makeHarness();
  // A short dividend interval makes a payout certain within the window.
  const market = new MarketService(h.db, testMarketConfig({ dividendTickInterval: 3 }), new Random(1));
  const seen: Record<string, number> = {};
  for (let i = 0; i < 120; i += 1) {
    const result = market.tick(GUILD);
    Object.assign(seen, result.dividends);
  }
  assert.ok(Object.keys(seen).length > 0, 'at least one company should have paid a dividend');
  h.close();
});
