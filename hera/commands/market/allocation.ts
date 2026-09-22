/** `/allocation` — chart how your portfolio is allocated. */
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { ephemeralError } from '../../framework/helpers';
import type { CommandDefinition } from '../../framework/types';
import * as charts from '../../ui/charts';

export const command: CommandDefinition = {
  name: 'allocation',
  category: 'market',
  description: 'Chart how your portfolio is allocated.',
  async execute(ctx, _args, services) {
    const result = services.trading.getPortfolio(ctx.userId, ctx.guildId);
    const labels = result.positions.map((position) => position.symbol);
    const values = result.positions.map((position) => position.marketValue);
    labels.push('Cash');
    values.push(result.wallet + result.bank);

    await ctx.defer();
    const image = charts.allocationChart(labels, values);
    if (!image) {
      await ephemeralError(ctx, 'You have nothing to allocate yet.');
      return;
    }
    const file = new AttachmentBuilder(image, { name: 'allocation.png' });
    const embed = new EmbedBuilder()
      .setTitle('\u{1F967} Portfolio allocation')
      .setColor(config.embedColor)
      .setImage('attachment://allocation.png');
    await ctx.followUp({ embeds: [embed], files: [file] });
  },
};
