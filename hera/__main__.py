"""Entrypoint: ``python -m hera``."""

from __future__ import annotations

import asyncio
import logging
import signal

import discord

from .bot import HeraBot
from .config import config

log = logging.getLogger("hera")

_SHUTDOWN_SIGNALS = tuple(
    sig
    for sig in (getattr(signal, "SIGTERM", None), getattr(signal, "SIGINT", None))
    if sig is not None
)

# How long to let the Discord connection drain before giving up. Docker sends
# SIGKILL ten seconds after SIGTERM, so this stays comfortably inside that.
_CLOSE_TIMEOUT = 5.0


async def _run() -> None:
    """Start the bot and keep running until it fails or a signal arrives.

    discord.py does not install signal handlers, so without this the process is
    killed outright on SIGTERM - which is what every container platform sends on
    deploy, restart and scale-down. That would skip ``HeraBot.close()``, leaving
    the market ticker running and the SQLite connection unclosed. WAL mode means
    committed ticks survive either way, but a clean close flushes the log and
    releases the lock promptly.
    """
    bot = HeraBot()
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in _SHUTDOWN_SIGNALS:
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # pragma: no cover - non-POSIX platforms
            log.debug("signal handlers are unavailable for %s", sig)

    runner = asyncio.create_task(bot.start(config.token))
    waiter = asyncio.create_task(stop.wait())
    try:
        await asyncio.wait({runner, waiter}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        waiter.cancel()
        if runner.done():
            # The bot finished by itself; re-raise whatever ended it.
            await runner
        else:
            log.info("shutdown signal received; closing Discord connection")
            await bot.close()
            try:
                await asyncio.wait_for(runner, timeout=_CLOSE_TIMEOUT)
            except asyncio.TimeoutError:
                log.warning("connection did not close within %.0fs; exiting", _CLOSE_TIMEOUT)
                runner.cancel()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )
    config.validate()
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        log.info("shutting down")
    except discord.LoginFailure:
        # A clean message and a non-zero exit code, so the platform's log view
        # says what is actually wrong instead of showing a bare traceback.
        log.error("Discord rejected the token; check DISCORD_TOKEN")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
