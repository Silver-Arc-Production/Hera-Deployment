/**
 * Reusable autocomplete builders.
 *
 * Slash users get live suggestions; prefix users type the ticker directly and the
 * command body resolves it with :meth:`MarketService.resolveSymbol`. Keeping the
 * builder here means every command offering tickers suggests them identically.
 */
import type { CommandArgument } from './types';
import { price } from '../formatting';

/** Suggest live tickers for a slash command's symbol argument. */
export function symbolAutocomplete(): CommandArgument['autocomplete'] {
  return async ({ guildId, focused }, services) => {
    if (!guildId) return [];
    const engine = services.market.getEngine(guildId);
    const query = focused.toUpperCase();
    const choices: { name: string; value: string }[] = [];
    for (const company of Object.values(engine.companies)) {
      if (
        query === '' ||
        company.symbol.includes(query) ||
        company.name.toUpperCase().includes(query)
      ) {
        choices.push({
          name: `${company.symbol} \u2014 ${company.name} (${price(company.price)})`,
          value: company.symbol,
        });
      }
      if (choices.length >= 25) break;
    }
    return choices;
  };
}
