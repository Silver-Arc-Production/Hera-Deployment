/** `/withdraw` — move credits from the bank to your wallet. */
import { withHeraErrors } from '../../framework/helpers';
import { stringArg, type CommandDefinition } from '../../framework/types';
import { parseAmount } from '../../parsing';
import { balanceEmbed } from './balance';

export const command: CommandDefinition = {
  name: 'withdraw',
  category: 'economy',
  description: 'Move credits from the bank to your wallet.',
  args: [stringArg('amount', "Amount to withdraw. Accepts 1k, 2.5m or 'all'.", { required: true, example: '1k' })],
  async execute(ctx, args, services) {
    const updated = await withHeraErrors(ctx, async () => {
      const account = services.economy.getAccount(ctx.userId, ctx.guildId);
      const value = parseAmount(String(args.amount), account.bank);
      return services.economy.withdraw(ctx.userId, ctx.guildId, value);
    });
    if (!updated) return;
    await ctx.reply({ embeds: [balanceEmbed(updated, ctx.user.displayName)] });
  },
};
