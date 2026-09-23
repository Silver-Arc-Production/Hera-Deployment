/** `/roulette` — Spin the wheel and back a colour. */
import { choiceArg, stringArg, type CommandDefinition } from '../../framework/types';
import { playRoulette, type RouletteColor } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'roulette',
  category: 'casino',
  description: 'Spin the wheel and back a colour.',
  args: [
    choiceArg('colour', 'Which colour to back.', ['red', 'black', 'green'], { required: true }),
    stringArg('bet', 'How much to wager.', { required: true, example: '100' }),
  ],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'roulette', String(args.bet), (amount, rng) =>
      playRoulette(rng, amount, args.colour as RouletteColor),
    );
  },
};
