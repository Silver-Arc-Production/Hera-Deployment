"""Parsers for user-supplied quantities and prices.

Discord users type things like ``5``, ``10k``, ``2.5m``, ``all`` or ``half``.
Centralising the parsing keeps every command consistent and keeps the error
messages identical across the bot.
"""

from __future__ import annotations

import re

from .errors import InvalidOrder

_SUFFIXES = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}
_NUMBER = re.compile(r"^(\d+(?:\.\d+)?)\s*([kmb])?$")


def parse_amount(raw: str, *, maximum: int | None = None) -> int:
    """Parse a quantity, accepting suffixes and the words ``all``/``half``."""
    text = raw.strip().lower().replace(",", "").replace("_", "")
    if not text:
        raise InvalidOrder("Quantity is required.")

    if text in {"all", "max"}:
        if maximum is None:
            raise InvalidOrder("'all' is not valid here — give a number.")
        return int(maximum)
    if text in {"half", "1/2"}:
        if maximum is None:
            raise InvalidOrder("'half' is not valid here — give a number.")
        return int(maximum // 2)

    match = _NUMBER.match(text)
    if match is None:
        raise InvalidOrder(f"'{raw}' is not a valid quantity. Try 10, 25k or all.")

    value = float(match.group(1)) * _SUFFIXES.get(match.group(2) or "", 1)
    if value <= 0:
        raise InvalidOrder("Quantity must be greater than zero.")
    return int(value)


def parse_price(raw: str) -> float:
    """Parse a limit price, accepting thousands separators."""
    text = raw.strip().lower().replace(",", "").replace("_", "")
    if not text:
        raise InvalidOrder("A price is required.")
    match = _NUMBER.match(text)
    if match is None:
        raise InvalidOrder(f"'{raw}' is not a valid price.")
    value = float(match.group(1)) * _SUFFIXES.get(match.group(2) or "", 1)
    if value <= 0:
        raise InvalidOrder("Price must be greater than zero.")
    return value
