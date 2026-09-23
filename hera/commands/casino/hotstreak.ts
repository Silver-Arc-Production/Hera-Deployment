/** `/hotstreak` — Push your luck on a run of coin flips. */
import { intArg, stringArg, type CommandDefinition } from '../../framework/types';
import { HOTSTREAK_MAX_FLIPS, HOTSTREAK_MIN_FLIPS, playHotStreak } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'hotstreak',
  category: 'casino',
  description: 'Push your luck on a run of coin flips.',
  args: [
    stringArg('bet', 'How much to wager.', { required: true, example: '100' }),
    intArg('flips', `How many heads to chase (${HOTSTREAK_MIN_FLIPS}-${HOTSTREAK_MAX_FLIPS}).`, {
      required: true,
      minValue: HOTSTREAK_MIN_FLIPS,
      maxValue: HOTSTREAK_MAX_FLIPS,
      example: '3',
    }),
  ],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'hotstreak', String(args.bet), (amount, rng) =>
      playHotStreak(rng, amount, Number(args.flips)),
    );
  },
};
