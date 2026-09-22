/** `/buy` — buy shares at the current market price, by share count or dollar amount. */
import { config } from '../../config';
import { symbolAutocomplete } from '../../framework/autocomplete';
import { withHeraErrors } from '../../framework/helpers';
import { symbolArg, stringArg, type CommandDefinition } from '../../framework/types';
import { HeraError } from '../../errors';
import { money, price, shares } from '../../formatting';
import { parseOrderSize } from '../../parsing';
import { tradeResultEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'buy',
  category: 'market',
  description: 'Buy shares at the current market price.',
  args: [
    symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true }),
    stringArg('amount', 'Shares to buy (0.5) or a dollar amount ($50).', {
      required: true,
      example: '$50',
    }),
  ],
  async execute(ctx, args, services) {
    const requested = String(args.symbol);
    const rawAmount = String(args.amount);
    const fill = await withHeraErrors(ctx, async () => {
      const company = services.market.resolveSymbol(ctx.guildId, requested);
      if (!company) throw new HeraError(`No listing matches \`${requested}\`.`);
      // 'all' means "spend my whole wallet". Route it through the value-based
      // path, which floors the quantity, rather than a share count rounded up
      // to the credit and one over the balance.
      if (['all', 'max'].includes(rawAmount.trim().toLowerCase())) {
        const account = services.economy.getAccount(ctx.userId, ctx.guildId);
        return services.trading.buyByValue(ctx.userId, ctx.guildId, requested, account.wallet);
      }
      const [estimate] = services.trading.estimateExecutionPrice(company, 1, 'buy');
      const account = services.economy.getAccount(ctx.userId, ctx.guildId);
      const maxShares = account.wallet / Math.max(estimate, 0.01);
      const size = parseOrderSize(rawAmount, maxShares);
      if (size.value !== undefined) {
        return services.trading.buyByValue(ctx.userId, ctx.guildId, requested, size.value);
      }
      return services.trading.buy(ctx.userId, ctx.guildId, requested, size.quantity!);
    });
    if (!fill) return;

    await ctx.reply({
      embeds: [
        tradeResultEmbed({
          title: '\u2705 Order filled',
          description: fill.message,
          color: config.embedColor,
          fields: [
            ['Shares', shares(fill.quantity)],
            ['Fill price', price(fill.price)],
            ['Total', money(fill.gross)],
          ],
        }),
      ],
    });
  },
};
