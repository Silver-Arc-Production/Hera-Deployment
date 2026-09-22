/** `/market` — index, movers and active stories. */
import type { CommandDefinition } from '../../framework/types';
import { marketOverviewEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'market',
  category: 'market',
  description: 'Market overview: index, movers and headlines.',
  async execute(ctx, _args, services) {
    const snapshot = services.market.snapshot(ctx.guildId);
    await ctx.reply({
      embeds: [
        marketOverviewEmbed({
          indexValue: snapshot.indexValue,
          indexChange: snapshot.indexChange,
          regime: snapshot.regime,
          tick: snapshot.tick,
          companies: snapshot.companies,
        }),
      ],
    });
  },
};
