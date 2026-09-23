/**
 * Wagering: table tiers, wager validation and wager settlement.
 *
 * Every casino command funnels through :meth:`GamblingService.settle`, so the
 * rules are enforced in exactly one place:
 *
 * * A wager must be a whole number of credits inside the player's current table
 *   limits. Limits come from the tier ladder in :mod:`hera/config`.
 * * The stake is debited, the game's payout credited, and the net result folded
 *   into the player's lifetime profile -- the sole driver of tier progression.
 * * All cash movement goes through :class:`EconomyService`, so the ledger keeps
 *   every gambling transaction.
 *
 * Tier progression counts *peak net winnings*. Net winnings rise and fall with
 * every bet, so gating on the live figure would let a lucky player reach a tier
 * once and then be demoted by a losing run, or a single early win pay for a
 * lifetime of tier access. Using the peak means a tier, once earned, is kept.
 */
import type { GamblingConfig, GambleLevel } from '../config';
import type { Database } from '../database';
import { BetTooLarge, BetTooSmall, InvalidBet } from '../errors';
import { Random } from '../market/random';
import type { EconomyService } from '../services/economy';
import type { GameOutcome } from './games';

export interface GamblingProfile {
  userId: string;
  guildId: string;
  /** Lifetime net gambling profit; may go negative. */
  earned: number;
  /** Highest net winnings ever reached; this is what gates the tiers. */
  peakEarned: number;
  wagered: number;
  bets: number;
  wins: number;
  biggestWin: number;
}

export interface GameStatRow {
  game: string;
  plays: number;
  wagered: number;
  net: number;
}

export interface GamblingLogRow {
  game: string;
  wager: number;
  net: number;
  createdAt: number;
}

export interface BetResult {
  game: string;
  wager: number;
  payout: number;
  /** ``payout - wager``. */
  net: number;
  outcome: GameOutcome;
  profile: GamblingProfile;
  levelBefore: GambleLevel;
  levelAfter: GambleLevel;
  /** The tier newly unlocked by this bet, if any. */
  rankedUp: GambleLevel | null;
  /** Wallet balance after the stake and payout have settled. */
  walletAfter: number;
}

interface ProfileRow {
  user_id: string;
  guild_id: string;
  earned: number;
  peak_earned: number;
  wagered: number;
  bets: number;
  wins: number;
  biggest_win: number;
}

export class GamblingService {
  constructor(
    private readonly db: Database,
    private readonly economy: EconomyService,
    private readonly config: GamblingConfig,
    private readonly rng: Random = new Random(),
  ) {}

  get random(): Random {
    return this.rng;
  }

  // ------------------------------------------------------------------ reads

  getProfile(userId: string, guildId: string): GamblingProfile {
    let row = this.db.fetchone<ProfileRow>(
      'SELECT * FROM gambling_profiles WHERE user_id = ? AND guild_id = ?',
      [userId, guildId],
    );
    if (!row) {
      this.db.execute(
        `INSERT INTO gambling_profiles (user_id, guild_id)
         VALUES (?, ?)
         ON CONFLICT (user_id, guild_id) DO NOTHING`,
        [userId, guildId],
      );
      row = this.db.fetchone<ProfileRow>(
        'SELECT * FROM gambling_profiles WHERE user_id = ? AND guild_id = ?',
        [userId, guildId],
      );
    }
    return rowToProfile(row!);
  }

  /** Per-game lifetime totals, best-paying first. */
  gameStats(userId: string, guildId: string): GameStatRow[] {
    return this.db
      .fetchall<{ game: string; plays: number; wagered: number; net: number }>(
        `SELECT game, plays, wagered, net FROM gambling_games
         WHERE user_id = ? AND guild_id = ? ORDER BY net DESC`,
        [userId, guildId],
      )
      .map((row) => ({
        game: row.game,
        plays: Number(row.plays),
        wagered: Number(row.wagered),
        net: Number(row.net),
      }));
  }

  ledger(userId: string, guildId: string, limit = 10): GamblingLogRow[] {
    return this.db
      .fetchall<{ game: string; net: number; wager: number; created_at: number }>(
        `SELECT game, net, wager, created_at FROM gambling_log
         WHERE user_id = ? AND guild_id = ? ORDER BY id DESC LIMIT ?`,
        [userId, guildId, limit],
      )
      .map((row) => ({
        game: row.game,
        net: Number(row.net),
        wager: Number(row.wager),
        createdAt: Number(row.created_at),
      }));
  }

  /** Rank members by peak net gambling winnings. */
  leaderboard(guildId: string, limit = 10): { userId: string; earned: number }[] {
    return this.db
      .fetchall<{ user_id: string; peak_earned: number }>(
        `SELECT user_id, peak_earned FROM gambling_profiles
         WHERE guild_id = ? ORDER BY peak_earned DESC LIMIT ?`,
        [guildId, limit],
      )
      .map((row) => ({ userId: String(row.user_id), earned: Number(row.peak_earned) }));
  }

  // ------------------------------------------------------------------ tiers

  /** The highest tier a given peak-winnings figure has unlocked. */
  levelFor(peakEarned: number): GambleLevel {
    let found = this.config.levels[0];
    for (const level of this.config.levels) {
      if (peakEarned >= level.requiredEarned) found = level;
    }
    return found;
  }

  levelOf(profile: GamblingProfile): GambleLevel {
    return this.levelFor(profile.peakEarned);
  }

  /** The tier after ``level``, or ``null`` at the top of the ladder. */
  nextLevel(level: GambleLevel): GambleLevel | null {
    return this.config.levels.find((candidate) => candidate.index === level.index + 1) ?? null;
  }

  /** Progress towards the next tier: the requirement and how much is banked. */
  progress(userId: string, guildId: string): {
    level: GambleLevel;
    next: GambleLevel | null;
    peakEarned: number;
  } {
    const profile = this.getProfile(userId, guildId);
    const level = this.levelOf(profile);
    return { level, next: this.nextLevel(level), peakEarned: profile.peakEarned };
  }

  // --------------------------------------------------------------- wagering

  /**
   * Validate a raw wager string against the player's table and wallet.
   *
   * ``all``/``max`` are honoured but clamped to the table ceiling, so a Bronze
   * player who types ``all`` stakes the most their table allows rather than
   * their whole wallet. The returned amount is a whole number of credits.
   */
  parseWager(raw: string, userId: string, guildId: string): number {
    const level = this.levelOf(this.getProfile(userId, guildId));
    const account = this.economy.getAccount(userId, guildId);
    // A leading currency sigil is accepted for parity with the market commands,
    // where '$50' means a 50-credit order. Here the bet is always in credits.
    const text = raw
      .trim()
      .toLowerCase()
      .replace(/^[$€£¥]/, '')
      .replace(/[,_]/g, '');
    if (!text) throw new InvalidBet('A bet is required.');

    let amount: number;
    if (text === 'all' || text === 'max') {
      amount = Math.min(account.wallet, level.maxBet);
    } else if (text === 'half' || text === '1/2') {
      amount = Math.min(account.wallet, level.maxBet) / 2;
    } else {
      const match = /^(\d+(?:\.\d+)?)\s*([kmb])?$/.exec(text);
      if (!match) {
        throw new InvalidBet(`'${raw}' is not a valid bet. Try 100, 5k or all.`);
      }
      const scale = match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : match[2] === 'b' ? 1_000_000_000 : 1;
      amount = Number.parseFloat(match[1]) * scale;
    }

    amount = Math.floor(amount);
    if (amount <= 0) throw new InvalidBet('Your bet must be at least a whole credit.');
    if (amount < level.minBet) throw new BetTooSmall(level.minBet, level.name);
    if (amount > level.maxBet) throw new BetTooLarge(level.maxBet, level.name);
    return amount;
  }

  /**
   * Take a stake, pay the result, and record it against the player's profile.
   *
   * The economy's own :class:`InsufficientFunds` guard rejects a stake the wallet
   * cannot cover, so this never has to second-guess a balance.
   */
  settle(userId: string, guildId: string, game: string, wager: number, outcome: GameOutcome): BetResult {
    const before = this.getProfile(userId, guildId);
    const levelBefore = this.levelOf(before);

    this.db.transaction(() => {
      this.economy.debit(userId, guildId, wager, {
        kind: 'gamble_stake',
        note: `${game} stake`,
      });
      if (outcome.payout > 0) {
        this.economy.credit(userId, guildId, outcome.payout, {
          kind: 'gamble_payout',
          note: `${game} payout`,
        });
      }

      const net = outcome.payout - wager;
      const earned = before.earned + net;
      const peak = Math.max(before.peakEarned, earned);
      const biggestWin = Math.max(before.biggestWin, outcome.payout - wager);
      this.db.execute(
        `UPDATE gambling_profiles
         SET earned = ?, peak_earned = ?, wagered = wagered + ?, bets = bets + ?,
             wins = wins + ?, biggest_win = ?, updated_at = unixepoch('subsec')
         WHERE user_id = ? AND guild_id = ?`,
        [earned, peak, wager, 1, outcome.win ? 1 : 0, biggestWin, userId, guildId],
      );
      this.db.execute(
        `INSERT INTO gambling_games (user_id, guild_id, game, plays, wagered, net)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT (user_id, guild_id, game) DO UPDATE SET
             plays = plays + 1,
             wagered = wagered + excluded.wagered,
             net = net + excluded.net,
             updated_at = unixepoch('subsec')`,
        [userId, guildId, game, wager, net],
      );
      this.db.execute(
        `INSERT INTO gambling_log (user_id, guild_id, game, wager, net)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, guildId, game, wager, net],
      );
    });

    const profile = this.getProfile(userId, guildId);
    const levelAfter = this.levelOf(profile);
    const rankedUp = levelAfter.index > levelBefore.index ? levelAfter : null;
    return {
      game,
      wager,
      payout: outcome.payout,
      net: outcome.payout - wager,
      outcome,
      profile,
      levelBefore,
      levelAfter,
      rankedUp,
      walletAfter: this.economy.getAccount(userId, guildId).wallet,
    };
  }
}

function rowToProfile(row: ProfileRow): GamblingProfile {
  return {
    userId: String(row.user_id),
    guildId: String(row.guild_id),
    earned: Number(row.earned),
    peakEarned: Number(row.peak_earned),
    wagered: Number(row.wagered),
    bets: Number(row.bets),
    wins: Number(row.wins),
    biggestWin: Number(row.biggest_win),
  };
}
