/** `/gambleinfo [member]` — Your casino record and per-game totals. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { resolveMember, selfMember } from '../../framework/helpers';
import { userArg, type CommandDefinition } from '../../framework/types';
import { money, percent, signed } from '../../formatting';
import { GAME_META } from '../../gambling/games';
import { progressLine } from './shared';

export const command: CommandDefinition = {
  name: 'gambleinfo',
  category: 'casino',
  description: 'Your casino record and per-game totals.',
  args: [userArg('member', 'Look up someone else instead.', { required: false })],
  async execute(ctx, args, services) {
    const target =
      resolveMember(args.member, ctx, (id) => services.displayName(id)) ?? selfMember(ctx);
    const profile = services.gambling.getProfile(target.id, ctx.guildId);
    const level = services.gambling.levelOf(profile);
    const next = services.gambling.nextLevel(level);
    const stats = services.gambling.gameStats(target.id, ctx.guildId);

    const winRate = profile.bets > 0 ? (profile.wins / profile.bets) * 100 : 0;
    const embed = new EmbedBuilder()
      .setTitle(`\u{1F3B0} ${target.displayName}'s casino record`)
      .setColor(config.embedColor)
      .addFields(
        { name: 'Table', value: `${level.emoji} ${level.name}`, inline: true },
        { name: 'Net winnings', value: signed(profile.earned, { decimals: 0 }), inline: true },
        { name: 'Peak winnings', value: money(profile.peakEarned, { decimals: 0 }), inline: true },
        { name: 'Total wagered', value: money(profile.wagered, { decimals: 0 }), inline: true },
        { name: 'Bets placed', value: profile.bets.toLocaleString(), inline: true },
        { name: 'Win rate', value: percent(winRate, { signedOutput: false }), inline: true },
        { name: 'Biggest win', value: signed(profile.biggestWin, { decimals: 0 }), inline: true },
      );

    if (stats.length > 0) {
      embed.addFields({
        name: '\u{1F4CA} By game',
        value: stats
          .map((row) => {
            const meta = GAME_META[row.game];
            const label = meta ? `${meta.emoji} ${meta.name}` : row.game;
            return `${label} \u2014 ${row.plays.toLocaleString()} play(s), ${signed(row.net, { decimals: 0 })}`;
          })
          .join('\n'),
        inline: false,
      });
    } else {
      embed.addFields({ name: 'By game', value: 'No bets placed yet.', inline: false });
    }

    embed.addFields({
      name: 'Next tier',
      value: progressLine(profile.peakEarned, level, next),
      inline: false,
    });
    await ctx.reply({ embeds: [embed] });
  },
};
