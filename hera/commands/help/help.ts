/** `/help` — list every command, or explain one in detail. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { ephemeralError } from '../../framework/helpers';
import { stringArg, type CommandDefinition } from '../../framework/types';
import { errorEmbed } from '../../ui/embeds';
import {
  categoryEmbed,
  detailEmbed,
  groupedCommands,
  paginate,
  type BotCommandIndex,
} from './directory';
import { Paginator } from '../../ui/views';

export const command: CommandDefinition = {
  name: 'help',
  category: 'help',
  description: 'List every command, or explain one in detail.',
  args: [stringArg('command', 'Optional: a command name to explain.', { required: false })],
  async execute(ctx, args, services) {
    const index: BotCommandIndex = services.commandIndex;
    if (args.command) {
      const cleaned = String(args.command).trim().replace(/^[!/]+/, '').toLowerCase();
      const embed = detailEmbed(index, cleaned, config.prefix);
      if (!embed) {
        await ephemeralError(
          ctx,
          `No command called \`${cleaned}\`. Run \`${config.prefix}help\` to see them all.`,
        );
        return;
      }
      await ctx.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    const buckets = groupedCommands(index);
    const pages = paginate(buckets);
    if (pages.length === 0) {
      await ctx.reply({ embeds: [errorEmbed('No commands are loaded.')], ephemeral: true });
      return;
    }
    const paginator = new Paginator({
      authorId: ctx.userId,
      totalPages: pages.length,
      build: (position) => {
        const page = pages[position];
        return categoryEmbed(index, page.category, page.entries, { continued: page.continued, prefix: config.prefix });
      },
    });
    const state = paginator.state;
    const messageId = await ctx.reply({
      embeds: [state.embed as EmbedBuilder],
      components: state.components,
    });
    if (messageId) services.registerView(messageId, paginator);
  },
};
