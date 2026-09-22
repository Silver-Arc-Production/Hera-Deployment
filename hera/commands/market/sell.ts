/** `/sell` — sell shares you own. */
import { config } from '../../config';
import { symbolAutocomplete } from '../../framework/autocomplete';
import { withHeraErrors } from '../../framework/helpers';
import { symbolArg, stringArg, type CommandDefinition } from '../../framework/types';
import { HeraError, InsufficientShares } from '../../errors';
import { money, price, signed } from '../../formatting';
import { parseAmount } from '../../parsing';
import { tradeResultEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'sell',
  category: 'market',
  description: 'Sell shares you own.',
  args: [
    symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true }),
    stringArg('quantity', "How many shares, or 'all'.", { required: true, example: 'all' }),
  ],
  async execute(ctx, args, services) {
    const requested = String(args.symbol);
    const rawQuantity = String(args.quantity);
    const fill = await withHeraErrors(ctx, async () => {
      const company = services.market.resolveSymbol(ctx.guildId, requested);
      if (!company) throw new HeraError(`No listing matches \`${requested}\`.`);
      const position = services.trading.getPosition(ctx.userId, ctx.guildId, company.symbol);
      const held = position ? position.quantity : 0;
      if (held <= 0) throw new InsufficientShares(company.symbol, 1, 0);
      const quantity = parseAmount(rawQuantity, held);
      return services.trading.sell(ctx.userId, ctx.guildId, requested, quantity);
    });
    if (!fill) return;

    await ctx.reply({
      embeds: [
        tradeResultEmbed({
          title:
            rawQuantity.trim().toLowerCase() === 'all'
              ? '\u2705 Position closed'
              : '\u2705 Order filled',
          description: fill.message,
          color: fill.realizedPnl >= 0 ? config.embedColor : config.errorColor,
          fields: [
            ['Shares', fill.quantity.toLocaleString()],
            ['Fill price', price(fill.price)],
            ['Net proceeds', money(fill.gross - fill.commission)],
            ['Realised P/L', signed(fill.realizedPnl)],
          ],
        }),
      ],
    });
  },
};
