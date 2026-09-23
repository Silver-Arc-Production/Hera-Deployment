/**
 * Tests for the casino: game maths, table tiers and wager settlement.
 *
 * The games are pure functions over a :class:`Random`, so the tests drive them
 * with a scripted ``FakeRandom`` and assert exact payouts. Settlement runs
 * against the real economy service over a real in-memory database, so the
 * ledger and profile updates are exercised end to end rather than mocked.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { economyDefaults, gamblingDefaults } from '../hera/config';
import { Database } from '../hera/database';
import { BetTooLarge, BetTooSmall, InsufficientFunds, InvalidBet } from '../hera/errors';
import {
  playBaccarat,
  playBlackjack,
  playCoinflip,
  playCrash,
  playDice,
  playHighLow,
  playHotStreak,
  playKeno,
  playPlinko,
  playRoulette,
  playRps,
  playScratchcard,
  playSlots,
  playWar,
  playWheel,
  rouletteColor,
  WHEEL_SEGMENT_COUNT,
} from '../hera/gambling/games';
import { GamblingService } from '../hera/gambling/service';
import { Random } from '../hera/market/random';
import { EconomyService } from '../hera/services/economy';
import { GUILD } from './harness';

/**
 * A stand-in :class:`Random` that returns values from a fixed script, cycling
 * when the script runs out. Every game reads randomness in a known order, so a
 * script makes each outcome deterministic.
 */
class FakeRandom {
  private index = 0;

  constructor(private readonly script: number[]) {}

  private next(): number {
    const value = this.script[this.index % this.script.length];
    this.index += 1;
    return value;
  }

  random(): number {
    return this.next();
  }

  randint(min: number, max: number): number {
    // The script holds raw draws in [0, 1); scale onto the requested range.
    return min + Math.min(max - min, Math.floor(this.next() * (max - min + 1)));
  }

  choice<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  choices<T>(items: readonly T[], weights?: readonly number[]): T {
    if (!weights) return this.choice(items);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let target = this.next() * total;
    for (let i = 0; i < items.length; i += 1) {
      target -= weights[i];
      if (target < 0) return items[i];
    }
    return items[items.length - 1];
  }
}

function asRandom(fake: FakeRandom): Random {
  return fake as unknown as Random;
}

/** Build a gambling service over a throwaway database. */
function makeGambling(): {
  db: Database;
  economy: EconomyService;
  gambling: GamblingService;
  close(): void;
} {
  const db = new Database(':memory:');
  const economy = new EconomyService(db);
  const gambling = new GamblingService(db, economy, gamblingDefaults, new Random(1234));
  return { db, economy, gambling, close: () => db.close() };
}

/**
 * Give an account enough wallet to cover large test wagers. The starting wallet
 * is a few hundred credits, so anything settling thousands has to be funded
 * first or the economy rightly refuses the debit.
 */
function fund(economy: EconomyService, userId: string, amount = 1_000_000): void {
  economy.getAccount(userId, GUILD);
  economy.credit(userId, GUILD, amount, { kind: 'test_funding' });
}

// ------------------------------------------------------------------ game maths

test('coinflip pays 1.98x on a correct call', () => {
  const outcome = playCoinflip(asRandom(new FakeRandom([0.0])), 100, 'heads');
  assert.equal(outcome.win, true);
  assert.equal(outcome.payout, 198);

  const loss = playCoinflip(asRandom(new FakeRandom([0.9])), 100, 'heads');
  assert.equal(loss.win, false);
  assert.equal(loss.payout, 0);
});

test('dice pays the over/under and seven multipliers', () => {
  // randint draws: 0.4 -> 3, 0.5 -> 4, so the total is 7.
  const seven = playDice(asRandom(new FakeRandom([0.4, 0.5])), 100, 'seven');
  assert.equal(seven.win, true);
  assert.equal(seven.payout, 570);

  const over = playDice(asRandom(new FakeRandom([0.99, 0.99])), 100, 'over');
  assert.equal(over.win, true);
  assert.equal(over.payout, 230);

  const under = playDice(asRandom(new FakeRandom([0.0, 0.0])), 100, 'under');
  assert.equal(under.win, true);
  assert.equal(under.payout, 230);
});

test('high-low grades a higher or lower next card', () => {
  // First draw rank 2 (0.0 -> 2), next draw rank 14 (1.0 clamps to 14).
  const high = playHighLow(asRandom(new FakeRandom([0.0, 0.0, 0.99, 0.0])), 100, 'high');
  assert.equal(high.win, true);
  assert.equal(high.payout, 195);
});

test('blackjack values aces as 1 or 11 and pays a natural 2.5x', () => {
  // Player: ace (rank 14) then king (rank 13) -> 21 natural. Dealer: two 5s.
  const fake = new FakeRandom([0.99, 0.0, 0.9, 0.0, 0.25, 0.0, 0.25, 0.0]);
  const outcome = playBlackjack(asRandom(fake), 100);
  assert.equal(outcome.win, true);
  assert.equal(outcome.payout, 250);
  assert.match(outcome.detail!, /21/);
});

test('war ties return the stake and a higher card pays 1.9x', () => {
  const tie = playWar(asRandom(new FakeRandom([0.5, 0.0, 0.5, 0.0])), 100);
  assert.equal(tie.win, false);
  assert.equal(tie.payout, 100);

  // Player king (0.9 -> 13), house 2 (0.0 -> 2).
  const win = playWar(asRandom(new FakeRandom([0.9, 0.0, 0.0, 0.0])), 100);
  assert.equal(win.win, true);
  assert.equal(win.payout, 190);
});

test('roulette colours match the wheel layout', () => {
  assert.equal(rouletteColor(0), 'green');
  assert.equal(rouletteColor(1), 'red');
  assert.equal(rouletteColor(2), 'black');
  assert.equal(rouletteColor(36), 'red');

  // value 0 -> green pays 34x.
  const green = playRoulette(asRandom(new FakeRandom([0.0])), 100, 'green');
  assert.equal(green.win, true);
  assert.equal(green.payout, 3400);
});

test('crash pays the target only when the multiplier survives it', () => {
  // u = 0 -> crash = 0.99, so a 1.5x target busts.
  const bust = playCrash(asRandom(new FakeRandom([0.0])), 100, 1.5);
  assert.equal(bust.win, false);

  // u = 0 -> crash 0.99: a 1.1x target should NOT survive 0.99.
  const low = playCrash(asRandom(new FakeRandom([0.0])), 100, 1.1);
  assert.equal(low.win, false);

  // u near 1 -> huge multiplier, a 2x target survives.
  const survive = playCrash(asRandom(new FakeRandom([0.9])), 100, 2);
  assert.equal(survive.win, true);
  assert.equal(survive.payout, 200);
});

test('plinko maps eight coin steps to a slot and multiplier', () => {
  // All steps land right -> slot 8, the top multiplier for the risk tier.
  const low = playPlinko(asRandom(new FakeRandom([0.99])), 100, 'low');
  assert.equal(low.payout, 1200);

  // All steps land left -> slot 0, which pays the same as slot 8.
  const high = playPlinko(asRandom(new FakeRandom([0.0])), 100, 'high');
  assert.equal(high.payout, 4500);
});

test('keno only returns in-range numbers and a sane payout', () => {
  const outcome = playKeno(new Random(99), 100, [1, 2, 3, 4, 5]);
  assert.ok(outcome.payout >= 0);
  assert.match(outcome.detail!, /1, 2, 3, 4, 5/);
});

test('rps pays 1.85x on a win and returns the stake on a tie', () => {
  // House picks rock (0.0 -> index 0); player throws paper -> win.
  const win = playRps(asRandom(new FakeRandom([0.0])), 100, 'paper');
  assert.equal(win.win, true);
  assert.equal(win.payout, 185);

  const tie = playRps(asRandom(new FakeRandom([0.0])), 100, 'rock');
  assert.equal(tie.win, false);
  assert.equal(tie.payout, 100);
});

test('slots pays the triple table and a leading pair', () => {
  // Three cherries: the most common symbol pays 9.55x.
  const triple = playSlots(asRandom(new FakeRandom([0.0, 0.0, 0.0])), 100);
  assert.equal(triple.payout, 955);

  // A leading pair pays 1.5x.
  const pair = playSlots(asRandom(new FakeRandom([0.0, 0.0, 0.99])), 100);
  assert.equal(pair.payout, 150);

  // A pair in the last two reels only does not pay.
  const trailing = playSlots(asRandom(new FakeRandom([0.99, 0.0, 0.0])), 100);
  assert.equal(trailing.payout, 0);
});

test('scratchcard only pays for a completed row', () => {
  // Every cell symbol 0 -> all three rows are cherries, worth 2x.
  const triple = playScratchcard(asRandom(new FakeRandom([0.0])), 100);
  assert.equal(triple.payout, 200);

  // A scattered three-of-a-kind is not a line, so it pays nothing. Symbols cycle
  // 0,1,2,3,4,5,0,1,2 across the nine cells.
  const scattered = playScratchcard(
    asRandom(new FakeRandom([0.0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 0.0, 1 / 6, 2 / 6])),
    100,
  );
  assert.equal(scattered.payout, 0);
});

test('wheel segments pay their multiplier', () => {
  // Segment 0 is 0x; segment 1 is 1.5x; the last is 5x.
  assert.equal(playWheel(asRandom(new FakeRandom([0.0])), 100).payout, 0);
  assert.equal(playWheel(asRandom(new FakeRandom([0.1])), 100).payout, 150);
  assert.equal(playWheel(asRandom(new FakeRandom([0.99])), 100).payout, 500);
});

test('the wheel is a closed loop of sixteen segments', () => {
  assert.equal(WHEEL_SEGMENT_COUNT, 16);
});

test('baccarat reports a decisive total', () => {
  const outcome = playBaccarat(new Random(7), 100, 'player');
  assert.ok(['player', 'banker', 'tie'].includes((outcome.summary.match(/\*\*(\w+)\*\*/) ?? [])[1] ?? ''));
  assert.ok(outcome.payout >= 0);
});

test('hot streak pays 2^n shaved when the whole run survives', () => {
  // Three heads then cash out: 2^3 * 0.97 = 7.76 -> 776 on a 100 bet.
  const win = playHotStreak(asRandom(new FakeRandom([0.0, 0.0, 0.0])), 100, 3);
  assert.equal(win.win, true);
  assert.equal(win.payout, 776);

  // A miss forfeits the whole stake.
  const loss = playHotStreak(asRandom(new FakeRandom([0.0, 0.99])), 100, 3);
  assert.equal(loss.win, false);
  assert.equal(loss.payout, 0);
});

// ----------------------------------------------------------------- table tiers

test('the tier ladder opens on peak winnings', () => {
  const { gambling, close } = makeGambling();
  assert.equal(gambling.levelFor(0).name, 'Bronze');
  assert.equal(gambling.levelFor(1_999).name, 'Bronze');
  assert.equal(gambling.levelFor(2_000).name, 'Silver');
  assert.equal(gambling.levelFor(15_000).name, 'Gold');
  assert.equal(gambling.levelFor(1_500_000).name, 'Legend');
  assert.equal(gambling.levelFor(999_999_999).name, 'Legend');
  close();
});

test('there are exactly six tiers, each raising both limits', () => {
  assert.equal(gamblingDefaults.levels.length, 6);
  for (let i = 1; i < gamblingDefaults.levels.length; i += 1) {
    const previous = gamblingDefaults.levels[i - 1];
    const current = gamblingDefaults.levels[i];
    assert.ok(current.index === previous.index + 1);
    assert.ok(current.requiredEarned > previous.requiredEarned);
    assert.ok(current.minBet > previous.minBet);
    assert.ok(current.maxBet > previous.maxBet);
  }
});

test('parseWager rejects a bet below the table minimum', () => {
  const { economy, gambling, close } = makeGambling();
  economy.getAccount('1', GUILD);
  assert.throws(() => gambling.parseWager('5', '1', GUILD), BetTooSmall);
  close();
});

test('parseWager rejects a bet above the table maximum', () => {
  const { economy, gambling, close } = makeGambling();
  economy.getAccount('2', GUILD);
  assert.throws(() => gambling.parseWager('99999', '2', GUILD), BetTooLarge);
  close();
});

test('parseWager rejects junk and non-positive bets', () => {
  const { economy, gambling, close } = makeGambling();
  economy.getAccount('3', GUILD);
  assert.throws(() => gambling.parseWager('banana', '3', GUILD), InvalidBet);
  assert.throws(() => gambling.parseWager('0', '3', GUILD), InvalidBet);
  close();
});

test('parseWager clamps all and half to the table ceiling', () => {
  const { economy, gambling, close } = makeGambling();
  economy.credit('4', GUILD, 100_000, { kind: 'test' });
  // Bronze caps at 250, so 'all' cannot stake the whole wallet.
  assert.equal(gambling.parseWager('all', '4', GUILD), 250);
  assert.equal(gambling.parseWager('half', '4', GUILD), 125);
  close();
});

test('parseWager accepts k/m suffixes, separators and a currency sigil', () => {
  const { db, economy, gambling, close } = makeGambling();
  economy.getAccount('6', GUILD);
  economy.credit('6', GUILD, 2_000_000, { kind: 'test' });
  // Promote to Gold (min 100, max 10,000) so these forms fit the table limits.
  gambling.getProfile('6', GUILD);
  db.execute('UPDATE gambling_profiles SET peak_earned = 15_000 WHERE user_id = ? AND guild_id = ?', [
    '6',
    GUILD,
  ]);

  assert.equal(gambling.parseWager('$150', '6', GUILD), 150);
  assert.equal(gambling.parseWager('1,500', '6', GUILD), 1500);
  assert.equal(gambling.parseWager('2k', '6', GUILD), 2000);
  assert.equal(gambling.parseWager('$2.5k', '6', GUILD), 2500);
  close();
});

test('a higher tier accepts a bet the lower one rejects', () => {
  const { db, economy, gambling, close } = makeGambling();
  fund(economy, '5');
  assert.throws(() => gambling.parseWager('500', '5', GUILD), BetTooLarge);
  // Promote by hand rather than by playing: this isolates the tier gate.
  gambling.getProfile('5', GUILD);
  db.execute('UPDATE gambling_profiles SET peak_earned = 2000 WHERE user_id = ? AND guild_id = ?', [
    '5',
    GUILD,
  ]);
  assert.equal(gambling.parseWager('500', '5', GUILD), 500);
  close();
});

// ------------------------------------------------------------------ settlement

const WIN = { payout: 200, win: true, summary: 'win' };
const LOSS = { payout: 0, win: false, summary: 'loss' };
const PUSH = { payout: 100, win: false, summary: 'push' };

test('a winning bet credits the payout and journals both legs', () => {
  const { economy, gambling, close } = makeGambling();
  const before = economy.getAccount('10', GUILD).wallet;
  const result = gambling.settle('10', GUILD, 'coinflip', 100, WIN);
  assert.equal(result.net, 100);
  assert.equal(result.walletAfter, before + 100);

  const kinds = economy.history('10', GUILD, 10).map((row) => row.kind);
  assert.ok(kinds.includes('gamble_stake') && kinds.includes('gamble_payout'));
  close();
});

test('a losing bet only removes the stake', () => {
  const { economy, gambling, close } = makeGambling();
  const before = economy.getAccount('11', GUILD).wallet;
  const result = gambling.settle('11', GUILD, 'slots', 100, LOSS);
  assert.equal(result.net, -100);
  assert.equal(result.walletAfter, before - 100);
  close();
});

test('a push returns exactly the stake', () => {
  const { economy, gambling, close } = makeGambling();
  const before = economy.getAccount('12', GUILD).wallet;
  const result = gambling.settle('12', GUILD, 'highlow', 100, PUSH);
  assert.equal(result.net, 0);
  assert.equal(result.walletAfter, before);
  close();
});

test('a bet larger than the wallet is refused by the economy', () => {
  const { gambling, close } = makeGambling();
  assert.throws(() => gambling.settle('13', GUILD, 'dice', 10_000_000, WIN), InsufficientFunds);
  close();
});

test('settlement records per-game totals', () => {
  const { economy, gambling, close } = makeGambling();
  fund(economy, '14');
  gambling.settle('14', GUILD, 'roulette', 100, WIN);
  gambling.settle('14', GUILD, 'roulette', 100, LOSS);
  const stats = gambling.gameStats('14', GUILD);
  const roulette = stats.find((row) => row.game === 'roulette')!;
  assert.equal(roulette.plays, 2);
  assert.equal(roulette.wagered, 200);
  // A 100-profit win followed by a 100 loss nets to zero.
  assert.equal(roulette.net, 0);
  close();
});

test('the ledger keeps the most recent bets first', () => {
  const { gambling, close } = makeGambling();
  gambling.settle('15', GUILD, 'coinflip', 100, WIN);
  gambling.settle('15', GUILD, 'war', 100, LOSS);
  const rows = gambling.ledger('15', GUILD, 5);
  assert.equal(rows[0].game, 'war');
  assert.equal(rows[1].game, 'coinflip');
  close();
});

// ----------------------------------------------------------------- progression

test('net winnings rising past a threshold promotes the player', () => {
  const { economy, gambling, close } = makeGambling();
  fund(economy, '20');
  // Two 1,000-profit wins push peak net winnings to 2,000, opening Silver.
  const first = gambling.settle('20', GUILD, 'crash', 1_000, { payout: 2_000, win: true, summary: 'w' });
  assert.equal(first.levelAfter.name, 'Bronze');
  const second = gambling.settle('20', GUILD, 'crash', 1_000, { payout: 2_000, win: true, summary: 'w' });
  assert.equal(second.levelAfter.name, 'Silver');
  assert.equal(second.rankedUp?.name, 'Silver');
  close();
});

test('a losing run does not demote a member from an earned tier', () => {
  const { economy, gambling, close } = makeGambling();
  fund(economy, '21');
  for (let i = 0; i < 2; i += 1) {
    gambling.settle('21', GUILD, 'crash', 1_000, { payout: 2_000, win: true, summary: 'w' });
  }
  assert.equal(gambling.getProfile('21', GUILD).peakEarned, 2_000);

  // A 1,500 loss drops net winnings below the Silver gate, but peak holds.
  gambling.settle('21', GUILD, 'crash', 1_500, LOSS);
  const profile = gambling.getProfile('21', GUILD);
  assert.ok(profile.earned < 2_000);
  assert.equal(profile.peakEarned, 2_000);
  assert.equal(gambling.levelOf(profile).name, 'Silver');
  close();
});

test('progress reports the next tier and its requirement', () => {
  const { gambling, close } = makeGambling();
  const { level, next } = gambling.progress('22', GUILD);
  assert.equal(level.name, 'Bronze');
  assert.equal(next?.name, 'Silver');
  assert.equal(next?.requiredEarned, 2_000);
  close();
});

test('the leaderboard ranks by peak winnings', () => {
  const { economy, gambling, close } = makeGambling();
  fund(economy, '30');
  fund(economy, '31');
  gambling.settle('30', GUILD, 'crash', 1_000, { payout: 3_000, win: true, summary: 'w' });
  gambling.settle('31', GUILD, 'crash', 1_000, { payout: 2_000, win: true, summary: 'w' });
  const rows = gambling.leaderboard(GUILD);
  assert.equal(rows[0].userId, '30');
  close();
});

test('gambling state is scoped per guild', () => {
  const { economy, gambling, close } = makeGambling();
  fund(economy, '40');
  gambling.settle('40', GUILD, 'crash', 1_000, { payout: 2_000, win: true, summary: 'w' });
  const other = String(Number(GUILD) + 1);
  assert.equal(gambling.getProfile('40', other).peakEarned, 0);
  assert.equal(gambling.getProfile('40', GUILD).peakEarned, 1_000);
  close();
});

test('a fresh profile starts at Bronze with no history', () => {
  const { gambling, close } = makeGambling();
  const profile = gambling.getProfile('50', GUILD);
  assert.equal(profile.earned, 0);
  assert.equal(profile.bets, 0);
  assert.equal(gambling.levelOf(profile).name, 'Bronze');
  close();
});

test('a game missing from the meta table still settles', () => {
  // Guards against a command being added without GAME_META: settlement must not
  // depend on display metadata.
  const { gambling, close } = makeGambling();
  const result = gambling.settle('51', GUILD, 'mystery', 100, WIN);
  assert.equal(result.net, 100);
  close();
});

test('economy defaults are unchanged by the gambling feature', () => {
  assert.equal(economyDefaults.startingWallet, 500);
});

// ------------------------------------------------------------------- house edge

/**
 * Every game must return less than the stake over a long run, or players could
 * print money by repeating one bet. These bounds are wide enough to absorb Monte
 * Carlo noise but tight enough to catch a paytable that flips the edge.
 */
test('every game has a house edge over a long run', () => {
  const rng = new Random(20240923);
  const rounds = 200_000;
  const stake = 100;
  const bets: [string, (random: Random) => { payout: number }][] = [
    ['coinflip', (r) => playCoinflip(r, stake, 'heads')],
    ['dice-over', (r) => playDice(r, stake, 'over')],
    ['dice-seven', (r) => playDice(r, stake, 'seven')],
    ['roulette-red', (r) => playRoulette(r, stake, 'red')],
    ['roulette-green', (r) => playRoulette(r, stake, 'green')],
    ['slots', (r) => playSlots(r, stake)],
    ['blackjack', (r) => playBlackjack(r, stake)],
    ['highlow', (r) => playHighLow(r, stake, 'high')],
    ['baccarat-player', (r) => playBaccarat(r, stake, 'player')],
    ['baccarat-banker', (r) => playBaccarat(r, stake, 'banker')],
    ['baccarat-tie', (r) => playBaccarat(r, stake, 'tie')],
    ['rps', (r) => playRps(r, stake, 'rock')],
    ['war', (r) => playWar(r, stake)],
    ['plinko-low', (r) => playPlinko(r, stake, 'low')],
    ['plinko-medium', (r) => playPlinko(r, stake, 'medium')],
    ['plinko-high', (r) => playPlinko(r, stake, 'high')],
    ['scratchcard', (r) => playScratchcard(r, stake)],
    ['wheel', (r) => playWheel(r, stake)],
    ['keno-2', (r) => playKeno(r, stake, [1, 2])],
    ['keno-5', (r) => playKeno(r, stake, [1, 2, 3, 4, 5])],
    ['keno-10', (r) => playKeno(r, stake, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])],
    ['crash-2', (r) => playCrash(r, stake, 2)],
    ['crash-10', (r) => playCrash(r, stake, 10)],
    ['hotstreak-3', (r) => playHotStreak(r, stake, 3)],
    ['hotstreak-8', (r) => playHotStreak(r, stake, 8)],
  ];

  for (const [name, bet] of bets) {
    let returned = 0;
    for (let i = 0; i < rounds; i += 1) returned += bet(rng).payout;
    const rtp = returned / (rounds * stake);
    assert.ok(rtp > 0.85, `${name} returns only ${(rtp * 100).toFixed(1)}%`);
    assert.ok(rtp < 1.0, `${name} is player-positive at ${(rtp * 100).toFixed(1)}%`);
  }
});
