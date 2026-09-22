/** `/alert` — get pinged when a price crosses a level. */
import { config } from '../../config';
import { symbolAutocomplete } from '../../framework/autocomplete';
import { withHeraErrors } from '../../framework/helpers';
import { choiceArg, symbolArg, stringArg, type CommandDefinition } from '../../framework/types';
import { price } from '../../formatting';
import { parsePrice } from '../../parsing';
import { tradeResultEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'alert',
  category: 'market',
  description: 'Get pinged when a price crosses a level.',
  args: [
    symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true }),
    choiceArg('direction', 'above or below', ['above', 'below'], { required: true }),
    stringArg('threshold', 'The price to watch for.', { required: true, example: '250' }),
  ],
  async execute(ctx, args, services) {
    const direction = String(args.direction);
    const created = await withHeraErrors(ctx, async () => {
      const value = parsePrice(String(args.threshold));
      const alertId = services.trading.createAlert(
        ctx.userId,
        ctx.guildId,
        String(args.symbol),
        direction,
        value,
      );
      return { alertId, value };
    });
    if (!created) return;
    await ctx.reply({
      embeds: [
        tradeResultEmbed({
          title: '\u{1F514} Alert set',
          description:
            `Alert **#${created.alertId}** will fire when the price goes ${direction} ${price(created.value)}.`,
          color: config.embedColor,
        }),
      ],
      ephemeral: true,
    });
  },
};
