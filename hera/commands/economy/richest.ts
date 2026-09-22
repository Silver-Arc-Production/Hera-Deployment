/** `/richest` — show the wealthiest members in this server. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import type { CommandDefinition } from '../../framework/types';
import { money } from '../../formatting';

export const command: CommandDefinition = {
  name: 'richest',
  category: 'economy',
  description: 'Show the wealthiest members in this server.',
  async execute(ctx, _args, services) {
    const rows = services.economy.leaderboard(ctx.guildId);
    const medals = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
    const lines = rows.map((row, index) => {
      const name = services.displayName(String(row.user_id));
      const prefix = index < medals.length ? medals[index] : `\`#${String(index + 1).padStart(2)}\``;
      return `${prefix} **${name}** — ${money(Number(row.total))}`;
    });
    const embed = new EmbedBuilder()
      .setTitle('\u{1F3C6} Richest members')
      .setColor(config.embedColor)
      .setDescription(lines.join('\n') || 'Nobody has any wealth yet.');
    await ctx.reply({ embeds: [embed] });
  },
};
