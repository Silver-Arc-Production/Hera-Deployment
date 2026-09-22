/** `/cover` — close part or all of a short position. */
import { config } from '../../config';
import { symbolAutocomplete } from '../../framework/autocomplete';
import { withHeraErrors } from '../../framework/helpers';
import { symbolArg, stringArg, type CommandDefinition } from '../../framework/types';
import { HeraError, InsufficientShares } from '../../errors';
import { price, shares, signed } from '../../formatting';
import { parseAmount } from '../../parsing';
import { tradeResultEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'cover',
  category: 'market',
  description: 'Close part or all of a short position.',
  args: [
    symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true }),
    stringArg('quantity', "Shares to cover, or 'all'.", { required: true, example: 'all' }),
  ],
  async execute(ctx, args, services) {
    const requested = String(args.symbol);
    const fill = await withHeraErrors(ctx, async () => {
      const company = services.market.resolveSymbol(ctx.guildId, requested);
      if (!company) throw new HeraError(`No listing matches \`${requested}\`.`);
      const short = services.trading.getShort(ctx.userId, ctx.guildId, company.symbol);
      const held = short ? short.quantity : 0;
      if (held <= 0) throw new InsufficientShares(company.symbol, 1, 0);
      const quantity = parseAmount(String(args.quantity), held);
      return services.trading.cover(ctx.userId, ctx.guildId, requested, quantity);
    });
    if (!fill) return;

    await ctx.reply({
      embeds: [
        tradeResultEmbed({
          title: '\u2705 Short covered',
          description: fill.message,
          color: fill.realizedPnl >= 0 ? config.embedColor : config.errorColor,
          fields: [
            ['Shares', shares(fill.quantity)],
            ['Cover price', price(fill.price)],
            ['Realised P/L', signed(fill.realizedPnl)],
          ],
        }),
      ],
    });
  },
};
