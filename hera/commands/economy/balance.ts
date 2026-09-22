/** `/balance` — show your wallet, bank and net worth. */
import { EmbedBuilder } from 'discord.js';

import { config } from '../../config';
import { resolveMember, selfMember } from '../../framework/helpers';
import { userArg, type CommandDefinition } from '../../framework/types';
import { money, progressBar } from '../../formatting';
import type { Account } from '../../services/economy';

function balanceEmbed(account: Account, displayName: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`\u{1F45B} ${displayName}'s balance`)
    .setColor(config.embedColor);
  embed.addFields(
    { name: 'Wallet', value: money(account.wallet), inline: true },
    { name: 'Bank', value: money(account.bank), inline: true },
    { name: 'Net worth', value: money(account.wallet + account.bank), inline: true },
    {
      name: 'Bank storage',
      value:
        `${money(account.bank)} / ${money(account.bankCapacity)}\n` +
        `\`${progressBar(account.bank, account.bankCapacity)}\``,
      inline: false,
    },
  );
  return embed;
}

export const command: CommandDefinition = {
  name: 'balance',
  category: 'economy',
  description: 'Show your wallet, bank and net worth.',
  args: [userArg('member', "Look up someone else's balance instead.", { required: false })],
  async execute(ctx, args, services) {
    const target =
      resolveMember(args.member, ctx, (id) => services.displayName(id)) ?? selfMember(ctx);
    const account = services.economy.getAccount(target.id, ctx.guildId);
    await ctx.reply({ embeds: [balanceEmbed(account, target.displayName)] });
  },
};

export { balanceEmbed };
