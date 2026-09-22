/** `/work` — do a shift for some credits. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { ephemeralError } from '../../framework/helpers';
import type { CommandDefinition } from '../../framework/types';
import { CooldownActive } from '../../errors';
import { duration, money } from '../../formatting';

export const command: CommandDefinition = {
  name: 'work',
  category: 'economy',
  description: 'Do a shift for some credits.',
  async execute(ctx, _args, services) {
    let result: [number, { wallet: number }];
    try {
      result = services.economy.work(ctx.userId, ctx.guildId) as [number, { wallet: number }];
    } catch (error) {
      if (error instanceof CooldownActive) {
        await ephemeralError(
          ctx,
          `You are still tired. Try again in **${duration(error.secondsRemaining)}**.`,
        );
        return;
      }
      throw error;
    }
    const [payout, account] = result;
    const embed = new EmbedBuilder()
      .setTitle('\u{1F6E0}\uFE0F Shift complete')
      .setDescription(`You earned ${money(payout)}.`)
      .setColor(config.embedColor)
      .addFields({ name: 'New wallet', value: money(account.wallet), inline: true });
    await ctx.reply({ embeds: [embed] });
  },
};
