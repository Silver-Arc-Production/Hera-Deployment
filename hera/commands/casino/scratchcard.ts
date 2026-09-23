/** `/scratchcard` — Buy a scratchcard and reveal the grid. */
import { stringArg, type CommandDefinition } from '../../framework/types';
import { playScratchcard } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'scratchcard',
  category: 'casino',
  description: 'Buy a scratchcard and reveal the grid.',
  args: [stringArg('bet', 'How much to wager.', { required: true, example: '100' })],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'scratchcard', String(args.bet), (amount, rng) =>
      playScratchcard(rng, amount),
    );
  },
};
