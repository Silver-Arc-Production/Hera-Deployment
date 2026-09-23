/** `/gambleleaderboard` — Members ranked by peak gambling winnings. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import type { CommandDefinition } from '../../framework/types';
import { money } from '../../formatting';

export const command: CommandDefinition = {
  name: 'gambleleaderboard',
  category: 'casino',
  description: 'Members ranked by peak gambling winnings.',
  async execute(ctx, _args, services) {
    const rows = services.gambling.leaderboard(ctx.guildId).filter((row) => row.earned > 0);
    const medals = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
    const embed = new EmbedBuilder()
      .setTitle('\u{1F3C6} Casino leaderboard')
      .setColor(config.embedColor)
      .setDescription(
        rows.length === 0
          ? 'Nobody has won anything yet. Be the first \u2014 try `/coinflip heads 100`.'
          : rows
              .map((row, index) => {
                const prefix = index < medals.length ? medals[index] : `\`#${index + 1}\``;
                return `${prefix} **${services.displayName(row.userId)}** \u2014 ${money(row.earned, { decimals: 0 })}`;
              })
              .join('\n'),
      )
      .setFooter({ text: 'Ranked by peak net winnings, not total wagered.' });
    await ctx.reply({ embeds: [embed] });
  },
};
