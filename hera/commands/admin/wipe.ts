/** `/wipe` — intentionally not implemented. Operator-only. */
import { ephemeralError } from '../../framework/helpers';
import type { CommandDefinition } from '../../framework/types';
import { isOperator } from './tick';

export const command: CommandDefinition = {
  name: 'wipe',
  category: 'admin',
  description: 'Delete all market and economy data in this server.',
  async execute(ctx, _args, services) {
    if (!isOperator(ctx, services.ownerId)) {
      await ephemeralError(ctx, 'You need the Manage Server permission to use that.');
      return;
    }
    await ephemeralError(
      ctx,
      'Wiping is intentionally not implemented: it would destroy every member\'s balance ' +
        'irreversibly. Reset the market by deleting the database file while the bot is stopped.',
    );
  },
};
