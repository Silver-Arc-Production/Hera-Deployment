/** `/traders` — rank members by portfolio net worth. */
import type { CommandDefinition } from '../../framework/types';
import { leaderboardEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'traders',
  category: 'market',
  description: 'Rank members by portfolio net worth.',
  async execute(ctx, _args, services) {
    const rows = services.trading.leaderboard(ctx.guildId);
    const names = new Map(rows.map((row) => [row.userId, services.displayName(row.userId)]));
    await ctx.reply({ embeds: [leaderboardEmbed(rows, { names, kind: 'Trader' })] });
  },
};
