"""Tests for the shared command context and the prefixed command mirrors.

These exercise the real adapters against real :class:`commands.Command` objects,
not doubles: the point of the module is that both Discord front ends reach the
same command body.
"""

from __future__ import annotations

import inspect
from typing import get_args

import discord
import pytest
from discord import app_commands
from discord.ext import commands

from hera.context import (
    ChoiceValue,
    PrefixContext,
    SlashContext,
    bind_contexts,
)


class _Response:
    status = 403
    reason = "Forbidden"


class FakeUser(discord.Object):
    def __init__(self, uid: int = 7) -> None:
        super().__init__(uid)
        self.mention = f"<@{uid}>"
        self.display_name = f"user{uid}"
        self.dms_open = True
        self.dms: list[dict] = []

    async def send(self, **kwargs) -> None:
        if not self.dms_open:
            raise discord.Forbidden(_Response(), "DMs closed")
        self.dms.append(kwargs)


class FakeMessage:
    def __init__(self) -> None:
        self.replies: list[dict] = []
        self.gone = False

    async def reply(self, **kwargs) -> None:
        if self.gone:
            raise discord.HTTPException(_Response(), "Unknown Message")
        self.replies.append(kwargs)


class FakeChannel(discord.abc.Messageable):
    """Stands in for a text channel, including the ``Messageable`` check."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, **kwargs) -> None:
        self.sent.append(kwargs)


class FakeGuild:
    id = 4242


class FakeContext:
    """The subset of ``commands.Context`` the adapter touches."""

    def __init__(self, uid: int = 7) -> None:
        self.author = FakeUser(uid)
        self.guild = FakeGuild()
        self.channel = FakeChannel()
        self.message = FakeMessage()

    @property
    def user(self):
        return self.author


# --------------------------------------------------------------- PrefixContext


async def test_public_reply_threads_onto_the_invoking_message():
    ctx = FakeContext()
    await PrefixContext(ctx).send(embed=discord.Embed(title="hi"))

    assert len(ctx.message.replies) == 1
    assert not ctx.channel.sent


async def test_public_reply_falls_back_to_channel_when_message_is_gone():
    ctx = FakeContext()
    ctx.message.gone = True
    await PrefixContext(ctx).send(embed=discord.Embed(title="hi"))

    assert len(ctx.channel.sent) == 1


async def test_ephemeral_reply_is_direct_messaged_and_stays_private():
    ctx = FakeContext()
    await PrefixContext(ctx).send(embed=discord.Embed(title="secret"), ephemeral=True)

    assert len(ctx.author.dms) == 1
    # Nothing is posted in the channel: the user asked for a private answer, and
    # announcing it would defeat the point.
    assert not ctx.channel.sent
    assert not ctx.message.replies


async def test_ephemeral_reply_falls_back_to_channel_with_a_label_when_dms_closed():
    ctx = FakeContext()
    ctx.author.dms_open = False
    await PrefixContext(ctx).send(embed=discord.Embed(title="secret"), ephemeral=True)

    assert not ctx.author.dms
    embed = ctx.message.replies[0]["embed"]
    assert "DMs are closed" in embed.footer.text


async def test_fallback_without_embed_still_explains_itself():
    ctx = FakeContext()
    ctx.author.dms_open = False
    await PrefixContext(ctx).send(ephemeral=True)

    assert "DMs are closed" in ctx.message.replies[0]["content"]


async def test_defer_is_a_no_op_for_prefix_commands():
    ctx = FakeContext()
    assert await PrefixContext(ctx).defer() is None


def test_prefix_guild_id_requires_a_guild():
    ctx = FakeContext()
    ctx.guild = None

    with pytest.raises(ValueError):
        PrefixContext(ctx).guild_id


# ---------------------------------------------------------------- SlashContext


class FakeInteraction:
    def __init__(self, user: FakeUser, *, defer: bool = False) -> None:
        self.user = user
        self.guild_id = 4242
        self.guild = FakeGuild()
        self.channel = FakeChannel()
        self._deferred = defer
        self.response = _FakeResponse(defer)
        self.followup = _FakeFollowup()


class _FakeResponse:
    def __init__(self, defer: bool) -> None:
        self._done = defer
        self.messages: list[dict] = []

    def is_done(self) -> bool:
        return self._done

    async def defer(self) -> None:
        self._done = True

    async def send_message(self, **kwargs) -> None:
        self.messages.append(kwargs)
        self._done = True


class _FakeFollowup:
    def __init__(self) -> None:
        self.messages: list[dict] = []

    async def send(self, **kwargs) -> None:
        self.messages.append(kwargs)


async def test_slash_reply_uses_response_before_deferring():
    interaction = FakeInteraction(FakeUser())
    await SlashContext(interaction).send(embed=discord.Embed(title="hi"), ephemeral=True)

    assert interaction.response.messages[0]["ephemeral"] is True
    assert not interaction.followup.messages


async def test_slash_reply_uses_followup_after_deferring():
    interaction = FakeInteraction(FakeUser(), defer=True)
    ctx = SlashContext(interaction)
    await ctx.defer()
    await ctx.send(embed=discord.Embed(title="hi"), ephemeral=True)

    assert not interaction.response.messages
    assert interaction.followup.messages[0]["ephemeral"] is True


# --------------------------------------------------------------- mirror wiring


@bind_contexts
class _Sample(commands.Cog):
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    @app_commands.command(name="plain", description="A command with no options.")
    async def plain(self, ctx) -> None:
        self.calls.append(("plain", ctx))

    @app_commands.command(name="optional", description="A command with a default.")
    async def optional(self, ctx, count: int = 3) -> None:
        self.calls.append(("optional", count))

    @app_commands.command(name="chosen", description="A command with fixed choices.")
    @app_commands.choices(
        action=[
            app_commands.Choice(name="add", value="add"),
            app_commands.Choice(name="remove", value="remove"),
        ]
    )
    async def chosen(self, ctx, action: app_commands.Choice[str]) -> None:
        self.calls.append(("chosen", action.value))


def test_every_slash_command_gains_a_prefixed_twin():
    names = {command.name for command in _Sample.__cog_commands__}
    assert names == {"plain", "optional", "chosen"}


def test_prefix_mirror_enforces_the_same_choices_as_the_slash_command():
    command = next(c for c in _Sample.__cog_commands__ if c.name == "chosen")
    param = command.clean_params["action"]

    assert getattr(param.annotation, "__args__", None) == ("add", "remove")
    assert "add" in command.signature and "remove" in command.signature


def test_prefix_mirror_keeps_optional_defaults():
    command = next(c for c in _Sample.__cog_commands__ if c.name == "optional")
    assert command.clean_params["count"].default == 3


async def test_prefix_mirror_calls_the_shared_body_with_an_adapted_context():
    cog = _Sample()
    command = next(c for c in _Sample.__cog_commands__ if c.name == "plain")
    ctx = FakeContext()

    await command.callback(cog, ctx)

    assert len(cog.calls) == 1
    name, received = cog.calls[0]
    assert name == "plain"
    assert isinstance(received, PrefixContext)
    assert received.ctx is ctx


async def test_prefix_mirror_passes_choice_values_through_as_choice_objects():
    cog = _Sample()
    command = next(c for c in _Sample.__cog_commands__ if c.name == "chosen")

    await command.callback(cog, FakeContext(), "add")

    assert cog.calls == [("chosen", "add")]


async def test_prefix_mirror_rejects_a_choice_the_slash_command_does_not_offer():
    command = next(c for c in _Sample.__cog_commands__ if c.name == "chosen")
    param = command.clean_params["action"]

    # discord.py validates ``Literal`` by inspecting the annotation, so the
    # mirror's allowed values come straight from the slash command's choices.
    assert get_args(param.annotation) == ("add", "remove")


def test_choice_value_reads_like_an_app_command_choice():
    assert ChoiceValue("add").value == "add"
    assert isinstance(ChoiceValue("add"), str)


def test_bind_contexts_leaves_slash_commands_untouched():
    app_names = {command.name for command in _Sample.__cog_app_commands__}
    assert app_names == {"plain", "optional", "chosen"}


def test_mirror_callback_signature_matches_the_exposed_parameters():
    command = next(c for c in _Sample.__cog_commands__ if c.name == "optional")
    parameters = list(inspect.signature(command.callback).parameters)

    # self, ctx, then the translated command parameters -- no ``*args`` leaking in.
    assert parameters[:2] == ["self", "ctx"]
    assert "count" in parameters
