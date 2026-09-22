"""The command directory: what exists, and how to call it.

Slash and prefix users see the same information because both forms of every
command are listed side by side. Signatures are read from the live command
objects, so the directory cannot fall out of step with the commands themselves.
"""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from ..config import config
from ..context import CommandContext, bind_contexts
from ..ui.embeds import Paginator, error_embed

# Cog class name -> how the directory groups it.
CATEGORIES: dict[str, tuple[str, str]] = {
    "Economy": ("💰 Economy", "Earning, banking and moving money between members."),
    "Stocks": ("📈 Market", "Quotes, trading, portfolios, alerts and the watchlist."),
    "Admin": ("🔧 Admin", "Operator-only controls for the simulation."),
    "Help": ("ℹ️ Help", "Finding your way around."),
}

_GUIDE_HINT = "New to the market? Read `/markethelp` — it explains ticks, risk and trading."

# Discord caps an embed at 25 fields. Stay below it so a growing category spills
# onto another page instead of being rejected at send time.
_MAX_FIELDS_PER_PAGE = 20


def _usage(command: commands.Command) -> str:
    """Both accepted forms of a command, e.g. ``!buy <symbol> <quantity>``."""
    signature = command.signature
    suffix = f" {signature}".rstrip()
    return f"`{config.prefix}{command.qualified_name}{suffix}`"


def _slash_usage(command: app_commands.Command) -> str:
    parts = []
    for parameter in command.parameters:
        parts.append(
            f"<{parameter.name}>" if parameter.required else f"[{parameter.name}]"
        )
    suffix = f" {' '.join(parts)}".rstrip()
    return f"`/{command.qualified_name}{suffix}`"


def _grouped(bot: commands.Bot) -> dict[str, list[tuple[commands.Command, app_commands.Command | None]]]:
    """Bucket every command by its category, slash twin attached where one exists."""
    buckets: dict[str, list[tuple[commands.Command, app_commands.Command | None]]] = {}

    for command in sorted(bot.commands, key=lambda item: item.qualified_name):
        if command.hidden:
            continue
        cog_name = command.cog.__class__.__name__ if command.cog else "Other"
        if cog_name not in CATEGORIES:
            continue
        slash = bot.tree.get_command(command.name)
        buckets.setdefault(cog_name, []).append((command, slash))

    return buckets


def _category_embed(
    bot: commands.Bot,
    cog_name: str,
    entries: list[tuple[commands.Command, app_commands.Command | None]],
    *,
    continued: bool = False,
) -> discord.Embed:
    title, blurb = CATEGORIES[cog_name]
    heading = f"{title} — commands" if not continued else f"{title} — commands (continued)"
    embed = discord.Embed(
        title=heading,
        description=f"{blurb}\nUse the command on its own or type the prefix form.\n\n{_GUIDE_HINT}",
        color=config.embed_color,
    )
    for command, slash in entries:
        forms = _usage(command)
        if slash is not None:
            forms = f"{forms} · {_slash_usage(slash)}"
        description = (command.description or "No description.").strip()
        embed.add_field(name=forms, value=description, inline=False)
    return embed


def _paginate(
    buckets: dict[str, list[tuple[commands.Command, app_commands.Command | None]]],
) -> list[tuple[str, list[tuple[commands.Command, app_commands.Command | None]], bool]]:
    """Flatten the categories into pages that fit an embed's field limit."""
    pages: list[tuple[str, list[tuple[commands.Command, app_commands.Command | None]], bool]] = []
    for cog_name in CATEGORIES:
        entries = buckets.get(cog_name)
        if not entries:
            continue
        chunks = [
            entries[start : start + _MAX_FIELDS_PER_PAGE]
            for start in range(0, len(entries), _MAX_FIELDS_PER_PAGE)
        ]
        for index, chunk in enumerate(chunks):
            pages.append((cog_name, chunk, index > 0))
    return pages


def _detail_embed(bot: commands.Bot, name: str) -> discord.Embed | None:
    """One command explained in full, or ``None`` if no such command exists."""
    prefix_command = bot.get_command(name)
    slash_command = bot.tree.get_command(name)
    if prefix_command is None and slash_command is None:
        return None

    embed = discord.Embed(
        title=f"ℹ️ {name}",
        description=(
            (prefix_command.description if prefix_command else None)
            or (slash_command.description if slash_command else None)
            or "No description."
        ),
        color=config.embed_color,
    )
    if prefix_command is not None:
        embed.add_field(name="Prefix", value=_usage(prefix_command), inline=False)
    if slash_command is not None:
        embed.add_field(name="Slash", value=_slash_usage(slash_command), inline=False)

    if slash_command is not None and slash_command.parameters:
        lines = []
        for parameter in slash_command.parameters:
            requirement = "required" if parameter.required else "optional"
            if parameter.choices:
                allowed = ", ".join(choice.name for choice in parameter.choices)
                lines.append(f"• `{parameter.name}` ({requirement}) — one of: {allowed}")
            elif parameter.default is not None:
                lines.append(
                    f"• `{parameter.name}` ({requirement}) — defaults to "
                    f"`{parameter.default}`"
                )
            else:
                lines.append(f"• `{parameter.name}` ({requirement})")
        embed.add_field(name="Parameters", value="\n".join(lines), inline=False)

    embed.set_footer(text=_GUIDE_HINT)
    return embed


@bind_contexts
class Help(commands.Cog):
    """A directory of every command, on both front ends."""

    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot

    @app_commands.command(name="help", description="List every command, or explain one in detail.")
    @app_commands.describe(command="Optional: a command name to explain.")
    async def help(self, ctx: CommandContext, command: str | None = None) -> None:
        if command:
            await self._detail(ctx, command)
            return

        buckets = _grouped(self.bot)
        pages = _paginate(buckets)
        if not pages:
            await ctx.send(embed=error_embed("No commands are loaded."), ephemeral=True)
            return

        def build(index: int) -> discord.Embed:
            cog_name, entries, continued = pages[index]
            return _category_embed(self.bot, cog_name, entries, continued=continued)

        view = Paginator(
            author_id=ctx.user.id,
            total_pages=len(pages),
            build=build,
            timeout=240.0,
        )
        await ctx.send(embed=build(0), view=view)

    async def _detail(self, ctx: CommandContext, name: str) -> None:
        cleaned = name.strip().lstrip(config.prefix).lstrip("/").lower()
        embed = _detail_embed(self.bot, cleaned)
        if embed is None:
            await ctx.send(
                embed=error_embed(
                    f"No command called `{cleaned}`. Run `{config.prefix}help` to see them all."
                ),
                ephemeral=True,
            )
            return
        await ctx.send(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Help(bot))
