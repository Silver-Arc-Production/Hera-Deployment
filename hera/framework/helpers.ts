/** Small helpers command bodies share: error replies and amount commands. */
import type { CommandContext } from '../framework/context';
import { HeraError } from '../errors';
import { errorEmbed } from '../ui/embeds';

/**
 * Run a body that may raise a :class:`HeraError`, replying with the message when
 * it does. Returns the body's result, or ``undefined`` when it failed.
 */
export async function withHeraErrors<T>(
  ctx: CommandContext,
  body: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof HeraError) {
      await ctx.reply({ embeds: [errorEmbed(error.message)], ephemeral: true });
      return undefined;
    }
    throw error;
  }
}

export function ephemeralError(ctx: CommandContext, message: string): Promise<string | null> {
  return ctx.reply({ embeds: [errorEmbed(message)], ephemeral: true });
}

export interface ResolvedMember {
  id: string;
  displayName: string;
}

/**
 * Read a user argument regardless of front end.
 *
 * A slash command hands the body a full :class:`User`; a prefix command hands it
 * a raw id string. Normalising here keeps the command body free of that branch.
 */
export function resolveMember(
  value: unknown,
  ctx: CommandContext,
  displayName?: (userId: string) => string,
): ResolvedMember | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    return { id: value, displayName: displayName?.(value) ?? `User ${value}` };
  }
  const user = value as { id: string; displayName?: string; username?: string };
  return { id: user.id, displayName: user.displayName ?? user.username ?? `User ${user.id}` };
}

/** Read the invoking member as a :class:`ResolvedMember` when none was given. */
export function selfMember(ctx: CommandContext): ResolvedMember {
  return { id: ctx.userId, displayName: ctx.user.displayName };
}
