/** `/buy` — buy shares at the current market price. */
import { config } from '../../config';
import { symbolAutocomplete } from '../../framework/autocomplete';
import { withHeraErrors } from '../../framework/helpers';
import { symbolArg, stringArg, type CommandDefinition } from '../../framework/types';
import { HeraError } from '../../errors';
import { money, price } from '../../formatting';
import { parseAmount } from '../../parsing';
import { tradeResultEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'buy',
  category: 'market',
  description: 'Buy shares at the current market price.',
  args: [
    symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true }),
    stringArg('quantity', 'How many shares.', { required: true, example: '10' }),
  ],
  async execute(ctx, args, services) {
    const requested = String(args.symbol);
    const fill = await withHeraErrors(ctx, async () => {
      const company = services.market.resolveSymbol(ctx.guildId, requested);
      if (!company) throw new HeraError(`No listing matches \`${requested}\`.`);
      const [estimate] = services.trading.estimateExecutionPrice(company, 1, 'buy');
      const account = services.economy.getAccount(ctx.userId, ctx.guildId);
      const maxShares = Math.max(0, Math.trunc(account.wallet / Math.max(estimate, 0.01)));
      const quantity = parseAmount(String(args.quantity), maxShares);
      return services.trading.buy(ctx.userId, ctx.guildId, requested, quantity);
    });
    if (!fill) return;

    await ctx.reply({
      embeds: [
        tradeResultEmbed({
          title: '\u2705 Order filled',
          description: fill.message,
          color: config.embedColor,
          fields: [
            ['Shares', fill.quantity.toLocaleString()],
            ['Fill price', price(fill.price)],
            ['Gross', money(fill.gross)],
            ['Commission', money(fill.commission)],
            ['Slippage', `${fill.slippagePct.toFixed(2)}%`],
          ],
        }),
      ],
    });
  },
};
