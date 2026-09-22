/** Tests for the quantity/price parsers and the display formatters. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { InvalidOrder } from '../hera/errors';
import { compact, duration, money, percent, price, progressBar, signed } from '../hera/formatting';
import { parseAmount, parsePrice } from '../hera/parsing';

const amountCases: [string, number][] = [
  ['10', 10],
  ['1,000', 1000],
  ['5k', 5000],
  ['2.5m', 2_500_000],
  ['1b', 1_000_000_000],
  ['  42  ', 42],
];

for (const [raw, expected] of amountCases) {
  test(`parseAmount accepts ${JSON.stringify(raw)}`, () => {
    assert.equal(parseAmount(raw), expected);
  });
}

test('parseAmount supports all and half', () => {
  assert.equal(parseAmount('all', 100), 100);
  assert.equal(parseAmount('half', 101), 50);
  assert.equal(parseAmount('max', 7), 7);
});

for (const raw of ['', 'abc', '1.2.3', '--5', '5x']) {
  test(`parseAmount rejects ${JSON.stringify(raw)}`, () => {
    assert.throws(() => parseAmount(raw), InvalidOrder);
  });
}

test('parseAmount rejects zero', () => {
  assert.throws(() => parseAmount('0'), InvalidOrder);
});

test('parseAmount needs a maximum for all', () => {
  assert.throws(() => parseAmount('all'), InvalidOrder);
});

const priceCases: [string, number][] = [
  ['100', 100.0],
  ['1,250.50', 1250.5],
  ['2k', 2000.0],
];

for (const [raw, expected] of priceCases) {
  test(`parsePrice accepts ${JSON.stringify(raw)}`, () => {
    assert.equal(parsePrice(raw), expected);
  });
}

for (const raw of ['', 'free', '-1', '0']) {
  test(`parsePrice rejects ${JSON.stringify(raw)}`, () => {
    assert.throws(() => parsePrice(raw), InvalidOrder);
  });
}

test('money formats with the currency symbol', () => {
  assert.ok(money(1234.5).includes('1,234.50'));
  assert.ok(money(1000).startsWith('\u{1FA99}'));
});

test('price adapts precision to magnitude', () => {
  assert.equal(price(0.5), '0.5000');
  assert.equal(price(12.5), '12.500');
  assert.equal(price(1234.5), '1,234.50');
});

test('signed always shows a sign', () => {
  assert.ok(signed(10).startsWith('+'));
  assert.ok(signed(-10).startsWith('-'));
});

test('percent renders two decimals', () => {
  assert.equal(percent(1.234), '+1.23%');
  assert.equal(percent(-1.234), '-1.23%');
  assert.equal(percent(5.0, { signedOutput: false }), '5.00%');
});

test('compact abbreviates large numbers', () => {
  assert.equal(compact(1_500), '1.50K');
  assert.equal(compact(2_500_000), '2.50M');
  assert.equal(compact(3_000_000_000), '3.00B');
  assert.equal(compact(999), '999');
});

test('duration formats each scale', () => {
  assert.equal(duration(45), '45s');
  assert.equal(duration(90), '1m 30s');
  assert.equal(duration(3661), '1h 01m 01s');
  assert.equal(duration(-5), '0s');
});

test('progress bar is bounded', () => {
  assert.equal(progressBar(0, 100, 10).length, 10);
  assert.equal((progressBar(0, 100, 10).match(/\u2588/g) ?? []).length, 0);
  assert.equal((progressBar(100, 100, 10).match(/\u2588/g) ?? []).length, 10);
  assert.equal(progressBar(50, 0, 4), '\u2591\u2591\u2591\u2591');
});
