"""Shared formatting helpers for money, percentages and durations."""

from __future__ import annotations

import math

from .config import config


def money(amount: float, *, symbol: bool = True, decimals: int = 2) -> str:
    """Format a credit amount, e.g. ``🪙 1,234.50``."""
    prefix = f"{config.currency_symbol} " if symbol else ""
    return f"{prefix}{amount:,.{decimals}f}"


def price(amount: float) -> str:
    """Format a share price with adaptive precision for penny stocks."""
    if amount < 1:
        return f"{amount:,.4f}"
    if amount < 100:
        return f"{amount:,.3f}"
    return f"{amount:,.2f}"


def signed(amount: float, *, decimals: int = 2, symbol: bool = True) -> str:
    """Format a value with an explicit +/- sign."""
    prefix = f"{config.currency_symbol} " if symbol else ""
    return f"{'+' if amount >= 0 else '-'}{prefix}{abs(amount):,.{decimals}f}"


def percent(value: float, *, decimals: int = 2, signed_output: bool = True) -> str:
    sign = "+" if value >= 0 and signed_output else ""
    return f"{sign}{value:.{decimals}f}%"


def compact(value: float) -> str:
    """Abbreviate large numbers: 1.23M, 4.56B, 7.89T."""
    abs_value = abs(value)
    for threshold, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs_value >= threshold:
            return f"{value / threshold:,.2f}{suffix}"
    return f"{value:,.0f}"


def arrow(change: float) -> str:
    if change > 0:
        return "🟢"
    if change < 0:
        return "🔴"
    return "⚪"


def duration(seconds: float) -> str:
    """Human-readable countdown, e.g. ``1h 04m 09s``."""
    seconds = max(0, int(math.ceil(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {secs:02d}s"
    if minutes:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"


def progress_bar(current: float, total: float, *, width: int = 12) -> str:
    if total <= 0:
        return "░" * width
    filled = int(max(0.0, min(1.0, current / total)) * width)
    return "█" * filled + "░" * (width - filled)
