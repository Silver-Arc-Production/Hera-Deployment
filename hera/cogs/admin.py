"""Administrative commands: manual ticks, seeding and market resets."""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from ..config import config
from ..ui.embeds import error_embed, trade_result_embed


class Admin(commands.Cog):
    """Owner-only controls for running the simulation by hand."""

    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    def _is_operator(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id == self.bot.owner_id:
            return True
        if isinstance(interaction.user, discord.Member):
            return interaction.user.guild_permissions.manage_guild
        return False

    async def _deny(self, interaction: discord.Interaction) -> None:
        await interaction.response.send_message(
            embed=error_embed("You need the Manage Server permission to use that."),
            ephemeral=True,
        )

    @app_commands.command(name="tick", description="Advance the market by one tick right now.")
    @app_commands.describe(count="How many ticks to advance (1-24).")
    async def tick(self, interaction: discord.Interaction, count: int = 1) -> None:
        if not self._is_operator(interaction):
            await self._deny(interaction)
            return
        count = max(1, min(24, count))
        await interaction.response.defer()
        for _ in range(count):
            await self.bot.run_market_tick(interaction.guild_id)  # type: ignore[attr-defined]
        snapshot = await self.bot.market.snapshot(interaction.guild_id)  # type: ignore[attr-defined]
        await interaction.followup.send(
            embed=trade_result_embed(
                title="⏩ Market advanced",
                description=f"Ran {count} tick(s). Now at tick **{snapshot.tick:,}**.",
                color=config.embed_color,
                fields=[
                    ("Index", f"{snapshot.index_value:,.2f}"),
                    ("Regime", snapshot.regime),
                ],
            )
        )

    @app_commands.command(name="wipe", description="Delete all market and economy data in this server.")
    async def wipe(self, interaction: discord.Interaction) -> None:
        if not self._is_operator(interaction):
            await self._deny(interaction)
            return
        await interaction.response.send_message(
            embed=error_embed(
                "Wiping is intentionally not implemented: it would destroy every member's "
                "balance irreversibly. Reset the market by deleting the database file "
                "while the bot is stopped."
            ),
            ephemeral=True,
        )


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Admin(bot))
