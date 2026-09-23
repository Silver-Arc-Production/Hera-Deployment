/** `/baccarat` — Back the player, the banker or a tie. */
import { choiceArg, stringArg, type CommandDefinition } from '../../framework/types';
import { playBaccarat, type BaccaratBet } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'baccarat',
  category: 'casino',
  description: 'Back the player, the banker or a tie.',
  args: [
    choiceArg('side', 'Which side to back.', ['player', 'banker', 'tie']),
    stringArg('bet', 'How much to wager.', { required: true, example: '100' }),
  ],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'baccarat', String(args.bet), (amount, rng) =>
      playBaccarat(rng, amount, args.side as BaccaratBet),
    );
  },
};
