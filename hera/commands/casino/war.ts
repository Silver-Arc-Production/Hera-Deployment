/** `/war` — Turn a card against the house, highest wins. */
import { stringArg, type CommandDefinition } from '../../framework/types';
import { playWar } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'war',
  category: 'casino',
  description: 'Turn a card against the house, highest wins.',
  args: [stringArg('bet', 'How much to wager.', { required: true, example: '100' })],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'war', String(args.bet), (amount, rng) =>
      playWar(rng, amount),
    );
  },
};
