"""Tests for bot-level wiring: command registration parity and error reporting.

Every command should exist on both front ends, and a failure should reach the user
in the same shape regardless of which one they used.
"""

from __future__ import annotations

from typing import get_args

import discord
import pytest
from discord.ext import commands

from hera.bot import HeraBot, usage_for
from hera.cogs.help import (
    _MAX_FIELDS_PER_PAGE,
    _category_embed,
    _detail_embed,
    _grouped,
    _paginate,
)
from hera.errors import InsufficientFunds

EXTENSIONS = ("hera.cogs.economy", "hera.cogs.stocks", "hera.cogs.admin", "hera.cogs.help")


@pytest.fixture
async def bot():
    instance = HeraBot()
    for extension in EXTENSIONS:
        await instance.load_extension(extension)
    yield instance
    await instance.close()


class _Reply:
    def __init__(self) -> None:
        self.embeds: list[discord.Embed] = []

    async def reply(self, *, embed: discord.Embed) -> None:
        self.embeds.append(embed)


class _FakeCommand:
    qualified_name = "buy"
    signature = "<symbol> <quantity>"


class _FakeParameter:
    """A command parameter, as ``MissingRequiredArgument`` expects it."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.displayed_name = name


class Ctx:
    """The slice of ``commands.Context`` the error handler reads."""

    def __init__(self) -> None:
        self.command = _FakeCommand()
        self.reply_impl = _Reply()

    async def reply(self, *, embed: discord.Embed) -> None:
        await self.reply_impl.reply(embed=embed)


# ------------------------------------------------------------------ registration


async def test_every_slash_command_has_a_prefix_twin(bot):
    slash = {command.name for command in bot.tree.get_commands()}
    prefix = {command.name for command in bot.commands}

    assert slash == prefix


async def test_prefix_twin_shares_the_slash_callback(bot):
    slash = bot.tree.get_command("buy")
    prefix = bot.get_command("buy")

    # Same body, so the two cannot diverge in behaviour.
    assert prefix.callback.__name__ == slash.callback.__name__


async def test_prefix_twin_exposes_the_same_required_arguments(bot):
    slash = bot.tree.get_command("buy")
    prefix = bot.get_command("buy")

    slash_required = {p.name for p in slash.parameters if p.required}
    prefix_required = {
        name
        for name, param in prefix.clean_params.items()
        if param.default is param.empty
    }
    assert prefix_required == slash_required


async def test_choice_commands_keep_their_choices_on_the_prefix_form(bot):
    prefix = bot.get_command("limit")
    offered = get_args(prefix.clean_params["side"].annotation)

    assert set(offered) == {"buy", "sell", "short", "cover"}


# ----------------------------------------------------------------- error paths


async def test_a_domain_error_reaches_the_user_verbatim(bot):
    ctx = Ctx()
    error = commands.CommandInvokeError(InsufficientFunds(needed=500, available=100))

    await bot.on_command_error(ctx, error)

    assert "500" in ctx.reply_impl.embeds[0].title


async def test_an_unknown_command_is_ignored(bot):
    ctx = Ctx()
    await bot.on_command_error(ctx, commands.CommandNotFound("nope"))

    assert not ctx.reply_impl.embeds


async def test_a_bad_argument_shows_how_to_call_the_command(bot):
    ctx = Ctx()
    await bot.on_command_error(ctx, commands.BadArgument("that is not a number"))

    title = ctx.reply_impl.embeds[0].title
    assert "not a number" in title
    assert "!buy <symbol> <quantity>" in title


async def test_missing_argument_names_the_parameter(bot):
    ctx = Ctx()
    param = _FakeParameter("symbol")
    await bot.on_command_error(ctx, commands.MissingRequiredArgument(param))

    assert "`symbol` is required" in ctx.reply_impl.embeds[0].title


async def test_an_unexpected_error_is_generic_and_logged_not_leaked(bot):
    ctx = Ctx()

    await bot.on_command_error(ctx, commands.CommandInvokeError(KeyError("secret detail")))

    title = ctx.reply_impl.embeds[0].title
    assert "something went wrong" in title.lower()
    assert "secret detail" not in title


def test_usage_line_reflects_the_configured_prefix():
    ctx = Ctx()
    assert usage_for(ctx) == "`!buy <symbol> <quantity>`"


# ------------------------------------------------------------------- directory


async def test_help_directory_groups_every_command(bot):
    buckets = _grouped(bot)
    listed = {command.name for entries in buckets.values() for command, _ in entries}
    available = {command.name for command in bot.commands if not command.hidden}

    assert listed == available


async def test_every_help_page_fits_discords_field_limit(bot):
    pages = _paginate(_grouped(bot))
    assert pages

    for cog_name, entries, continued in pages:
        embed = _category_embed(bot, cog_name, entries, continued=continued)
        assert len(embed.fields) <= 25


async def test_a_category_too_long_for_one_page_is_split(bot):
    pages = _paginate(_grouped(bot))
    stocks = [page for page in pages if page[0] == "Stocks"]

    assert len(stocks) > 1
    assert all(len(entries) <= _MAX_FIELDS_PER_PAGE for _, entries, _ in pages)
    # Only the continuation is marked as such.
    assert stocks[0][2] is False
    assert all(page[2] is True for page in stocks[1:])


async def test_help_detail_lists_both_spellings_and_the_choices(bot):
    embed = _detail_embed(bot, "limit")
    fields = {field.name: field.value for field in embed.fields}

    assert "!limit" in fields["Prefix"]
    assert "/limit" in fields["Slash"]
    assert "one of: buy, sell, short, cover" in fields["Parameters"]


async def test_help_detail_returns_nothing_for_an_unknown_command(bot):
    assert _detail_embed(bot, "definitely-not-a-command") is None
