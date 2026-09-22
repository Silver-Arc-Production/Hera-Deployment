/**
 * Read-only views of the Hera exchange for the web dashboard.
 *
 * This layer only reads. It never writes to the database, so the dashboard cannot
 * disturb a live market: it snapshots the same :class:`MarketService` the Discord
 * commands use and serialises it into plain JSON.
 */
import type { MarketService } from '../hera/services/market';
import { SECTOR_BETA } from '../hera/market/companies';
import type { CompanyState } from '../hera/market/engine';
import { chartDataUri, fallbackChart, renderPriceChart, renderSparkline } from './charts';

/** How many ticks of history the tables and charts go back by default. */
export const DEFAULT_HISTORY = 120;

export interface StockRow {
  symbol: string;
  name: string;
  sector: string;
  description: string;
  price: number;
  previous_close: number;
  open: number;
  day_high: number;
  day_low: number;
  change: number;
  change_pct: number;
  market_cap: number;
  dividend_yield: number;
  volatility: number;
  beta: number;
  halted: boolean;
  sector_beta: number;
  history_tick_start: number | null;
  sparkline: string;
}

export interface MarketPayload {
  generated_at: string;
  tick: number;
  regime: string;
  index: { value: number; change: number; change_pct: number };
  totals: {
    listings: number;
    market_cap: number;
    gainers: number;
    losers: number;
    unchanged: number;
    halted: number;
  };
  sectors: { sector: string; change_pct: number; count: number }[];
  stocks: StockRow[];
  news: { symbol: string | null; headline: string; impact: number }[];
}

function isoNow(): string {
  return new Date().toISOString().slice(0, 19) + 'Z';
}

/**
 * Assembles JSON payloads from the market service.
 *
 * ``guildId`` selects which server's market to show, because every guild runs an
 * independent simulation.
 */
export class DashboardService {
  constructor(
    readonly market: MarketService,
    readonly guildId: string,
    private readonly historyLimit: number = DEFAULT_HISTORY,
  ) {}

  /** What ``/healthz`` reports: liveness plus how far the simulation has run. */
  health(): { status: string; tick: number } {
    return { status: 'ok', tick: this.market.snapshot(this.guildId).tick };
  }

  async marketPayload(): Promise<MarketPayload> {
    const snapshot = this.market.snapshot(this.guildId);
    const companies = snapshot.companies;

    const rows: StockRow[] = [];
    for (const company of companies) {
      const history = this.market.history(company.symbol, this.historyLimit);
      const prices = history.map(([, value]) => value);
      rows.push({
        symbol: company.symbol,
        name: company.name,
        sector: company.sector,
        description: company.description,
        price: company.price,
        previous_close: company.previousClose,
        open: company.openPrice,
        day_high: company.dayHigh,
        day_low: company.dayLow,
        change: company.price - company.previousClose,
        change_pct: company.dayChangeFraction * 100,
        market_cap: company.marketCap,
        dividend_yield: company.dividendYield,
        volatility: company.volatility,
        beta: company.beta,
        halted: company.isHalted,
        sector_beta: SECTOR_BETA[company.sector] ?? 1.0,
        history_tick_start: history.length > 0 ? history[0][0] : null,
        sparkline: chartDataUri(renderSparkline(prices)),
      });
    }

    const sectors = sectorRows(companies);
    const gainers = rows.filter((row) => row.change_pct > 0).length;
    const losers = rows.filter((row) => row.change_pct < 0).length;
    const news = this.market.news(this.guildId, 8);

    return {
      generated_at: isoNow(),
      tick: snapshot.tick,
      regime: snapshot.regime,
      index: {
        value: snapshot.indexValue,
        change: snapshot.indexChange,
        change_pct: snapshot.indexChange * 100,
      },
      totals: {
        listings: rows.length,
        market_cap: rows.reduce((sum, row) => sum + row.market_cap, 0),
        gainers,
        losers,
        unchanged: rows.length - gainers - losers,
        halted: rows.filter((row) => row.halted).length,
      },
      sectors,
      stocks: rows,
      news: news.map((item) => ({
        symbol: item.symbol,
        headline: item.headline,
        impact: item.impact,
      })),
    };
  }

  /** A full price chart for one listing, rendered as standalone SVG. */
  stockChartSvg(symbol: string, points = 160): string | null {
    const company = this.market.getCompany(this.guildId, symbol);
    if (!company) return null;
    const history = this.market.history(company.symbol, points);
    return renderPriceChart(company.symbol, company.name, history) || null;
  }

  indexChartSvg(points = 160): string | null {
    const history = this.market.indexHistory(this.guildId, points);
    return renderPriceChart('HERA', 'Hera Exchange Index', history) || null;
  }
}

function sectorRows(companies: CompanyState[]): { sector: string; change_pct: number; count: number }[] {
  const buckets = new Map<string, number[]>();
  for (const company of companies) {
    const changes = buckets.get(company.sector) ?? [];
    changes.push(company.dayChangeFraction);
    buckets.set(company.sector, changes);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sector, changes]) => ({
      sector,
      change_pct: (changes.reduce((sum, value) => sum + value, 0) / changes.length) * 100,
      count: changes.length,
    }));
}

export { fallbackChart };
