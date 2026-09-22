/** `/rob` — try to steal from another member's wallet. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { ephemeralError, resolveMember } from '../../framework/helpers';
import { userArg, type CommandDefinition } from '../../framework/types';
import { CooldownActive, HeraError } from '../../errors';
import { duration, money } from '../../formatting';

export const command: CommandDefinition = {
  name: 'rob',
  category: 'economy',
  description: "Try to steal from another member's wallet.",
  args: [userArg('member', 'Who to rob.', { required: true })],
  async execute(ctx, args, services) {
    const member = resolveMember(args.member, ctx, (id) => services.displayName(id));
    if (!member || member.id === ctx.userId) {
      await ephemeralError(ctx, 'Pick a real member who is not you.');
      return;
    }
    let outcome: [boolean, number, { wallet: number }];
    try {
      outcome = services.economy.rob(ctx.userId, ctx.guildId, member.id) as [
        boolean,
        number,
        { wallet: number },
      ];
    } catch (error) {
      if (error instanceof CooldownActive) {
        await ephemeralError(ctx, `Lay low for **${duration(error.secondsRemaining)}**.`);
        return;
      }
      if (error instanceof HeraError) {
        await ephemeralError(ctx, error.message);
        return;
      }
      throw error;
    }
    const [success, amount, account] = outcome;
    const embed = success
      ? new EmbedBuilder()
          .setTitle('\u{1F575}\uFE0F Robbery successful')
          .setDescription(`You lifted ${money(amount)} from <@${member.id}>.`)
          .setColor(config.embedColor)
      : new EmbedBuilder()
          .setTitle('\u{1F6A8} Robbery failed')
          .setDescription(
            amount
              ? `You were caught and fined ${money(amount)}.`
              : 'You were caught, but had nothing to pay the fine with.',
          )
          .setColor(config.errorColor);
    embed.addFields({ name: 'Wallet', value: money(account.wallet), inline: true });
    await ctx.reply({ embeds: [embed] });
  },
};
