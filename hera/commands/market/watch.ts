/** `/watch` — add or remove a company from your watchlist. */
import { config } from '../../config';
import { symbolAutocomplete } from '../../framework/autocomplete';
import { withHeraErrors } from '../../framework/helpers';
import { choiceArg, symbolArg, type CommandDefinition } from '../../framework/types';
import { tradeResultEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'watch',
  category: 'market',
  description: 'Add or remove a company from your watchlist.',
  args: [
    choiceArg('action', 'add or remove', ['add', 'remove'], { required: true }),
    symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true }),
  ],
  async execute(ctx, args, services) {
    const action = String(args.action);
    const symbol = String(args.symbol);
    const message = await withHeraErrors(ctx, async () => {
      if (action === 'add') {
        const added = services.trading.addWatch(ctx.userId, ctx.guildId, symbol);
        return added ? `${symbol.toUpperCase()} added to your watchlist.` : 'Already on your watchlist.';
      }
      const removed = services.trading.removeWatch(ctx.userId, ctx.guildId, symbol);
      return removed ? `${symbol.toUpperCase()} removed.` : 'That was not on your watchlist.';
    });
    if (!message) return;
    await ctx.reply({
      embeds: [
        tradeResultEmbed({ title: '\u2B50 Watchlist', description: message, color: config.embedColor }),
      ],
      ephemeral: true,
    });
  },
};
