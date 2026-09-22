/**
 * Parsers for user-supplied quantities and prices.
 *
 * Discord users type things like ``5``, ``0.5``, ``10k``, ``2.5m``, ``all``,
 * ``half`` or a dollar amount like ``$50``. Centralising the parsing keeps every
 * command consistent and keeps the error messages identical across the bot.
 */
import { InvalidOrder } from './errors';

const SUFFIXES: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
const NUMBER = /^(\d+(?:\.\d+)?)\s*([kmb])?$/;

/**
 * Parse a share quantity. Fractional values are accepted, so ``0.5`` means half
 * a share. ``all``/``max``/``half`` still resolve against the supplied maximum.
 */
export function parseAmount(raw: string, maximum?: number): number {
  const text = raw.trim().toLowerCase().replace(/[,_]/g, '');
  if (!text) throw new InvalidOrder('Quantity is required.');

  if (text === 'all' || text === 'max') {
    if (maximum === undefined) throw new InvalidOrder("'all' is not valid here \u2014 give a number.");
    return maximum;
  }
  if (text === 'half' || text === '1/2') {
    if (maximum === undefined) throw new InvalidOrder("'half' is not valid here \u2014 give a number.");
    return maximum / 2;
  }

  const match = NUMBER.exec(text);
  if (match === null) {
    throw new InvalidOrder(`'${raw}' is not a valid quantity. Try 10, 0.5, 25k or all.`);
  }
  const value = Number.parseFloat(match[1]) * (SUFFIXES[match[2] ?? ''] ?? 1);
  if (value <= 0) throw new InvalidOrder('Quantity must be greater than zero.');
  return value;
}

export interface OrderSize {
  /** Shares to trade, when the order was sized in shares. */
  quantity?: number;
  /** Credits to spend, when the order was sized with a ``$`` amount. */
  value?: number;
}

/**
 * Interpret an order-size argument.
 *
 * A leading ``$`` means the user is naming a currency amount -- the Cash App
 * "buy $50 of stock" form -- and the caller converts it to shares at the live
 * price. Anything else is a share count, which may be fractional.
 */
export function parseOrderSize(raw: string, maximum?: number): OrderSize {
  const text = raw.trim().toLowerCase().replace(/[,_]/g, '');
  if (!text) throw new InvalidOrder('Quantity is required.');
  if (text.startsWith('$')) return { value: parsePrice(text.slice(1)) };
  return { quantity: parseAmount(text, maximum) };
}

export function parsePrice(raw: string): number {
  const text = raw.trim().toLowerCase().replace(/[,_$]/g, '');
  if (!text) throw new InvalidOrder('A price is required.');
  const match = NUMBER.exec(text);
  if (match === null) throw new InvalidOrder(`'${raw}' is not a valid price.`);
  const value = Number.parseFloat(match[1]) * (SUFFIXES[match[2] ?? ''] ?? 1);
  if (value <= 0) throw new InvalidOrder('Price must be greater than zero.');
  return value;
}
