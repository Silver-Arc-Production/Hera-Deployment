/** `/bankupgrade` — buy more space in your bank. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { ephemeralError } from '../../framework/helpers';
import type { CommandDefinition } from '../../framework/types';
import { InsufficientFunds } from '../../errors';
import { money } from '../../formatting';

export const command: CommandDefinition = {
  name: 'bankupgrade',
  category: 'economy',
  description: 'Buy more space in your bank.',
  async execute(ctx, _args, services) {
    const account = services.economy.getAccount(ctx.userId, ctx.guildId);
    const cost = config.economy.bankUpgradeBaseCost * account.bankLevel;
    let result: [{ bankLevel: number; bankCapacity: number }, number];
    try {
      result = services.economy.upgradeBank(ctx.userId, ctx.guildId);
    } catch (error) {
      if (error instanceof InsufficientFunds) {
        await ephemeralError(
          ctx,
          `You need ${money(cost)} in your wallet. You have ${money(error.available)}.`,
        );
        return;
      }
      throw error;
    }
    const [updated, paid] = result;
    const embed = new EmbedBuilder()
      .setTitle('\u{1F3E6} Bank upgraded')
      .setDescription(`Paid ${money(paid)} for level ${updated.bankLevel}.`)
      .setColor(config.embedColor)
      .addFields({ name: 'New capacity', value: money(updated.bankCapacity), inline: true });
    await ctx.reply({ embeds: [embed] });
  },
};
