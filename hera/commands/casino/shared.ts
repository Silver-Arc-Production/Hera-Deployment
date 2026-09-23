/**
 * Shared scaffolding for the casino commands.
 *
 * Every game command is the same shape: read a wager, resolve an outcome, settle
 * it and render the result. Only "resolve an outcome" differs, so this module
 * wires the rest together. It exports no ``command``, so the registry loads it
 * and finds nothing to register.
 */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import type { CommandContext } from '../../framework/context';
import { ephemeralError } from '../../framework/helpers';
import type { CommandServices } from '../../framework/types';
import {
  BetTooLarge,
  BetTooSmall,
  CooldownActive,
  HeraError,
  InsufficientFunds,
  InvalidBet,
} from '../../errors';
import { money, progressBar, signed } from '../../formatting';
import { GAME_META, type GameOutcome } from '../../gambling/games';
import type { BetResult } from '../../gambling/service';

/** Build the result embed shared by every game. */
export function resultEmbed(result: BetResult): EmbedBuilder {
  const meta = GAME_META[result.game] ?? { name: result.game, emoji: '\u{1F3B2}' };
  const won = result.net > 0;
  const push = result.net === 0;
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${meta.emoji} ${meta.name}` })
    .setDescription(result.outcome.summary)
    .setColor(won ? config.embedColor : push ? 0xf1c40f : config.errorColor);

  if (result.outcome.detail) {
    embed.addFields({ name: 'Result', value: result.outcome.detail, inline: false });
  }
  embed.addFields(
    { name: 'Bet', value: money(result.wager, { decimals: 0 }), inline: true },
    {
      name: 'Returned',
      value: result.payout > 0 ? money(result.payout, { decimals: 0 }) : '\u2014',
      inline: true,
    },
    {
      name: won ? 'Profit' : push ? 'Push' : 'Loss',
      value: signed(result.net, { decimals: 0 }),
      inline: true,
    },
    { name: 'Wallet', value: money(result.walletAfter, { decimals: 0 }), inline: false },
    {
      name: 'Table',
      value: `${result.levelAfter.emoji} ${result.levelAfter.name} \u2022 limits ${money(
        result.levelAfter.minBet,
        { decimals: 0 },
      )} \u2013 ${money(result.levelAfter.maxBet, { decimals: 0 })}`,
      inline: false,
    },
  );

  if (result.rankedUp) {
    embed.addFields({
      name: '\u{1F389} New table unlocked',
      value:
        `You have graduated to **${result.rankedUp.emoji} ${result.rankedUp.name}** \u2014 limits ` +
        `are now ${money(result.rankedUp.minBet, { decimals: 0 })} \u2013 ${money(result.rankedUp.maxBet, { decimals: 0 })}.`,
      inline: false,
    });
  }
  return embed;
}

/** Report a wager error to the user; returns true when it was one we handle. */
export async function reportWagerError(ctx: CommandContext, error: unknown): Promise<boolean> {
  if (
    error instanceof BetTooSmall ||
    error instanceof BetTooLarge ||
    error instanceof InvalidBet ||
    error instanceof CooldownActive
  ) {
    await ephemeralError(ctx, error.message);
    return true;
  }
  if (error instanceof InsufficientFunds) {
    await ephemeralError(ctx, `You cannot cover that bet \u2014 ${error.message}.`);
    return true;
  }
  if (error instanceof HeraError) {
    await ephemeralError(ctx, error.message);
    return true;
  }
  return false;
}

/**
 * Read and settle one wager for a game.
 *
 * ``resolve`` receives the validated wager and returns the outcome. Returns
 * ``null`` when an error was already reported to the user.
 */
export async function wager(
  ctx: CommandContext,
  services: CommandServices,
  game: string,
  raw: string,
  resolve: (amount: number, rng: CommandServices['gambling']['random']) => GameOutcome,
): Promise<BetResult | null> {
  let amount: number;
  try {
    amount = services.gambling.parseWager(raw, ctx.userId, ctx.guildId);
  } catch (error) {
    if (await reportWagerError(ctx, error)) return null;
    throw error;
  }

  let result: BetResult;
  try {
    result = services.gambling.settle(
      ctx.userId,
      ctx.guildId,
      game,
      amount,
      resolve(amount, services.gambling.random),
    );
  } catch (error) {
    if (await reportWagerError(ctx, error)) return null;
    throw error;
  }

  await ctx.reply({ embeds: [resultEmbed(result)] });
  return result;
}

/** A progress readout towards the next table, for the info command. */
export function progressLine(
  peakEarned: number,
  level: { requiredEarned: number },
  next: { requiredEarned: number; name: string } | null,
): string {
  if (!next) return `${money(peakEarned, { decimals: 0 })} earned \u2014 top table reached.`;
  const bar = progressBar(
    peakEarned - level.requiredEarned,
    next.requiredEarned - level.requiredEarned,
    16,
  );
  return `${money(peakEarned, { decimals: 0 })} / ${money(next.requiredEarned, { decimals: 0 })} \u2014 ${next.name}\n\`${bar}\``;
}
