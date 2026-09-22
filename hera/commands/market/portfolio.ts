/** `/portfolio` — your holdings, cash and profit and loss. */
import { resolveMember, selfMember } from '../../framework/helpers';
import { userArg, type CommandDefinition } from '../../framework/types';
import { portfolioEmbed } from '../../ui/embeds';

export const command: CommandDefinition = {
  name: 'portfolio',
  category: 'market',
  description: 'Your holdings, cash and profit and loss.',
  args: [userArg('member', "Inspect someone else's portfolio.", { required: false })],
  async execute(ctx, args, services) {
    const target =
      resolveMember(args.member, ctx, (id) => services.displayName(id)) ?? selfMember(ctx);
    const result = services.trading.getPortfolio(target.id, ctx.guildId);
    await ctx.reply({ embeds: [portfolioEmbed(result, { displayName: target.displayName })] });
  },
};
