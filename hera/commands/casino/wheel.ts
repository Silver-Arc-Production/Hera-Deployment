/** `/wheel` — Spin the wheel of fortune. */
import { stringArg, type CommandDefinition } from '../../framework/types';
import { playWheel } from '../../gambling/games';
import { wager } from './shared';

export const command: CommandDefinition = {
  name: 'wheel',
  category: 'casino',
  description: 'Spin the wheel of fortune.',
  args: [stringArg('bet', 'How much to wager.', { required: true, example: '100' })],
  async execute(ctx, args, services) {
    await wager(ctx, services, 'wheel', String(args.bet), (amount, rng) =>
      playWheel(rng, amount),
    );
  },
};
