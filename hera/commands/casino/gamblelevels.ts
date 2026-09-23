/** `/gamblelevels` — Show the six betting tiers and your progress. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import type { CommandDefinition } from '../../framework/types';
import { money } from '../../formatting';
import { progressLine } from './shared';

export const command: CommandDefinition = {
  name: 'gamblelevels',
  category: 'casino',
  description: 'Show the six betting tiers and your progress.',
  async execute(ctx, _args, services) {
    const { level, next, peakEarned } = services.gambling.progress(ctx.userId, ctx.guildId);
    const embed = new EmbedBuilder()
      .setTitle('\u{1F3C5} Casino tiers')
      .setColor(config.embedColor)
      .setDescription(
        'Your table is set by your **peak** gambling winnings. Win your way up the ladder \u2014 ' +
          'each tier raises both the floor and the ceiling on every bet.',
      );

    for (const tier of config.gambling.levels) {
      const unlocked = tier.index <= level.index;
      const mark = unlocked ? '\u2705' : '\u{1F512}';
      const here = tier.index === level.index ? ' \u2B05\uFE0F **you**' : '';
      embed.addFields({
        name: `${mark} ${tier.emoji} ${tier.name}${here}`,
        value:
          `Requires ${money(tier.requiredEarned, { decimals: 0 })} in peak winnings\n` +
          `Bets ${money(tier.minBet, { decimals: 0 })} \u2013 ${money(tier.maxBet, { decimals: 0 })}`,
        inline: false,
      });
    }

    embed.addFields({
      name: 'Your progress',
      value: progressLine(peakEarned, level, next),
      inline: false,
    });
    await ctx.reply({ embeds: [embed] });
  },
};
