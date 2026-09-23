/** `/plinko` — Drop a ball down the peg board. */
import { choiceArg, stringArg, type CommandDefinition } from '../../framework/types';
import { playPlinko, type PlinkoRisk } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'plinko',
  category: 'casino',
  description: 'Drop a ball down the peg board.',
  args: [
    choiceArg('risk', 'Higher risk, higher top prize.', ['low', 'medium', 'high'], { required: true }),
    stringArg('bet', 'How much to wager.', { required: true, example: '100' }),
  ],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'plinko', String(args.bet), (amount, rng) =>
      playPlinko(rng, amount, args.risk as PlinkoRisk),
    );
  },
};
