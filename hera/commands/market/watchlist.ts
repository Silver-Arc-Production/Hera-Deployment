/** `/watchlist` — show your watchlist with live prices. */
import type { CommandDefinition } from '../../framework/types';
import { watchlistEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'watchlist',
  category: 'market',
  description: 'Show your watchlist with live prices.',
  async execute(ctx, _args, services) {
    const symbols = services.trading.watchlist(ctx.userId, ctx.guildId);
    const engine = services.market.getEngine(ctx.guildId);
    const companies = symbols
      .filter((symbol) => engine.companies[symbol])
      .map((symbol) => engine.companies[symbol]);
    await ctx.reply({
      embeds: [watchlistEmbed(symbols, companies, { displayName: ctx.user.displayName })],
    });
  },
};
