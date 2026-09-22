/** `/position` — drill into one of your positions. */
import { symbolAutocomplete } from '../../framework/autocomplete';
import { ephemeralError } from '../../framework/helpers';
import { symbolArg, type CommandDefinition } from '../../framework/types';
import { percent, price, signed } from '../../formatting';
import { listingEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'position',
  category: 'market',
  description: 'Drill into one of your positions.',
  args: [symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true })],
  async execute(ctx, args, services) {
    const requested = String(args.symbol);
    const company = services.market.resolveSymbol(ctx.guildId, requested);
    if (!company) {
      await ephemeralError(ctx, `No listing matches \`${requested}\`.`);
      return;
    }
    const longPosition = services.trading.getPosition(ctx.userId, ctx.guildId, company.symbol);
    const shortPosition = services.trading.getShort(ctx.userId, ctx.guildId, company.symbol);
    if (!longPosition && !shortPosition) {
      await ephemeralError(ctx, `You have no open position in ${company.symbol}.`);
      return;
    }
    const embed = listingEmbed(company);
    if (longPosition) {
      embed.addFields({
        name: 'Long',
        value:
          `${longPosition.quantity.toLocaleString()} @ ${price(longPosition.averageCost)}  ` +
          `${signed(longPosition.unrealizedPnl)} (${percent(longPosition.unrealizedPct)})`,
        inline: false,
      });
    }
    if (shortPosition) {
      embed.addFields({
        name: 'Short',
        value:
          `${shortPosition.quantity.toLocaleString()} @ ${price(shortPosition.averagePrice)}  ` +
          `${signed(shortPosition.unrealizedPnl)} (${percent(shortPosition.unrealizedPct)})`,
        inline: false,
      });
    }
    await ctx.reply({ embeds: [embed] });
  },
};
