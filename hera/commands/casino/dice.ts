/** `/dice` — Roll two dice and bet over, under or exactly seven. */
import { choiceArg, stringArg, type CommandDefinition } from '../../framework/types';
import { playDice, type DiceBet } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'dice',
  category: 'casino',
  description: 'Roll two dice and bet over, under or exactly seven.',
  args: [
    choiceArg('call', 'Over, under or exactly seven.', ['over', 'under', 'seven'], {
      required: true,
    }),
    stringArg('bet', 'How much to wager.', { required: true, example: '100' }),
  ],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'dice', String(args.bet), (amount, rng) =>
      playDice(rng, amount, args.call as DiceBet),
    );
  },
};
