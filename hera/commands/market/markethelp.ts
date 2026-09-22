/** `/markethelp` — how the market works: ticks, risk, trading, getting started. */
import type { CommandDefinition } from '../../framework/types';
import { guideEmbed, guidePages } from '../../ui/guide';
import { Paginator } from '../../ui/views';

export const command: CommandDefinition = {
  name: 'markethelp',
  category: 'market',
  description: 'How the market works: ticks, risk, trading and getting started.',
  async execute(ctx, _args, services) {
    const pages = guidePages();
    const paginator = new Paginator({
      authorId: ctx.userId,
      totalPages: pages.length,
      build: (index) => guideEmbed(pages[index], { page: index, total: pages.length }),
    });
    const state = paginator.state;
    const messageId = await ctx.reply({ embeds: [state.embed], components: state.components });
    if (messageId) services.registerView(messageId, paginator);
  },
};
