/** Tests for wallet, bank, cooldowns and the transaction ledger. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { economyDefaults } from '../hera/config';
import { BankFull, CooldownActive, InsufficientFunds } from '../hera/errors';
import { makeHarness, GUILD } from './harness';

const cfg = economyDefaults;

test('a new account gets the starting wallet', () => {
  const h = makeHarness();
  const account = h.economy.getAccount('1', GUILD);
  assert.equal(account.wallet, cfg.startingWallet);
  assert.equal(account.bank, 0);
  assert.equal(account.bankCapacity, cfg.startingBankCapacity);
  h.close();
});

test('account creation is idempotent', () => {
  const h = makeHarness();
  const first = h.economy.getAccount('2', GUILD);
  const second = h.economy.getAccount('2', GUILD);
  assert.equal(first.wallet, second.wallet);
  h.close();
});

test('credit and debit round trip', () => {
  const h = makeHarness();
  h.economy.getAccount('3', GUILD);
  h.economy.credit('3', GUILD, 500, { kind: 'test' });
  h.economy.debit('3', GUILD, 200, { kind: 'test' });
  assert.equal(h.economy.getAccount('3', GUILD).wallet, cfg.startingWallet + 300);
  h.close();
});

test('debit beyond wallet raises', () => {
  const h = makeHarness();
  h.economy.getAccount('4', GUILD);
  assert.throws(() => h.economy.debit('4', GUILD, 10_000_000, { kind: 'test' }), InsufficientFunds);
  h.close();
});

test('credit and debit reject non-positive amounts', () => {
  const h = makeHarness();
  h.economy.getAccount('5', GUILD);
  assert.throws(() => h.economy.credit('5', GUILD, 0, { kind: 'test' }), /positive/);
  assert.throws(() => h.economy.debit('5', GUILD, -5, { kind: 'test' }), /positive/);
  h.close();
});

test('deposit and withdraw move between pockets', () => {
  const h = makeHarness();
  h.economy.getAccount('6', GUILD);
  h.economy.transfer('6', GUILD, 400);
  let account = h.economy.getAccount('6', GUILD);
  assert.equal(account.bank, 400);
  assert.equal(account.wallet, cfg.startingWallet - 400);

  h.economy.withdraw('6', GUILD, 150);
  account = h.economy.getAccount('6', GUILD);
  assert.equal(account.bank, 250);
  assert.equal(account.wallet, cfg.startingWallet - 250);
  h.close();
});

test('deposit respects bank capacity', () => {
  const h = makeHarness();
  h.economy.getAccount('7', GUILD);
  h.economy.credit('7', GUILD, cfg.startingBankCapacity, { kind: 'test' });
  assert.throws(
    () => h.economy.transfer('7', GUILD, cfg.startingBankCapacity + 1),
    BankFull,
  );
  h.close();
});

test('deposit beyond wallet raises', () => {
  const h = makeHarness();
  h.economy.getAccount('8', GUILD);
  assert.throws(
    () => h.economy.transfer('8', GUILD, cfg.startingWallet + 1),
    InsufficientFunds,
  );
  h.close();
});

test('withdraw beyond bank raises', () => {
  const h = makeHarness();
  h.economy.getAccount('9', GUILD);
  assert.throws(() => h.economy.withdraw('9', GUILD, 1), InsufficientFunds);
  h.close();
});

test('credit to bank overflows into wallet', () => {
  const h = makeHarness();
  h.economy.getAccount('10', GUILD);
  const big = cfg.startingBankCapacity + 5_000;
  const account = h.economy.credit('10', GUILD, big, { kind: 'test', toBank: true });
  assert.equal(account.bank, cfg.startingBankCapacity);
  assert.equal(account.wallet, cfg.startingWallet + 5_000);
  h.close();
});

test('bank upgrade increases capacity and charges wallet', () => {
  const h = makeHarness();
  h.economy.getAccount('11', GUILD);
  h.economy.credit('11', GUILD, 100_000, { kind: 'test' });
  const [account, cost] = h.economy.upgradeBank('11', GUILD);
  assert.equal(cost, cfg.bankUpgradeBaseCost);
  assert.equal(account.bankLevel, 2);
  assert.equal(account.bankCapacity, cfg.startingBankCapacity + cfg.bankUpgradeCapacity);
  h.close();
});

test('bank upgrade without funds raises', () => {
  const h = makeHarness();
  h.economy.getAccount('12', GUILD);
  assert.throws(() => h.economy.upgradeBank('12', GUILD), InsufficientFunds);
  h.close();
});

test('work pays out then enforces cooldown', () => {
  const h = makeHarness();
  const [payout, account] = h.economy.work('13', GUILD);
  assert.ok(payout >= cfg.workMin && payout <= cfg.workMax);
  assert.ok(account.wallet > cfg.startingWallet);
  assert.throws(() => h.economy.work('13', GUILD), CooldownActive);
  h.close();
});

test('daily increases the streak on consecutive days', () => {
  const h = makeHarness();
  const [payout, streak] = h.economy.daily('14', GUILD);
  assert.equal(streak, 1);
  assert.equal(payout, cfg.dailyAmount);

  // Backdate the claim so the next one counts as a fresh day.
  h.db.execute('UPDATE accounts SET last_daily = ? WHERE user_id = ? AND guild_id = ?', [
    Date.now() / 1000 - cfg.dailyCooldownSeconds - 60,
    '14',
    GUILD,
  ]);
  const [payout2, streak2] = h.economy.daily('14', GUILD);
  assert.equal(streak2, 2);
  assert.ok(payout2 > payout);
  h.close();
});

test('daily resets the streak after a long gap', () => {
  const h = makeHarness();
  h.economy.daily('15', GUILD);
  h.db.execute('UPDATE accounts SET last_daily = ? WHERE user_id = ? AND guild_id = ?', [
    Date.now() / 1000 - cfg.dailyCooldownSeconds * 5,
    '15',
    GUILD,
  ]);
  const [, streak] = h.economy.daily('15', GUILD);
  assert.equal(streak, 1);
  h.close();
});

test('daily enforces its cooldown', () => {
  const h = makeHarness();
  h.economy.daily('16', GUILD);
  assert.throws(() => h.economy.daily('16', GUILD), CooldownActive);
  h.close();
});

test('rob cannot target yourself', () => {
  const h = makeHarness();
  h.economy.getAccount('17', GUILD);
  assert.throws(() => h.economy.rob('17', GUILD, '17'), /yourself/);
  h.close();
});

test('rob moves money or fines the robber', () => {
  const h = makeHarness();
  h.economy.getAccount('18', GUILD);
  h.economy.getAccount('19', GUILD);
  h.economy.credit('19', GUILD, 5_000, { kind: 'test' });

  const victimBefore = h.economy.getAccount('19', GUILD).wallet;
  const robberBefore = h.economy.getAccount('18', GUILD).wallet;
  const [success, amount, robberAfter] = h.economy.rob('18', GUILD, '19');

  if (success) {
    assert.equal(h.economy.getAccount('19', GUILD).wallet, victimBefore - amount);
    assert.equal(robberAfter.wallet, robberBefore + amount);
  } else {
    assert.equal(robberAfter.wallet, robberBefore - amount);
  }
  h.close();
});

test('rob enforces its cooldown', () => {
  const h = makeHarness();
  h.economy.getAccount('20', GUILD);
  h.economy.getAccount('21', GUILD);
  h.economy.rob('20', GUILD, '21');
  assert.throws(() => h.economy.rob('20', GUILD, '21'), CooldownActive);
  h.close();
});

test('ledger records every mutation', () => {
  const h = makeHarness();
  h.economy.getAccount('22', GUILD);
  h.economy.credit('22', GUILD, 100, { kind: 'alpha' });
  h.economy.debit('22', GUILD, 50, { kind: 'beta' });
  const kinds = h.economy.history('22', GUILD, 10).map((row) => row.kind);
  assert.ok(kinds.includes('alpha') && kinds.includes('beta'));
  h.close();
});

test('ledger reconciles with the wallet', () => {
  // ``amount`` is the change in net worth, so the ledger sums to the total.
  // Wallet-to-bank transfers journal a zero amount: they move money between
  // pockets without changing what the member is worth.
  const h = makeHarness();
  h.economy.getAccount('23', GUILD);
  h.economy.credit('23', GUILD, 1_000, { kind: 'a' });
  h.economy.debit('23', GUILD, 400, { kind: 'b' });
  h.economy.transfer('23', GUILD, 300);

  const account = h.economy.getAccount('23', GUILD);
  const rows = h.db.fetchall<{ amount: number }>(
    'SELECT amount FROM transactions WHERE user_id = ? AND guild_id = ?',
    ['23', GUILD],
  );
  assert.equal(account.wallet, 800);
  assert.equal(account.bank, 300);
  assert.equal(account.wallet + account.bank, rows.reduce((sum, row) => sum + Number(row.amount), 0));
  h.close();
});

test('wallet reconciles when there are no transfers', () => {
  const h = makeHarness();
  h.economy.getAccount('24', GUILD);
  h.economy.credit('24', GUILD, 1_000, { kind: 'a' });
  h.economy.debit('24', GUILD, 400, { kind: 'b' });
  const account = h.economy.getAccount('24', GUILD);
  const rows = h.db.fetchall<{ amount: number }>(
    'SELECT amount FROM transactions WHERE user_id = ? AND guild_id = ?',
    ['24', GUILD],
  );
  assert.equal(account.wallet, rows.reduce((sum, row) => sum + Number(row.amount), 0));
  h.close();
});

test('leaderboard ranks by total wealth', () => {
  const h = makeHarness();
  h.economy.getAccount('30', GUILD);
  h.economy.getAccount('31', GUILD);
  h.economy.credit('31', GUILD, 50_000, { kind: 'test' });
  const rows = h.economy.leaderboard(GUILD);
  assert.equal(String(rows[0].user_id), '31');
  h.close();
});

test('accounts are scoped per guild', () => {
  const h = makeHarness();
  const first = h.economy.getAccount('40', GUILD);
  const other = h.economy.getAccount('40', String(Number(GUILD) + 1));
  assert.equal(first.guildId, GUILD);
  assert.equal(other.guildId, String(Number(GUILD) + 1));
  h.close();
});
