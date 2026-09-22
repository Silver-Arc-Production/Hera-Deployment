/**
 * One command body, two front ends.
 *
 * Every command exists as both a slash command and a prefix message command, but
 * the two APIs differ in almost every respect: ``ChatInputCommandInteraction``
 * versus ``Message``. Rather than write each command twice, command bodies accept
 * a :class:`CommandContext` and talk only to that. This module adapts the two
 * discord.js entry points onto one interface.
 *
 * The subtle one is ``defer``. A slash command must acknowledge within three
 * seconds, so long commands defer and then use the follow-up endpoint. A prefix
 * command has no acknowledgement requirement and no follow-up endpoint, so
 * deferring is unnecessary and the "follow-up" is just another message.
 */
import {
  MessageFlags,
  type ActionRowBuilder,
  type AttachmentBuilder,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type Guild,
  type GuildMember,
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageReplyOptions,
  type TextBasedChannel,
  type User,
  ChannelType,
} from 'discord.js';

const EPHEMERAL_FOOTER = 'Private by default \u2014 posted here because your DMs are closed.';

export interface ReplyOptions {
  content?: string;
  embeds?: EmbedBuilder[];
  files?: AttachmentBuilder[];
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
  ephemeral?: boolean;
}

export interface CommandContext {
  readonly user: User;
  readonly userId: string;
  readonly guildId: string;
  readonly guild: Guild | null;
  readonly channel: TextBasedChannel | null;
  readonly member: GuildMember | null;
  /** True for a slash command, whose replies can be ephemeral. */
  readonly isSlash: boolean;
  defer(): Promise<void>;
  /** Replies and returns the created message id when Discord supplies one. */
  reply(options: ReplyOptions): Promise<string | null>;
  followUp(options: ReplyOptions): Promise<string | null>;
}

function toMessagePayload(options: ReplyOptions): MessageReplyOptions {
  const payload: MessageReplyOptions = {};
  if (options.content !== undefined) payload.content = options.content;
  if (options.embeds && options.embeds.length > 0) payload.embeds = options.embeds;
  if (options.files && options.files.length > 0) payload.files = options.files;
  if (options.components && options.components.length > 0) payload.components = options.components;
  return payload;
}

/** Ephemeral replies are expressed with the flag on modern discord.js. */
function ephemeralFlags(ephemeral: boolean | undefined): MessageFlags.Ephemeral | undefined {
  return ephemeral ? MessageFlags.Ephemeral : undefined;
}

export class SlashContext implements CommandContext {
  readonly isSlash = true;

  constructor(private readonly interaction: ChatInputCommandInteraction) {}

  get user(): User {
    return this.interaction.user;
  }

  get userId(): string {
    return this.interaction.user.id;
  }

  get guildId(): string {
    const guildId = this.interaction.guildId;
    if (!guildId) throw new Error('This command only works inside a server.');
    return guildId;
  }

  get guild(): Guild | null {
    return this.interaction.guild;
  }

  get channel(): TextBasedChannel | null {
    const channel = this.interaction.channel;
    if (channel && 'send' in channel) return channel;
    return null;
  }

  get member(): GuildMember | null {
    return this.interaction.member instanceof Object ? (this.interaction.member as GuildMember) : null;
  }

  async defer(): Promise<void> {
    await this.interaction.deferReply();
  }

  async reply(options: ReplyOptions): Promise<string | null> {
    const payload = toMessagePayload(options);
    const flags = ephemeralFlags(options.ephemeral);
    if (this.interaction.replied) {
      const message = await this.interaction.followUp({ ...payload, flags });
      return message.id;
    }
    if (this.interaction.deferred) {
      const message = await this.interaction.editReply(payload as never);
      return message.id;
    }
    const response = (await this.interaction.reply({
      ...payload,
      flags,
    })) as unknown as { id: string } | undefined;
    return response?.id ?? null;
  }

  async followUp(options: ReplyOptions): Promise<string | null> {
    const message = await this.interaction.followUp({
      ...toMessagePayload(options),
      flags: ephemeralFlags(options.ephemeral),
    });
    return message.id;
  }
}

export class PrefixContext implements CommandContext {
  readonly isSlash = false;

  constructor(private readonly message: Message) {}

  get user(): User {
    return this.message.author;
  }

  get userId(): string {
    return this.message.author.id;
  }

  get guildId(): string {
    if (!this.message.guild) throw new Error('This command only works inside a server.');
    return this.message.guild.id;
  }

  get guild(): Guild | null {
    return this.message.guild;
  }

  get channel(): TextBasedChannel | null {
    return this.message.channel;
  }

  get member(): GuildMember | null {
    return this.message.member;
  }

  async defer(): Promise<void> {
    // Nothing to acknowledge: a prefix command has no interaction deadline, so the
    // reply simply goes out when the work finishes.
    return;
  }

  private async sendToChannel(payload: MessageReplyOptions): Promise<string | null> {
    try {
      const sent = await this.message.reply(payload);
      return sent.id;
    } catch {
      // The invoking message can be gone (deleted, or an old reference); a plain
      // channel send still gets the answer to the user.
      const channel = this.message.channel;
      if (channel.type !== ChannelType.DM && 'send' in channel) {
        const sent = await channel.send(payload);
        return sent.id;
      }
      return null;
    }
  }

  async reply(options: ReplyOptions): Promise<string | null> {
    if (!options.ephemeral) {
      return this.sendToChannel(toMessagePayload(options));
    }

    try {
      await this.user.send(toMessagePayload(options));
      // The answer is already where the user wanted it. Saying so in the channel
      // would announce activity they asked to keep private.
      return null;
    } catch {
      // DMs closed is normal; fall back to a labelled channel post below.
    }

    const payload = toMessagePayload(options);
    const embeds = (payload.embeds ?? []).map((embed) => {
      // An injected footer is how a DM fallback stays honest about being a fallback.
      const data = 'toJSON' in embed ? (embed.toJSON() as Record<string, unknown>) : embed;
      return { ...(data as object), footer: { text: EPHEMERAL_FOOTER } };
    }) as MessageReplyOptions['embeds'];
    if (embeds && embeds.length > 0) {
      payload.embeds = embeds;
    } else {
      payload.content = EPHEMERAL_FOOTER;
    }
    return this.sendToChannel(payload);
  }

  async followUp(options: ReplyOptions): Promise<string | null> {
    return this.reply(options);
  }
}
