/** `/alerts` — list your active price alerts. */
import type { CommandDefinition } from '../../framework/types';
import { alertsEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'alerts',
  category: 'market',
  description: 'List your active price alerts.',
  async execute(ctx, _args, services) {
    const rows = services.trading.listAlerts(ctx.userId, ctx.guildId);
    await ctx.reply({
      embeds: [alertsEmbed(rows, { displayName: ctx.user.displayName })],
      ephemeral: true,
    });
  },
};
