/** `/quote` — the full quote for one company, plus your position if you hold one. */
import { symbolAutocomplete } from '../../framework/autocomplete';
import { ephemeralError } from '../../framework/helpers';
import { symbolArg, type CommandDefinition } from '../../framework/types';
import { listingEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'quote',
  category: 'market',
  description: 'Show the full quote for one company.',
  args: [symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true })],
  async execute(ctx, args, services) {
    const symbol = String(args.symbol);
    const company = services.market.resolveSymbol(ctx.guildId, symbol);
    if (!company) {
      await ephemeralError(ctx, `No listing matches \`${symbol}\`.`);
      return;
    }
    const position = services.trading.getPosition(ctx.userId, ctx.guildId, company.symbol);
    await ctx.reply({
      embeds: [
        listingEmbed(company, {
          held: position ? position.quantity : 0,
          averageCost: position ? position.averageCost : 0,
        }),
      ],
    });
  },
};
