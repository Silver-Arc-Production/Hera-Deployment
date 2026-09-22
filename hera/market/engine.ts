/**
 * The price simulation engine.
 *
 * Design notes
 * ------------
 * The engine is deliberately pure: it owns no database connection and takes an
 * injected :class:`Random`, so the exact same tick sequence can be replayed in
 * tests.
 *
 * Prices follow a geometric random walk with three extra forces on top:
 *
 * 1. **Mean reversion** toward a slowly drifting fair value. Without this, a
 *    positive drift compounds without bound over a long-running bot. The pull is
 *    weak (a ~14 hour half-life at the default 5-minute tick) so news-driven
 *    trends still get room to run.
 * 2. **Events.** Sector or company headlines apply a signed per-tick pull for a
 *    bounded number of ticks, producing a trend rather than a single jump.
 * 3. **Regime.** A market-wide bull/bear/neutral state scales every company's
 *    move by its beta.
 *
 * The market never closes and never halts: there are no trading sessions and no
 * circuit breakers, so a listing can be bought or sold at any time at whatever
 * the current price happens to be.
 *
 * Company ``volatility`` and ``drift`` are expressed as *daily* figures and are
 * normalised by the number of ticks in a day, so changing ``STOCK_TICK_SECONDS``
 * does not change the market's character.
 */
import type { MarketConfig } from '../config';
import { COMPANIES, SECTOR_BETA, type CompanySeed } from './companies';
import { pickEvent, pickSectorEvent, renderHeadline } from './events';
import { Random } from './random';

export const REGIMES = ['bull', 'neutral', 'bear'] as const;
export type Regime = (typeof REGIMES)[number];

export const REGIME_MULTIPLIER: Record<Regime, number> = {
  bull: 0.75,
  neutral: 0.0,
  bear: -0.75,
};
export const REGIME_VOL_MULTIPLIER: Record<Regime, number> = {
  bull: 0.9,
  neutral: 1.0,
  bear: 1.35,
};

export class CompanyState {
  symbol: string;
  name: string;
  sector: string;
  description: string;
  price: number;
  previousClose: number;
  openPrice: number;
  dayHigh: number;
  dayLow: number;
  fairValue: number;
  volatility: number;
  drift: number;
  beta: number;
  sharesOutstanding: number;
  dividendYield: number;
  activeEvent: string | null = null;
  eventTicksLeft = 0;
  eventMagnitude = 0.0;
  lastDividendTick = 0;

  constructor(seed: CompanySeed) {
    this.symbol = seed.symbol;
    this.name = seed.name;
    this.sector = seed.sector;
    this.description = seed.description;
    this.price = seed.price;
    this.previousClose = seed.price;
    this.openPrice = seed.price;
    this.dayHigh = seed.price;
    this.dayLow = seed.price;
    this.fairValue = seed.price;
    this.volatility = seed.volatility;
    this.drift = seed.drift;
    this.beta = seed.beta;
    this.sharesOutstanding = seed.sharesOutstanding;
    this.dividendYield = seed.dividendYield ?? 0.0;
  }

  static fromSeed(seed: CompanySeed): CompanyState {
    return new CompanyState(seed);
  }

  get marketCap(): number {
    return this.price * this.sharesOutstanding;
  }

  get dayChangeFraction(): number {
    if (this.previousClose === 0) return 0.0;
    return (this.price - this.previousClose) / this.previousClose;
  }
}

export interface NewsItem {
  symbol: string | null;
  headline: string;
  impact: number;
  sector?: string | null;
}

export class TickResult {
  tick = 0;
  indexValue = 0;
  indexChange = 0;
  regime: Regime = 'neutral';
  news: NewsItem[] = [];
  dividends: Record<string, number> = {};
  movers: [string, number][] = [];
}

export class MarketEngine {
  readonly companies: Record<string, CompanyState> = {};
  tick = 0;
  regime: Regime = 'neutral';
  regimeTicksLeft: number;
  indexValue: number;
  previousIndex: number;
  /** @internal */
  _initialMarketCap: number;
  private readonly rng: Random;
  private readonly ticksPerDay: number;
  private readonly tickScale: number;
  /**
   * Company drift values are per-day figures. This multiplier is the economy's
   * growth dial and is tuned so a 30-day run trends mildly upward. It is
   * deliberately not larger: volatility drag (the bear regime carries a higher
   * vol multiplier) pulls the index down, so there is a tipping point above
   * which the market inflates without bound and below which it bleeds out.
   */
  private readonly driftMultiplier = 15.0;

  constructor(
    public readonly config: MarketConfig,
    options: { seeds?: CompanySeed[]; rng?: Random } = {},
  ) {
    this.rng = options.rng ?? new Random();
    const seeds = options.seeds ?? COMPANIES;
    for (const seed of seeds) this.companies[seed.symbol] = CompanyState.fromSeed(seed);
    this.regimeTicksLeft = this.nextRegimeLength();
    this.indexValue = config.startingIndex;
    this.previousIndex = config.startingIndex;
    this._initialMarketCap =
      Object.values(this.companies).reduce((sum, c) => sum + c.marketCap, 0) || 1.0;

    this.ticksPerDay = Math.max(1.0, 86_400 / this.config.tickSeconds);
    this.tickScale = 300.0 / this.config.tickSeconds;
  }

  // ------------------------------------------------------------------ setup

  private nextRegimeLength(): number {
    return this.rng.randint(this.config.regimeMinTicks, this.config.regimeMaxTicks);
  }

  /** Restore a persisted market so restarts do not reset prices. */
  loadState(state: {
    tick: number;
    regime: string;
    regimeTicksLeft: number;
    indexValue: number;
    previousIndex: number;
    companies: Record<string, CompanyState>;
  }): void {
    this.tick = state.tick;
    this.regime = (REGIMES as readonly string[]).includes(state.regime)
      ? (state.regime as Regime)
      : 'neutral';
    this.regimeTicksLeft = state.regimeTicksLeft;
    this.indexValue = state.indexValue;
    this.previousIndex = state.previousIndex;
    for (const [symbol, company] of Object.entries(state.companies)) {
      if (symbol in this.companies) this.companies[symbol] = company;
    }
    this._initialMarketCap =
      Object.values(this.companies).reduce((sum, c) => sum + c.marketCap, 0) || 1.0;
  }

  // ------------------------------------------------------------------- tick

  /**
   * Advance one tick and return everything that happened.
   *
   * When ``newDay`` is omitted the rollover is derived from ``sessionTicks`` so
   * callers do not have to track it.
   */
  advance(options: { newDay?: boolean } = {}): TickResult {
    this.tick += 1;
    let newDay = options.newDay;
    if (newDay === undefined) newDay = this.tick % Math.max(1, this.config.sessionTicks) === 0;
    this.previousIndex = this.indexValue;
    const news: NewsItem[] = [];
    const dividends: Record<string, number> = {};

    this.maybeRotateRegime();
    const sectorEvents = this.maybeSectorEvents(news);

    for (const symbol of Object.keys(this.companies).sort()) {
      const state = this.companies[symbol];

      if (newDay) {
        state.previousClose = state.price;
        state.openPrice = state.price;
        state.dayHigh = state.price;
        state.dayLow = state.price;
      }

      const sectorTemplate = sectorEvents[symbol];
      if (sectorTemplate) {
        state.eventMagnitude += sectorTemplate.magnitude * this.tickScale;
        state.eventTicksLeft = Math.max(state.eventTicksLeft, this.rng.randint(2, 6));
        state.activeEvent = sectorTemplate.key;
      }

      this.maybeStartCompanyEvent(state, news);
      this.maybePayDividend(state, dividends);

      this.movePrice(state);
    }

    this.indexValue = this.computeIndex();
    const movers = Object.entries(this.companies)
      .map(([symbol, company]): [string, number] => [symbol, company.dayChangeFraction])
      .sort((a, b) => b[1] - a[1]);

    const result = new TickResult();
    result.tick = this.tick;
    result.indexValue = this.indexValue;
    result.indexChange =
      this.previousIndex === 0 ? 0.0 : (this.indexValue - this.previousIndex) / this.previousIndex;
    result.regime = this.regime;
    result.news = news;
    result.dividends = dividends;
    result.movers = movers;
    return result;
  }

  // --------------------------------------------------------------- internals

  private maybeRotateRegime(): void {
    this.regimeTicksLeft -= 1;
    if (this.regimeTicksLeft > 0) return;
    const choices = REGIMES.filter((regime) => regime !== this.regime);
    // Neutral is the most likely state; bulls and bears alternate around it.
    const weights = choices.map((regime) => (regime === 'neutral' ? 1.0 : 0.55));
    this.regime = this.rng.choices(choices, weights);
    this.regimeTicksLeft = this.nextRegimeLength();
  }

  private maybeSectorEvents(news: NewsItem[]): Record<string, import('./events').EventTemplate> {
    if (this.rng.random() >= 0.05) return {};
    const sectors = [...new Set(Object.values(this.companies).map((c) => c.sector))].sort();
    const sector = this.rng.choice(sectors);
    const template = pickSectorEvent(sector, this.rng);
    const headline = renderHeadline(template, { symbol: '', name: '', sector });
    news.push({ symbol: null, headline, impact: template.magnitude, sector });
    const members = Object.values(this.companies).filter((c) => c.sector === sector);
    const events: Record<string, import('./events').EventTemplate> = {};
    for (const member of members) events[member.symbol] = template;
    return events;
  }

  private maybeStartCompanyEvent(state: CompanyState, news: NewsItem[]): void {
    if (state.eventTicksLeft > 0) return;
    if (this.rng.random() >= this.config.eventChance) return;
    const template = pickEvent(state.sector, this.rng);
    state.activeEvent = template.key;
    state.eventMagnitude = template.magnitude * this.tickScale;
    state.eventTicksLeft = this.rng.randint(this.config.eventTicksMin, this.config.eventTicksMax);
    const headline = renderHeadline(template, {
      symbol: state.symbol,
      name: state.name,
      sector: state.sector,
    });
    news.push({ symbol: state.symbol, headline, impact: template.magnitude });
  }

  private maybePayDividend(state: CompanyState, dividends: Record<string, number>): void {
    if (state.dividendYield <= 0) return;
    if (this.tick - state.lastDividendTick < this.config.dividendTickInterval) return;
    if (state.lastDividendTick === 0) {
      // Stagger the first payout so every payer does not go ex-div together.
      state.lastDividendTick =
        this.tick - this.rng.randint(0, this.config.dividendTickInterval - 1);
      return;
    }
    state.lastDividendTick = this.tick;
    const perShare =
      (state.price * state.dividendYield) /
      (this.ticksPerDay / this.config.dividendTickInterval);
    dividends[state.symbol] = perShare;
    // Shares trade lower by the payout on the ex-dividend tick.
    state.price = Math.max(this.config.minPrice, state.price - perShare);
    state.fairValue = Math.max(this.config.minPrice, state.fairValue - perShare);
  }

  private movePrice(state: CompanyState): void {
    const perTickVol = state.volatility / Math.sqrt(this.ticksPerDay);
    const perTickDrift = (state.drift * this.driftMultiplier) / this.ticksPerDay;

    const regimeComponent = REGIME_MULTIPLIER[this.regime] * perTickVol * state.beta * 0.6;
    const reversion =
      this.config.meanReversion *
      Math.log(Math.max(state.fairValue, 1e-6) / Math.max(state.price, 1e-6));

    let eventComponent = 0.0;
    if (state.eventTicksLeft > 0) {
      // Events decay toward the end so the price settles rather than snaps back.
      const decay = 0.6 + 0.4 * (state.eventTicksLeft / Math.max(1, this.config.eventTicksMax));
      eventComponent = state.eventMagnitude * decay;
      state.eventTicksLeft -= 1;
      if (state.eventTicksLeft <= 0) {
        state.activeEvent = null;
        state.eventMagnitude = 0.0;
      }
    }

    const shock = this.rng.gauss(0.0, perTickVol * REGIME_VOL_MULTIPLIER[this.regime]);
    let logReturn =
      perTickDrift + regimeComponent + reversion + eventComponent + shock - 0.5 * perTickVol ** 2;
    logReturn = Math.max(-this.config.maxTickMove, Math.min(this.config.maxTickMove, logReturn));
    const newPrice = state.price * Math.exp(logReturn);
    state.price = Math.min(this.config.maxPrice, Math.max(this.config.minPrice, newPrice));

    // Fair value tracks the company's growth story with a little noise of its own.
    state.fairValue *= Math.exp(perTickDrift + this.rng.gauss(0.0, perTickVol * 0.25));
    state.fairValue = Math.min(
      this.config.maxPrice,
      Math.max(this.config.minPrice, state.fairValue),
    );

    if (state.price > 0) {
      state.dayHigh = Math.max(state.dayHigh, state.price);
      state.dayLow = Math.min(state.dayLow, state.price);
    }
  }

  private computeIndex(): number {
    const totalCap = Object.values(this.companies).reduce((sum, c) => sum + c.marketCap, 0);
    return this.config.startingIndex * (totalCap / this._initialMarketCap);
  }

  // ----------------------------------------------------------------- helpers

  snapshot(): CompanyState[] {
    return Object.keys(this.companies)
      .sort()
      .map((symbol) => this.companies[symbol]);
  }

  topMovers(count = 5): [CompanyState[], CompanyState[]] {
    const ordered = Object.values(this.companies).sort(
      (a, b) => b.dayChangeFraction - a.dayChangeFraction,
    );
    return [ordered.slice(0, count), ordered.slice(-count).reverse()];
  }

  /** Average day change per sector, for the sector heatmap. */
  sectorPerformance(): Record<string, number> {
    const buckets: Record<string, number[]> = {};
    for (const company of Object.values(this.companies)) {
      (buckets[company.sector] ??= []).push(company.dayChangeFraction);
    }
    const result: Record<string, number> = {};
    for (const sector of Object.keys(buckets).sort()) {
      const changes = buckets[sector];
      result[sector] = changes.reduce((sum, value) => sum + value, 0) / changes.length;
    }
    return result;
  }

  sectorBeta(sector: string): number {
    return SECTOR_BETA[sector] ?? 1.0;
  }
}
