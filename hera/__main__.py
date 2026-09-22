"""Entrypoint: ``python -m hera``."""

from __future__ import annotations

import asyncio
import logging

from .bot import HeraBot
from .config import config


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )
    config.validate()
    bot = HeraBot()
    try:
        asyncio.run(bot.start(config.token))
    except KeyboardInterrupt:
        logging.getLogger("hera").info("shutting down")


if __name__ == "__main__":
    main()
