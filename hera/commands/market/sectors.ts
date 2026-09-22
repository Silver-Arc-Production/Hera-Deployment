/** `/sectors` — see how each sector is performing today. */
import type { CommandDefinition } from '../../framework/types';
import { sectorEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'sectors',
  category: 'market',
  description: 'See how each sector is performing today.',
  async execute(ctx, _args, services) {
    const engine = services.market.getEngine(ctx.guildId);
    await ctx.reply({ embeds: [sectorEmbed(engine.sectorPerformance())] });
  },
};
