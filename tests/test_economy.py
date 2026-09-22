"""Tests for wallet, bank, cooldowns and the transaction ledger."""

from __future__ import annotations

import time

import pytest

from hera.config import config
from hera.errors import BankFull, CooldownActive, InsufficientFunds
from tests.conftest import GUILD


async def test_new_account_gets_the_starting_wallet(economy):
    account = await economy.get_account(1, GUILD)
    assert account.wallet == config.economy.starting_wallet
    assert account.bank == 0
    assert account.bank_capacity == config.economy.starting_bank_capacity


async def test_account_creation_is_idempotent(economy):
    first = await economy.get_account(2, GUILD)
    second = await economy.get_account(2, GUILD)
    assert first.wallet == second.wallet


async def test_credit_and_debit_round_trip(economy):
    await economy.get_account(3, GUILD)
    await economy.credit(3, GUILD, 500, kind="test")
    await economy.debit(3, GUILD, 200, kind="test")
    account = await economy.get_account(3, GUILD)
    assert account.wallet == config.economy.starting_wallet + 300


async def test_debit_beyond_wallet_raises(economy):
    await economy.get_account(4, GUILD)
    with pytest.raises(InsufficientFunds):
        await economy.debit(4, GUILD, 10_000_000, kind="test")


async def test_credit_and_debit_reject_non_positive_amounts(economy):
    await economy.get_account(5, GUILD)
    with pytest.raises(ValueError):
        await economy.credit(5, GUILD, 0, kind="test")
    with pytest.raises(ValueError):
        await economy.debit(5, GUILD, -5, kind="test")


async def test_deposit_and_withdraw_move_between_pockets(economy):
    await economy.get_account(6, GUILD)
    await economy.transfer(6, GUILD, 400)
    account = await economy.get_account(6, GUILD)
    assert account.bank == 400
    assert account.wallet == config.economy.starting_wallet - 400

    await economy.withdraw(6, GUILD, 150)
    account = await economy.get_account(6, GUILD)
    assert account.bank == 250
    assert account.wallet == config.economy.starting_wallet - 250


async def test_deposit_respects_bank_capacity(economy):
    await economy.get_account(7, GUILD)
    await economy.credit(7, GUILD, config.economy.starting_bank_capacity, kind="test")
    with pytest.raises(BankFull):
        await economy.transfer(7, GUILD, config.economy.starting_bank_capacity + 1)


async def test_deposit_beyond_wallet_raises(economy):
    await economy.get_account(8, GUILD)
    with pytest.raises(InsufficientFunds):
        await economy.transfer(8, GUILD, config.economy.starting_wallet + 1)


async def test_withdraw_beyond_bank_raises(economy):
    await economy.get_account(9, GUILD)
    with pytest.raises(InsufficientFunds):
        await economy.withdraw(9, GUILD, 1)


async def test_credit_to_bank_overflows_into_wallet(economy):
    await economy.get_account(10, GUILD)
    big = config.economy.starting_bank_capacity + 5_000
    account = await economy.credit(10, GUILD, big, kind="test", to_bank=True)
    assert account.bank == config.economy.starting_bank_capacity
    assert account.wallet == config.economy.starting_wallet + 5_000


async def test_bank_upgrade_increases_capacity_and_charges_wallet(economy):
    await economy.get_account(11, GUILD)
    await economy.credit(11, GUILD, 100_000, kind="test")
    account, cost = await economy.upgrade_bank(11, GUILD)
    assert cost == config.economy.bank_upgrade_base_cost
    assert account.bank_level == 2
    assert account.bank_capacity == config.economy.starting_bank_capacity + config.economy.bank_upgrade_capacity


async def test_bank_upgrade_without_funds_raises(economy):
    await economy.get_account(12, GUILD)
    with pytest.raises(InsufficientFunds):
        await economy.upgrade_bank(12, GUILD)


async def test_work_pays_out_then_enforces_cooldown(economy):
    payout, account = await economy.work(13, GUILD)
    assert config.economy.work_min <= payout <= config.economy.work_max
    assert account.wallet > config.economy.starting_wallet

    with pytest.raises(CooldownActive):
        await economy.work(13, GUILD)


async def test_daily_increases_the_streak_on_consecutive_days(economy):
    payout, streak, _ = await economy.daily(14, GUILD)
    assert streak == 1
    assert payout == config.economy.daily_amount

    # Backdate the claim so the next one counts as a fresh day.
    await economy.db.execute(
        "UPDATE accounts SET last_daily = ? WHERE user_id = ? AND guild_id = ?",
        (time.time() - config.economy.daily_cooldown_seconds - 60, 14, GUILD),
    )
    payout2, streak2, _ = await economy.daily(14, GUILD)
    assert streak2 == 2
    assert payout2 > payout


async def test_daily_resets_the_streak_after_a_long_gap(economy):
    await economy.daily(15, GUILD)
    await economy.db.execute(
        "UPDATE accounts SET last_daily = ? WHERE user_id = ? AND guild_id = ?",
        (time.time() - config.economy.daily_cooldown_seconds * 5, 15, GUILD),
    )
    _, streak, _ = await economy.daily(15, GUILD)
    assert streak == 1


async def test_daily_enforces_its_cooldown(economy):
    await economy.daily(16, GUILD)
    with pytest.raises(CooldownActive):
        await economy.daily(16, GUILD)


async def test_rob_cannot_target_yourself(economy):
    await economy.get_account(17, GUILD)
    with pytest.raises(ValueError):
        await economy.rob(17, GUILD, 17)


async def test_rob_moves_money_or_fines_the_robber(economy):
    await economy.get_account(18, GUILD)
    await economy.get_account(19, GUILD)
    await economy.credit(19, GUILD, 5_000, kind="test")

    victim_before = (await economy.get_account(19, GUILD)).wallet
    robber_before = (await economy.get_account(18, GUILD)).wallet
    success, amount, robber_after = await economy.rob(18, GUILD, 19)

    if success:
        assert (await economy.get_account(19, GUILD)).wallet == victim_before - amount
        assert robber_after.wallet == robber_before + amount
    else:
        assert robber_after.wallet == robber_before - amount


async def test_rob_enforces_its_cooldown(economy):
    await economy.get_account(20, GUILD)
    await economy.get_account(21, GUILD)
    await economy.rob(20, GUILD, 21)
    with pytest.raises(CooldownActive):
        await economy.rob(20, GUILD, 21)


async def test_ledger_records_every_mutation(economy):
    await economy.get_account(22, GUILD)
    await economy.credit(22, GUILD, 100, kind="alpha")
    await economy.debit(22, GUILD, 50, kind="beta")
    rows = await economy.history(22, GUILD, limit=10)
    kinds = [row["kind"] for row in rows]
    assert "alpha" in kinds and "beta" in kinds


async def test_ledger_reconciles_with_the_wallet(economy):
    """``amount`` is the change in *net worth*, so the ledger sums to the total.

    Wallet-to-bank transfers journal a zero amount: they move money between
    pockets without changing what the member is worth.
    """
    await economy.get_account(23, GUILD)
    await economy.credit(23, GUILD, 1_000, kind="a")
    await economy.debit(23, GUILD, 400, kind="b")
    await economy.transfer(23, GUILD, 300)

    account = await economy.get_account(23, GUILD)
    rows = await economy.db.fetchall(
        "SELECT amount FROM transactions WHERE user_id = ? AND guild_id = ?", (23, GUILD)
    )
    assert account.wallet == 800
    assert account.bank == 300
    assert account.total == sum(int(row["amount"]) for row in rows)


async def test_wallet_reconciles_when_there_are_no_transfers(economy):
    await economy.get_account(24, GUILD)
    await economy.credit(24, GUILD, 1_000, kind="a")
    await economy.debit(24, GUILD, 400, kind="b")

    account = await economy.get_account(24, GUILD)
    rows = await economy.db.fetchall(
        "SELECT amount FROM transactions WHERE user_id = ? AND guild_id = ?", (24, GUILD)
    )
    assert account.wallet == sum(int(row["amount"]) for row in rows)


async def test_leaderboard_ranks_by_total_wealth(economy):
    await economy.get_account(30, GUILD)
    await economy.get_account(31, GUILD)
    await economy.credit(31, GUILD, 50_000, kind="test")
    rows = await economy.leaderboard(GUILD)
    assert int(rows[0]["user_id"]) == 31


async def test_accounts_are_scoped_per_guild(economy):
    first = await economy.get_account(40, GUILD)
    other = await economy.get_account(40, GUILD + 1)
    assert first.guild_id == GUILD
    assert other.guild_id == GUILD + 1
