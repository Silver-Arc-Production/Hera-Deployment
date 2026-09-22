/** `/short` — open a short position with posted collateral. */
import { config } from '../../config';
import { symbolAutocomplete } from '../../framework/autocomplete';
import { withHeraErrors } from '../../framework/helpers';
import { symbolArg, stringArg, type CommandDefinition } from '../../framework/types';
import { HeraError } from '../../errors';
import { money, price, shares } from '../../formatting';
import { parseAmount } from '../../parsing';
import { tradeResultEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'short',
  category: 'market',
  description: 'Open a short position with posted collateral.',
  args: [
    symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true }),
    stringArg('quantity', 'Shares to short (fractions allowed).', { required: true, example: '5' }),
  ],
  async execute(ctx, args, services) {
    const requested = String(args.symbol);
    const fill = await withHeraErrors(ctx, async () => {
      const company = services.market.resolveSymbol(ctx.guildId, requested);
      if (!company) throw new HeraError(`No listing matches \`${requested}\`.`);
      const quantity = parseAmount(String(args.quantity));
      return services.trading.short(ctx.userId, ctx.guildId, requested, quantity);
    });
    if (!fill) return;

    await ctx.reply({
      embeds: [
        tradeResultEmbed({
          title: '\u{1F4C9} Short opened',
          description: fill.message,
          color: config.errorColor,
          fields: [
            ['Shares', shares(fill.quantity)],
            ['Entry price', price(fill.price)],
            ['Position value', money(fill.gross)],
          ],
        }).setFooter({
          text: 'Profit if the price falls. Collateral is returned when you cover.',
        }),
      ],
    });
  },
};
