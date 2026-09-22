/** Tests for order execution, positions, orders, alerts and risk checks. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  InsufficientCollateral,
  InsufficientFunds,
  InsufficientShares,
  InvalidOrder,
  UnknownSymbol,
} from '../hera/errors';
import { makeHarness, GUILD, type Harness } from './harness';

function wallet(h: Harness, userId: string): number {
  return h.economy.getAccount(userId, GUILD).wallet;
}

function approx(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${expected}, got ${actual}`);
}

// --------------------------------------------------------------------- buying

test('buy creates a position and debits the wallet', () => {
  const h = makeHarness();
  h.fund('1');
  const before = wallet(h, '1');
  const fill = h.trading.buy('1', GUILD, 'NOVA', 10);
  const after = wallet(h, '1');

  const position = h.trading.getPosition('1', GUILD, 'NOVA');
  assert.ok(position);
  assert.equal(position.quantity, 10);
  approx(position.averageCost, fill.price);
  // Cash is charged in whole credits, rounded up so the house never undercharges.
  assert.equal(after, before - Math.ceil(fill.gross) - fill.commission);
  assert.ok(fill.commission >= h.trading.config.commissionMin);
  h.close();
});

test('buy uses weighted average cost', () => {
  const h = makeHarness();
  h.fund('2');
  const first = h.trading.buy('2', GUILD, 'BREW', 10);
  const second = h.trading.buy('2', GUILD, 'BREW', 30);

  const position = h.trading.getPosition('2', GUILD, 'BREW');
  assert.ok(position);
  assert.equal(position.quantity, 40);
  approx(position.averageCost, (10 * first.price + 30 * second.price) / 40);
  h.close();
});

test('buy accepts a company name', () => {
  const h = makeHarness();
  h.fund('3');
  assert.equal(h.trading.buy('3', GUILD, 'novadyne', 1).symbol, 'NOVA');
  h.close();
});

test('buy rejects an unknown symbol', () => {
  const h = makeHarness();
  h.fund('4');
  assert.throws(() => h.trading.buy('4', GUILD, 'ZZZZ', 1), UnknownSymbol);
  h.close();
});

test('buy rejects zero or negative quantity', () => {
  const h = makeHarness();
  h.fund('5');
  assert.throws(() => h.trading.buy('5', GUILD, 'NOVA', 0), InvalidOrder);
  assert.throws(() => h.trading.buy('5', GUILD, 'NOVA', -3), InvalidOrder);
  h.close();
});

test('buy without funds raises', () => {
  const h = makeHarness();
  const account = h.economy.getAccount('99', GUILD);
  assert.ok(account.wallet > 0);
  assert.throws(() => h.trading.buy('99', GUILD, 'NOVA', 100_000), InsufficientFunds);
  h.close();
});

test('large orders incur more slippage', () => {
  const h = makeHarness();
  const company = h.market.getCompany(GUILD, 'NOVA')!;
  const [, small] = h.trading.estimateExecutionPrice(company, 10, 'buy');
  const [, large] = h.trading.estimateExecutionPrice(company, 500_000, 'buy');
  assert.ok(large > small);
  assert.ok(large <= h.trading.config.maxSlippage);
  h.close();
});

// -------------------------------------------------------------------- selling

test('sell partial keeps remaining shares', () => {
  const h = makeHarness();
  h.fund('10');
  h.trading.buy('10', GUILD, 'TERA', 20);
  const fill = h.trading.sell('10', GUILD, 'TERA', 5);
  const position = h.trading.getPosition('10', GUILD, 'TERA');
  assert.ok(position);
  assert.equal(position.quantity, 15);
  assert.equal(fill.side, 'sell');
  h.close();
});

test('selling everything clears the position', () => {
  const h = makeHarness();
  h.fund('11');
  h.trading.buy('11', GUILD, 'TERA', 4);
  h.trading.sell('11', GUILD, 'TERA', 4);
  assert.equal(h.trading.getPosition('11', GUILD, 'TERA'), undefined);
  h.close();
});

test('selling more than held raises', () => {
  const h = makeHarness();
  h.fund('12');
  h.trading.buy('12', GUILD, 'TERA', 3);
  assert.throws(() => h.trading.sell('12', GUILD, 'TERA', 4), InsufficientShares);
  h.close();
});

test('selling without a position raises', () => {
  const h = makeHarness();
  h.fund('13');
  assert.throws(() => h.trading.sell('13', GUILD, 'TERA', 1), InsufficientShares);
  h.close();
});

test('sell credits proceeds and records realized pnl', () => {
  const h = makeHarness();
  h.fund('14');
  h.trading.buy('14', GUILD, 'BREW', 10);
  const before = wallet(h, '14');
  const fill = h.trading.sell('14', GUILD, 'BREW', 10);
  assert.ok(wallet(h, '14') > before);
  assert.equal(h.trading.getPosition('14', GUILD, 'BREW'), undefined);
  const row = h.db.fetchone<{ realized_pnl: number }>(
    "SELECT realized_pnl FROM positions WHERE user_id = ? AND symbol = 'BREW'",
    ['14'],
  );
  assert.equal(Number(row!.realized_pnl), fill.realizedPnl);
  h.close();
});

// --------------------------------------------------------------------- shorts

test('short posts collateral and creates a position', () => {
  const h = makeHarness();
  h.fund('20');
  const before = wallet(h, '20');
  const fill = h.trading.short('20', GUILD, 'NOVA', 5);

  const short = h.trading.getShort('20', GUILD, 'NOVA');
  assert.ok(short);
  assert.equal(short.quantity, 5);
  assert.ok(short.collateral > 0);
  // Collateral plus commission leaves the wallet.
  assert.equal(wallet(h, '20'), before - short.collateral - fill.commission);
  h.close();
});

test('short requires enough collateral', () => {
  const h = makeHarness();
  h.fund('21', 100);
  const company = h.market.getCompany(GUILD, 'NOVA')!;
  const needed = h.trading.requiredCollateral(company, 5);
  assert.throws(() => h.trading.short('21', GUILD, 'NOVA', 5), InsufficientCollateral);
  assert.ok(needed > 100);
  h.close();
});

test('cover returns collateral and realizes pnl', () => {
  const h = makeHarness();
  h.fund('22');
  h.trading.short('22', GUILD, 'NOVA', 5);
  const short = h.trading.getShort('22', GUILD, 'NOVA')!;
  const { collateral } = short;
  const before = wallet(h, '22');
  const fill = h.trading.cover('22', GUILD, 'NOVA', 5);
  const after = wallet(h, '22');

  assert.equal(h.trading.getShort('22', GUILD, 'NOVA'), undefined);
  assert.ok(after > before);
  // The posted collateral comes back, adjusted by the trade's profit or loss.
  assert.equal(after, before + collateral + fill.realizedPnl);
  h.close();
});

test('covering more than shorted raises', () => {
  const h = makeHarness();
  h.fund('23');
  h.trading.short('23', GUILD, 'NOVA', 2);
  assert.throws(() => h.trading.cover('23', GUILD, 'NOVA', 3), InsufficientShares);
  h.close();
});

test('short profits when the price falls', () => {
  const h = makeHarness();
  h.fund('24');
  h.trading.short('24', GUILD, 'NOVA', 10);
  h.market.getCompany(GUILD, 'NOVA')!.price *= 0.5;
  assert.ok(h.trading.getShort('24', GUILD, 'NOVA')!.unrealizedPnl > 0);
  h.close();
});

// --------------------------------------------------------------- limit orders

test('a limit order reserves cash and fills when triggered', () => {
  const h = makeHarness();
  h.fund('30');
  const company = h.market.getCompany(GUILD, 'NOVA')!;
  const before = wallet(h, '30');
  // A limit far above market triggers immediately on the next processing pass.
  const orderId = h.trading.placeLimitOrder('30', GUILD, 'NOVA', 'buy', 2, company.price * 1.5);
  assert.ok(wallet(h, '30') < before);

  const fills = h.trading.processOpenOrders(GUILD);
  assert.equal(fills.length, 1);
  const [userId, fill] = fills[0];
  assert.equal(userId, '30');
  assert.equal(fill.side, 'buy');
  assert.equal(h.trading.getPosition('30', GUILD, 'NOVA')!.quantity, 2);
  const row = h.db.fetchone<{ status: string }>('SELECT status FROM orders WHERE id = ?', [orderId]);
  assert.equal(row!.status, 'filled');
  h.close();
});

test('a limit order that does not trigger stays open', () => {
  const h = makeHarness();
  h.fund('31');
  const company = h.market.getCompany(GUILD, 'NOVA')!;
  const orderId = h.trading.placeLimitOrder('31', GUILD, 'NOVA', 'buy', 2, company.price * 0.5);
  assert.deepEqual(h.trading.processOpenOrders(GUILD), []);
  const row = h.db.fetchone<{ status: string }>('SELECT status FROM orders WHERE id = ?', [orderId]);
  assert.equal(row!.status, 'open');
  h.close();
});

test('cancelling an order refunds the reservation', () => {
  const h = makeHarness();
  h.fund('32');
  const company = h.market.getCompany(GUILD, 'NOVA')!;
  const before = wallet(h, '32');
  const orderId = h.trading.placeLimitOrder('32', GUILD, 'NOVA', 'buy', 2, company.price * 0.5);
  assert.ok(wallet(h, '32') < before);
  assert.equal(h.trading.cancelOrder('32', GUILD, orderId), true);
  assert.equal(wallet(h, '32'), before);
  h.close();
});

test('an expired order is cancelled and refunded', () => {
  const h = makeHarness();
  h.fund('33');
  const company = h.market.getCompany(GUILD, 'NOVA')!;
  const before = wallet(h, '33');
  const orderId = h.trading.placeLimitOrder('33', GUILD, 'NOVA', 'buy', 2, company.price * 0.5);
  // Advance well past the expiry horizon without triggering the order.
  const engine = h.market.getEngine(GUILD);
  engine.tick += h.trading.config.limitOrderExpiryTicks + 5;

  h.trading.processOpenOrders(GUILD);
  const row = h.db.fetchone<{ status: string }>('SELECT status FROM orders WHERE id = ?', [orderId]);
  assert.equal(row!.status, 'expired');
  assert.equal(wallet(h, '33'), before);
  h.close();
});

test('orders are isolated per user', () => {
  const h = makeHarness();
  h.fund('34');
  h.fund('35');
  const company = h.market.getCompany(GUILD, 'NOVA')!;
  h.trading.placeLimitOrder('34', GUILD, 'NOVA', 'buy', 1, company.price * 0.5);
  assert.equal(h.trading.openOrders('34', GUILD).length, 1);
  assert.deepEqual(h.trading.openOrders('35', GUILD), []);
  assert.equal(h.trading.cancelOrder('35', GUILD, 1), false);
  h.close();
});

test('a limit order requires a valid side', () => {
  const h = makeHarness();
  h.fund('36');
  assert.throws(
    () => h.trading.placeLimitOrder('36', GUILD, 'NOVA', 'yolo' as never, 1, 100),
    InvalidOrder,
  );
  h.close();
});

// --------------------------------------------------------------------- alerts

test('an alert triggers once when the price crosses', () => {
  const h = makeHarness();
  h.fund('40');
  const company = h.market.getCompany(GUILD, 'NOVA')!;
  h.trading.createAlert('40', GUILD, 'NOVA', 'above', company.price * 0.9);
  const hits = h.trading.triggeredAlerts(GUILD);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].userId, '40');
  // Deactivated after firing.
  assert.deepEqual(h.trading.triggeredAlerts(GUILD), []);
  h.close();
});

test('an alert does not trigger before the threshold', () => {
  const h = makeHarness();
  h.fund('41');
  const company = h.market.getCompany(GUILD, 'NOVA')!;
  h.trading.createAlert('41', GUILD, 'NOVA', 'above', company.price * 10);
  assert.deepEqual(h.trading.triggeredAlerts(GUILD), []);
  h.close();
});

test('alert below direction', () => {
  const h = makeHarness();
  h.fund('42');
  const company = h.market.getCompany(GUILD, 'NOVA')!;
  h.trading.createAlert('42', GUILD, 'NOVA', 'below', company.price * 1.1);
  const hits = h.trading.triggeredAlerts(GUILD);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].direction, 'below');
  h.close();
});

test('an alert rejects a bad direction', () => {
  const h = makeHarness();
  h.fund('43');
  assert.throws(
    () => h.trading.createAlert('43', GUILD, 'NOVA', 'sideways' as never, 10),
    InvalidOrder,
  );
  h.close();
});

test('delete alert', () => {
  const h = makeHarness();
  h.fund('44');
  const alertId = h.trading.createAlert('44', GUILD, 'NOVA', 'above', 1_000_000);
  assert.equal(h.trading.deleteAlert('44', GUILD, alertId), true);
  assert.deepEqual(h.trading.listAlerts('44', GUILD), []);
  assert.equal(h.trading.deleteAlert('45', GUILD, alertId), false);
  h.close();
});

// ------------------------------------------------------------------ watchlist

test('watchlist add and remove', () => {
  const h = makeHarness();
  h.fund('50');
  assert.equal(h.trading.addWatch('50', GUILD, 'NOVA'), true);
  assert.equal(h.trading.addWatch('50', GUILD, 'NOVA'), false); // duplicate
  assert.equal(h.trading.addWatch('50', GUILD, 'terrafirma'), true);
  assert.deepEqual(h.trading.watchlist('50', GUILD), ['NOVA', 'TERA']);
  assert.equal(h.trading.removeWatch('50', GUILD, 'NOVA'), true);
  assert.equal(h.trading.removeWatch('50', GUILD, 'NOVA'), false);
  assert.deepEqual(h.trading.watchlist('50', GUILD), ['TERA']);
  h.close();
});

test('the watchlist rejects an unknown symbol', () => {
  const h = makeHarness();
  h.fund('51');
  assert.throws(() => h.trading.addWatch('51', GUILD, 'NOPE'), UnknownSymbol);
  h.close();
});

// ------------------------------------------------------------------ portfolio

test('portfolio reports cash, positions and pnl', () => {
  const h = makeHarness();
  h.fund('60');
  h.trading.buy('60', GUILD, 'NOVA', 3);
  h.trading.short('60', GUILD, 'TERA', 2);
  const portfolio = h.trading.getPortfolio('60', GUILD);
  assert.equal(portfolio.positions.length, 1);
  assert.equal(portfolio.shorts.length, 1);
  assert.equal(portfolio.positions[0].symbol, 'NOVA');
  assert.equal(portfolio.shorts[0].symbol, 'TERA');
  assert.ok(portfolio.longValue > 0);
  assert.ok(portfolio.shortValue > 0);
  assert.ok(portfolio.collateral > 0);
  assert.ok(portfolio.netWorth > 0);
  h.close();
});

test('net worth tracks the cash balance for an all-cash account', () => {
  const h = makeHarness();
  h.fund('61', 1_000);
  const portfolio = h.trading.getPortfolio('61', GUILD);
  assert.deepEqual(portfolio.positions, []);
  assert.deepEqual(portfolio.shorts, []);
  approx(portfolio.netWorth, portfolio.wallet + portfolio.bank);
  h.close();
});

test('a position gains value when the price rises', () => {
  const h = makeHarness();
  h.fund('62');
  h.trading.buy('62', GUILD, 'NOVA', 5);
  h.market.getCompany(GUILD, 'NOVA')!.price *= 2;
  const position = h.trading.getPosition('62', GUILD, 'NOVA')!;
  assert.ok(position.unrealizedPnl > 0);
  assert.ok(position.unrealizedPct > 0);
  h.close();
});

// --------------------------------------------------------------- dividends/risk

test('dividends are paid to long holders', () => {
  const h = makeHarness();
  h.fund('70');
  h.trading.buy('70', GUILD, 'BREW', 100);
  const before = wallet(h, '70');
  const payouts = h.trading.applyDividends(GUILD, { BREW: 0.5 });
  approx(payouts['70'] ?? 0, 50.0);
  assert.equal(wallet(h, '70'), before + 50);
  h.close();
});

test('dividends skip non-holders', () => {
  const h = makeHarness();
  h.fund('71');
  const payouts = h.trading.applyDividends(GUILD, { BREW: 0.5 });
  assert.equal('71' in payouts, false);
  h.close();
});

test('a margin call fires when a short goes badly wrong', () => {
  const h = makeHarness();
  h.fund('72');
  h.trading.short('72', GUILD, 'NOVA', 10);
  h.market.getCompany(GUILD, 'NOVA')!.price *= 3; // a squeeze
  const calls = h.trading.marginCalls(GUILD);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, '72');
  assert.equal(calls[0].symbol, 'NOVA');
  h.close();
});

test('no margin call for a healthy short', () => {
  const h = makeHarness();
  h.fund('73');
  h.trading.short('73', GUILD, 'NOVA', 5);
  assert.deepEqual(h.trading.marginCalls(GUILD), []);
  h.close();
});

test('the trader leaderboard ranks by net worth', () => {
  const h = makeHarness();
  h.fund('80', 1_000);
  h.fund('81', 9_000);
  const ranked = new Map(h.trading.leaderboard(GUILD, 5).map((row) => [row.userId, row.netWorth]));
  assert.ok(ranked.get('81')! > ranked.get('80')!);
  h.close();
});

// ------------------------------------------------------------------- ledger

test('every trade is journalled', () => {
  const h = makeHarness();
  h.fund('90');
  h.trading.buy('90', GUILD, 'NOVA', 2);
  h.trading.sell('90', GUILD, 'NOVA', 2);
  h.trading.short('90', GUILD, 'TERA', 1);
  h.trading.cover('90', GUILD, 'TERA', 1);
  const kinds = new Set(h.economy.history('90', GUILD, 50).map((row) => row.kind));
  for (const expected of ['stock_buy', 'stock_sell', 'short_open', 'short_cover']) {
    assert.ok(kinds.has(expected), `missing ${expected}`);
  }
  h.close();
});

test('the wallet matches the sum of its transactions', () => {
  // The ledger must reconcile with the live balance after a busy session.
  const h = makeHarness();
  h.fund('91', 100_000);
  h.trading.buy('91', GUILD, 'BREW', 10);
  h.trading.sell('91', GUILD, 'BREW', 4);
  h.trading.short('91', GUILD, 'TERA', 3);
  h.trading.cover('91', GUILD, 'TERA', 3);

  const account = h.economy.getAccount('91', GUILD);
  // Wallet movements only: bank transfers are net-zero on the wallet.
  const rows = h.db.fetchall<{ amount: number; kind: string }>(
    "SELECT kind, amount FROM transactions WHERE user_id = ? AND guild_id = ? AND kind NOT IN ('deposit', 'withdraw')",
    ['91', GUILD],
  );
  const expected = rows.reduce((sum, row) => sum + Number(row.amount), 0);
  assert.equal(account.wallet, expected);
  h.close();
});
