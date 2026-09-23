/** `/keno` — Mark up to ten numbers and see how many fall. */
import { ephemeralError } from '../../framework/helpers';
import { stringArg, type CommandDefinition } from '../../framework/types';
import { KENO_MAX_NUMBER, KENO_MAX_PICKS, KENO_MIN_PICKS, playKeno } from '../../gambling/games';
import { wager } from './shared';

/** Read ``3 14 27`` / ``3,14,27`` into distinct in-range numbers. */
function parsePicks(raw: string): number[] | null {
  const parts = raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const picks: number[] = [];
  for (const part of parts) {
    const value = Number.parseInt(part, 10);
    if (Number.isNaN(value) || value < 1 || value > KENO_MAX_NUMBER) return null;
    picks.push(value);
  }
  const unique = [...new Set(picks)];
  if (unique.length < KENO_MIN_PICKS || unique.length > KENO_MAX_PICKS) return null;
  return unique;
}

export const command: CommandDefinition = {
  name: 'keno',
  category: 'casino',
  description: `Mark ${KENO_MIN_PICKS}-${KENO_MAX_PICKS} numbers and see how many fall.`,
  args: [
    stringArg('bet', 'How much to wager.', { required: true, example: '100' }),
    stringArg('picks', 'Space or comma separated numbers, e.g. 3 14 27 42.', {
      required: true,
      example: '3 14 27 42',
    }),
  ],
  async execute(ctx, args, services) {
    const picks = parsePicks(String(args.picks));
    if (!picks) {
      await ephemeralError(
        ctx,
        `Pick between ${KENO_MIN_PICKS} and ${KENO_MAX_PICKS} distinct numbers from 1 to ${KENO_MAX_NUMBER}.`,
      );
      return;
    }
    await wager(ctx, services, 'keno', String(args.bet), (amount, rng) =>
      playKeno(rng, amount, picks),
    );
  },
};
