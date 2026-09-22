/** `/unalert` — remove one of your price alerts. */
import { config } from '../../config';
import { intArg, type CommandDefinition } from '../../framework/types';
import { errorEmbed, tradeResultEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'unalert',
  category: 'market',
  description: 'Remove one of your price alerts.',
  args: [intArg('alert_id', 'The alert number shown by /alerts.', { required: true, minValue: 1 })],
  async execute(ctx, args, services) {
    const alertId = Number(args.alert_id);
    const ok = services.trading.deleteAlert(ctx.userId, ctx.guildId, alertId);
    await ctx.reply({
      embeds: [
        ok
          ? tradeResultEmbed({
              title: '\u{1F5D1}\uFE0F Alert removed',
              description: `Alert **#${alertId}** is no longer active.`,
              color: config.embedColor,
            })
          : errorEmbed(`No active alert **#${alertId}** belongs to you.`),
      ],
      ephemeral: true,
    });
  },
};
