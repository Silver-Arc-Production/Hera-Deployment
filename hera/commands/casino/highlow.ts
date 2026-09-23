/** `/highlow` — Bet whether the next card is higher or lower. */
import { choiceArg, stringArg, type CommandDefinition } from '../../framework/types';
import { playHighLow } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'highlow',
  category: 'casino',
  description: 'Bet whether the next card is higher or lower.',
  args: [
    choiceArg('call', 'High or low.', ['high', 'low'], { required: true }),
    stringArg('bet', 'How much to wager.', { required: true, example: '100' }),
  ],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'highlow', String(args.bet), (amount, rng) =>
      playHighLow(rng, amount, args.call as 'high' | 'low'),
    );
  },
};
