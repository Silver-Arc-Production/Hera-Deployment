/** `/slots` — Pull the lever on the three-reel machine. */
import { stringArg, type CommandDefinition } from '../../framework/types';
import { playSlots } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'slots',
  category: 'casino',
  description: 'Pull the lever on the three-reel machine.',
  args: [stringArg('bet', 'How much to wager.', { required: true, example: '100' })],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'slots', String(args.bet), (amount, rng) =>
      playSlots(rng, amount),
    );
  },
};
