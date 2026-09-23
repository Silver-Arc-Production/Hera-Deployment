/** `/crash` — Cash out before the multiplier busts. */
import { numberArg, stringArg, type CommandDefinition } from '../../framework/types';
import { CRASH_MAX_TARGET, CRASH_MIN_TARGET, playCrash } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'crash',
  category: 'casino',
  description: 'Cash out before the multiplier busts.',
  args: [
    stringArg('bet', 'How much to wager.', { required: true, example: '100' }),
    numberArg('target', 'The multiplier to cash out at (1.1-100).', {
      required: true,
      minValue: CRASH_MIN_TARGET,
      maxValue: CRASH_MAX_TARGET,
      example: '2',
    }),
  ],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'crash', String(args.bet), (amount, rng) =>
      playCrash(rng, amount, Number(args.target)),
    );
  },
};
