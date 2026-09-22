/** `/history` — review your recent transactions. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { intArg, type CommandDefinition } from '../../framework/types';
import { signed } from '../../formatting';

export const command: CommandDefinition = {
  name: 'history',
  category: 'economy',
  description: 'Review your recent transactions.',
  args: [intArg('count', 'How many entries to show (max 25).', { required: false, minValue: 1, maxValue: 25 })],
  async execute(ctx, args, services) {
    const count = Math.max(1, Math.min(25, Number(args.count ?? 10)));
    const rows = services.economy.history(ctx.userId, ctx.guildId, count);
    const embed = new EmbedBuilder()
      .setTitle(`\u{1F9FE} ${ctx.user.displayName}'s transactions`)
      .setColor(config.embedColor);
    embed.setDescription(
      rows.length === 0
        ? 'No transactions yet.'
        : rows
            .map(
              (row) =>
                `\`${row.kind.padEnd(14)}\` ${signed(Number(row.amount)).padStart(16)}  ${row.note ?? ''}`,
            )
            .join('\n'),
    );
    await ctx.reply({ embeds: [embed], ephemeral: true });
  },
};
