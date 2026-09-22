/**
 * Market-moving events: sector shocks, earnings surprises and scandals.
 *
 * Events are the main source of non-random movement. Each active event applies a
 * per-tick pull to a company's price for a bounded number of ticks, so a headline
 * produces a visible trend rather than a single instantaneous jump.
 */
import type { Random } from './random';

export interface EventTemplate {
  key: string;
  headline: string;
  /** Per-tick drift contribution while the event is active (signed). */
  magnitude: number;
  weight: number;
  sectorWide: boolean;
  good: boolean;
}

function template(
  key: string,
  headline: string,
  magnitude: number,
  weight = 1.0,
  sectorWide = false,
  good = true,
): EventTemplate {
  return { key, headline, magnitude, weight, sectorWide, good };
}

export const EVENT_TEMPLATES: EventTemplate[] = [
  template('earnings_beat', '{name} smashes quarterly estimates', 0.016, 1.4),
  template('earnings_miss', '{name} misses revenue guidance', -0.017, 1.4, false, false),
  template('upgrade', 'Analysts upgrade {symbol} to outperform', 0.01, 1.2),
  template('downgrade', 'Analysts downgrade {symbol} on valuation concerns', -0.011, 1.2, false, false),
  template('contract', '{name} lands a multi-year government contract', 0.013, 1.0),
  template('recall', '{name} recalls a flagship product line', -0.019, 1.0, false, false),
  template('buyback', '{name} announces a share buyback programme', 0.012, 0.9),
  template('lawsuit', '{name} faces a class-action lawsuit', -0.014, 0.9, false, false),
  template('breakthrough', '{name} publishes a breakthrough trial result', 0.022, 0.7),
  template('breach', '{name} discloses a customer data breach', -0.021, 0.7, false, false),
  template('ceo_exit', "Shock resignation of {name}'s chief executive", -0.013, 0.8, false, false),
  template('merger', 'Rumours swirl around a {name} takeover', 0.02, 0.6),
  template('regulation', 'Regulators open a probe into {name}', -0.016, 0.7, false, false),
  template('expansion', '{name} opens operations in two new markets', 0.009, 1.1),
  template('supply', 'Supply constraints squeeze {name} margins', -0.012, 0.9, false, false),
  template('dividend_hike', '{name} raises its dividend payout', 0.008, 0.8),
];

export const SECTOR_TEMPLATES: EventTemplate[] = [
  template('sector_rally', 'Broad rally lifts the {sector} sector', 0.009, 1.0, true),
  template('sector_selloff', 'Selloff sweeps the {sector} sector', -0.01, 1.0, true, false),
  template('sector_tariff', 'New tariffs hit {sector} importers', -0.011, 0.9, true, false),
  template('sector_subsidy', 'Subsidy package boosts {sector} names', 0.01, 0.9, true),
];

/**
 * Choose a company-specific event, biased toward headline-worthy ones.
 *
 * ``rng`` is passed in rather than using a shared generator so a seeded engine
 * replays exactly.
 */
export function pickEvent(_sector: string, rng: Random): EventTemplate {
  const weights = EVENT_TEMPLATES.map((item) => item.weight);
  return rng.choices(EVENT_TEMPLATES, weights);
}

export function pickSectorEvent(_sector: string, rng: Random): EventTemplate {
  return rng.choice(SECTOR_TEMPLATES);
}

export function renderHeadline(
  event: EventTemplate,
  values: { symbol: string; name: string; sector: string },
): string {
  return event.headline
    .replace(/\{symbol\}/g, values.symbol)
    .replace(/\{name\}/g, values.name)
    .replace(/\{sector\}/g, values.sector);
}
