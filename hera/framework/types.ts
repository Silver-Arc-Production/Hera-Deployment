/**
 * The command definition model shared by every command file.
 *
 * A command is written once as a plain :class:`CommandDefinition`. The loader
 * turns it into a slash command *and* a prefix command, so the two front ends
 * share one callback and cannot drift apart.
 */
import type { CommandContext } from './context';

export type CommandCategory = 'market' | 'economy' | 'casino' | 'admin' | 'help';

export type ArgumentType = 'string' | 'integer' | 'number' | 'user';

export interface Choice {
  name: string;
  value: string;
}

export interface CommandArgument {
  name: string;
  description: string;
  type: ArgumentType;
  required?: boolean;
  /** Fixed set of accepted values. Prefix users get these validated locally. */
  choices?: Choice[];
  /** Dynamic suggestions, only available on the slash front end. */
  autocomplete?: (
    query: { guildId: string | null; userId: string; focused: string },
    services: CommandServices,
  ) => Promise<Choice[]>;
  minValue?: number;
  maxValue?: number;
  /** Placeholder shown when a prefix user omits or mistypes the argument. */
  example?: string;
}

/**
 * The shared services a command body may use. Passed to every ``execute`` so
 * commands never reach for globals.
 */
export interface CommandServices {
  market: import('../services/market').MarketService;
  trading: import('../services/trading').TradingService;
  economy: import('../services/economy').EconomyService;
  gambling: import('../gambling/service').GamblingService;
  /** Resolve a cached user's display name, for leaderboards. */
  displayName(userId: string): string;
  /** Advance the market by one tick by hand (admin). */
  runMarketTick(guildId: string): Promise<void>;
  /** Register a paginator so its buttons route back to it. */
  registerView(messageId: string, paginator: import('../ui/views').Paginator): void;
  /** The live command index, used by the help directory. */
  commandIndex: import('../commands/help/directory').BotCommandIndex;
  ownerId: string | null;
}

export interface CommandDefinition {
  name: string;
  category: CommandCategory;
  description: string;
  args?: CommandArgument[];
  execute(
    ctx: CommandContext,
    args: Record<string, unknown>,
    services: CommandServices,
  ): Promise<void>;
}

// ---------------------------------------------------------------- arg helpers

export function stringArg(
  name: string,
  description: string,
  options: Partial<Omit<CommandArgument, 'name' | 'description' | 'type'>> = {},
): CommandArgument {
  return { name, description, type: 'string', ...options };
}

export function intArg(
  name: string,
  description: string,
  options: Partial<Omit<CommandArgument, 'name' | 'description' | 'type'>> = {},
): CommandArgument {
  return { name, description, type: 'integer', ...options };
}

export function numberArg(
  name: string,
  description: string,
  options: Partial<Omit<CommandArgument, 'name' | 'description' | 'type'>> = {},
): CommandArgument {
  return { name, description, type: 'number', ...options };
}

export function userArg(
  name: string,
  description: string,
  options: Partial<Omit<CommandArgument, 'name' | 'description' | 'type'>> = {},
): CommandArgument {
  return { name, description, type: 'user', ...options };
}

/** A string argument restricted to a fixed set of values. */
export function choiceArg(
  name: string,
  description: string,
  values: string[],
  options: Partial<Omit<CommandArgument, 'name' | 'description' | 'type' | 'choices'>> = {},
): CommandArgument {
  return {
    name,
    description,
    type: 'string',
    choices: values.map((value) => ({ name: value, value })),
    ...options,
  };
}

/** A string argument that suggests live tickers on the slash front end. */
export function symbolArg(
  name: string,
  description: string,
  autocomplete: CommandArgument['autocomplete'],
  options: Partial<Omit<CommandArgument, 'name' | 'description' | 'type' | 'autocomplete'>> = {},
): CommandArgument {
  return { name, description, type: 'string', autocomplete, ...options };
}
