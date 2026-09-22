/** `/daily` — claim your daily reward and build a streak. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { ephemeralError } from '../../framework/helpers';
import type { CommandDefinition } from '../../framework/types';
import { CooldownActive } from '../../errors';
import { duration, money } from '../../formatting';

export const command: CommandDefinition = {
  name: 'daily',
  category: 'economy',
  description: 'Claim your daily reward and build a streak.',
  async execute(ctx, _args, services) {
    let result: [number, number, { bank: number }];
    try {
      result = services.economy.daily(ctx.userId, ctx.guildId) as [number, number, { bank: number }];
    } catch (error) {
      if (error instanceof CooldownActive) {
        await ephemeralError(
          ctx,
          `Already claimed. Come back in **${duration(error.secondsRemaining)}**.`,
        );
        return;
      }
      throw error;
    }
    const [payout, streak, account] = result;
    const embed = new EmbedBuilder()
      .setTitle('\u{1F381} Daily reward')
      .setDescription(`You collected ${money(payout)}.`)
      .setColor(config.embedColor)
      .addFields(
        { name: 'Streak', value: `${streak} day(s)`, inline: true },
        { name: 'Bank', value: money(account.bank), inline: true },
      )
      .setFooter({ text: 'Rewards go straight to your bank — spend them with /withdraw.' });
    await ctx.reply({ embeds: [embed] });
  },
};
