/** `/deposit` — move credits from your wallet into the bank. */
import { withHeraErrors } from '../../framework/helpers';
import { stringArg, type CommandDefinition } from '../../framework/types';
import { parseAmount } from '../../parsing';
import { balanceEmbed } from './balance';

export const command: CommandDefinition = {
  name: 'deposit',
  category: 'economy',
  description: 'Move credits from your wallet into the bank.',
  args: [stringArg('amount', "Amount to deposit. Accepts 1k, 2.5m or 'all'.", { required: true, example: '1k' })],
  async execute(ctx, args, services) {
    const updated = await withHeraErrors(ctx, async () => {
      const account = services.economy.getAccount(ctx.userId, ctx.guildId);
      const value = parseAmount(String(args.amount), account.wallet);
      return services.economy.transfer(ctx.userId, ctx.guildId, value);
    });
    if (!updated) return;
    await ctx.reply({ embeds: [balanceEmbed(updated, ctx.user.displayName)] });
  },
};
