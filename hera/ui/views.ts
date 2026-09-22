/**
 * Interactive Discord views: pagination and confirmation.
 *
 * Views own their own state and expire on their own so they do not leak message
 * references.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type EmbedBuilder,
  type Interaction,
} from 'discord.js';

export interface ViewState {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
}

export class Paginator {
  readonly authorId: string;
  readonly totalPages: number;
  page = 0;
  private readonly build: (page: number) => EmbedBuilder;

  constructor(options: {
    authorId: string;
    totalPages: number;
    build: (page: number) => EmbedBuilder;
  }) {
    this.authorId = options.authorId;
    this.totalPages = Math.max(1, options.totalPages);
    this.build = options.build;
  }

  get state(): ViewState {
    return { embed: this.build(this.page), components: [this.row()] };
  }

  private row(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('page:prev')
        .setLabel('\u25C0')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(this.page <= 0),
      new ButtonBuilder()
        .setCustomId('page:counter')
        .setLabel(`${this.page + 1}/${this.totalPages}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('page:next')
        .setLabel('\u25B6')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(this.page >= this.totalPages - 1),
    );
  }

  /** Handle a button press. Returns true when the interaction was consumed. */
  async handle(interaction: ButtonInteraction): Promise<boolean> {
    if (interaction.user.id !== this.authorId) {
      await interaction.reply({
        content: 'These buttons belong to someone else. Run the command yourself.',
        ephemeral: true,
      });
      return true;
    }
    if (interaction.customId === 'page:prev') {
      this.page = Math.max(0, this.page - 1);
    } else if (interaction.customId === 'page:next') {
      this.page = Math.min(this.totalPages - 1, this.page + 1);
    } else {
      return false;
    }
    await interaction.update({ embeds: [this.build(this.page)], components: [this.row()] });
    return true;
  }
}

export class ConfirmView {
  readonly authorId: string;

  constructor(
    authorId: string,
    private readonly onConfirm: () => Promise<void>,
  ) {
    this.authorId = authorId;
  }

  get row(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('confirm:yes').setLabel('Confirm').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('confirm:no').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
  }

  async handle(interaction: ButtonInteraction): Promise<boolean> {
    if (interaction.user.id !== this.authorId) {
      await interaction.reply({ content: 'This confirmation is not for you.', ephemeral: true });
      return true;
    }
    if (interaction.customId === 'confirm:yes') {
      await this.onConfirm();
      await interaction.update({ content: '\u2705 Done.', embeds: [], components: [] });
      return true;
    }
    if (interaction.customId === 'confirm:no') {
      await interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
      return true;
    }
    return true;
  }
}

/** A registry of live paginators keyed by the message they were posted to. */
export class ViewRegistry {
  private readonly paginators = new Map<string, Paginator>();

  register(messageId: string, paginator: Paginator): void {
    this.paginators.set(messageId, paginator);
  }

  async dispatch(interaction: Interaction): Promise<boolean> {
    if (!interaction.isButton()) return false;
    const paginator = this.paginators.get(interaction.message.id);
    if (!paginator) return false;
    const consumed = await paginator.handle(interaction as ButtonInteraction);
    if (paginator.page >= paginator.totalPages - 1 || paginator.page <= 0) {
      // Keep the entry so the user can page back; Discord expires the buttons.
    }
    return consumed;
  }
}
