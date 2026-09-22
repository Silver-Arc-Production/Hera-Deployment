/**
 * Turns :class:`CommandDefinition`s into live slash and prefix commands.
 *
 * Slash commands are declared to Discord with ``SlashCommandBuilder``. Prefix
 * commands are resolved from message text against the same definitions, so both
 * front ends share one callback. Fixed-choice arguments are validated locally for
 * prefix users, and user arguments accept a mention or a raw id.
 */
import {
  SlashCommandBuilder,
  SlashCommandStringOption,
  SlashCommandIntegerOption,
  SlashCommandNumberOption,
  SlashCommandUserOption,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Message,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

import { PrefixContext, SlashContext, type CommandContext } from './context';
import type { CommandArgument, CommandDefinition, CommandServices } from './types';
import { config } from '../config';

export type CommandHandler = (ctx: CommandContext, args: Record<string, unknown>) => Promise<void>;

export class PrefixArgumentError extends Error {}

/** Build the JSON payload Discord needs to register a slash command. */
export function buildSlashData(definition: CommandDefinition): RESTPostAPIChatInputApplicationCommandsJSONBody {
  const builder = new SlashCommandBuilder()
    .setName(definition.name)
    .setDescription(definition.description.slice(0, 100));

  for (const arg of definition.args ?? []) {
    switch (arg.type) {
      case 'string':
        builder.addStringOption((option) => configureString(option, arg));
        break;
      case 'integer':
        builder.addIntegerOption((option) => configureInteger(option, arg));
        break;
      case 'number':
        builder.addNumberOption((option) => configureNumber(option, arg));
        break;
      case 'user':
        builder.addUserOption((option) => {
          option.setName(arg.name).setDescription(arg.description).setRequired(arg.required ?? false);
          return option;
        });
        break;
    }
  }

  return builder.toJSON();
}

function configureString(option: SlashCommandStringOption, arg: CommandArgument): SlashCommandStringOption {
  option.setName(arg.name).setDescription(arg.description).setRequired(arg.required ?? false);
  if (arg.choices) option.addChoices(...arg.choices.map((choice) => ({ name: choice.name, value: choice.value })));
  if (arg.autocomplete) option.setAutocomplete(true);
  return option;
}

function configureInteger(option: SlashCommandIntegerOption, arg: CommandArgument): SlashCommandIntegerOption {
  option.setName(arg.name).setDescription(arg.description).setRequired(arg.required ?? false);
  if (arg.minValue !== undefined) option.setMinValue(arg.minValue);
  if (arg.maxValue !== undefined) option.setMaxValue(arg.maxValue);
  return option;
}

function configureNumber(option: SlashCommandNumberOption, arg: CommandArgument): SlashCommandNumberOption {
  option.setName(arg.name).setDescription(arg.description).setRequired(arg.required ?? false);
  if (arg.minValue !== undefined) option.setMinValue(arg.minValue);
  if (arg.maxValue !== undefined) option.setMaxValue(arg.maxValue);
  return option;
}

/** Read the arguments a slash interaction supplied. */
export function readSlashArgs(
  definition: CommandDefinition,
  interaction: ChatInputCommandInteraction,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of definition.args ?? []) {
    switch (arg.type) {
      case 'string': {
        const value = interaction.options.getString(arg.name);
        if (value !== null) args[arg.name] = value;
        break;
      }
      case 'integer': {
        const value = interaction.options.getInteger(arg.name);
        if (value !== null) args[arg.name] = value;
        break;
      }
      case 'number': {
        const value = interaction.options.getNumber(arg.name);
        if (value !== null) args[arg.name] = value;
        break;
      }
      case 'user': {
        const value = interaction.options.getUser(arg.name);
        if (value !== null) args[arg.name] = value;
        break;
      }
    }
  }
  return args;
}

/**
 * Read the arguments a prefix message supplied.
 *
 * The last argument greedily consumes the remaining words, matching how people
 * type ``!compare NOVA TERA BREW``.
 */
export function readPrefixArgs(
  definition: CommandDefinition,
  tokens: string[],
  message: Message,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const spec = definition.args ?? [];
  let index = 0;

  for (let position = 0; position < spec.length; position += 1) {
    const arg = spec[position];
    const isLast = position === spec.length - 1;
    let token: string | undefined;

    if (isLast && arg.type === 'string' && (arg.choices === undefined)) {
      // Free-form trailing string (e.g. a list of tickers) takes the rest.
      token = tokens.slice(index).join(' ') || undefined;
      index = tokens.length;
    } else {
      token = tokens[index];
      index += 1;
    }

    if (token === undefined || token === '') {
      if (arg.required) {
        throw new PrefixArgumentError(missingArgumentMessage(definition, arg));
      }
      continue;
    }

    switch (arg.type) {
      case 'string': {
        if (!arg.choices) {
          args[arg.name] = token;
          break;
        }
        const matched = arg.choices.find((choice) => choice.value.toLowerCase() === token!.toLowerCase());
        if (!matched) {
          const allowed = arg.choices.map((choice) => choice.value).join(', ');
          throw new PrefixArgumentError(
            `\`${arg.name}\` must be one of: ${allowed}. ${usage(definition, config.prefix)}`,
          );
        }
        args[arg.name] = matched.value;
        break;
      }
      case 'integer': {
        const value = Number.parseInt(token, 10);
        if (Number.isNaN(value)) {
          throw new PrefixArgumentError(`\`${arg.name}\` must be a whole number. ${usage(definition, config.prefix)}`);
        }
        args[arg.name] = value;
        break;
      }
      case 'number': {
        const value = Number.parseFloat(token);
        if (Number.isNaN(value)) {
          throw new PrefixArgumentError(`\`${arg.name}\` must be a number. ${usage(definition, config.prefix)}`);
        }
        args[arg.name] = value;
        break;
      }
      case 'user': {
        const id = resolveUserId(token, message);
        if (id === null) {
          throw new PrefixArgumentError(`\`${arg.name}\` must be a member mention. ${usage(definition, config.prefix)}`);
        }
        args[arg.name] = id;
        break;
      }
    }
  }
  return args;
}

function resolveUserId(token: string, message: Message): string | null {
  const mention = /^<@!?(\d+)>$/.exec(token);
  if (mention) return mention[1];
  if (/^\d{15,25}$/.test(token)) return token;
  const member =
    message.guild?.members.cache.find(
      (candidate) =>
        candidate.user.username.toLowerCase() === token.toLowerCase() ||
        candidate.displayName.toLowerCase() === token.toLowerCase(),
    ) ?? null;
  return member ? member.user.id : null;
}

function missingArgumentMessage(
  definition: CommandDefinition,
  arg: CommandArgument,
): string {
  return `\`${arg.name}\` is required: ${usage(definition, config.prefix)}`;
}

/** Render a copy-pasteable usage line, e.g. ``!buy <symbol> <quantity>``. */
export function usage(definition: CommandDefinition, prefix: string): string {
  const parts = (definition.args ?? []).map((arg) =>
    arg.required ? `<${arg.name}>` : `[${arg.name}]`,
  );
  const suffix = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  return `\`${prefix}${definition.name}${suffix}\``;
}

export async function dispatchSlash(
  definition: CommandDefinition,
  handler: CommandHandler,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const args = readSlashArgs(definition, interaction);
  await handler(new SlashContext(interaction), args);
}

export function dispatchPrefix(
  definition: CommandDefinition,
  handler: CommandHandler,
  message: Message,
  tokens: string[],
): Promise<void> {
  const args = readPrefixArgs(definition, tokens, message);
  return handler(new PrefixContext(message), args);
}

/** Route an autocomplete interaction to the argument that requested it. */
export async function handleAutocomplete(
  definition: CommandDefinition,
  interaction: AutocompleteInteraction,
  services: CommandServices,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const arg = (definition.args ?? []).find((candidate) => candidate.name === focused.name);
  if (!arg?.autocomplete) {
    await interaction.respond([]);
    return;
  }
  const choices = await arg.autocomplete(
    {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      focused: String(focused.value ?? ''),
    },
    services,
  );
  await interaction.respond(choices.slice(0, 25));
}

export interface PrefixCommand {
  definition: CommandDefinition;
  handler: CommandHandler;
}

/**
 * Find the prefix command a message invokes and the tokens that follow it.
 * Returns ``null`` when the message is not a command.
 */
export function matchPrefix(
  content: string,
  prefix: string,
  commands: Map<string, PrefixCommand>,
): { command: PrefixCommand; tokens: string[] } | null {
  if (!content.startsWith(prefix)) return null;
  const body = content.slice(prefix.length).trim();
  if (!body) return null;
  const tokens = body.split(/\s+/);
  const name = tokens.shift()!.toLowerCase();
  const command = commands.get(name);
  if (!command) return null;
  return { command, tokens };
}

/** Resolve which of a client's guilds a prefix/slash command applies to. */
export function guildIds(client: Client): string[] {
  return [...client.guilds.cache.keys()];
}
