/** `/list` — browse every listed company, optionally filtered by sector. */
import { SECTORS } from '../../market/companies';
import { choiceArg, type CommandDefinition } from '../../framework/types';
import { stockListEmbed } from '../../ui/embeds';
import { Paginator } from '../../ui/views';

const PER_PAGE = 5;

export const command: CommandDefinition = {
  name: 'list',
  category: 'market',
  description: 'Browse every listed company.',
  args: [choiceArg('sector', 'Filter the board to a single sector.', [...SECTORS], { required: false })],
  async execute(ctx, args, services) {
    const sector = (args.sector as string | undefined) ?? null;
    const snapshot = services.market.snapshot(ctx.guildId);
    let companies = snapshot.companies;
    if (sector) companies = companies.filter((company) => company.sector === sector);
    companies = [...companies].sort((a, b) => a.symbol.localeCompare(b.symbol));

    const pages = Math.max(1, Math.ceil(companies.length / PER_PAGE));
    const paginator = new Paginator({
      authorId: ctx.userId,
      totalPages: pages,
      build: (page) => stockListEmbed(companies, { page, perPage: PER_PAGE, sector }),
    });
    const state = paginator.state;
    const messageId = await ctx.reply({ embeds: [state.embed], components: state.components });
    if (messageId) services.registerView(messageId, paginator);
  },
};
