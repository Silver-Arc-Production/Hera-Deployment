/**
 * The market guide: a plain-language tour of how the simulation behaves.
 *
 * Everything here is derived from the live configuration so the guide cannot
 * drift out of step with the engine. If a value is retuned in ``config.ts``, the
 * guide follows automatically.
 */
import { EmbedBuilder } from 'discord.js';

import { config } from '../config';
import { money, percent } from '../formatting';
import { COMPANIES, SECTORS } from '../market/companies';

export interface GuidePage {
  title: string;
  description: string;
  fields: [string, string][];
}

function ticksPerDay(): number {
  return config.market.sessionTicks;
}

/** Human-readable length of one trading session at the current tick rate. */
function sessionHours(): string {
  const seconds = ticksPerDay() * config.market.tickSeconds;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  return `${(seconds / 3600).toFixed(1)} hours`;
}

/** Format a whole-credit config amount, e.g. ``🪙 50,000``. */
export function credits(amount: number): string {
  return money(amount, { decimals: 0 });
}

/** Build every guide page from the current configuration. */
export function guidePages(): GuidePage[] {
  const market = config.market;
  const trading = config.trading;
  const economy = config.economy;

  return [
    {
      title: '\u{1F4C8} How the exchange works',
      description:
        `The exchange lists **${COMPANIES.length} fictional companies** across **${SECTORS.length} sectors**. ` +
        'All names and tickers are invented.\n\n' +
        'Everything is driven by a **tick** \u2014 one step of simulated time. ' +
        `A tick runs every **${market.tickSeconds} seconds**, and **${ticksPerDay()} ticks** make up one trading day.\n\n` +
        `At the default rate a full day is about **${sessionHours()}**. The market runs continuously while the ` +
        'bot is online, so prices move even when nobody is watching. Use `/market` to catch up.',
      fields: [
        [
          'The index',
          `The **Hera Index** starts at **${market.startingIndex.toLocaleString('en-US', { maximumFractionDigits: 0 })}** ` +
            "and is weighted by market capitalisation \u2014 that is, each company's share price multiplied by its " +
            'shares outstanding. Bigger companies move the index more. `/market` shows its current level and change.',
        ],
        ['Sectors', SECTORS.map((sector) => `\u2022 ${sector}`).join('\n')],
        [
          'Sector tendencies',
          'Each sector has a characteristic sensitivity to the wider market. Technology and Entertainment swing ' +
            'hardest; Healthcare and Materials are the steady ones. This sensitivity is called **beta** and is ' +
            'shown on every quote.',
        ],
      ],
    },
    {
      title: '\u{1F3B2} What moves a price',
      description:
        "Every tick, each company's price takes a small random step. The size of that step is the company's " +
        '**volatility**, which is stated on every quote. Several forces are applied on top of the random step.',
      fields: [
        [
          'Drift',
          'Each company leans gently in a direction over time \u2014 its growth story. A high drift is a long-term ' +
            'tailwind, but it is small per tick and easily overwhelmed by volatility in the short run.',
        ],
        [
          'Mean reversion',
          `Prices are pulled faintly back toward fair value (${market.meanReversion.toFixed(4)} per tick). This keeps ` +
            'prices from wandering off forever. It is weak, so it does not stop trends.',
        ],
        [
          'Market regime',
          `The whole market sits in one of three regimes: **bull**, **neutral**, or **bear**. A bull market adds a ` +
            'steady upward tilt and calms volatility slightly; a bear market pushes down and makes everything ' +
            `choppier. Regimes last between ${market.regimeMinTicks} and ${market.regimeMaxTicks} ticks, then rotate. ` +
            '`/market` shows the current one.',
        ],
        [
          'News events',
          `Roughly ${percent(market.eventChance * 100, { decimals: 0, signedOutput: false })} of ticks produce an ` +
            `event \u2014 good or bad news for one company or a whole sector. An event's effect decays over ` +
            `${market.eventTicksMin}\u2013${market.eventTicksMax} ticks rather than landing all at once, so headlines ` +
            'stay relevant for a while. Read them with `/news`.',
        ],
        [
          'Limits and halts',
          `No single tick can move a price more than ${percent(market.maxTickMove * 100, { signedOutput: false })} ` +
            '\u2014 this applies to the random component too, so a crash arrives as a series of bad ticks rather than ' +
            `one. If a company falls ${percent(market.circuitBreakerDrop * 100, { signedOutput: false })} or more in a ` +
            `day, trading in it **halts** for ${market.haltTicks} ticks and the price is frozen.`,
        ],
      ],
    },
    {
      title: '\u{1F4B8} Trading',
      description:
        'You trade against the market itself, not against other members. Fills are immediate at the live price, ' +
        'adjusted for size and fees.',
      fields: [
        [
          'Slippage',
          'You never fill at the screen price if your order is large. Slippage grows with the square root of your ' +
            "order size relative to the company's typical daily volume, and is capped at " +
            `${percent(trading.maxSlippage * 100, { signedOutput: false })}. Splitting a huge order across ticks is ` +
            'cheaper than sending it at once.',
        ],
        [
          'Commission',
          `${percent(trading.commissionRate * 100, { signedOutput: false })} of the trade's value, with a minimum of ` +
            `${trading.commissionMin} and a maximum of ${trading.commissionMax.toLocaleString()} per fill.`,
        ],
        [
          'Limit orders',
          'A limit order rests until the market touches your price. It does not guarantee a fill \u2014 it waits for ' +
            `one. Orders expire after ${trading.limitOrderExpiryTicks} ticks, which is about ` +
            `${Math.floor(trading.limitOrderExpiryTicks / Math.max(1, ticksPerDay()))} trading days. Review them with ` +
            '`/orders` and pull them with `/cancel`.',
        ],
        [
          'Short selling',
          'Shorting lets you profit when a price falls, and your loss is unbounded in theory, so it demands ' +
            `collateral. You must post ${percent(trading.minShortCollateralRatio * 100, { signedOutput: false })} of ` +
            'the position\'s value up front. If the trade goes against you far enough to eat into that collateral, you ' +
            'get a **margin call** warning by DM. Positions are not force-closed \u2014 the decision stays yours.',
        ],
        [
          'Dividends',
          `Some companies pay dividends roughly every ${market.dividendTickInterval} ticks. On the ex-dividend tick ` +
            'the share price drops by the payout and holders receive cash for each share they own. The drop is not a ' +
            'loss: it is the payout leaving the company.',
        ],
      ],
    },
    {
      title: '\u{1F3E6} Money and risk',
      description:
        'The economy is deliberately separate from the market. You earn through work and rewards, then choose how ' +
        'much to expose to the exchange.',
      fields: [
        [
          'Wallet versus bank',
          'Your **wallet** is spendable and is what trading draws on. Your **bank** is storage with a capacity limit, ' +
            'and it is safer: only your wallet can be robbed. Move money with `/deposit` and `/withdraw`.',
        ],
        [
          'Earning',
          `\`/economy work\` pays between ${credits(economy.workMin)} and ${credits(economy.workMax)} on a ` +
            `${Math.floor(economy.workCooldownSeconds / 3600)}h cooldown. \`/economy daily\` pays ` +
            `${credits(economy.dailyAmount)} and grows with a streak up to ${economy.dailyStreakCap} days. ` +
            `\`/economy rob\` is risky: it succeeds ${percent(economy.robSuccessChance * 100, { decimals: 0, signedOutput: false })} ` +
            `of the time and fines you ${credits(economy.robFine)} when it fails.`,
        ],
        [
          'Bank upgrades',
          `Start with ${credits(economy.startingBankCapacity)} of storage. \`/economy bankupgrade\` costs ` +
            `${credits(economy.bankUpgradeBaseCost)} times your current level and adds ${credits(economy.bankUpgradeCapacity)} more.`,
        ],
        [
          'Reading your portfolio',
          '`/portfolio` splits your net worth into cash, long positions and short collateral. `Unrealised` ' +
            'profit is what you would make by closing now; `realised` is already banked. Watch the two separately ' +
            '\u2014 an open winner is not yet money in hand.',
        ],
      ],
    },
    {
      title: '\u{1F9ED} A sensible first hour',
      description: 'A suggested path if you are new to the exchange.',
      fields: [
        [
          '1. Get and keep some cash',
          'Run `/daily` and `/work`. Keep a reserve in your bank rather than spending everything ' +
            '\u2014 you need a cash buffer for opportunities and to avoid forced selling.',
        ],
        [
          '2. Learn the board',
          '`/market` for the overall picture, `/list` to browse all 20 companies, `/sectors` to ' +
            'see which parts of the market are strong today. Check the regime: buying into a bear market is harder ' +
            'than it looks.',
        ],
        [
          '3. Study a company before buying',
          '`/quote NOVA` shows price, volatility, drift, beta and dividend yield. `/chart NOVA` shows the ' +
            'price history. High volatility means bigger swings in both directions.',
        ],
        [
          '4. Place a small trade',
          '`/buy NOVA 5` spends real money, so start small while you learn how slippage and commission behave. ' +
            '`/position NOVA` tracks it afterwards.',
        ],
        [
          '5. Automate your discipline',
          '`/limit` to buy below the market or sell above it without watching the chart. ' +
            '`/alert NOVA above 500` pings you when a price crosses a level. `/watch add NOVA` puts it ' +
            'on your watchlist.',
        ],
        [
          'Remember: this is a simulation',
          'Prices here are generated, not real. Nothing on this market reflects an actual company, and no strategy ' +
            'here works in real trading.',
        ],
      ],
    },
  ];
}

export function guideEmbed(page: GuidePage, options: { page: number; total: number }): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(page.title)
    .setDescription(page.description)
    .setColor(config.embedColor);
  for (const [name, value] of page.fields) embed.addFields({ name, value, inline: false });
  embed.setFooter({ text: `Market guide \u2014 page ${options.page + 1} of ${options.total}` });
  return embed;
}
