/** `/news` — read the latest market headlines. */
import type { CommandDefinition } from '../../framework/types';
import { newsEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'news',
  category: 'market',
  description: 'Read the latest market headlines.',
  async execute(ctx, _args, services) {
    const items = services.market.news(ctx.guildId, 8);
    await ctx.reply({ embeds: [newsEmbed(items)] });
  },
};
