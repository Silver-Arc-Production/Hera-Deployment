"""Bot wiring: shared services, background market ticker and event dispatch."""

from __future__ import annotations

import logging

import discord
from discord import app_commands
from discord.ext import commands, tasks

from .config import config
from .database import Database
from .errors import HeraError
from .formatting import money, percent, price, signed
from .services.economy import EconomyService
from .services.market import MarketService
from .services.trading import TradingService

log = logging.getLogger("hera")


def _usage_error(ctx: commands.Context, error: commands.CommandError) -> str:
    """Explain a mistyped command and show how to call it correctly."""
    if isinstance(error, commands.MissingRequiredArgument):
        return f"`{error.param.name}` is required: {usage_for(ctx)}"
    if isinstance(error, commands.BadArgument):
        return f"{error}\n{usage_for(ctx)}"
    return f"That is not how the command is used: {usage_for(ctx)}"


def usage_for(ctx: commands.Context) -> str:
    """Render a copy-pasteable usage line for the invoked command."""
    command = ctx.command
    if command is None:
        return f"Use `{config.prefix}help`."
    return f"`{config.prefix}{command.qualified_name} {command.signature}`".rstrip()


class HeraBot(commands.Bot):
    """A bot instance that owns the database and every shared service."""

    def __init__(self) -> None:
        intents = discord.Intents.default()
        intents.members = True
        # Prefix commands read ordinary messages, which Discord gates behind the
        # privileged Message Content intent. Without it the bot still boots and
        # slash commands still work, but typed commands are invisible to it.
        intents.message_content = True
        super().__init__(
            command_prefix=config.prefix, intents=intents, help_command=None
        )

        self.db = Database(config.db_path)
        self.economy = EconomyService(self.db)
        self.market = MarketService(self.db, config.market)
        self.trading = TradingService(self.db, self.economy, self.market, config.trading)
        self._last_tick_at = 0.0
        self._known_guilds: set[int] = set()

    # -------------------------------------------------------------- lifecycle

    async def setup_hook(self) -> None:
        await self.db.connect()
        for extension in (
            "hera.cogs.economy",
            "hera.cogs.stocks",
            "hera.cogs.admin",
            "hera.cogs.help",
        ):
            await self.load_extension(extension)
            log.info("loaded extension %s", extension)

        if config.guild_id:
            guild = discord.Object(id=config.guild_id)
            self.tree.copy_global_to(guild=guild)
            synced = await self.tree.sync(guild=guild)
            log.info("synced %d commands to guild %s", len(synced), config.guild_id)
        else:
            synced = await self.tree.sync()
            log.info("synced %d global commands", len(synced))

        self.market_ticker.start()

    async def close(self) -> None:
        if self.market_ticker.is_running():
            self.market_ticker.cancel()
        await self.db.close()
        await super().close()

    async def on_ready(self) -> None:
        log.info("logged in as %s (%s)", self.user, self.user.id if self.user else "?")
        self._known_guilds = {guild.id for guild in self.guilds}
        await self.change_presence(
            activity=discord.Activity(
                type=discord.ActivityType.watching, name="the Hera exchange"
            )
        )

    async def on_guild_join(self, guild: discord.Guild) -> None:
        self._known_guilds.add(guild.id)

    # ------------------------------------------------------------ market ticks

    @tasks.loop(seconds=config.market.tick_seconds)
    async def market_ticker(self) -> None:
        """Advance every known guild's market once per tick."""
        # Refresh from the live guild list so markets for guilds joined while
        # offline are picked up without needing on_guild_join to have fired.
        self._known_guilds.update(guild.id for guild in self.guilds)
        for guild_id in list(self._known_guilds):
            try:
                await self.run_market_tick(guild_id)
            except Exception:  # pragma: no cover - defensive
                log.exception("market tick failed for guild %s", guild_id)

    @market_ticker.before_loop
    async def before_market_ticker(self) -> None:
        await self.wait_until_ready()

    async def run_market_tick(self, guild_id: int) -> None:
        """One full market tick: prices, dividends, orders, alerts, news."""
        result = await self.market.tick(guild_id)

        if result.dividends:
            await self.trading.apply_dividends(guild_id, result.dividends)

        fills = await self.trading.process_open_orders(guild_id)
        alerts = await self.trading.triggered_alerts(guild_id)
        margin_calls = await self.trading.margin_calls(guild_id)

        await self._announce(guild_id, result, fills, alerts, margin_calls)

    async def _announce(self, guild_id, result, fills, alerts, margin_calls) -> None:
        """Publish tick outcomes to the configured channel and to users."""
        if not result.news and not fills and not alerts and not margin_calls:
            return

        channel = self.get_channel(config.market_channel_id) if config.market_channel_id else None
        if isinstance(channel, discord.abc.Messageable):
            if result.news:
                headlines = "\n".join(
                    f"{'🟢' if item.impact >= 0 else '🔴'} {item.headline}"
                    for item in result.news[:6]
                )
                embed = discord.Embed(
                    title=f"📰 Market wire — tick {result.tick:,}",
                    description=headlines,
                    color=config.embed_color,
                )
                embed.set_footer(
                    text=f"Index {result.index_value:,.2f} ({percent(result.index_change * 100)})"
                )
                try:
                    await channel.send(embed=embed)
                except discord.HTTPException:
                    log.warning("could not post market news to channel %s", config.market_channel_id)

        # Order fills and alerts are direct messages: they are private by nature.
        for user_id, fill in fills:
            user = self.get_user(user_id)
            if user is None:
                continue
            embed = discord.Embed(
                title="🧾 Limit order filled",
                description=(
                    f"{fill.message}\n{signed(fill.realized_pnl)} realised" if fill.realized_pnl
                    else fill.message
                ),
                color=config.embed_color,
            )
            await self._safe_dm(user, embed)

        for alert in alerts:
            user = self.get_user(alert["user_id"])
            if user is None:
                continue
            embed = discord.Embed(
                title=f"🔔 {alert['symbol']} is {alert['direction']} {price(alert['threshold'])}",
                description=f"Last price: **{price(alert['price'])}**",
                color=config.embed_color,
            )
            if alert["note"]:
                embed.set_footer(text=alert["note"])
            await self._safe_dm(user, embed)

        for call in margin_calls:
            user = self.get_user(call["user_id"])
            if user is None:
                continue
            embed = discord.Embed(
                title=f"⚠️ Margin call on {call['symbol']}",
                description=(
                    f"Your short of {call['quantity']:,} {call['symbol']} is down "
                    f"{money(call['loss'])} against {money(call['collateral'])} of collateral.\n"
                    f"Entry {price(call['entry'])} → now {price(call['price'])}.\n"
                    "Cover the position or post more collateral."
                ),
                color=config.error_color,
            )
            await self._safe_dm(user, embed)

    async def _safe_dm(self, user: discord.User, embed: discord.Embed) -> None:
        try:
            await user.send(embed=embed)
        except (discord.Forbidden, discord.HTTPException):
            # DMs closed is normal; nothing actionable to do.
            pass

    # ---------------------------------------------------------------- errors

    async def on_app_command_error(
        self, interaction: discord.Interaction, error: app_commands.AppCommandError
    ) -> None:
        original = getattr(error, "original", error)
        if isinstance(original, HeraError):
            message = str(original)
        else:
            log.error("command error", exc_info=original)
            message = "Something went wrong handling that command."

        embed = discord.Embed(title=f"❌ {message}", color=config.error_color)
        try:
            if interaction.response.is_done():
                await interaction.followup.send(embed=embed, ephemeral=True)
            else:
                await interaction.response.send_message(embed=embed, ephemeral=True)
        except discord.HTTPException:
            pass

    async def on_command_error(
        self, ctx: commands.Context, error: commands.CommandError
    ) -> None:
        """Report prefixed-command failures the same way slash failures are shown."""
        if isinstance(error, commands.CommandNotFound):
            return
        if isinstance(error, commands.CommandInvokeError):
            original: BaseException = error.original
        else:
            original = error

        if isinstance(original, HeraError):
            message = str(original)
        elif isinstance(original, commands.UserInputError):
            message = _usage_error(ctx, error)
        else:
            log.error("prefix command error", exc_info=original)
            message = "Something went wrong handling that command."

        embed = discord.Embed(title=f"❌ {message}", color=config.error_color)
        try:
            await ctx.reply(embed=embed)
        except discord.HTTPException:
            pass
