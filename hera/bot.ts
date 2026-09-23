/**
 * Bot wiring: shared services, command registration, background market ticker and
 * event dispatch.
 *
 * Commands are discovered from ``hera/commands/<category>/*.ts`` and registered on
 * both front ends from one definition. Prefix invocation is handled by a
 * ``MessageCreate`` listener; slash invocation by the interaction handler; both
 * funnel through the same handler in :mod:`hera/framework/register`.
 */
import { join } from 'node:path';
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type User,
} from 'discord.js';
import { config } from './config';
import { Database } from './database';
import { HeraError } from './errors';
import { loadCommands } from './framework/registry';
import {
  dispatchPrefix,
  dispatchSlash,
  handleAutocomplete,
  matchPrefix,
  usage,
  PrefixArgumentError,
  type CommandHandler,
  type PrefixCommand,
} from './framework/register';
import type { CommandDefinition, CommandServices } from './framework/types';
import { EconomyService } from './services/economy';
import { MarketService } from './services/market';
import { TradingService } from './services/trading';
import { GamblingService } from './gambling/service';
import { errorEmbed } from './ui/embeds';
import { ViewRegistry } from './ui/views';
import { registerEvents, type EventContext } from './events';
import { outgoingFor } from './events/marketevents';

export type Logger = (message: string, error?: unknown) => void;

export interface BotOptions {
  log?: (message: string) => void;
  logError?: (message: string, error?: unknown) => void;
}

export class HeraBot extends Client {
  readonly db: Database;
  readonly economy: EconomyService;
  readonly market: MarketService;
  readonly trading: TradingService;
  readonly gambling: GamblingService;
  readonly commands = new Map<string, CommandDefinition>();
  readonly services: CommandServices;
  readonly ownerId: string | null = config.ownerId;
  readonly views = new ViewRegistry();

  private readonly definitions: CommandDefinition[] = [];
  private ticker: NodeJS.Timeout | null = null;
  private readonly knownGuilds = new Set<string>();
  private readonly prefixCommands = new Map<string, PrefixCommand>();
  private readonly displayNames = new Map<string, string>();
  private started = false;

  private readonly botOptions: BotOptions;

  constructor(options: BotOptions = {}, dbPath?: string) {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        // Two intents gate prefix commands. GuildMessages is what makes Discord
        // deliver MESSAGE_CREATE for guild channels at all; without it the bot
        // still boots and slash commands still work, but typed commands never
        // arrive. MessageContent is the privileged intent that fills in the
        // message text once an event is delivered.
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
    this.botOptions = options;

    this.db = new Database(dbPath ?? config.dbPath);
    this.economy = new EconomyService(this.db);
    this.market = new MarketService(this.db, config.market);
    this.trading = new TradingService(this.db, this.economy, this.market, config.trading);
    this.gambling = new GamblingService(this.db, this.economy, config.gambling);

    this.services = {
      market: this.market,
      trading: this.trading,
      economy: this.economy,
      gambling: this.gambling,
      displayName: (userId) => this.displayNames.get(userId) ?? `User ${userId}`,
      runMarketTick: (guildId) => this.runMarketTick(guildId),
      registerView: (messageId, paginator) => this.views.register(messageId, paginator),
      commandIndex: { commands: this.commands },
      ownerId: this.ownerId,
    };
  }

  // -------------------------------------------------------------- lifecycle

  /** Discover commands and wire the gateway listeners. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const { commands, failures } = loadCommands(join(__dirname, 'commands'));
    for (const [path, error] of failures) {
      this.botOptions.logError?.(`failed to load command file ${path}`, error);
    }
    for (const definition of commands) {
      if (this.commands.has(definition.name)) {
        this.botOptions.logError?.(`duplicate command name: ${definition.name}`);
        continue;
      }
      this.definitions.push(definition);
      this.commands.set(definition.name, definition);
      this.prefixCommands.set(definition.name, { definition, handler: this.handlerFor(definition) });
    }
    this.botOptions.log?.(`loaded ${this.definitions.length} commands`);

    registerEvents(this, this.eventContext());

    this.once(Events.ClientReady, () => void this.onReady());
    this.on(Events.InteractionCreate, (interaction) => void this.onInteraction(interaction));
    this.on(Events.MessageCreate, (message) => void this.onMessage(message));

    await this.login(config.token);
    await this.syncCommands();
  }

  private handlerFor(definition: CommandDefinition): CommandHandler {
    return (ctx, args) => definition.execute(ctx, args, this.services);
  }

  private async onReady(): Promise<void> {
    this.botOptions.log?.(`logged in as ${this.user?.tag ?? '?'}`);
    for (const guild of this.guilds.cache.values()) this.knownGuilds.add(guild.id);
    await this.startTicker();
    void this.user?.setActivity({ name: 'the Hera exchange', type: ActivityType.Watching });
  }

  private eventContext(): EventContext {
    return {
      guildJoined: (guildId) => this.knownGuilds.add(guildId),
      ensureGuild: (guildId) => this.knownGuilds.add(guildId),
      onTick: (guildId, result) =>
        this.announceTick(guildId, result as import('./market/engine').TickResult),
    };
  }

  // ---------------------------------------------------------- registration

  private async syncCommands(): Promise<void> {
    const rest = new REST().setToken(config.token);
    const payloads = this.definitions.map((definition) => buildCommandPayload(definition));

    if (config.guildId) {
      await rest.put(Routes.applicationGuildCommands(this.user!.id, config.guildId), {
        body: payloads,
      });
      this.botOptions.log?.(`synced ${payloads.length} commands to guild ${config.guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(this.user!.id), { body: payloads });
      this.botOptions.log?.(`synced ${payloads.length} global commands`);
    }
  }

  // ---------------------------------------------------------------- ticker

  private async startTicker(): Promise<void> {
    if (this.ticker) return;
    const intervalMs = Math.max(1, config.market.tickSeconds) * 1000;
    this.ticker = setInterval(() => {
      void this.tickAllGuilds();
    }, intervalMs);
    // Do not hold the process open solely for the ticker.
    this.ticker.unref?.();
    if (config.runMarketOnStartup) await this.tickAllGuilds();
  }

  private async tickAllGuilds(): Promise<void> {
    for (const guild of this.guilds.cache.values()) this.knownGuilds.add(guild.id);
    for (const guildId of [...this.knownGuilds]) {
      try {
        await this.runMarketTick(guildId);
      } catch (error) {
        this.botOptions.logError?.(`market tick failed for guild ${guildId}`, error);
      }
    }
  }

  // ------------------------------------------------------------ interactions

  private async onInteraction(interaction: import('discord.js').Interaction): Promise<void> {
    if (await this.views.dispatch(interaction)) return;
    if (interaction.isAutocomplete()) {
      await this.onAutocomplete(interaction);
      return;
    }
    if (interaction.isChatInputCommand()) {
      await this.onSlashCommand(interaction);
    }
  }

  private async onAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const definition = this.commands.get(interaction.commandName);
    if (!definition) {
      await interaction.respond([]);
      return;
    }
    try {
      await handleAutocomplete(definition, interaction, this.services);
    } catch {
      await interaction.respond([]);
    }
  }

  private async onSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const definition = this.commands.get(interaction.commandName);
    if (!definition) return;
    try {
      await dispatchSlash(definition, this.handlerFor(definition), interaction);
    } catch (error) {
      await this.reportSlashError(interaction, error);
    }
  }

  private async reportSlashError(
    interaction: ChatInputCommandInteraction,
    error: unknown,
  ): Promise<void> {
    const message = this.describeError(error);
    const embed = errorEmbed(message);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    } catch {
      // The interaction token can expire; nothing actionable to do.
    }
  }

  // -------------------------------------------------------------- prefix

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!this.user) return;
    const matched = matchPrefix(message.content, config.prefix, this.prefixCommands);
    if (!matched) return;
    if (message.guild) this.knownGuilds.add(message.guild.id);
    this.cacheUser(message.author);
    try {
      await dispatchPrefix(matched.command.definition, matched.command.handler, message, matched.tokens);
    } catch (error) {
      await this.reportPrefixError(message, matched.command.definition, error);
    }
  }

  private async reportPrefixError(
    message: Message,
    definition: CommandDefinition,
    error: unknown,
  ): Promise<void> {
    let text: string;
    if (error instanceof HeraError) {
      text = error.message;
    } else if (error instanceof PrefixArgumentError) {
      text = error.message;
    } else {
      this.botOptions.logError?.('prefix command error', error);
      text = 'Something went wrong handling that command.';
    }
    const embed =
      text.includes(config.prefix) && !(error instanceof HeraError)
        ? errorEmbed(text)
        : errorEmbed(text + (error instanceof HeraError ? `\n${usage(definition, config.prefix)}` : ''));
    try {
      await message.reply({ embeds: [embed] });
    } catch {
      // The message may have been deleted mid-command.
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof HeraError) return error.message;
    this.botOptions.logError?.('command error', error);
    return 'Something went wrong handling that command.';
  }

  // ------------------------------------------------------------ market tick

  /** One full market tick: prices, dividends, orders, alerts, news. */
  async runMarketTick(guildId: string): Promise<void> {
    const result = this.market.tick(guildId);

    if (Object.keys(result.dividends).length > 0) {
      this.trading.applyDividends(guildId, result.dividends);
    }

    const fills = this.trading.processOpenOrders(guildId);
    const alerts = this.trading.triggeredAlerts(guildId);
    const marginCalls = this.trading.marginCalls(guildId);

    await this.announceTick(guildId, result, fills, alerts, marginCalls);
  }

  private async announceTick(
    guildId: string,
    result: import('./market/engine').TickResult,
    fills: [string, import('./services/trading').Fill][] = [],
    alerts: import('./services/trading').AlertHit[] = [],
    marginCalls: import('./services/trading').MarginCall[] = [],
  ): Promise<void> {
    void guildId;
    const messages = outgoingFor(result, fills, alerts, marginCalls);
    for (const message of messages) {
      if (message.channel) {
        await this.postToMarketChannel(message.embed);
      } else if (message.userId) {
        // Order fills and alerts are private, so they go out as direct messages.
        await this.safeDm(message.userId, message.embed);
      }
    }
  }

  private async postToMarketChannel(embed: import('discord.js').EmbedBuilder): Promise<void> {
    if (!config.marketChannelId) return;
    const channel = this.channels.cache.get(config.marketChannelId);
    if (!channel || !('send' in channel)) return;
    try {
      await channel.send({ embeds: [embed] });
    } catch {
      this.botOptions.logError?.(`could not post market news to ${config.marketChannelId}`);
    }
  }

  private async safeDm(userId: string, embed: import('discord.js').EmbedBuilder): Promise<void> {
    try {
      const user = await this.users.fetch(userId);
      await user.send({ embeds: [embed] });
    } catch {
      // DMs closed is normal; nothing actionable to do.
    }
  }

  cacheUser(user: User): void {
    this.displayNames.set(user.id, user.displayName);
  }

  // ---------------------------------------------------------------- shutdown

  async shutdown(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.db.close();
    await this.destroy();
  }
}

// ------------------------------------------------------------- payload helpers

function toOptionPayload(arg: import('./framework/types').CommandArgument): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: arg.name,
    description: arg.description.slice(0, 100),
    required: arg.required ?? false,
  };
  switch (arg.type) {
    case 'string':
      base.type = 3;
      if (arg.choices) base.choices = arg.choices;
      if (arg.autocomplete) base.autocomplete = true;
      break;
    case 'integer':
      base.type = 4;
      if (arg.minValue !== undefined) base.min_value = arg.minValue;
      if (arg.maxValue !== undefined) base.max_value = arg.maxValue;
      break;
    case 'number':
      base.type = 10;
      if (arg.minValue !== undefined) base.min_value = arg.minValue;
      if (arg.maxValue !== undefined) base.max_value = arg.maxValue;
      break;
    case 'user':
      base.type = 6;
      break;
  }
  return base;
}

function buildCommandPayload(definition: CommandDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description.slice(0, 100),
    options: (definition.args ?? []).map(toOptionPayload),
  };
}
