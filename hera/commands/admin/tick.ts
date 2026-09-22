/** `/tick` — advance the market by hand. Operator-only. */
import { PermissionFlagsBits, type GuildMember } from 'discord.js';

import { config } from '../../config';
import { ephemeralError } from '../../framework/helpers';
import { intArg, type CommandDefinition } from '../../framework/types';
import { tradeResultEmbed } from '../../ui/embeds';

/** Owner, administrators, or anyone with Manage Server may drive the simulation. */
export function isOperator(
  ctx: { userId: string; member: GuildMember | null },
  ownerId: string | null,
): boolean {
  if (ownerId && ctx.userId === ownerId) return true;
  if (!ctx.member) return false;
  return ctx.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

export const command: CommandDefinition = {
  name: 'tick',
  category: 'admin',
  description: 'Advance the market by one tick right now.',
  args: [intArg('count', 'How many ticks to advance (1-24).', { required: false, minValue: 1, maxValue: 24 })],
  async execute(ctx, args, services) {
    if (!isOperator(ctx, services.ownerId)) {
      await ephemeralError(ctx, 'You need the Manage Server permission to use that.');
      return;
    }
    const count = Math.max(1, Math.min(24, Number(args.count ?? 1)));
    await ctx.defer();
    for (let index = 0; index < count; index += 1) {
      await services.runMarketTick(ctx.guildId);
    }
    const snapshot = services.market.snapshot(ctx.guildId);
    await ctx.followUp({
      embeds: [
        tradeResultEmbed({
          title: '\u23E9 Market advanced',
          description: `Ran ${count} tick(s). Now at tick **${snapshot.tick.toLocaleString()}**.`,
          color: config.embedColor,
          fields: [
            ['Index', snapshot.indexValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
            ['Regime', snapshot.regime],
          ],
        }),
      ],
    });
  },
};
