/** `/compare` — chart several companies against each other. */
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { ephemeralError } from '../../framework/helpers';
import { stringArg, type CommandDefinition } from '../../framework/types';
import * as charts from '../../ui/charts';

export const command: CommandDefinition = {
  name: 'compare',
  category: 'market',
  description: 'Chart several companies against each other.',
  args: [
    stringArg('symbols', 'Up to 5 tickers separated by spaces.', { required: true, example: 'NOVA TERA BREW' }),
  ],
  async execute(ctx, args, services) {
    const tokens = String(args.symbols)
      .replace(/,/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);
    if (tokens.length < 2) {
      await ephemeralError(ctx, 'Give at least two tickers, e.g. `NOVA TERA BREW`.');
      return;
    }

    const series: Record<string, number[]> = {};
    const missing: string[] = [];
    for (const token of tokens) {
      const company = services.market.resolveSymbol(ctx.guildId, token);
      if (!company) {
        missing.push(token);
        continue;
      }
      const history = services.market.history(company.symbol, 120);
      if (history.length > 0) series[company.symbol] = history.map(([, value]) => value);
    }

    if (Object.keys(series).length < 2) {
      await ephemeralError(
        ctx,
        'Need history for at least two of those tickers' +
          (missing.length ? ` (unknown: ${missing.join(', ')})` : '.'),
      );
      return;
    }

    await ctx.defer();
    const image = charts.comparisonChart(series, 'Relative performance (last 120 ticks)');
    if (!image) {
      await ephemeralError(ctx, 'Could not build that chart.');
      return;
    }
    const file = new AttachmentBuilder(image, { name: 'compare.png' });
    const embed = new EmbedBuilder()
      .setTitle('\u{1F4CA} Comparison')
      .setDescription('Each line is normalised to 0% at the start of the window.')
      .setColor(config.embedColor)
      .setImage('attachment://compare.png');
    await ctx.followUp({ embeds: [embed], files: [file] });
  },
};
