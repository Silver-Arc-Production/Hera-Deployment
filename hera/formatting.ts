/** Shared formatting helpers for money, percentages and durations. */
import { config } from './config';

function group(value: number, decimals: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format a credit amount, e.g. ``🪙 1,234.50``. */
export function money(amount: number, opts: { symbol?: boolean; decimals?: number } = {}): string {
  const { symbol = true, decimals = 2 } = opts;
  const prefix = symbol ? `${config.currencySymbol} ` : '';
  return `${prefix}${group(amount, decimals)}`;
}

/** Format a share price with adaptive precision for penny stocks. */
export function price(amount: number): string {
  if (amount < 1) return group(amount, 4);
  if (amount < 100) return group(amount, 3);
  return group(amount, 2);
}

/** Format a share count, which may be fractional, trimming trailing zeroes. */
export function shares(quantity: number): string {
  const trimmed = Math.round(quantity * 1e6) / 1e6;
  return trimmed.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/** Format a value with an explicit +/- sign. */
export function signed(
  amount: number,
  opts: { decimals?: number; symbol?: boolean } = {},
): string {
  const { decimals = 2, symbol = true } = opts;
  const prefix = symbol ? `${config.currencySymbol} ` : '';
  const sign = amount >= 0 ? '+' : '-';
  return `${sign}${prefix}${group(Math.abs(amount), decimals)}`;
}

export function percent(
  value: number,
  opts: { decimals?: number; signedOutput?: boolean } = {},
): string {
  const { decimals = 2, signedOutput = true } = opts;
  const sign = value >= 0 && signedOutput ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

/** Abbreviate large numbers: 1.23M, 4.56B, 7.89T. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [threshold, suffix] of units) {
    if (abs >= threshold) return `${group(value / threshold, 2)}${suffix}`;
  }
  return group(value, 0);
}

export function arrow(change: number): string {
  if (change > 0) return '\u{1F7E2}';
  if (change < 0) return '\u{1F534}';
  return '\u26AA';
}

/** Human-readable countdown, e.g. ``1h 04m 09s``. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(total / 3600);
  const remainder = total % 3600;
  const minutes = Math.floor(remainder / 60);
  const secs = remainder % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hours) return `${hours}h ${pad(minutes)}m ${pad(secs)}s`;
  if (minutes) return `${minutes}m ${pad(secs)}s`;
  return `${secs}s`;
}

export function progressBar(current: number, total: number, width = 12): string {
  if (total <= 0) return '\u2591'.repeat(width);
  const filled = Math.floor(Math.max(0, Math.min(1, current / total)) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}
