/**
 * Parsers for user-supplied quantities and prices.
 *
 * Discord users type things like ``5``, ``10k``, ``2.5m``, ``all`` or ``half``.
 * Centralising the parsing keeps every command consistent and keeps the error
 * messages identical across the bot.
 */
import { InvalidOrder } from './errors';

const SUFFIXES: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
const NUMBER = /^(\d+(?:\.\d+)?)\s*([kmb])?$/;

export function parseAmount(raw: string, maximum?: number): number {
  const text = raw.trim().toLowerCase().replace(/[,_]/g, '');
  if (!text) throw new InvalidOrder('Quantity is required.');

  if (text === 'all' || text === 'max') {
    if (maximum === undefined) throw new InvalidOrder("'all' is not valid here \u2014 give a number.");
    return Math.trunc(maximum);
  }
  if (text === 'half' || text === '1/2') {
    if (maximum === undefined) throw new InvalidOrder("'half' is not valid here \u2014 give a number.");
    return Math.trunc(maximum / 2);
  }

  const match = NUMBER.exec(text);
  if (match === null) {
    throw new InvalidOrder(`'${raw}' is not a valid quantity. Try 10, 25k or all.`);
  }
  const value = Number.parseFloat(match[1]) * (SUFFIXES[match[2] ?? ''] ?? 1);
  if (value <= 0) throw new InvalidOrder('Quantity must be greater than zero.');
  return Math.trunc(value);
}

export function parsePrice(raw: string): number {
  const text = raw.trim().toLowerCase().replace(/[,_]/g, '');
  if (!text) throw new InvalidOrder('A price is required.');
  const match = NUMBER.exec(text);
  if (match === null) throw new InvalidOrder(`'${raw}' is not a valid price.`);
  const value = Number.parseFloat(match[1]) * (SUFFIXES[match[2] ?? ''] ?? 1);
  if (value <= 0) throw new InvalidOrder('Price must be greater than zero.');
  return value;
}
