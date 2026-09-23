/**
 * The command directory: what exists, and how to call it.
 *
 * Slash and prefix users see the same information because both forms of every
 * command are listed side by side. Signatures are read from the live command
 * definitions, so the directory cannot fall out of step with the commands.
 */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import type { CommandDefinition } from '../../framework/types';
import { usage } from '../../framework/register';

/** Cog-equivalent grouping. The order here is the order of the pages. */
export const CATEGORIES: Record<string, [string, string]> = {
  economy: ['\u{1F4B0} Economy', 'Earning, banking and moving money between members.'],
  casino: ['\u{1F3B0} Casino', 'Games of chance, wager tiers and the gambling leaderboard.'],
  market: ['\u{1F4C8} Market', 'Quotes, trading, portfolios, alerts and the watchlist.'],
  admin: ['\u{1F527} Admin', 'Operator-only controls for the simulation.'],
  help: ['\u2139\uFE0F Help', 'Finding your way around.'],
};

const GUIDE_HINT = 'New to the market? Read `/markethelp` \u2014 it explains ticks, risk and trading.';

// Discord caps an embed at 25 fields. Stay below it so a growing category spills
// onto another page instead of being rejected at send time.
export const MAX_FIELDS_PER_PAGE = 20;

export interface BotCommandIndex {
  commands: Map<string, CommandDefinition>;
}

function slashUsage(definition: CommandDefinition): string {
  const parts = (definition.args ?? []).map((arg) =>
    arg.required ? `<${arg.name}>` : `[${arg.name}]`,
  );
  const suffix = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  return `\`/${definition.name}${suffix}\``;
}

/** Bucket every command by its category. */
export function groupedCommands(
  index: BotCommandIndex,
): Record<string, CommandDefinition[]> {
  const buckets: Record<string, CommandDefinition[]> = {};
  for (const definition of [...index.commands.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!(definition.category in CATEGORIES)) continue;
    (buckets[definition.category] ??= []).push(definition);
  }
  return buckets;
}

export interface DirectoryPage {
  category: string;
  entries: CommandDefinition[];
  continued: boolean;
}

/** Flatten the categories into pages that fit an embed's field limit. */
export function paginate(buckets: Record<string, CommandDefinition[]>): DirectoryPage[] {
  const pages: DirectoryPage[] = [];
  for (const category of Object.keys(CATEGORIES)) {
    const entries = buckets[category];
    if (!entries || entries.length === 0) continue;
    for (let start = 0; start < entries.length; start += MAX_FIELDS_PER_PAGE) {
      pages.push({
        category,
        entries: entries.slice(start, start + MAX_FIELDS_PER_PAGE),
        continued: start > 0,
      });
    }
  }
  return pages;
}

export function categoryEmbed(
  _index: BotCommandIndex,
  category: string,
  entries: CommandDefinition[],
  options: { continued: boolean; prefix: string },
): EmbedBuilder {
  const [title, blurb] = CATEGORIES[category];
  const heading = options.continued ? `${title} \u2014 commands (continued)` : `${title} \u2014 commands`;
  const embed = new EmbedBuilder()
    .setTitle(heading)
    .setDescription(`${blurb}\nUse the command on its own or type the prefix form.\n\n${GUIDE_HINT}`)
    .setColor(config.embedColor);
  for (const definition of entries) {
    const forms = `${usage(definition, options.prefix)} \u00B7 ${slashUsage(definition)}`;
    embed.addFields({
      name: forms,
      value: (definition.description || 'No description.').trim(),
      inline: false,
    });
  }
  return embed;
}

/** One command explained in full, or ``null`` if no such command exists. */
export function detailEmbed(
  index: BotCommandIndex,
  name: string,
  prefix: string,
): EmbedBuilder | null {
  const definition = index.commands.get(name);
  if (!definition) return null;

  const embed = new EmbedBuilder()
    .setTitle(`\u2139\uFE0F ${name}`)
    .setDescription(definition.description || 'No description.')
    .setColor(config.embedColor);
  embed.addFields({ name: 'Prefix', value: usage(definition, prefix), inline: false });
  embed.addFields({ name: 'Slash', value: slashUsage(definition), inline: false });

  if (definition.args && definition.args.length > 0) {
    const lines = definition.args.map((arg) => {
      const requirement = arg.required ? 'required' : 'optional';
      if (arg.choices) {
        const allowed = arg.choices.map((choice) => choice.name).join(', ');
        return `\u2022 \`${arg.name}\` (${requirement}) \u2014 one of: ${allowed}`;
      }
      return `\u2022 \`${arg.name}\` (${requirement})`;
    });
    embed.addFields({ name: 'Parameters', value: lines.join('\n'), inline: false });
  }

  embed.setFooter({ text: GUIDE_HINT });
  return embed;
}
