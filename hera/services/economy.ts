/**
 * Account and currency operations: wallet, bank, daily/work payouts.
 *
 * Every mutation writes a row to ``transactions`` so the history command has a
 * source of truth and balances remain auditable.
 */
import { config } from '../config';
import type { Database } from '../database';
import { BankFull, CooldownActive, InsufficientFunds } from '../errors';

export interface Account {
  userId: string;
  guildId: string;
  wallet: number;
  bank: number;
  bankCapacity: number;
  bankLevel: number;
  dailyStreak: number;
  lastDaily: number | null;
  lastWork: number | null;
  lastRob: number | null;
}

export function accountNetWorth(account: Account): number {
  return account.wallet + account.bank;
}

interface AccountRow {
  user_id: number;
  guild_id: number;
  wallet: number;
  bank: number;
  bank_capacity: number;
  bank_level: number;
  daily_streak: number;
  last_daily: number | null;
  last_work: number | null;
  last_rob: number | null;
}

export interface TransactionRow {
  kind: string;
  amount: number;
  balance_after: number;
  note: string | null;
  created_at: number;
}

export interface WealthRow {
  user_id: number;
  total: number;
}

export class EconomyService {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------------ reads

  getAccount(userId: string, guildId: string): Account {
    let row = this.db.fetchone<AccountRow>(
      'SELECT * FROM accounts WHERE user_id = ? AND guild_id = ?',
      [userId, guildId],
    );
    if (!row) {
      this.db.transaction(() => {
        this.db.execute(
          `INSERT INTO accounts (user_id, guild_id, wallet, bank, bank_capacity)
           VALUES (?, ?, ?, 0, ?)
           ON CONFLICT (user_id, guild_id) DO NOTHING`,
          [userId, guildId, config.economy.startingWallet, config.economy.startingBankCapacity],
        );
        this.journal(
          userId,
          guildId,
          'starting_balance',
          config.economy.startingWallet,
          config.economy.startingWallet,
          'Welcome grant',
        );
      });
      row = this.db.fetchone<AccountRow>(
        'SELECT * FROM accounts WHERE user_id = ? AND guild_id = ?',
        [userId, guildId],
      );
    }
    return this.rowToAccount(row!);
  }

  history(userId: string, guildId: string, limit = 10): TransactionRow[] {
    return this.db.fetchall<TransactionRow>(
      `SELECT kind, amount, balance_after, note, created_at
       FROM transactions WHERE user_id = ? AND guild_id = ?
       ORDER BY id DESC LIMIT ?`,
      [userId, guildId, limit],
    );
  }

  /** Rank members by total liquid wealth. */
  leaderboard(guildId: string, limit = 10): WealthRow[] {
    return this.db.fetchall<WealthRow>(
      `SELECT user_id, wallet + bank AS total FROM accounts
       WHERE guild_id = ? ORDER BY total DESC LIMIT ?`,
      [guildId, limit],
    );
  }

  // -------------------------------------------------------------- mutations

  /** Add credits. Overflow past bank capacity stays in the wallet. */
  credit(
    userId: string,
    guildId: string,
    amount: number,
    options: { kind: string; note?: string | null; toBank?: boolean },
  ): Account {
    if (amount <= 0) throw new Error('credit amount must be positive');
    this.getAccount(userId, guildId);
    this.db.transaction(() => {
      if (options.toBank) {
        this.db.execute(
          `UPDATE accounts
           SET bank = MIN(bank + ?, bank_capacity),
               wallet = wallet + MAX(0, ? - (bank_capacity - bank)),
               updated_at = unixepoch('subsec')
           WHERE user_id = ? AND guild_id = ?`,
          [amount, amount, userId, guildId],
        );
      } else {
        this.db.execute(
          `UPDATE accounts SET wallet = wallet + ?, updated_at = unixepoch('subsec')
           WHERE user_id = ? AND guild_id = ?`,
          [amount, userId, guildId],
        );
      }
      const balance = this.totalLocked(userId, guildId);
      this.journal(userId, guildId, options.kind, amount, balance, options.note ?? null);
    });
    return this.getAccount(userId, guildId);
  }

  /** Remove credits, raising :class:`InsufficientFunds` when short. */
  debit(
    userId: string,
    guildId: string,
    amount: number,
    options: { kind: string; note?: string | null; fromBank?: boolean },
  ): Account {
    if (amount <= 0) throw new Error('debit amount must be positive');
    const account = this.getAccount(userId, guildId);
    const available = options.fromBank ? account.bank : account.wallet;
    if (available < amount) throw new InsufficientFunds(amount, available);
    this.db.transaction(() => {
      const column = options.fromBank ? 'bank' : 'wallet';
      this.db.execute(
        `UPDATE accounts SET ${column} = ${column} - ?, updated_at = unixepoch('subsec')
         WHERE user_id = ? AND guild_id = ?`,
        [amount, userId, guildId],
      );
      const balance = this.totalLocked(userId, guildId);
      this.journal(userId, guildId, options.kind, -amount, balance, options.note ?? null);
    });
    return this.getAccount(userId, guildId);
  }

  /** Move credits between wallet and bank in a single transaction. */
  transfer(userId: string, guildId: string, amount: number): Account {
    const account = this.getAccount(userId, guildId);
    if (amount <= 0) throw new Error('transfer amount must be positive');
    if (account.wallet < amount) throw new InsufficientFunds(amount, account.wallet);
    if (account.bank + amount > account.bankCapacity) throw new BankFull(account.bankCapacity);
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE accounts SET wallet = wallet - ?, bank = bank + ?, updated_at = unixepoch('subsec')
         WHERE user_id = ? AND guild_id = ?`,
        [amount, amount, userId, guildId],
      );
      this.journal(userId, guildId, 'deposit', 0, accountNetWorth(account), `Deposited ${amount.toLocaleString()}`);
    });
    return this.getAccount(userId, guildId);
  }

  withdraw(userId: string, guildId: string, amount: number): Account {
    const account = this.getAccount(userId, guildId);
    if (amount <= 0) throw new Error('withdrawal amount must be positive');
    if (account.bank < amount) throw new InsufficientFunds(amount, account.bank);
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE accounts SET wallet = wallet + ?, bank = bank - ?, updated_at = unixepoch('subsec')
         WHERE user_id = ? AND guild_id = ?`,
        [amount, amount, userId, guildId],
      );
      this.journal(userId, guildId, 'withdraw', 0, accountNetWorth(account), `Withdrew ${amount.toLocaleString()}`);
    });
    return this.getAccount(userId, guildId);
  }

  /** Purchase the next bank tier. Returns the account and the cost paid. */
  upgradeBank(userId: string, guildId: string): [Account, number] {
    const account = this.getAccount(userId, guildId);
    const cost = config.economy.bankUpgradeBaseCost * account.bankLevel;
    if (account.wallet < cost) throw new InsufficientFunds(cost, account.wallet);
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE accounts
         SET wallet = wallet - ?, bank_level = bank_level + 1,
             bank_capacity = bank_capacity + ?, updated_at = unixepoch('subsec')
         WHERE user_id = ? AND guild_id = ?`,
        [cost, config.economy.bankUpgradeCapacity, userId, guildId],
      );
      const balance = this.totalLocked(userId, guildId);
      this.journal(
        userId,
        guildId,
        'bank_upgrade',
        -cost,
        balance,
        `Bank upgraded to level ${account.bankLevel + 1}`,
      );
    });
    return [this.getAccount(userId, guildId), cost];
  }

  // ------------------------------------------------------------- cooldowns

  private static remaining(last: number | null, cooldown: number): number {
    if (last === null) return 0.0;
    return Math.max(0.0, last + cooldown - Date.now() / 1000);
  }

  work(userId: string, guildId: string): [number, Account] {
    const account = this.getAccount(userId, guildId);
    const remaining = EconomyService.remaining(account.lastWork, config.economy.workCooldownSeconds);
    if (remaining > 0) throw new CooldownActive(remaining);
    const payout = this.randomInt(config.economy.workMin, config.economy.workMax);
    this.db.execute('UPDATE accounts SET last_work = ? WHERE user_id = ? AND guild_id = ?', [
      Date.now() / 1000,
      userId,
      guildId,
    ]);
    const updated = this.credit(userId, guildId, payout, { kind: 'work', note: 'Shift wages' });
    return [payout, updated];
  }

  /** Claim the daily reward. Returns [payout, streak, account]. */
  daily(userId: string, guildId: string): [number, number, Account] {
    const account = this.getAccount(userId, guildId);
    const remaining = EconomyService.remaining(account.lastDaily, config.economy.dailyCooldownSeconds);
    if (remaining > 0) throw new CooldownActive(remaining);

    // The streak survives one missed day; beyond that it resets.
    const now = Date.now() / 1000;
    let streak: number;
    if (
      account.lastDaily === null ||
      now - account.lastDaily > config.economy.dailyCooldownSeconds * 2
    ) {
      streak = 1;
    } else {
      streak = Math.min(account.dailyStreak + 1, config.economy.dailyStreakCap);
    }

    const payout = config.economy.dailyAmount + config.economy.dailyStreakBonus * (streak - 1);
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE accounts SET last_daily = ?, daily_streak = ?, updated_at = unixepoch('subsec')
         WHERE user_id = ? AND guild_id = ?`,
        [now, streak, userId, guildId],
      );
      this.db.execute(
        `UPDATE accounts SET bank = MIN(bank + ?, bank_capacity)
         WHERE user_id = ? AND guild_id = ?`,
        [payout, userId, guildId],
      );
      const balance = this.totalLocked(userId, guildId);
      this.journal(userId, guildId, 'daily', payout, balance, `Daily reward (streak ${streak})`);
    });
    return [payout, streak, this.getAccount(userId, guildId)];
  }

  /** Attempt a robbery. Returns [succeeded, amount, robber account]. */
  rob(userId: string, guildId: string, targetId: string): [boolean, number, Account] {
    if (userId === targetId) throw new Error('you cannot rob yourself');
    const robber = this.getAccount(userId, guildId);
    const remaining = EconomyService.remaining(robber.lastRob, config.economy.robCooldownSeconds);
    if (remaining > 0) throw new CooldownActive(remaining);
    const victim = this.getAccount(targetId, guildId);

    this.db.execute('UPDATE accounts SET last_rob = ? WHERE user_id = ? AND guild_id = ?', [
      Date.now() / 1000,
      userId,
      guildId,
    ]);

    if (victim.wallet < 100 || Math.random() > config.economy.robSuccessChance) {
      const fine = Math.min(config.economy.robFine, robber.wallet);
      if (fine > 0) {
        this.debit(userId, guildId, fine, { kind: 'rob_fine', note: 'Failed robbery' });
      }
      return [false, fine, this.getAccount(userId, guildId)];
    }

    let stolen = Math.trunc(
      victim.wallet * (0.05 + Math.random() * (config.economy.robMaxStealFraction - 0.05)),
    );
    stolen = Math.max(1, Math.min(stolen, victim.wallet));
    this.db.transaction(() => {
      this.db.execute('UPDATE accounts SET wallet = wallet - ? WHERE user_id = ? AND guild_id = ?', [
        stolen,
        targetId,
        guildId,
      ]);
      this.db.execute('UPDATE accounts SET wallet = wallet + ? WHERE user_id = ? AND guild_id = ?', [
        stolen,
        userId,
        guildId,
      ]);
      const victimBalance = this.totalLocked(targetId, guildId);
      this.journal(targetId, guildId, 'robbed', -stolen, victimBalance, 'Robbery');
      const robberBalance = this.totalLocked(userId, guildId);
      this.journal(userId, guildId, 'robbery', stolen, robberBalance, 'Successful robbery');
    });
    return [true, stolen, this.getAccount(userId, guildId)];
  }

  // ------------------------------------------------------------- internals

  private totalLocked(userId: string, guildId: string): number {
    const row = this.db.fetchone<Record<string, number>>(
      'SELECT wallet + bank AS total FROM accounts WHERE user_id = ? AND guild_id = ?',
      [userId, guildId],
    );
    return row ? Number(row.total) : 0;
  }

  private journal(
    userId: string,
    guildId: string,
    kind: string,
    amount: number,
    balanceAfter: number,
    note: string | null,
  ): void {
    this.db.execute(
      `INSERT INTO transactions (user_id, guild_id, kind, amount, balance_after, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, guildId, kind, amount, balanceAfter, note],
    );
  }

  private randomInt(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  private rowToAccount(row: AccountRow): Account {
    return {
      userId: String(row.user_id),
      guildId: String(row.guild_id),
      wallet: Number(row.wallet),
      bank: Number(row.bank),
      bankCapacity: Number(row.bank_capacity),
      bankLevel: Number(row.bank_level),
      dailyStreak: Number(row.daily_streak),
      lastDaily: row.last_daily === null ? null : Number(row.last_daily),
      lastWork: row.last_work === null ? null : Number(row.last_work),
      lastRob: row.last_rob === null ? null : Number(row.last_rob),
    };
  }
}
