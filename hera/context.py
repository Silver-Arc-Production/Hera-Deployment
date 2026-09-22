"""One command body, two front ends.

Every command exists as both a slash command and a prefix message command, but
the two APIs differ in almost every respect: ``discord.Interaction`` versus
``commands.Context``, ``guild_id`` versus ``guild.id``, and so on. Rather than
write each command twice, the cogs accept a :class:`CommandContext` and talk
only to that. This module adapts the two Discord APIs onto one interface.

The subtle one is ``defer``. A slash command must acknowledge within three
seconds, so long commands defer and then use the followup endpoint. A prefix
command has no acknowledgement requirement and no followup endpoint, so
deferring is unnecessary and the "followup" is just another message.
"""

from __future__ import annotations

import functools
import inspect
import logging
from typing import Any, Literal, Protocol, runtime_checkable

import discord
from discord import app_commands
from discord.ext import commands
from discord.ext.commands.core import get_signature_parameters

log = logging.getLogger("hera")

__all__ = ["CommandContext", "SlashContext", "PrefixContext", "bind_contexts"]

_EPHEMERAL_FOOTER = "Private by default — posted here because your DMs are closed."


def bind_contexts(cls: type) -> type:
    """Class decorator: give every slash command a prefixed twin.

    Slash commands are written once and read naturally. This decorator derives a
    matching message command for each of them, so the two front ends share a
    callback and cannot drift apart — adding a slash command automatically adds
    its ``!`` form.

    The generated commands are installed on the cog's own ``__cog_commands__``,
    which is what ``Cog._inject`` walks when the cog is added to a bot, so no
    per-command boilerplate is needed.

    Failures are reported by :meth:`HeraBot.on_command_error`, the same place slash
    failures are handled, so there is one error path rather than two.
    """
    commands_list = list(cls.__dict__.get("__cog_commands__", []))
    commands_list.extend(_mirror_commands(cls))
    if commands_list:
        cls.__cog_commands__ = commands_list

    return cls


def _mirror_commands(cls: type) -> list[commands.Command]:
    """Build a prefixed twin for every slash command defined on ``cls``.

    The twin shares the callback, so the body — and therefore the behaviour —
    cannot drift from the slash command. Only the public shape is translated from
    the app-command model to the message-command model, which is the same
    approach discord.py's own hybrid commands take.
    """
    mirrors: list[commands.Command] = []
    for command in getattr(cls, "__cog_app_commands__", []):
        callback = getattr(command, "_callback", None)
        if callback is None:
            continue

        params = _message_parameters(command, callback)
        choice_names = frozenset(p.name for p in command.parameters if p.choices)
        names = tuple(params)

        async def invoke(
            cog,
            ctx,
            *args,
            _callback=callback,
            _choices=choice_names,
            _names=names,
            **kwargs,
        ):
            # discord.py passes positional parameters by position and "consume
            # rest" ones by keyword; re-key everything by name for the shared body.
            bound = dict(zip(_names, args))
            bound.update(kwargs)
            for name in _choices:
                value = bound.get(name)
                if value is not None and not isinstance(value, ChoiceValue):
                    bound[name] = ChoiceValue(value)
            return await _callback(cog, PrefixContext(ctx), **bound)

        functools.update_wrapper(invoke, callback)
        # Present the translated parameters to inspect. Without this,
        # ``update_wrapper``'s ``__wrapped__`` sends signature lookups back to the
        # original app-command callback, whose ``Choice[...]`` annotations discord.py
        # cannot parse for message commands -- and every command copy re-derives its
        # parameters from this signature, so it has to be the translated one.
        invoke.__signature__ = inspect.Signature(
            [
                inspect.Parameter("self", inspect.Parameter.POSITIONAL_OR_KEYWORD),
                inspect.Parameter("ctx", inspect.Parameter.POSITIONAL_OR_KEYWORD),
                *params.values(),
            ]
        )

        twin = commands.Command(
            invoke,
            name=command.name,
            description=getattr(command, "description", "") or "",
        )
        mirrors.append(twin)
    return mirrors


def _message_parameters(
    command: app_commands.Command, callback: Any
) -> dict[str, inspect.Parameter]:
    """Translate app-command parameters into message-command parameters.

    Choice parameters become ``Literal[...]`` so prefix users get the same
    validation the Discord client enforces for slash users; the literal's value is
    rewrapped as a :class:`ChoiceValue` at call time.
    """
    params = get_signature_parameters(callback, callback.__globals__, skip_parameters=2)
    offered = {
        parameter.name: [choice.value for choice in parameter.choices]
        for parameter in command.parameters
        if parameter.choices
    }
    translated: dict[str, inspect.Parameter] = {}
    for name, param in params.items():
        values = offered.get(name)
        if values:
            param = param.replace(annotation=Literal[tuple(values)])
        translated[name] = param
    return translated


class ChoiceValue(str):
    """A prefix-supplied choice, shaped like :class:`app_commands.Choice`.

    Command bodies read ``choice.value``. For a slash command that attribute comes
    from the chosen option; for a prefix command the typed word *is* the value, so
    the string carries itself and no body has to care which front end it came from.
    """

    @property
    def value(self) -> str:
        return str(self)


@runtime_checkable
class CommandContext(Protocol):
    """The slice of interaction/context behaviour the command bodies rely on."""

    @property
    def user(self) -> discord.abc.User: ...

    @property
    def guild_id(self) -> int: ...

    @property
    def guild(self) -> discord.Guild | None: ...

    @property
    def channel(self) -> discord.abc.Messageable: ...

    async def defer(self) -> None: ...

    async def send(
        self,
        *,
        embed: discord.Embed | None = None,
        view: discord.ui.View | None = None,
        ephemeral: bool = False,
        file: discord.File | None = None,
    ) -> None: ...

    async def followup_send(
        self,
        *,
        embed: discord.Embed | None = None,
        view: discord.ui.View | None = None,
        ephemeral: bool = False,
        file: discord.File | None = None,
    ) -> None: ...


class SlashContext:
    """Thin adapter over :class:`discord.Interaction`."""

    def __init__(self, interaction: discord.Interaction) -> None:
        self.interaction = interaction

    @property
    def user(self) -> discord.abc.User:
        return self.interaction.user

    @property
    def guild_id(self) -> int:
        guild_id = self.interaction.guild_id
        if guild_id is None:
            raise ValueError("This command only works inside a server.")
        return guild_id

    @property
    def guild(self) -> discord.Guild | None:
        return self.interaction.guild

    @property
    def channel(self) -> discord.abc.Messageable:
        return self.interaction.channel  # type: ignore[return-value]

    async def defer(self) -> None:
        await self.interaction.response.defer()

    async def send(
        self,
        *,
        embed: discord.Embed | None = None,
        view: discord.ui.View | None = None,
        ephemeral: bool = False,
        file: discord.File | None = None,
    ) -> None:
        kwargs: dict[str, Any] = {"ephemeral": ephemeral}
        if file is not None:
            kwargs["file"] = file
        if embed is not None:
            kwargs["embed"] = embed
        if view is not None:
            kwargs["view"] = view
        if self.interaction.response.is_done():
            await self.interaction.followup.send(**kwargs)
        else:
            await self.interaction.response.send_message(**kwargs)

    async def followup_send(
        self,
        *,
        embed: discord.Embed | None = None,
        view: discord.ui.View | None = None,
        ephemeral: bool = False,
        file: discord.File | None = None,
    ) -> None:
        await self.send(embed=embed, view=view, ephemeral=ephemeral, file=file)


class PrefixContext:
    """Adapter over :class:`commands.Context`.

    Prefix replies go back via ``reply`` so they thread onto the invoking
    message. "Ephemeral" has no equivalent for a message command, so private
    responses are direct-messaged instead, falling back to the channel (clearly
    labelled) only when the member's DMs are closed.
    """

    def __init__(self, ctx: commands.Context) -> None:
        self.ctx = ctx

    @property
    def message(self) -> discord.Message:
        return self.ctx.message

    @property
    def user(self) -> discord.abc.User:
        return self.ctx.author

    @property
    def guild_id(self) -> int:
        if self.ctx.guild is None:
            raise ValueError("This command only works inside a server.")
        return self.ctx.guild.id

    @property
    def guild(self) -> discord.Guild | None:
        return self.ctx.guild

    @property
    def channel(self) -> discord.abc.Messageable:
        return self.ctx.channel

    async def defer(self) -> None:
        # Nothing to acknowledge: a prefix command has no interaction deadline,
        # so the reply simply goes out when the work finishes.
        return None

    async def _reply(
        self,
        *,
        embed: discord.Embed | None = None,
        view: discord.ui.View | None = None,
        file: discord.File | None = None,
        content: str | None = None,
    ) -> None:
        kwargs: dict[str, Any] = {}
        if content is not None:
            kwargs["content"] = content
        if embed is not None:
            kwargs["embed"] = embed
        if view is not None:
            kwargs["view"] = view
        if file is not None:
            kwargs["file"] = file
        try:
            await self.message.reply(**kwargs)
        except discord.HTTPException:
            # The invoking message can be gone (deleted, or an old reference);
            # a plain channel send still gets the answer to the user.
            destination = self.ctx.channel
            if isinstance(destination, discord.abc.Messageable):
                await destination.send(**kwargs)

    async def send(
        self,
        *,
        embed: discord.Embed | None = None,
        view: discord.ui.View | None = None,
        ephemeral: bool = False,
        file: discord.File | None = None,
    ) -> None:
        if not ephemeral:
            await self._reply(embed=embed, view=view, file=file)
            return

        sent_privately = False
        try:
            dm_kwargs: dict[str, Any] = {}
            if embed is not None:
                dm_kwargs["embed"] = embed
            if view is not None:
                dm_kwargs["view"] = view
            if file is not None:
                dm_kwargs["file"] = file
            await self.user.send(**dm_kwargs)  # type: ignore[union-attr]
            sent_privately = True
        except discord.HTTPException:
            log.debug("could not DM %s; falling back to the channel", self.user.id)

        if sent_privately:
            # The answer is already where the user wanted it. Saying so in the
            # channel would announce activity they asked to keep private.
            return

        if embed is not None:
            embed.set_footer(text=_EPHEMERAL_FOOTER)
        await self._reply(
            embed=embed,
            view=view,
            file=file,
            content=None if embed is not None else _EPHEMERAL_FOOTER,
        )

    async def followup_send(
        self,
        *,
        embed: discord.Embed | None = None,
        view: discord.ui.View | None = None,
        ephemeral: bool = False,
        file: discord.File | None = None,
    ) -> None:
        await self.send(embed=embed, view=view, ephemeral=ephemeral, file=file)
