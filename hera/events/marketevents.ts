/**
 * Formats market tick outcomes into Discord messages.
 *
 * This is the market-facing half of the event layer: the bot's ticker collects
 * the raw results and asks this module to render the news wire, limit-order
 * fills, price alerts and margin calls. Keeping it here means the dispatch logic
 * in ``bot.ts`` never contains presentation code.
 */
import { EmbedBuilder } from 'discord.js';

import { config } from '../config';
import { percent, price, signed } from '../formatting';
import type { TickResult } from '../market/engine';
import type { AlertHit, Fill, MarginCall } from '../services/trading';

export interface OutgoingMessage {
  userId?: string;
  channel: boolean;
  embed: EmbedBuilder;
}

/** The market wire post for a tick's headlines, if any. */
export function newsEmbedFor(result: TickResult): EmbedBuilder | null {
  if (result.news.length === 0) return null;
  const headlines = result.news
    .slice(0, 6)
    .map((item) => `${item.impact >= 0 ? '\u{1F7E2}' : '\u{1F534}'} ${item.headline}`)
    .join('\n');

  return new EmbedBuilder()
    .setTitle(`\u{1F4F0} Market wire \u2014 tick ${result.tick.toLocaleString()}`)
    .setDescription(headlines)
    .setColor(config.embedColor)
    .setFooter({
      text:
        `Index ${result.indexValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ` +
        `(${percent(result.indexChange * 100)})`,
    });
}

export function fillEmbedFor(fill: Fill): EmbedBuilder {
  const description = fill.realizedPnl
    ? `${fill.message}\n${signed(fill.realizedPnl)} realised`
    : fill.message;
  return new EmbedBuilder()
    .setTitle('\u{1F9FE} Limit order filled')
    .setDescription(description)
    .setColor(config.embedColor);
}

export function alertEmbedFor(alert: AlertHit): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`\u{1F514} ${alert.symbol} is ${alert.direction} ${price(alert.threshold)}`)
    .setDescription(`Last price: **${price(alert.price)}**`)
    .setColor(config.embedColor);
  if (alert.note) embed.setFooter({ text: alert.note });
  return embed;
}

export function marginCallEmbedFor(call: MarginCall): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`\u26A0\uFE0F Margin call on ${call.symbol}`)
    .setDescription(
      `Your short of ${call.quantity.toLocaleString()} ${call.symbol} is down ` +
        `${call.loss.toFixed(2)} against ${call.collateral.toLocaleString()} of collateral.\n` +
        `Entry ${price(call.entry)} \u2192 now ${price(call.price)}.\n` +
        'Cover the position or post more collateral.',
    )
    .setColor(config.errorColor);
}

/**
 * Collapse one tick's outcomes into the messages that need sending, so the bot
 * can dispatch them without knowing how each is rendered.
 */
export function outgoingFor(
  result: TickResult,
  fills: [string, Fill][],
  alerts: AlertHit[],
  marginCalls: MarginCall[],
): OutgoingMessage[] {
  const messages: OutgoingMessage[] = [];
  const news = newsEmbedFor(result);
  if (news) messages.push({ channel: true, embed: news });
  for (const [userId, fill] of fills) {
    messages.push({ userId, channel: false, embed: fillEmbedFor(fill) });
  }
  for (const alert of alerts) {
    messages.push({ userId: alert.userId, channel: false, embed: alertEmbedFor(alert) });
  }
  for (const call of marginCalls) {
    messages.push({ userId: call.userId, channel: false, embed: marginCallEmbedFor(call) });
  }
  return messages;
}
