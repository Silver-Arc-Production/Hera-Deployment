/** `/orders` — review your resting limit orders. */
import type { CommandDefinition } from '../../framework/types';
import { orderBookEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'orders',
  category: 'market',
  description: 'Review your resting limit orders.',
  async execute(ctx, _args, services) {
    const rows = services.trading.openOrders(ctx.userId, ctx.guildId);
    await ctx.reply({ embeds: [orderBookEmbed(rows, { displayName: ctx.user.displayName })], ephemeral: true });
  },
};
