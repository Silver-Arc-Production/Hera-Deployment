/**
 * Embed builders.
 *
 * Embeds are built as plain functions returning an :class:`EmbedBuilder` so they
 * can be unit tested without a live bot.
 */
import { EmbedBuilder } from 'discord.js';

import { config } from '../config';
import { arrow, compact, money, percent, price, progressBar, signed } from '../formatting';
import type { CompanyState, NewsItem } from '../market/engine';
import type { Portfolio } from '../services/trading';
import type { AlertRow, OrderRow } from '../services/trading';

export const REGIME_LABEL: Record<string, string> = {
  bull: '\u{1F402} Bull market',
  neutral: '\u{1F610} Neutral market',
  bear: '\u{1F43B} Bear market',
};
export const REGIME_COLOR: Record<string, number> = {
  bull: 0x2ecc71,
  neutral: 0x95a5a6,
  bear: 0xe74c3c,
};

function pctValue(value: number): string {
  return percent(value * 100);
}

// ---------------------------------------------------------------- market views

export function marketOverviewEmbed(options: {
  indexValue: number;
  indexChange: number;
  regime: string;
  tick: number;
  companies: CompanyState[];
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('\u{1F4C8} Hera Exchange')
    .setDescription(
      `**Index** ${options.indexValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}  ${arrow(options.indexChange)} ${pctValue(options.indexChange)}\n` +
        `${REGIME_LABEL[options.regime] ?? options.regime}  \u2022  tick **${options.tick.toLocaleString()}**`,
    )
    .setColor(REGIME_COLOR[options.regime] ?? config.embedColor);

  const sorted = [...options.companies].sort((a, b) => b.dayChangeFraction - a.dayChangeFraction);
  const gainers = sorted.slice(0, 5);
  const losers = sorted.slice(-5).reverse();

  embed.addFields({
    name: '\u{1F7E2} Top gainers',
    value:
      gainers
        .map((c) => `\`${c.symbol.padEnd(4)}\` ${price(c.price).padStart(10)}  ${pctValue(c.dayChangeFraction)}`)
        .join('\n') || '\u2014',
    inline: true,
  });
  embed.addFields({
    name: '\u{1F534} Top losers',
    value:
      losers
        .map((c) => `\`${c.symbol.padEnd(4)}\` ${price(c.price).padStart(10)}  ${pctValue(c.dayChangeFraction)}`)
        .join('\n') || '\u2014',
    inline: true,
  });

  const active = options.companies.filter((c) => c.activeEvent);
  embed.addFields({
    name: '\u{1F4F0} Active stories',
    value:
      active
        .slice(0, 5)
        .map((c) => `\`${c.symbol}\` ${(c.activeEvent ?? '').replace(/_/g, ' ')}`)
        .join('\n') || 'A quiet session \u2014 no major headlines.',
    inline: false,
  });
  embed.setFooter({ text: 'Use /market list for the full board \u2022 /market chart SYMBOL for a graph' });
  return embed;
}

export function listingEmbed(
  company: CompanyState,
  options: { held?: number; averageCost?: number } = {},
): EmbedBuilder {
  const { held = 0, averageCost = 0 } = options;
  const change = company.dayChangeFraction;
  const embed = new EmbedBuilder()
    .setTitle(`${company.symbol} \u2014 ${company.name}`)
    .setDescription(company.description)
    .setColor(change >= 0 ? config.embedColor : config.errorColor);
  embed.addFields(
    { name: 'Price', value: `**${price(company.price)}**`, inline: true },
    { name: 'Day', value: `${arrow(change)} ${pctValue(change)}`, inline: true },
    { name: 'Sector', value: company.sector, inline: true },
    { name: 'Open', value: price(company.openPrice), inline: true },
    { name: 'High', value: price(company.dayHigh), inline: true },
    { name: 'Low', value: price(company.dayLow), inline: true },
    { name: 'Market cap', value: `${config.currencySymbol} ${compact(company.marketCap)}`, inline: true },
    {
      name: 'Dividend yield',
      value: company.dividendYield
        ? percent(company.dividendYield * 100, { signedOutput: false })
        : '\u2014',
      inline: true,
    },
    { name: 'Volatility', value: `${(company.volatility * 100).toFixed(1)}% daily`, inline: true },
  );
  if (held) {
    const pnl = (company.price - averageCost) * held;
    embed.addFields({
      name: 'Your position',
      value:
        `${held.toLocaleString()} shares @ ${price(averageCost)}\n` +
        `${signed(pnl)} (${percent(averageCost ? (company.price / averageCost - 1) * 100 : 0)})`,
      inline: false,
    });
  }
  if (company.haltedUntilTick) {
    embed.addFields({
      name: '\u26D4 Trading halted',
      value: 'A circuit breaker paused this listing after a sharp drop.',
      inline: false,
    });
  }
  if (company.activeEvent) {
    embed.addFields({
      name: '\u{1F4F0} Active story',
      value: titleCase(company.activeEvent.replace(/_/g, ' ')),
      inline: false,
    });
  }
  return embed;
}

export function stockListEmbed(
  companies: CompanyState[],
  options: { page: number; perPage: number; sector?: string | null },
): EmbedBuilder {
  const { page, perPage, sector = null } = options;
  const start = page * perPage;
  const window = companies.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(companies.length / perPage));
  const embed = new EmbedBuilder()
    .setTitle(sector ? `\u{1F4CA} Stock board \u2014 ${sector}` : '\u{1F4CA} Stock board')
    .setDescription(`Page ${page + 1}/${totalPages} \u2022 ${companies.length} listings`)
    .setColor(config.embedColor);
  for (const company of window) {
    const change = company.dayChangeFraction;
    embed.addFields({
      name: `${arrow(change)} \`${company.symbol}\` ${company.name}`,
      value:
        `${price(company.price)}  ${pctValue(change)}  \u2022 ${company.sector}  ` +
        `\u2022 cap ${config.currencySymbol}${compact(company.marketCap)}`,
      inline: false,
    });
  }
  return embed;
}

export function newsEmbed(items: NewsItem[]): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('\u{1F4F0} Market wire').setColor(config.embedColor);
  if (items.length === 0) {
    embed.setDescription('No headlines yet. The wire fills up as the market ticks.');
    return embed;
  }
  for (const item of items) {
    const tag = item.symbol ? `\`${item.symbol}\` ` : '`SECTOR` ';
    const emoji = item.impact >= 0 ? '\u{1F7E2}' : '\u{1F534}';
    embed.addFields({ name: `${emoji} ${tag}`, value: item.headline, inline: false });
  }
  return embed;
}

export function portfolioEmbed(portfolio: Portfolio, options: { displayName: string }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`\u{1F4BC} ${options.displayName}'s portfolio`)
    .setColor(config.embedColor);
  embed.addFields(
    { name: 'Wallet', value: money(portfolio.wallet), inline: true },
    { name: 'Bank', value: money(portfolio.bank), inline: true },
    { name: 'Net worth', value: money(portfolio.netWorth), inline: true },
    { name: 'Holdings value', value: money(portfolio.longValue), inline: true },
    { name: 'Unrealised P/L', value: signed(portfolio.unrealizedPnl), inline: true },
    { name: 'Realised P/L', value: signed(portfolio.realizedPnl), inline: true },
  );

  if (portfolio.positions.length > 0) {
    embed.addFields({
      name: '\u{1F4C8} Long positions',
      value: portfolio.positions
        .slice(0, 10)
        .map(
          (position) =>
            `${arrow(position.unrealizedPnl)} \`${position.symbol}\` ${position.quantity.toLocaleString()} @ ` +
            `${price(position.averageCost)} \u2192 ${price(position.price)}  ${signed(position.unrealizedPnl)} ` +
            `(${percent(position.unrealizedPct)})`,
        )
        .join('\n'),
      inline: false,
    });
  }

  if (portfolio.shorts.length > 0) {
    embed.addFields({
      name: '\u{1F4C9} Short positions',
      value: portfolio.shorts
        .slice(0, 10)
        .map(
          (short) =>
            `${arrow(short.unrealizedPnl)} \`${short.symbol}\` short ${short.quantity.toLocaleString()} @ ` +
            `${price(short.averagePrice)} \u2192 ${price(short.price)}  ${signed(short.unrealizedPnl)} ` +
            `(${percent(short.unrealizedPct)})`,
        )
        .join('\n'),
      inline: false,
    });
  }

  if (portfolio.positions.length === 0 && portfolio.shorts.length === 0) {
    embed.addFields({
      name: 'No positions',
      value: 'You are all cash. Try `/buy NOVA 5` to open a position.',
      inline: false,
    });
  }
  return embed;
}

export function orderBookEmbed(rows: OrderRow[], options: { displayName: string }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`\u{1F9FE} ${options.displayName}'s open orders`)
    .setColor(config.embedColor);
  if (rows.length === 0) {
    embed.setDescription('No resting orders. Use `/limit` to place one.');
    return embed;
  }
  for (const row of rows) {
    embed.addFields({
      name: `#${row.id} \u2022 ${row.side.toUpperCase()} ${Number(row.quantity).toLocaleString()} ${row.symbol}`,
      value:
        `limit ${price(Number(row.limit_price))} \u2022 filled ${Number(row.filled_quantity).toLocaleString()} \u2022 ` +
        `expires tick ${row.expires_tick}`,
      inline: false,
    });
  }
  return embed;
}

export function alertsEmbed(rows: AlertRow[], options: { displayName: string }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`\u{1F514} ${options.displayName}'s price alerts`)
    .setColor(config.embedColor);
  if (rows.length === 0) {
    embed.setDescription('No alerts set. Use `/alert NOVA above 500`.');
    return embed;
  }
  for (const row of rows) {
    embed.addFields({
      name: `#${row.id} ${row.symbol} ${row.direction} ${price(Number(row.threshold))}`,
      value: row.note ?? '\u2014',
      inline: false,
    });
  }
  return embed;
}

export function watchlistEmbed(
  symbols: string[],
  companies: CompanyState[],
  options: { displayName: string },
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`\u2B50 ${options.displayName}'s watchlist`)
    .setColor(config.embedColor);
  void symbols;
  if (companies.length === 0) {
    embed.setDescription('Your watchlist is empty. Use `/watch add NOVA`.');
    return embed;
  }
  for (const company of companies) {
    const change = company.dayChangeFraction;
    embed.addFields({
      name: `${arrow(change)} \`${company.symbol}\``,
      value: `${price(company.price)}  ${pctValue(change)}`,
      inline: true,
    });
  }
  return embed;
}

export function leaderboardEmbed(
  rows: { userId: string; netWorth: number }[],
  options: { names: Map<string, string>; kind: string },
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`\u{1F3C6} ${options.kind} leaderboard`)
    .setColor(config.embedColor);
  const medals = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
  const lines = rows.map((row, index) => {
    const name = options.names.get(row.userId) ?? `User ${row.userId}`;
    const prefix = index < medals.length ? medals[index] : `\`#${String(index + 1).padStart(2)}\``;
    return `${prefix} **${name}** \u2014 ${money(row.netWorth)}`;
  });
  embed.setDescription(lines.join('\n') || 'Nobody has any wealth yet.');
  return embed;
}

export function sectorEmbed(performance: Record<string, number>): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('\u{1F3ED} Sector performance').setColor(config.embedColor);
  for (const [sector, change] of Object.entries(performance).sort((a, b) => b[1] - a[1])) {
    const bar = progressBar(Math.abs(change), 0.05, 10);
    embed.addFields({
      name: `${arrow(change)} ${sector}`,
      value: `${pctValue(change)}  \`${bar}\``,
      inline: false,
    });
  }
  return embed;
}

export function tradeResultEmbed(options: {
  title: string;
  description: string;
  color: number;
  fields?: [string, string][];
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(options.title)
    .setDescription(options.description)
    .setColor(options.color);
  for (const [name, value] of options.fields ?? []) {
    embed.addFields({ name, value, inline: true });
  }
  return embed;
}

export function errorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setTitle(`\u274C ${message}`).setColor(config.errorColor);
}

export function successEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(config.embedColor);
}

export function titleCase(text: string): string {
  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}
