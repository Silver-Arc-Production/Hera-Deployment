/** `/blackjack` — Play a hand against the dealer. */
import { stringArg, type CommandDefinition } from '../../framework/types';
import { playBlackjack } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'blackjack',
  category: 'casino',
  description: 'Play a hand against the dealer.',
  args: [stringArg('bet', 'How much to wager.', { required: true, example: '100' })],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'blackjack', String(args.bet), (amount, rng) =>
      playBlackjack(rng, amount),
    );
  },
};
