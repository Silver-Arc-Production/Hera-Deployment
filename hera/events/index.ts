/**
 * Gateway events, kept separate from command handling.
 *
 * ``registerEvents`` wires the listeners that are not command dispatch: guild
 * joins (so a new server's market starts ticking) and the ready handshake. The
 * market-facing formatting lives in ``marketevents.ts``.
 */
import { Events, type Client } from 'discord.js';

export interface EventContext {
  /** Record a guild so its market is ticked from now on. */
  guildJoined(guildId: string): void;
  /** Make sure a guild is known before it is used. */
  ensureGuild(guildId: string): void;
  /** Run one tick for a guild, e.g. an immediate tick on startup. */
  onTick(guildId: string, result: import('../market/engine').TickResult): Promise<void> | void;
}

export function registerEvents(client: Client, context: EventContext): void {
  client.on(Events.GuildCreate, (guild) => {
    context.guildJoined(guild.id);
  });

  client.on(Events.GuildDelete, () => {
    // Nothing to tear down: engines are cheap and reloaded on demand.
  });
}
