/** `/chart` — render a price chart for a company. */
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { symbolAutocomplete } from '../../framework/autocomplete';
import { ephemeralError } from '../../framework/helpers';
import { intArg, symbolArg, type CommandDefinition } from '../../framework/types';
import { percent, price } from '../../formatting';
import * as charts from '../../ui/charts';

export const command: CommandDefinition = {
  name: 'chart',
  category: 'market',
  description: 'Render a price chart for a company.',
  args: [
    symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true }),
    intArg('points', 'How many ticks of history to plot.', { required: false, minValue: 10, maxValue: 400 }),
  ],
  async execute(ctx, args, services) {
    const requested = String(args.symbol);
    const company = services.market.resolveSymbol(ctx.guildId, requested);
    if (!company) {
      await ephemeralError(ctx, `No listing matches \`${requested}\`.`);
      return;
    }
    const points = Math.max(10, Math.min(400, Number(args.points ?? 120)));

    await ctx.defer();
    const history = services.market.history(company.symbol, points);
    const position = services.trading.getPosition(ctx.userId, ctx.guildId, company.symbol);
    const image = charts.priceChart(company.symbol, company.name, history, {
      averageCost: position ? position.averageCost : null,
    });
    if (!image) {
      await ctx.followUp({
        embeds: [
          new EmbedBuilder()
            .setTitle('\u274C Not enough price history yet \u2014 the chart fills in as the market ticks.')
            .setColor(config.errorColor),
        ],
      });
      return;
    }

    const file = new AttachmentBuilder(image, { name: `${company.symbol}.png` });
    const embed = new EmbedBuilder()
      .setTitle(`${company.symbol} \u2014 ${company.name}`)
      .setDescription(
        `**${price(company.price)}** ${percent(company.dayChangeFraction * 100)} \u2022 ${points} ticks \u2022 ${company.sector}`,
      )
      .setColor(config.embedColor)
      .setImage(`attachment://${company.symbol}.png`);
    await ctx.followUp({ embeds: [embed], files: [file] });
  },
};
