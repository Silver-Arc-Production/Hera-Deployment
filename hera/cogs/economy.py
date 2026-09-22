"""Wallet, bank, daily rewards and the other economy commands."""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from ..config import config
from ..errors import CooldownActive, HeraError, InsufficientFunds
from ..formatting import duration, money, progress_bar, signed
from ..parsing import parse_amount
from ..services.economy import Account, EconomyService
from ..ui.embeds import error_embed


class Economy(commands.Cog):
    """Currency commands shared by the whole bot."""

    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot
        self.economy: EconomyService = bot.economy  # type: ignore[attr-defined]

    # ------------------------------------------------------------------ helpers

    def _balance_embed(self, account: Account, user: discord.abc.User) -> discord.Embed:
        embed = discord.Embed(
            title=f"👛 {user.display_name}'s balance",
            color=config.embed_color,
        )
        embed.add_field(name="Wallet", value=money(account.wallet), inline=True)
        embed.add_field(name="Bank", value=money(account.bank), inline=True)
        embed.add_field(name="Net worth", value=money(account.net_worth), inline=True)
        embed.add_field(
            name="Bank storage",
            value=(
                f"{money(account.bank)} / {money(account.bank_capacity)}\n"
                f"`{progress_bar(account.bank, account.bank_capacity)}`"
            ),
            inline=False,
        )
        return embed

    # ---------------------------------------------------------------- commands

    @app_commands.command(name="balance", description="Show your wallet, bank and net worth.")
    @app_commands.describe(member="Look up someone else's balance instead.")
    async def balance(
        self, interaction: discord.Interaction, member: discord.Member | None = None
    ) -> None:
        target = member or interaction.user
        account = await self.economy.get_account(target.id, interaction.guild_id)
        await interaction.response.send_message(embed=self._balance_embed(account, target))

    @app_commands.command(name="work", description="Do a shift for some credits.")
    async def work(self, interaction: discord.Interaction) -> None:
        try:
            payout, account = await self.economy.work(interaction.user.id, interaction.guild_id)
        except CooldownActive as exc:
            await interaction.response.send_message(
                embed=error_embed(
                    f"You are still tired. Try again in **{duration(exc.seconds_remaining)}**."
                ),
                ephemeral=True,
            )
            return
        embed = discord.Embed(
            title="🛠️ Shift complete",
            description=f"You earned {money(payout)}.",
            color=config.embed_color,
        )
        embed.add_field(name="New wallet", value=money(account.wallet), inline=True)
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="daily", description="Claim your daily reward and build a streak.")
    async def daily(self, interaction: discord.Interaction) -> None:
        try:
            payout, streak, account = await self.economy.daily(
                interaction.user.id, interaction.guild_id
            )
        except CooldownActive as exc:
            await interaction.response.send_message(
                embed=error_embed(
                    f"Already claimed. Come back in **{duration(exc.seconds_remaining)}**."
                ),
                ephemeral=True,
            )
            return
        embed = discord.Embed(
            title="🎁 Daily reward",
            description=f"You collected {money(payout)}.",
            color=config.embed_color,
        )
        embed.add_field(name="Streak", value=f"{streak} day(s)", inline=True)
        embed.add_field(name="Bank", value=money(account.bank), inline=True)
        embed.set_footer(text="Rewards go straight to your bank — spend them with /withdraw.")
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="deposit", description="Move credits from your wallet into the bank.")
    @app_commands.describe(amount="Amount to deposit. Accepts 1k, 2.5m or 'all'.")
    async def deposit(self, interaction: discord.Interaction, amount: str) -> None:
        account = await self.economy.get_account(interaction.user.id, interaction.guild_id)
        try:
            value = parse_amount(amount, maximum=account.wallet)
            updated = await self.economy.transfer(interaction.user.id, interaction.guild_id, value)
        except HeraError as exc:
            await interaction.response.send_message(embed=error_embed(str(exc)), ephemeral=True)
            return
        await interaction.response.send_message(
            embed=self._balance_embed(updated, interaction.user)
        )

    @app_commands.command(name="withdraw", description="Move credits from the bank to your wallet.")
    @app_commands.describe(amount="Amount to withdraw. Accepts 1k, 2.5m or 'all'.")
    async def withdraw(self, interaction: discord.Interaction, amount: str) -> None:
        account = await self.economy.get_account(interaction.user.id, interaction.guild_id)
        try:
            value = parse_amount(amount, maximum=account.bank)
            updated = await self.economy.withdraw(interaction.user.id, interaction.guild_id, value)
        except HeraError as exc:
            await interaction.response.send_message(embed=error_embed(str(exc)), ephemeral=True)
            return
        await interaction.response.send_message(
            embed=self._balance_embed(updated, interaction.user)
        )

    @app_commands.command(name="pay", description="Send credits to another member.")
    @app_commands.describe(member="Who to pay.", amount="How much to send.")
    async def pay(
        self, interaction: discord.Interaction, member: discord.Member, amount: str
    ) -> None:
        if member.id == interaction.user.id:
            await interaction.response.send_message(
                embed=error_embed("You cannot pay yourself."), ephemeral=True
            )
            return
        if member.bot:
            await interaction.response.send_message(
                embed=error_embed("Bots do not need credits."), ephemeral=True
            )
            return
        account = await self.economy.get_account(interaction.user.id, interaction.guild_id)
        try:
            value = parse_amount(amount, maximum=account.wallet)
            await self.economy.debit(
                interaction.user.id,
                interaction.guild_id,
                value,
                kind="transfer_out",
                note=f"Paid {member.display_name}",
            )
            await self.economy.credit(
                member.id,
                interaction.guild_id,
                value,
                kind="transfer_in",
                note=f"Payment from {interaction.user.display_name}",
            )
        except HeraError as exc:
            await interaction.response.send_message(embed=error_embed(str(exc)), ephemeral=True)
            return
        embed = discord.Embed(
            title="💸 Payment sent",
            description=f"{interaction.user.mention} paid {member.mention} {money(value)}.",
            color=config.embed_color,
        )
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="bankupgrade", description="Buy more space in your bank.")
    async def bankupgrade(self, interaction: discord.Interaction) -> None:
        account = await self.economy.get_account(interaction.user.id, interaction.guild_id)
        cost = config.economy.bank_upgrade_base_cost * account.bank_level
        try:
            updated, paid = await self.economy.upgrade_bank(
                interaction.user.id, interaction.guild_id
            )
        except InsufficientFunds as exc:
            await interaction.response.send_message(
                embed=error_embed(
                    f"You need {money(cost)} in your wallet. You have {money(exc.available)}."
                ),
                ephemeral=True,
            )
            return
        embed = discord.Embed(
            title="🏦 Bank upgraded",
            description=f"Paid {money(paid)} for level {updated.bank_level}.",
            color=config.embed_color,
        )
        embed.add_field(name="New capacity", value=money(updated.bank_capacity), inline=True)
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="rob", description="Try to steal from another member's wallet.")
    @app_commands.describe(member="Who to rob.")
    async def rob(self, interaction: discord.Interaction, member: discord.Member) -> None:
        if member.bot or member.id == interaction.user.id:
            await interaction.response.send_message(
                embed=error_embed("Pick a real member who is not you."), ephemeral=True
            )
            return
        try:
            success, amount, account = await self.economy.rob(
                interaction.user.id, interaction.guild_id, member.id
            )
        except CooldownActive as exc:
            await interaction.response.send_message(
                embed=error_embed(f"Lay low for **{duration(exc.seconds_remaining)}**."),
                ephemeral=True,
            )
            return
        except HeraError as exc:
            await interaction.response.send_message(embed=error_embed(str(exc)), ephemeral=True)
            return

        if success:
            embed = discord.Embed(
                title="🕵️ Robbery successful",
                description=f"You lifted {money(amount)} from {member.mention}.",
                color=config.embed_color,
            )
        else:
            embed = discord.Embed(
                title="🚨 Robbery failed",
                description=(
                    f"You were caught and fined {money(amount)}."
                    if amount
                    else "You were caught, but had nothing to pay the fine with."
                ),
                color=config.error_color,
            )
        embed.add_field(name="Wallet", value=money(account.wallet), inline=True)
        await interaction.response.send_message(embed=embed)

    @app_commands.command(name="history", description="Review your recent transactions.")
    @app_commands.describe(count="How many entries to show (max 25).")
    async def history(self, interaction: discord.Interaction, count: int = 10) -> None:
        count = max(1, min(25, count))
        rows = await self.economy.history(interaction.user.id, interaction.guild_id, count)
        embed = discord.Embed(
            title=f"🧾 {interaction.user.display_name}'s transactions",
            color=config.embed_color,
        )
        if not rows:
            embed.description = "No transactions yet."
        else:
            embed.description = "\n".join(
                f"`{row['kind']:<14}` {signed(float(row['amount'])):>16}  {row['note'] or ''}"
                for row in rows
            )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(name="richest", description="Show the wealthiest members in this server.")
    async def richest(self, interaction: discord.Interaction) -> None:
        rows = await self.economy.leaderboard(interaction.guild_id)
        embed = discord.Embed(title="🏆 Richest members", color=config.embed_color)
        medals = ["🥇", "🥈", "🥉"]
        lines = []
        for index, row in enumerate(rows):
            member = interaction.guild.get_member(int(row["user_id"]))
            name = member.display_name if member else f"User {row['user_id']}"
            prefix = medals[index] if index < len(medals) else f"`#{index + 1:>2}`"
            lines.append(f"{prefix} **{name}** — {money(float(row['total']))}")
        embed.description = "\n".join(lines) or "Nobody has any wealth yet."
        await interaction.response.send_message(embed=embed)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Economy(bot))
