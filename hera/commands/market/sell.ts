/** `/sell` — sell shares you own, by share count or dollar amount. */
import { config } from '../../config';
import { symbolAutocomplete } from '../../framework/autocomplete';
import { withHeraErrors } from '../../framework/helpers';
import { symbolArg, stringArg, type CommandDefinition } from '../../framework/types';
import { HeraError, InsufficientShares } from '../../errors';
import { money, price, shares, signed } from '../../formatting';
import { parseOrderSize } from '../../parsing';
import { tradeResultEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'sell',
  category: 'market',
  description: 'Sell shares you own.',
  args: [
    symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true }),
    stringArg('amount', "Shares to sell (0.5), a dollar amount ($50), or 'all'.", {
      required: true,
      example: 'all',
    }),
  ],
  async execute(ctx, args, services) {
    const requested = String(args.symbol);
    const rawAmount = String(args.amount);
    const fill = await withHeraErrors(ctx, async () => {
      const company = services.market.resolveSymbol(ctx.guildId, requested);
      if (!company) throw new HeraError(`No listing matches \`${requested}\`.`);
      const position = services.trading.getPosition(ctx.userId, ctx.guildId, company.symbol);
      const held = position ? position.quantity : 0;
      if (held <= 0) throw new InsufficientShares(company.symbol, 1, 0);
      const size = parseOrderSize(rawAmount, held);
      if (size.value !== undefined) {
        return services.trading.sellByValue(ctx.userId, ctx.guildId, requested, size.value);
      }
      return services.trading.sell(ctx.userId, ctx.guildId, requested, size.quantity!);
    });
    if (!fill) return;

    await ctx.reply({
      embeds: [
        tradeResultEmbed({
          title: rawAmount.trim().toLowerCase() === 'all' ? '\u2705 Position closed' : '\u2705 Order filled',
          description: fill.message,
          color: fill.realizedPnl >= 0 ? config.embedColor : config.errorColor,
          fields: [
            ['Shares', shares(fill.quantity)],
            ['Fill price', price(fill.price)],
            ['Proceeds', money(fill.gross)],
            ['Realised P/L', signed(fill.realizedPnl)],
          ],
        }),
      ],
    });
  },
};
