/** Tests for the read-only web dashboard: payloads, SVG charts and routes. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Database } from '../hera/database';
import { MarketService } from '../hera/services/market';
import { Random } from '../hera/market/random';
import { config } from '../hera/config';
import {
  chartDataUri,
  fallbackChart,
  renderComparisonChart,
  renderPriceChart,
  renderSparkline,
} from '../dashboard/charts';
import { DashboardService } from '../dashboard/service';
import { Dashboard } from '../dashboard/server';
import { testMarketConfig, GUILD } from './harness';

function advance(market: MarketService, count: number): void {
  for (let i = 0; i < count; i += 1) market.tick(GUILD);
}

interface Fixture {
  db: Database;
  market: MarketService;
  service: DashboardService;
  close(): void;
}

function fixture(): Fixture {
  const db = new Database(':memory:');
  const market = new MarketService(db, testMarketConfig(), new Random(1234));
  advance(market, 40);
  return {
    db,
    market,
    service: new DashboardService(market, GUILD),
    close: () => db.close(),
  };
}

// ------------------------------------------------------------------ the payload

test('the market payload lists every company', async () => {
  const f = fixture();
  const payload = await f.service.marketPayload();
  assert.equal(payload.stocks.length, 20);
  assert.equal(payload.totals.listings, 20);
  assert.ok(payload.tick > 0);
  f.close();
});

test('the market payload has the documented shape', async () => {
  const f = fixture();
  const payload = await f.service.marketPayload();
  for (const key of ['generated_at', 'tick', 'regime', 'index', 'totals', 'sectors', 'stocks', 'news']) {
    assert.ok(key in payload, `missing ${key}`);
  }
  assert.deepEqual(Object.keys(payload.index).sort(), ['change', 'change_pct', 'value']);
  f.close();
});

test('stock rows expose the tracking fields', async () => {
  const f = fixture();
  const row = (await f.service.marketPayload()).stocks[0];
  for (const key of [
    'symbol',
    'name',
    'sector',
    'price',
    'change_pct',
    'day_high',
    'day_low',
    'market_cap',
    'dividend_yield',
    'halted',
    'sparkline',
  ]) {
    assert.ok(key in row, `missing ${key}`);
  }
  assert.ok(row.sparkline.startsWith('data:image/svg+xml;base64,'));
  f.close();
});

test('change_pct matches price and previous_close', async () => {
  const f = fixture();
  const payload = await f.service.marketPayload();
  for (const row of payload.stocks) {
    const expected = row.previous_close ? ((row.price - row.previous_close) / row.previous_close) * 100 : 0;
    assert.ok(Math.abs(row.change_pct - expected) < 1e-9, `${row.symbol} change_pct`);
  }
  f.close();
});

test('sectors cover every stock', async () => {
  const f = fixture();
  const payload = await f.service.marketPayload();
  const counted = payload.sectors.reduce((sum, sector) => sum + sector.count, 0);
  assert.equal(counted, payload.stocks.length);
  f.close();
});

test('totals breadth adds up', async () => {
  const f = fixture();
  const { totals } = await f.service.marketPayload();
  assert.equal(totals.gainers + totals.losers + totals.unchanged, totals.listings);
  f.close();
});

// -------------------------------------------------------------------- the charts

test('the price chart is well-formed SVG with the series', () => {
  const history: [number, number][] = Array.from({ length: 30 }, (_, i) => [i, 100 + i]);
  const svg = renderPriceChart('TEST', 'Test Co', history);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  assert.ok(svg.includes('TEST') && svg.includes('Test Co'));
  assert.equal(svg.split('<polyline').length - 1, 1);
});

test('the price chart needs at least two points', () => {
  assert.equal(renderPriceChart('TEST', 'Test Co', [[1, 10]]), '');
  assert.equal(renderPriceChart('TEST', 'Test Co', []), '');
});

test('the sparkline requires two points', () => {
  assert.equal(renderSparkline([]), '');
  assert.equal(renderSparkline([5]), '');
  const svg = renderSparkline([1, 2, 3]);
  assert.ok(svg.startsWith('<svg') && svg.includes('</svg>'));
});

test('the comparison chart normalises and handles empty input', () => {
  assert.equal(renderComparisonChart({}), '');
  assert.equal(renderComparisonChart({ A: [1] }), '');
  const svg = renderComparisonChart({ A: [100, 110], B: [50, 45] });
  assert.equal(svg.split('<polyline').length - 1, 2);
  assert.ok(svg.includes('A') && svg.includes('B'));
});

test('the chart data URI round-trips', () => {
  const uri = chartDataUri('<svg></svg>');
  assert.ok(uri.startsWith('data:image/svg+xml;base64,'));
  assert.equal(Buffer.from(uri.split(',')[1], 'base64').toString('utf-8'), '<svg></svg>');
  assert.equal(chartDataUri(''), '');
});

test('the fallback chart is a valid image', () => {
  const svg = fallbackChart();
  assert.ok(svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'));
});

test('stockChartSvg renders a known symbol', () => {
  const f = fixture();
  const svg = f.service.stockChartSvg('NOVA');
  assert.ok(svg);
  assert.ok(svg.includes('NOVA') && svg.startsWith('<svg'));
  assert.ok(f.service.stockChartSvg('nova'));
  assert.equal(f.service.stockChartSvg('ZZZZ'), null);
  f.close();
});

test('indexChartSvg renders the index', () => {
  const f = fixture();
  const svg = f.service.indexChartSvg();
  assert.ok(svg && svg.includes('Hera Exchange Index'));
  f.close();
});

test('rendered SVG has no unfilled placeholders', () => {
  // Guards against a template literal silently slipping into the markup.
  const svg = renderPriceChart('TEST', 'Test Co', Array.from({ length: 10 }, (_, i) => [i, 10 + i]));
  assert.equal(/\{[a-z_]+\}/.test(svg), false);
});

// --------------------------------------------------------------------- the routes

interface Response {
  status: number;
  contentType: string | null;
  body: string;
}

async function get(port: number, path: string): Promise<Response> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { accept: '*/*' },
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: await response.text(),
  };
}

/** Start a live dashboard on a port the OS picks, and return its details. */
async function withServer<T>(body: (port: number, dashboard: Dashboard) => Promise<T>): Promise<T> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const directory = mkdtempSync(join(tmpdir(), 'hera-dashboard-'));
  const path = join(directory, 'test.db');
  const previous = { dbPath: config.dbPath, guildId: config.guildId };

  // Seed the file the dashboard will open, then point the shared config at it.
  const seed = new Database(path);
  const market = new MarketService(seed, testMarketConfig(), new Random(1));
  for (let i = 0; i < 40; i += 1) market.tick(GUILD);
  seed.close();
  config.dbPath = path;
  config.guildId = GUILD;

  const dashboard = new Dashboard();
  await dashboard.start('127.0.0.1', 0);
  const address = (dashboard as unknown as { server: { address(): { port: number } } }).server.address();
  try {
    return await body(address.port, dashboard);
  } finally {
    await dashboard.stop();
    config.dbPath = previous.dbPath;
    config.guildId = previous.guildId;
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the overview and stocks pages are served', async () => {
  await withServer(async (port) => {
    for (const path of ['/', '/stocks']) {
      const response = await get(port, path);
      assert.equal(response.status, 200);
      assert.ok(response.body.includes('<!DOCTYPE html>'));
      assert.ok(response.body.includes('/static/app.js'));
    }
  });
});

test('static assets are served', async () => {
  await withServer(async (port) => {
    for (const path of ['/static/style.css', '/static/app.js']) {
      const response = await get(port, path);
      assert.equal(response.status, 200);
      assert.ok(response.body.trim().length > 0);
    }
  });
});

test('the market JSON endpoint responds', async () => {
  await withServer(async (port) => {
    const response = await get(port, '/api/market');
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.ok(payload.stocks.length > 0);
    assert.ok(payload.index.value > 0);
  });
});

test('the stocks JSON endpoint responds', async () => {
  await withServer(async (port) => {
    const response = await get(port, '/api/stocks');
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).stocks.length, 20);
  });
});

test('the chart endpoint returns SVG', async () => {
  await withServer(async (port) => {
    const response = await get(port, '/api/charts/nova.svg');
    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'image/svg+xml');
    assert.ok(response.body.startsWith('<svg'));
    assert.ok(response.body.includes('NOVA'));
  });
});

test('the index chart endpoint returns SVG', async () => {
  await withServer(async (port) => {
    const response = await get(port, '/api/charts/index.svg');
    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'image/svg+xml');
    assert.ok(response.body.startsWith('<svg'));
  });
});

test('the chart endpoint 404s on an unknown symbol', async () => {
  await withServer(async (port) => {
    assert.equal((await get(port, '/api/charts/zzzz.svg')).status, 404);
  });
});

test('the health endpoint responds', async () => {
  await withServer(async (port) => {
    const response = await get(port, '/healthz');
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.status, 'ok');
    assert.ok(payload.tick > 0);
  });
});

test('the dashboard is read-only', async () => {
  await withServer(async (port) => {
    const before = await get(port, '/api/market');
    for (const path of [
      '/',
      '/stocks',
      '/api/market',
      '/api/stocks',
      '/api/charts/nova.svg',
      '/api/charts/index.svg',
      '/healthz',
    ]) {
      await get(port, path);
    }
    const after = await get(port, '/api/market');
    const beforePayload = JSON.parse(before.body);
    const afterPayload = JSON.parse(after.body);
    assert.equal(afterPayload.tick, beforePayload.tick);
    assert.deepEqual(
      afterPayload.stocks.map((row: { price: number }) => row.price),
      beforePayload.stocks.map((row: { price: number }) => row.price),
    );
  });
});

test('the dashboard refuses to start without a guild', () => {
  const previous = config.guildId;
  config.guildId = null;
  try {
    assert.throws(() => new Dashboard(), /guild/i);
  } finally {
    config.guildId = previous;
  }
});

test('the dashboard can serve an injected market without owning the database', async () => {
  const db = new Database(':memory:');
  const market = new MarketService(db, testMarketConfig(), new Random(99));
  advance(market, 25);
  const dashboard = new Dashboard({ guildId: GUILD, db, market });
  await dashboard.start('127.0.0.1', 0);
  const address = (dashboard as unknown as { server: { address(): { port: number } } }).server.address();
  try {
    const response = await get(address.port, '/api/market');
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.stocks.length, 20);
    assert.equal(payload.tick, 25);
  } finally {
    // stop() must leave a borrowed database open for its owner.
    await dashboard.stop();
  }
  // The bot relies on this: the handle is still usable, and it closes it itself
  // during shutdown.
  const stillOpen = new Dashboard({ guildId: GUILD, db, market });
  await stillOpen.start('127.0.0.1', 0);
  await stillOpen.stop();
  db.close();
});

test('a dashboard opened standalone closes the database it owns', async () => {
  const previous = config.dbPath;
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'hera-dash-'));
  const path = join(directory, 'hera.db');
  const seed = new Database(path);
  const market = new MarketService(seed, testMarketConfig(), new Random(3));
  advance(market, 5);
  seed.close();
  config.dbPath = path;
  try {
    const dashboard = new Dashboard({ guildId: GUILD });
    await dashboard.start('127.0.0.1', 0);
    await dashboard.stop();
    // It opened (and closed) its own connection, so reopening the file works.
    const reopened = new Database(path);
    const count = reopened.fetchval<number>('SELECT COUNT(*) FROM companies');
    assert.equal(count, 20);
    reopened.close();
  } finally {
    config.dbPath = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
