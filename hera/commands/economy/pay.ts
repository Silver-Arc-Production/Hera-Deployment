/** `/pay` — send credits to another member. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { ephemeralError, resolveMember, withHeraErrors } from '../../framework/helpers';
import { stringArg, userArg, type CommandDefinition } from '../../framework/types';
import { money } from '../../formatting';
import { parseAmount } from '../../parsing';

export const command: CommandDefinition = {
  name: 'pay',
  category: 'economy',
  description: 'Send credits to another member.',
  args: [
    userArg('member', 'Who to pay.', { required: true }),
    stringArg('amount', 'How much to send.', { required: true, example: '500' }),
  ],
  async execute(ctx, args, services) {
    const member = resolveMember(args.member, ctx, (id) => services.displayName(id));
    if (!member) {
      await ephemeralError(ctx, 'Pick a member to pay.');
      return;
    }
    if (member.id === ctx.userId) {
      await ephemeralError(ctx, 'You cannot pay yourself.');
      return;
    }
    const value = await withHeraErrors(ctx, async () => {
      const account = services.economy.getAccount(ctx.userId, ctx.guildId);
      const amount = parseAmount(String(args.amount), account.wallet);
      services.economy.debit(ctx.userId, ctx.guildId, amount, {
        kind: 'transfer_out',
        note: `Paid ${member.displayName}`,
      });
      services.economy.credit(member.id, ctx.guildId, amount, {
        kind: 'transfer_in',
        note: `Payment from ${ctx.user.displayName}`,
      });
      return amount;
    });
    if (!value) return;
    const embed = new EmbedBuilder()
      .setTitle('\u{1F4B8} Payment sent')
      .setDescription(`${ctx.user} paid <@${member.id}> ${money(value)}.`)
      .setColor(config.embedColor);
    await ctx.reply({ embeds: [embed] });
  },
};
