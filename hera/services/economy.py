"""Account and currency operations: wallet, bank, daily/work payouts.

Balances live in :mod:`hera.services.stocks`'s database but conceptually belong
to the wider economy. Every mutation writes a row to ``transactions`` so the
history command has a source of truth and balances remain auditable.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass

from ..config import config
from ..database import Database
from ..errors import BankFull, CooldownActive, InsufficientFunds


@dataclass
class Account:
    user_id: int
    guild_id: int
    wallet: int
    bank: int
    bank_capacity: int
    bank_level: int
    daily_streak: int
    last_daily: float | None
    last_work: float | None
    last_rob: float | None

    @property
    def net_worth(self) -> int:
        return self.wallet + self.bank

    @property
    def total(self) -> int:
        return self.wallet + self.bank


class EconomyService:
    """Owns the ``accounts`` and ``transactions`` tables."""

    def __init__(self, db: Database) -> None:
        self.db = db

    # ------------------------------------------------------------------ reads

    async def get_account(self, user_id: int, guild_id: int) -> Account:
        row = await self.db.fetchone(
            "SELECT * FROM accounts WHERE user_id = ? AND guild_id = ?",
            (user_id, guild_id),
        )
        if row is None:
            async with self.db.transaction() as conn:
                await conn.execute(
                    """
                    INSERT INTO accounts (user_id, guild_id, wallet, bank, bank_capacity)
                    VALUES (?, ?, ?, 0, ?)
                    ON CONFLICT (user_id, guild_id) DO NOTHING
                    """,
                    (
                        user_id,
                        guild_id,
                        config.economy.starting_wallet,
                        config.economy.starting_bank_capacity,
                    ),
                )
                await conn.execute(
                    """
                    INSERT INTO transactions
                        (user_id, guild_id, kind, amount, balance_after, note)
                    VALUES (?, ?, 'starting_balance', ?, ?, 'Welcome grant')
                    """,
                    (user_id, guild_id, config.economy.starting_wallet, config.economy.starting_wallet),
                )
            row = await self.db.fetchone(
                "SELECT * FROM accounts WHERE user_id = ? AND guild_id = ?",
                (user_id, guild_id),
            )
        return self._row_to_account(row)

    async def history(self, user_id: int, guild_id: int, limit: int = 10):
        return await self.db.fetchall(
            """
            SELECT kind, amount, balance_after, note, created_at
            FROM transactions
            WHERE user_id = ? AND guild_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (user_id, guild_id, limit),
        )

    async def leaderboard(self, guild_id: int, limit: int = 10):
        """Rank members by total liquid wealth."""
        return await self.db.fetchall(
            """
            SELECT user_id, wallet + bank AS total
            FROM accounts
            WHERE guild_id = ?
            ORDER BY total DESC
            LIMIT ?
            """,
            (guild_id, limit),
        )

    # -------------------------------------------------------------- mutations

    async def credit(
        self,
        user_id: int,
        guild_id: int,
        amount: int,
        *,
        kind: str,
        note: str | None = None,
        to_bank: bool = False,
    ) -> Account:
        """Add credits. Overflow past bank capacity stays in the wallet."""
        if amount <= 0:
            raise ValueError("credit amount must be positive")
        await self.get_account(user_id, guild_id)
        async with self.db.transaction() as conn:
            if to_bank:
                await conn.execute(
                    """
                    UPDATE accounts
                    SET bank = MIN(bank + ?, bank_capacity),
                        wallet = wallet + MAX(0, ? - (bank_capacity - bank)),
                        updated_at = unixepoch('subsec')
                    WHERE user_id = ? AND guild_id = ?
                    """,
                    (amount, amount, user_id, guild_id),
                )
            else:
                await conn.execute(
                    """
                    UPDATE accounts
                    SET wallet = wallet + ?, updated_at = unixepoch('subsec')
                    WHERE user_id = ? AND guild_id = ?
                    """,
                    (amount, user_id, guild_id),
                )
            balance = await self._total_locked(conn, user_id, guild_id)
            await self._journal(conn, user_id, guild_id, kind, amount, balance, note)
        return await self.get_account(user_id, guild_id)

    async def debit(
        self,
        user_id: int,
        guild_id: int,
        amount: int,
        *,
        kind: str,
        note: str | None = None,
        from_bank: bool = False,
    ) -> Account:
        """Remove credits, raising :class:`InsufficientFunds` when short."""
        if amount <= 0:
            raise ValueError("debit amount must be positive")
        account = await self.get_account(user_id, guild_id)
        available = account.bank if from_bank else account.wallet
        if available < amount:
            raise InsufficientFunds(amount, available)
        async with self.db.transaction() as conn:
            column = "bank" if from_bank else "wallet"
            await conn.execute(
                f"""
                UPDATE accounts
                SET {column} = {column} - ?, updated_at = unixepoch('subsec')
                WHERE user_id = ? AND guild_id = ?
                """,
                (amount, user_id, guild_id),
            )
            balance = await self._total_locked(conn, user_id, guild_id)
            await self._journal(conn, user_id, guild_id, kind, -amount, balance, note)
        return await self.get_account(user_id, guild_id)

    async def transfer(self, user_id: int, guild_id: int, amount: int) -> Account:
        """Move credits between wallet and bank in a single transaction."""
        account = await self.get_account(user_id, guild_id)
        if amount <= 0:
            raise ValueError("transfer amount must be positive")
        if account.wallet < amount:
            raise InsufficientFunds(amount, account.wallet)
        if account.bank + amount > account.bank_capacity:
            raise BankFull(account.bank_capacity)
        async with self.db.transaction() as conn:
            await conn.execute(
                """
                UPDATE accounts
                SET wallet = wallet - ?, bank = bank + ?, updated_at = unixepoch('subsec')
                WHERE user_id = ? AND guild_id = ?
                """,
                (amount, amount, user_id, guild_id),
            )
            await self._journal(
                conn, user_id, guild_id, "deposit", 0, account.total, f"Deposited {amount:,}"
            )
        return await self.get_account(user_id, guild_id)

    async def withdraw(self, user_id: int, guild_id: int, amount: int) -> Account:
        account = await self.get_account(user_id, guild_id)
        if amount <= 0:
            raise ValueError("withdrawal amount must be positive")
        if account.bank < amount:
            raise InsufficientFunds(amount, account.bank)
        async with self.db.transaction() as conn:
            await conn.execute(
                """
                UPDATE accounts
                SET wallet = wallet + ?, bank = bank - ?, updated_at = unixepoch('subsec')
                WHERE user_id = ? AND guild_id = ?
                """,
                (amount, amount, user_id, guild_id),
            )
            await self._journal(
                conn, user_id, guild_id, "withdraw", 0, account.total, f"Withdrew {amount:,}"
            )
        return await self.get_account(user_id, guild_id)

    async def upgrade_bank(self, user_id: int, guild_id: int) -> tuple[Account, int]:
        """Purchase the next bank tier. Returns the account and the cost paid."""
        account = await self.get_account(user_id, guild_id)
        cost = config.economy.bank_upgrade_base_cost * account.bank_level
        if account.wallet < cost:
            raise InsufficientFunds(cost, account.wallet)
        async with self.db.transaction() as conn:
            await conn.execute(
                """
                UPDATE accounts
                SET wallet = wallet - ?,
                    bank_level = bank_level + 1,
                    bank_capacity = bank_capacity + ?,
                    updated_at = unixepoch('subsec')
                WHERE user_id = ? AND guild_id = ?
                """,
                (cost, config.economy.bank_upgrade_capacity, user_id, guild_id),
            )
            balance = await self._total_locked(conn, user_id, guild_id)
            await self._journal(
                conn,
                user_id,
                guild_id,
                "bank_upgrade",
                -cost,
                balance,
                f"Bank upgraded to level {account.bank_level + 1}",
            )
        return await self.get_account(user_id, guild_id), cost

    # ------------------------------------------------------------- cooldowns

    @staticmethod
    def _remaining(last: float | None, cooldown: int) -> float:
        if last is None:
            return 0.0
        return max(0.0, (last + cooldown) - time.time())

    async def work(self, user_id: int, guild_id: int) -> tuple[int, Account]:
        account = await self.get_account(user_id, guild_id)
        remaining = self._remaining(account.last_work, config.economy.work_cooldown_seconds)
        if remaining > 0:
            raise CooldownActive(remaining)
        payout = random.randint(config.economy.work_min, config.economy.work_max)
        await self.db.execute(
            "UPDATE accounts SET last_work = ? WHERE user_id = ? AND guild_id = ?",
            (time.time(), user_id, guild_id),
        )
        updated = await self.credit(
            user_id, guild_id, payout, kind="work", note="Shift wages"
        )
        return payout, updated

    async def daily(self, user_id: int, guild_id: int) -> tuple[int, int, Account]:
        """Claim the daily reward. Returns (payout, streak, account)."""
        account = await self.get_account(user_id, guild_id)
        remaining = self._remaining(account.last_daily, config.economy.daily_cooldown_seconds)
        if remaining > 0:
            raise CooldownActive(remaining)

        # The streak survives one missed day; beyond that it resets.
        now = time.time()
        if account.last_daily is None or now - account.last_daily > config.economy.daily_cooldown_seconds * 2:
            streak = 1
        else:
            streak = min(account.daily_streak + 1, config.economy.daily_streak_cap)

        payout = config.economy.daily_amount + config.economy.daily_streak_bonus * (streak - 1)
        async with self.db.transaction() as conn:
            await conn.execute(
                """
                UPDATE accounts
                SET last_daily = ?, daily_streak = ?, updated_at = unixepoch('subsec')
                WHERE user_id = ? AND guild_id = ?
                """,
                (now, streak, user_id, guild_id),
            )
            await conn.execute(
                """
                UPDATE accounts SET bank = MIN(bank + ?, bank_capacity)
                WHERE user_id = ? AND guild_id = ?
                """,
                (payout, user_id, guild_id),
            )
            balance = await self._total_locked(conn, user_id, guild_id)
            await self._journal(
                conn,
                user_id,
                guild_id,
                "daily",
                payout,
                balance,
                f"Daily reward (streak {streak})",
            )
        return payout, streak, await self.get_account(user_id, guild_id)

    async def rob(
        self, user_id: int, guild_id: int, target_id: int
    ) -> tuple[bool, int, Account]:
        """Attempt a robbery. Returns (succeeded, amount, robber account)."""
        if user_id == target_id:
            raise ValueError("you cannot rob yourself")
        robber = await self.get_account(user_id, guild_id)
        remaining = self._remaining(robber.last_rob, config.economy.rob_cooldown_seconds)
        if remaining > 0:
            raise CooldownActive(remaining)
        victim = await self.get_account(target_id, guild_id)

        await self.db.execute(
            "UPDATE accounts SET last_rob = ? WHERE user_id = ? AND guild_id = ?",
            (time.time(), user_id, guild_id),
        )

        if victim.wallet < 100 or random.random() > config.economy.rob_success_chance:
            fine = min(config.economy.rob_fine, robber.wallet)
            if fine > 0:
                await self.debit(user_id, guild_id, fine, kind="rob_fine", note="Failed robbery")
            return False, fine, await self.get_account(user_id, guild_id)

        stolen = int(victim.wallet * random.uniform(0.05, config.economy.rob_max_steal_fraction))
        stolen = max(1, min(stolen, victim.wallet))
        async with self.db.transaction() as conn:
            await conn.execute(
                "UPDATE accounts SET wallet = wallet - ? WHERE user_id = ? AND guild_id = ?",
                (stolen, target_id, guild_id),
            )
            await conn.execute(
                "UPDATE accounts SET wallet = wallet + ? WHERE user_id = ? AND guild_id = ?",
                (stolen, user_id, guild_id),
            )
            victim_balance = await self._total_locked(conn, target_id, guild_id)
            await self._journal(
                conn, target_id, guild_id, "robbed", -stolen, victim_balance, "Robbery"
            )
            robber_balance = await self._total_locked(conn, user_id, guild_id)
            await self._journal(
                conn, user_id, guild_id, "robbery", stolen, robber_balance, "Successful robbery"
            )
        return True, stolen, await self.get_account(user_id, guild_id)

    # ------------------------------------------------------------- internals

    @staticmethod
    async def _total_locked(conn, user_id: int, guild_id: int) -> int:
        async with conn.execute(
            "SELECT wallet + bank FROM accounts WHERE user_id = ? AND guild_id = ?",
            (user_id, guild_id),
        ) as cursor:
            row = await cursor.fetchone()
            return int(row[0]) if row else 0

    @staticmethod
    async def _journal(
        conn,
        user_id: int,
        guild_id: int,
        kind: str,
        amount: int,
        balance_after: int,
        note: str | None,
    ) -> None:
        await conn.execute(
            """
            INSERT INTO transactions (user_id, guild_id, kind, amount, balance_after, note)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (user_id, guild_id, kind, amount, balance_after, note),
        )

    @staticmethod
    def _row_to_account(row) -> Account:
        return Account(
            user_id=row["user_id"],
            guild_id=row["guild_id"],
            wallet=int(row["wallet"]),
            bank=int(row["bank"]),
            bank_capacity=int(row["bank_capacity"]),
            bank_level=int(row["bank_level"]),
            daily_streak=int(row["daily_streak"]),
            last_daily=row["last_daily"],
            last_work=row["last_work"],
            last_rob=row["last_rob"],
        )
