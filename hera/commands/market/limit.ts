/** `/limit` — place a resting limit order. */
import { config } from '../../config';
import { symbolAutocomplete } from '../../framework/autocomplete';
import { withHeraErrors } from '../../framework/helpers';
import { choiceArg, symbolArg, stringArg, type CommandDefinition } from '../../framework/types';
import { price } from '../../formatting';
import { parseAmount, parsePrice } from '../../parsing';
import { tradeResultEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'limit',
  category: 'market',
  description: 'Place a resting limit order.',
  args: [
    choiceArg('side', 'buy, sell, short or cover', ['buy', 'sell', 'short', 'cover'], { required: true }),
    symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true }),
    stringArg('quantity', 'How many shares.', { required: true, example: '5' }),
    stringArg('limit_price', 'Only fill at this price or better.', { required: true, example: '2500' }),
  ],
  async execute(ctx, args, services) {
    const side = String(args.side);
    const symbol = String(args.symbol);
    const order = await withHeraErrors(ctx, async () => {
      const quantity = parseAmount(String(args.quantity));
      const target = parsePrice(String(args.limit_price));
      const orderId = services.trading.placeLimitOrder(
        ctx.userId,
        ctx.guildId,
        symbol,
        side,
        quantity,
        target,
      );
      return { orderId, quantity, target };
    });
    if (!order) return;

    await ctx.reply({
      embeds: [
        tradeResultEmbed({
          title: '\u{1F9FE} Limit order placed',
          description:
            `Order **#${order.orderId}**: ${side} ${order.quantity.toLocaleString()} ${symbol.toUpperCase()} ` +
            `at ${price(order.target)}`,
          color: config.embedColor,
          fields: [
            ['Expires', `after ${config.trading.limitOrderExpiryTicks} ticks`],
            ['Manage', '`/orders` to review, `/cancel` to pull it'],
          ],
        }),
      ],
    });
  },
};
