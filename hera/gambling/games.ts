/**
 * Pure resolvers for every casino game.
 *
 * Each function takes a :class:`Random`, the wager and the player's choice and
 * returns a :class:`GameOutcome` -- no database, no Discord. Keeping the maths
 * here means every paytable lives in one place where its house edge is visible,
 * and the games can be simulated in tests without touching a wallet.
 *
 * A payout is the *total* returned to the player, so a 2x payout on a 100 credit
 * wager returns 200 (for 100 profit). Amounts are floored to whole credits,
 * which quietly leaves any fractional remainder with the house.
 */
import type { Random } from '../market/random';

export interface GameOutcome {
  /** Total credits returned to the player (0 on a loss). */
  payout: number;
  win: boolean;
  /** One-line result, shown as the embed description. */
  summary: string;
  /** Optional extra line, e.g. the grid or the dealer's hand. */
  detail?: string;
}

export interface GameMeta {
  name: string;
  emoji: string;
  description: string;
}

/** Display metadata for the statistics and help commands. */
export const GAME_META: Record<string, GameMeta> = {
  blackjack: { name: 'Blackjack', emoji: '\u{1F0CF}', description: 'Beat the dealer to 21.' },
  highlow: { name: 'High-Low', emoji: '\u{1F0DD}', description: 'Bet the next card higher or lower.' },
  roulette: { name: 'Roulette', emoji: '\u{1F3B0}', description: 'Spin the wheel, pick your colour.' },
  slots: { name: 'Slots', emoji: '\u{1F3B0}', description: 'Three reels, one pull.' },
  coinflip: { name: 'Coin Flip', emoji: '\u{1FA99}', description: 'Call it in the air.' },
  dice: { name: 'Dice', emoji: '\u{1F3B2}', description: 'Over, under or exactly seven.' },
  baccarat: { name: 'Baccarat', emoji: '\u{1F0B4}', description: 'Player, banker or tie.' },
  crash: { name: 'Crash', emoji: '\u{1F4C9}', description: 'Cash out before the multiplier busts.' },
  plinko: { name: 'Plinko', emoji: '\u{1F53A}', description: 'Drop a ball down the peg board.' },
  keno: { name: 'Keno', emoji: '\u{1F522}', description: 'Mark numbers and hope they fall.' },
  rps: { name: 'Rock Paper Scissors', emoji: '\u270B', description: 'Best the house at RPS.' },
  scratchcard: { name: 'Scratchcard', emoji: '\u{1F3AB}', description: 'Scratch for a winning line.' },
  wheel: { name: 'Wheel', emoji: '\u{1F6DE}', description: 'Spin the wheel of fortune.' },
  war: { name: 'War', emoji: '\u2694\uFE0F', description: 'Highest card takes the pot.' },
  hotstreak: {
    name: 'Hot Streak',
    emoji: '\u{1F525}',
    description: 'Push your luck on a run of coin flips, then cash out before it breaks.',
  },
};

/** Floor a payout to whole credits, never negative. */
function credits(amount: number): number {
  // Nudge past binary-float error: 100 * 2.3 is 229.99999999999997, which should
  // pay 230. The epsilon is far smaller than a credit, so it only absorbs error.
  return Math.max(0, Math.floor(amount + 1e-9));
}

// ---------------------------------------------------------------- coin games

export type CoinSide = 'heads' | 'tails';

export function playCoinflip(rng: Random, wager: number, side: CoinSide): GameOutcome {
  const landed: CoinSide = rng.random() < 0.5 ? 'heads' : 'tails';
  const win = landed === side;
  const face = landed === 'heads' ? '\u{1F7E1}' : '\u{1F535}';
  return {
    payout: win ? credits(wager * 1.98) : 0,
    win,
    summary: `${face} The coin lands **${landed}**. You called **${side}** \u2014 ${
      win ? 'you win!' : 'no luck.'
    }`,
  };
}

// ---------------------------------------------------------------------- cards

const RANK_LABEL: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

const SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'];

interface Card {
  rank: number;
  suit: string;
}

function drawCard(rng: Random): Card {
  return { rank: rng.randint(2, 14), suit: rng.choice(SUITS) };
}

function cardLabel(card: Card): string {
  return `${RANK_LABEL[card.rank]}${card.suit}`;
}

/** Blackjack hand value; aces count as 11 until that would bust the hand. */
function handValue(hand: Card[]): number {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    if (card.rank === 14) {
      aces += 1;
      total += 11;
    } else {
      total += Math.min(10, card.rank);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

// ------------------------------------------------------------------ high-low

const HIGH_LOW_PAYOUT = 1.95;

export function playHighLow(rng: Random, wager: number, choice: 'high' | 'low'): GameOutcome {
  const shown = drawCard(rng);
  const next = drawCard(rng);
  const tie = next.rank === shown.rank;
  const win =
    !tie &&
    ((choice === 'high' && next.rank > shown.rank) || (choice === 'low' && next.rank < shown.rank));

  return {
    payout: tie ? wager : win ? credits(wager * HIGH_LOW_PAYOUT) : 0,
    win,
    summary:
      `\u{1F0DD} Showing **${cardLabel(shown)}** \u2014 you bet **${choice}**.\n` +
      `Next card: **${cardLabel(next)}** \u2014 ${
        tie ? 'a tie, your stake comes back.' : win ? 'you win!' : 'you lose.'
      }`,
  };
}

// ---------------------------------------------------------------- blackjack

const BLACKJACK_NATURAL_PAYOUT = 2.5;

export function playBlackjack(rng: Random, wager: number): GameOutcome {
  // A hand resolves in one shot instead of prompting hit/stand: the player stands
  // on 17+, the dealer hits to 17. It is a house-rule hand rather than a strategy
  // game, which keeps one invocation to one reply on both front ends.
  const player: Card[] = [drawCard(rng), drawCard(rng)];
  const dealer: Card[] = [drawCard(rng), drawCard(rng)];

  const playerNatural = handValue(player) === 21;
  const dealerNatural = handValue(dealer) === 21;

  if (!playerNatural && !dealerNatural) {
    while (handValue(player) < 17) player.push(drawCard(rng));
    while (handValue(dealer) < 17) dealer.push(drawCard(rng));
  }

  const playerTotal = handValue(player);
  const dealerTotal = handValue(dealer);
  const playerBust = playerTotal > 21;
  const dealerBust = dealerTotal > 21;

  let payout: number;
  if (playerNatural && !dealerNatural) payout = credits(wager * BLACKJACK_NATURAL_PAYOUT);
  else if (playerBust || dealerNatural) payout = 0;
  else if (dealerBust || playerTotal > dealerTotal) payout = credits(wager * 2);
  else if (playerTotal === dealerTotal) payout = wager;
  else payout = 0;

  const win = payout > wager;
  const verdict =
    playerNatural && !dealerNatural
      ? 'Blackjack! You win.'
      : playerBust
        ? 'You bust.'
        : dealerNatural
          ? 'Dealer has blackjack.'
          : dealerBust
            ? 'Dealer busts \u2014 you win!'
            : playerTotal > dealerTotal
              ? 'You win!'
              : playerTotal === dealerTotal
                ? 'A push \u2014 stake returned.'
                : 'Dealer wins.';

  return {
    payout,
    win,
    summary: `\u{1F0CF} ${verdict}`,
    detail:
      `Your hand: **${player.map(cardLabel).join(' ')}** (${playerTotal})\n` +
      `Dealer: **${dealer.map(cardLabel).join(' ')}** (${dealerTotal})`,
  };
}

// ----------------------------------------------------------------- baccarat

// Banker pays 1.95x rather than even money: with no commission on this table,
// banker would otherwise return more than the player bet despite winning more
// often. The tie pays 9.5x, which lands near 90% given ties come up about once
// in ten hands.
const BACCARAT_PAYOUTS = { player: 2.0, banker: 1.95, tie: 9.5 } as const;
export type BaccaratBet = keyof typeof BACCARAT_PAYOUTS;

function baccaratValue(cards: number[]): number {
  return cards.reduce((sum, value) => sum + value, 0) % 10;
}

/** Standard baccarat banker third-card rule. */
function bankerDrawsWithThird(bankerTotal: number, playerThird: number): boolean {
  if (bankerTotal <= 2) return true;
  if (bankerTotal === 3) return playerThird !== 8;
  if (bankerTotal === 4) return playerThird >= 2 && playerThird <= 7;
  if (bankerTotal === 5) return playerThird >= 4 && playerThird <= 7;
  if (bankerTotal === 6) return playerThird === 6 || playerThird === 7;
  return false;
}

export function playBaccarat(rng: Random, wager: number, bet: BaccaratBet): GameOutcome {
  const player: number[] = [rng.randint(0, 9), rng.randint(0, 9)];
  const banker: number[] = [rng.randint(0, 9), rng.randint(0, 9)];

  let playerTotal = baccaratValue(player);
  let bankerTotal = baccaratValue(banker);
  let playerThird: number | null = null;

  if (playerTotal < 8 && bankerTotal < 8) {
    if (playerTotal <= 5) {
      playerThird = rng.randint(0, 9);
      player.push(playerThird);
      playerTotal = baccaratValue(player);
    }
    // With no player third card the banker simply hits on 0-5; otherwise the
    // standard third-card table applies.
    const draws =
      playerThird === null ? bankerTotal <= 5 : bankerDrawsWithThird(bankerTotal, playerThird);
    if (draws) {
      banker.push(rng.randint(0, 9));
      bankerTotal = baccaratValue(banker);
    }
  }

  const outcome: BaccaratBet =
    playerTotal > bankerTotal ? 'player' : bankerTotal > playerTotal ? 'banker' : 'tie';
  const win = outcome === bet;

  return {
    payout: win ? credits(wager * BACCARAT_PAYOUTS[bet]) : 0,
    win,
    summary: `\u{1F0B4} **${outcome}** wins \u2014 ${win ? 'your bet lands!' : 'not your side.'}`,
    detail: `Player **${playerTotal}** (${player.join(' ')})  \u2022  Banker **${bankerTotal}** (${banker.join(' ')})`,
  };
}

// ----------------------------------------------------------------------- war

export function playWar(rng: Random, wager: number): GameOutcome {
  const player = drawCard(rng);
  const house = drawCard(rng);
  const win = player.rank > house.rank;
  const tie = player.rank === house.rank;
  // A tie returns the stake and a win pays 1.9x, so the game returns about 95%
  // over time: half the hands are wins and a further 6% are pushes.
  return {
    payout: tie ? wager : win ? credits(wager * 1.9) : 0,
    win,
    summary: `\u2694\uFE0F You drew **${cardLabel(player)}**, the house drew **${cardLabel(house)}** \u2014 ${
      tie ? 'war! Stake returned.' : win ? 'you win!' : 'the house wins.'
    }`,
  };
}

// ---------------------------------------------------------------------- dice

export type DiceBet = 'over' | 'under' | 'seven';

export function playDice(rng: Random, wager: number, bet: DiceBet): GameOutcome {
  const first = rng.randint(1, 6);
  const second = rng.randint(1, 6);
  const total = first + second;

  let win: boolean;
  let multiplier: number;
  switch (bet) {
    case 'over':
      win = total > 7;
      multiplier = 2.3;
      break;
    case 'under':
      win = total < 7;
      multiplier = 2.3;
      break;
    default:
      win = total === 7;
      multiplier = 5.7;
      break;
  }
  return {
    payout: win ? credits(wager * multiplier) : 0,
    win,
    summary:
      `\u{1F3B2} You rolled **${first}** and **${second}** for **${total}**. ` +
      `Betting **${bet}** \u2014 ${win ? 'you win!' : 'you lose.'}`,
  };
}

// -------------------------------------------------------------------- keno

export const KENO_MIN_PICKS = 2;
export const KENO_MAX_PICKS = 10;
export const KENO_MAX_NUMBER = 80;
const KENO_DRAWN = 20;

/**
 * Payout multiplier for a number of picks and matches.
 *
 * These tables are calibrated to return roughly 90% of the stake in the long
 * run, whatever number of picks is used, so no pick count is a better deal than
 * another. The `3/6` and `4/8` rows include a small consolation return so a near
 * miss is not a total loss.
 */
function kenoMultiplier(picks: number, matches: number): number {
  if (picks <= 2) return matches === 2 ? 14.97 : 0;
  if (picks === 3) return matches === 3 ? 43.24 : matches === 2 ? 2.16 : 0;
  if (picks === 4) return matches === 4 ? 159.06 : matches === 3 ? 9.54 : 0;
  if (picks === 5) return matches === 5 ? 74.4 : matches === 4 ? 44.64 : matches === 3 ? 3.72 : 0;
  if (picks === 6) return matches === 6 ? 62.32 : matches === 5 ? 37.39 : matches === 4 ? 18.7 : matches === 3 ? 1.87 : 0;
  if (picks === 7) {
    return matches === 7 ? 103.86 : matches === 6 ? 41.54 : matches === 5 ? 24.93 : matches === 4 ? 8.31 : matches === 3 ? 1.25 : 0;
  }
  if (picks === 8) {
    return matches === 8 ? 199.22 : matches === 7 ? 79.69 : matches === 6 ? 55.78 : matches === 5 ? 19.92 : matches === 4 ? 4.78 : 0;
  }
  if (picks === 9) {
    return matches === 9 ? 220.38 : matches === 8 ? 141.04 : matches === 7 ? 79.34 : matches === 6 ? 35.26 : matches === 5 ? 10.58 : matches === 4 ? 2.64 : 0;
  }
  if (matches === 10) return 475.68;
  if (matches === 9) return 304.43;
  if (matches === 8) return 190.27;
  if (matches === 7) return 95.14;
  if (matches === 6) return 28.54;
  if (matches === 5) return 7.61;
  return 0;
}

export function playKeno(rng: Random, wager: number, picks: number[]): GameOutcome {
  const pool = Array.from({ length: KENO_MAX_NUMBER }, (_, index) => index + 1);
  const drawn: number[] = [];
  for (let i = 0; i < KENO_DRAWN; i += 1) {
    drawn.push(pool.splice(rng.randint(0, pool.length - 1), 1)[0]);
  }
  const hits = picks.filter((pick) => drawn.includes(pick)).sort((a, b) => a - b);
  const multiplier = kenoMultiplier(picks.length, hits.length);
  return {
    payout: credits(wager * multiplier),
    win: multiplier > 1,
    summary: `\u{1F522} You caught **${hits.length}/${picks.length}** \u2014 ${
      multiplier > 0 ? `${multiplier}x` : 'no payout.'
    }`,
    detail: `Your picks: ${[...picks].sort((a, b) => a - b).join(', ')}${
      hits.length ? `\nHit: ${hits.join(', ')}` : ''
    }`,
  };
}

// -------------------------------------------------------------- rock paper

export type RpsMove = 'rock' | 'paper' | 'scissors';
const RPS_MOVES: RpsMove[] = ['rock', 'paper', 'scissors'];
const RPS_BEATS: Record<RpsMove, RpsMove> = {
  rock: 'scissors',
  paper: 'rock',
  scissors: 'paper',
};
const RPS_EMOJI: Record<RpsMove, string> = {
  rock: '\u{1FAA8}',
  paper: '\u{1F4C4}',
  scissors: '\u2702\uFE0F',
};

/** The house plays uniformly at random, so every move wins 1/3 of the time. */
export function playRps(rng: Random, wager: number, move: RpsMove): GameOutcome {
  const house = rng.choice(RPS_MOVES);
  const win = RPS_BEATS[move] === house;
  const tie = move === house;
  return {
    payout: tie ? wager : win ? credits(wager * 1.85) : 0,
    win,
    summary: `${RPS_EMOJI[move]} You **${move}**, house **${house}** \u2014 ${
      tie ? 'a tie, stake returned.' : win ? 'you win!' : 'the house wins.'
    }`,
  };
}

// ------------------------------------------------------------------- crash

/**
 * Crash multipliers are drawn as ``EDGE / (1 - u)`` over ``u in [0, 1)``. That
 * makes the probability of surviving any target ``t`` exactly ``EDGE / t``, so
 * every target carries the same flat house edge regardless of how greedy it is.
 */
const CRASH_EDGE = 0.99;
export const CRASH_MIN_TARGET = 1.1;
export const CRASH_MAX_TARGET = 100;

export function playCrash(rng: Random, wager: number, target: number): GameOutcome {
  const u = rng.random();
  const crash = Math.min(CRASH_MAX_TARGET, CRASH_EDGE / (1 - u));
  const survived = target <= crash;
  return {
    payout: survived ? credits(wager * target) : 0,
    win: survived,
    summary: survived
      ? `\u{1F4C9} The multiplier crashed at **${crash.toFixed(2)}x** \u2014 you cashed out at **${target.toFixed(2)}x**!`
      : `\u{1F4C9} Crash at **${crash.toFixed(2)}x** \u2014 your **${target.toFixed(2)}x** was too greedy.`,
  };
}

// ------------------------------------------------------------------- plinko

export type PlinkoRisk = 'low' | 'medium' | 'high';

/** Slot multipliers, left to right, for an eight-row board (nine slots). */
const PLINKO_MULTIPLIERS: Record<PlinkoRisk, number[]> = {
  low: [12, 2.8, 1.4, 0.6, 0.4, 0.6, 1.4, 2.8, 12],
  medium: [30, 3, 1, 0.4, 0.2, 0.4, 1, 3, 30],
  high: [45, 6, 0.5, 0.2, 0.1, 0.2, 0.5, 6, 45],
};

export function playPlinko(rng: Random, wager: number, risk: PlinkoRisk): GameOutcome {
  const rows = 8;
  let slot = 0;
  for (let row = 0; row < rows; row += 1) {
    if (rng.random() < 0.5) slot += 1;
  }
  const multiplier = PLINKO_MULTIPLIERS[risk][slot];
  return {
    payout: credits(wager * multiplier),
    win: multiplier >= 1,
    summary: `\u{1F53A} The ball lands in slot **${slot}** \u2014 ${multiplier}x ${
      multiplier >= 1 ? 'payout!' : 'a partial return.'
    }`,
  };
}

// ---------------------------------------------------------------- hot streak

/**
 * The original game. Hot Streak is a push-your-luck run: the player names how
 * many flips to attempt before committing, each flip survives at 50% and doubles
 * the prize, and one miss forfeits the stake. Completing the run pays ``2 ** n``.
 *
 * Unlike the table games there is no fixed paytable to hide the edge in, so a
 * small shave is applied to every payout. That keeps the edge flat (about 3%) no
 * matter how many flips the player dares, while an eight-head run still pays 256x.
 */
export const HOTSTREAK_MIN_FLIPS = 1;
export const HOTSTREAK_MAX_FLIPS = 8;
const HOTSTREAK_SHAVE = 0.97;

export function playHotStreak(rng: Random, wager: number, stopAfter: number): GameOutcome {
  const target = Math.max(HOTSTREAK_MIN_FLIPS, Math.min(HOTSTREAK_MAX_FLIPS, Math.floor(stopAfter)));
  const flips: boolean[] = [];
  let broke = false;

  for (let i = 1; i <= target; i += 1) {
    if (rng.random() < 0.5) {
      flips.push(true);
    } else {
      flips.push(false);
      broke = true;
      break;
    }
  }

  const run = flips.filter(Boolean).length;
  const payout = broke ? 0 : credits(wager * 2 ** run * HOTSTREAK_SHAVE);
  const faces = flips.map((heads) => (heads ? '\u{1F7E1}' : '\u{1F535}')).join(' ');
  return {
    payout,
    win: payout > wager,
    summary: broke
      ? `\u{1F525} The streak broke after **${run}** flip(s).\n${faces}\nYour stake is gone.`
      : `\u{1F525} **${run}** heads in a row \u2014 you cash out for **${2 ** run}x**!\n${faces}`,
  };
}

// ------------------------------------------------------------------ scratchcard

const SCRATCH_SYMBOLS = ['\u{1F352}', '\u{1F34B}', '\u{1F4B0}', '\u{2B50}', '\u{1F36C}', '\u{1F48E}'];
/**
 * Three-of-a-kind prizes, matched to the symbol's index.
 *
 * The grid is nine cells in three rows, and only a completed row counts, so each
 * row lands a triple with probability 1/36. With three rows the top prize sums
 * to about 92% return; the values are chosen to keep the rare symbols worth
 * chasing without making the card player-positive.
 */
const SCRATCH_PRIZES = [2, 3, 5, 8, 14, 34];

export function playScratchcard(rng: Random, wager: number): GameOutcome {
  const grid = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(() => rng.randint(0, SCRATCH_SYMBOLS.length - 1));

  // Only a full row of three counts, so the grid is read as lines rather than as
  // loose symbols: three cherries scattered across the card is not a win.
  let multiplier = 0;
  let matched: number | null = null;
  for (let row = 0; row < 3; row += 1) {
    const [a, b, c] = grid.slice(row * 3, row * 3 + 3);
    if (a === b && b === c) {
      const prize = SCRATCH_PRIZES[a];
      if (prize > multiplier) {
        multiplier = prize;
        matched = a;
      }
    }
  }

  const rows = [0, 1, 2].map((row) =>
    grid
      .slice(row * 3, row * 3 + 3)
      .map((symbol) => SCRATCH_SYMBOLS[symbol])
      .join(' '),
  );
  return {
    payout: credits(wager * multiplier),
    win: multiplier > 1,
    summary:
      multiplier === 0
        ? '\u{1F3AB} No matching line \u2014 nothing to claim.'
        : `\u{1F3AB} Three ${SCRATCH_SYMBOLS[matched!]} on a line \u2014 **${multiplier}x**!`,
    detail: rows.join('\n'),
  };
}

// ------------------------------------------------------------------------ wheel

// Sixteen segments summing to 14.5x, so a spin returns about 90% over time while
// still offering a rare 5x.
const WHEEL_SEGMENTS = [0, 1.5, 0, 2, 0, 1, 0, 1.5, 0, 1, 0, 1.5, 0, 1, 0, 5];
export const WHEEL_SEGMENT_COUNT = WHEEL_SEGMENTS.length;

/** Pick a segment to stop on. Exposed so a UI can pre-roll then animate to it. */
export function spinWheel(rng: Random): { segment: number; multiplier: number } {
  const segment = rng.randint(0, WHEEL_SEGMENT_COUNT - 1);
  return { segment, multiplier: WHEEL_SEGMENTS[segment] };
}

export function playWheel(rng: Random, wager: number, forcedSegment?: number): GameOutcome {
  const { segment, multiplier } =
    forcedSegment === undefined
      ? spinWheel(rng)
      : { segment: forcedSegment, multiplier: WHEEL_SEGMENTS[forcedSegment] };
  const label = WHEEL_SEGMENTS.map((value) => `${value}x`).join(' \u2022 ');
  return {
    payout: credits(wager * multiplier),
    win: multiplier > 1,
    summary: `\u{1F6DE} The wheel stops on segment **${segment + 1}** \u2014 **${multiplier}x** ${
      multiplier > 1 ? 'payout!' : multiplier === 1 ? '(stake back).' : 'nothing this time.'
    }\n\u2039${label}\u203A`,
  };
}

// --------------------------------------------------------------------- roulette

export type RouletteColor = 'red' | 'black' | 'green';
export const ROULETTE_COLOR_PAYOUTS: Record<RouletteColor, number> = {
  red: 2.0,
  black: 2.0,
  green: 34.0,
};

const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export function rouletteColor(value: number): RouletteColor {
  if (value === 0) return 'green';
  return RED_NUMBERS.has(value) ? 'red' : 'black';
}

export function playRoulette(rng: Random, wager: number, bet: RouletteColor): GameOutcome {
  const value = rng.randint(0, 36);
  const color = rouletteColor(value);
  const win = color === bet;
  const swatch = color === 'red' ? '\u{1F534}' : color === 'black' ? '\u26AB' : '\u{1F7E2}';
  return {
    payout: win ? credits(wager * ROULETTE_COLOR_PAYOUTS[bet]) : 0,
    win,
    summary: `${swatch} The wheel lands on **${value} ${color}** \u2014 you bet **${bet}**: ${
      win ? 'you win!' : 'no luck.'
    }`,
  };
}

// ----------------------------------------------------------------------- slots

/** Reels are weighted so the rare symbols line up far less often than the common. */
const SLOT_REELS: [string, number][] = [
  ['\u{1F352}', 26],
  ['\u{1F34B}', 22],
  ['\u{1F347}', 18],
  ['\u{1F514}', 14],
  ['\u{1F48E}', 10],
  ['7\uFE0F\u20E3', 7],
  ['\u{1F4B0}', 3],
];
/**
 * Three-of-a-kind prizes, matched to the reel order above.
 *
 * Tuned with the reel weights and the pair rule to return about 92% overall.
 * The rarest symbol pays the most, and the whole table is scaled so the triples
 * fill the gap left by the pair payout rather than stacking on top of it.
 */
export const SLOT_TRIPLE_PAYOUTS: Record<string, number> = {
  '\u{1F352}': 9.55,
  '\u{1F34B}': 14.35,
  '\u{1F347}': 23.9,
  '\u{1F514}': 38.2,
  '\u{1F48E}': 71.7,
  '7\uFE0F\u20E3': 160,
  '\u{1F4B0}': 386,
};

/** A left-hand pair returns a fraction over the stake, keeping the reels lively. */
const SLOT_PAIR_PAYOUT = 1.5;

export function playSlots(rng: Random, wager: number): GameOutcome {
  const symbols = SLOT_REELS.map(([symbol]) => symbol);
  const weights = SLOT_REELS.map(([, weight]) => weight);
  // Each of the three reels is an independent weighted pull, so the pays are not
  // driven by one shared outcome.
  const reels = [0, 1, 2].map(() => rng.choices(symbols, weights));

  let multiplier = 0;
  let label: string;
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    multiplier = SLOT_TRIPLE_PAYOUTS[reels[0]];
    label = `Three ${reels[0]} \u2014 **${multiplier}x**!`;
  } else if (reels[0] === reels[1]) {
    // Only the leading pair counts, as on a real line-pay machine. Paying any two
    // matching reels would hit 44% of the time and push the return over 100%.
    multiplier = SLOT_PAIR_PAYOUT;
    label = 'A leading pair \u2014 a small return.';
  } else {
    label = 'No match.';
  }

  return {
    payout: credits(wager * multiplier),
    win: multiplier > 1,
    summary: `\u{1F3B0} ${label}`,
    detail: `\u2016 ${reels.join(' \u2502 ')} \u2016`,
  };
}
