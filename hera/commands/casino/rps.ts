/** `/rps` — Best the house at rock paper scissors. */
import { choiceArg, stringArg, type CommandDefinition } from '../../framework/types';
import { playRps, type RpsMove } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'rps',
  category: 'casino',
  description: 'Best the house at rock paper scissors.',
  args: [
    choiceArg('move', 'Your throw.', ['rock', 'paper', 'scissors'], { required: true }),
    stringArg('bet', 'How much to wager.', { required: true, example: '100' }),
  ],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'rps', String(args.bet), (amount, rng) =>
      playRps(rng, amount, args.move as RpsMove),
    );
  },
};
