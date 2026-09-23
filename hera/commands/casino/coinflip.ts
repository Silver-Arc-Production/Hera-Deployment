/** `/coinflip` — Call a coin in the air. */
import { choiceArg, stringArg, type CommandDefinition } from '../../framework/types';
import { playCoinflip, type CoinSide } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'coinflip',
  category: 'casino',
  description: 'Call a coin in the air.',
  args: [
    choiceArg('side', 'Heads or tails.', ['heads', 'tails']),
    stringArg('bet', 'How much to wager.', { required: true, example: '100' }),
  ],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'coinflip', String(args.bet), (amount, rng) =>
      playCoinflip(rng, amount, args.side as CoinSide),
    );
  },
};
