/** `/cancel` — cancel one of your resting orders. */
import { config } from '../../config';
import { ephemeralError } from '../../framework/helpers';
import { intArg, type CommandDefinition } from '../../framework/types';
import { tradeResultEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'cancel',
  category: 'market',
  description: 'Cancel one of your resting orders.',
  args: [intArg('order_id', 'The order number shown by /orders.', { required: true, minValue: 1 })],
  async execute(ctx, args, services) {
    const orderId = Number(args.order_id);
    const ok = services.trading.cancelOrder(ctx.userId, ctx.guildId, orderId);
    if (!ok) {
      await ephemeralError(ctx, `No open order **#${orderId}** belongs to you.`);
      return;
    }
    await ctx.reply({
      embeds: [
        tradeResultEmbed({
          title: '\u{1F5D1}\uFE0F Order cancelled',
          description: `Order **#${orderId}** was cancelled and any reservation refunded.`,
          color: config.embedColor,
        }),
      ],
      ephemeral: true,
    });
  },
};
