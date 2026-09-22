"""Runtime configuration loaded from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

REPO_ROOT = Path(__file__).resolve().parent.parent


def _env_int(key: str, default: int) -> int:
    raw = os.getenv(key)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    raw = os.getenv(key)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class EconomyConfig:
    """Tuning for the wallet/bank side of the bot."""

    starting_wallet: int = 500
    starting_bank_capacity: int = 50_000
    work_min: int = 120
    work_max: int = 480
    work_cooldown_seconds: int = 3600
    daily_amount: int = 1_000
    daily_cooldown_seconds: int = 86_400
    daily_streak_bonus: int = 150
    daily_streak_cap: int = 7
    bank_upgrade_base_cost: int = 25_000
    bank_upgrade_capacity: int = 50_000
    rob_cooldown_seconds: int = 7200
    rob_success_chance: float = 0.45
    rob_max_steal_fraction: float = 0.25
    rob_fine: int = 250


@dataclass(frozen=True)
class MarketConfig:
    """Tuning for the simulated stock market."""

    tick_seconds: int = field(default_factory=lambda: _env_int("STOCK_TICK_SECONDS", 300))
    history_limit: int = 720
    session_ticks: int = 24
    """Ticks per trading session. At the default 300s tick this is a 2-hour day."""
    starting_index: float = 1_000.0
    mean_reversion: float = 0.004
    max_tick_move: float = 0.18
    min_price: float = 1.0
    max_price: float = 100_000.0
    event_chance: float = 0.22
    event_ticks_min: int = 3
    event_ticks_max: int = 12
    regime_min_ticks: int = 20
    regime_max_ticks: int = 70
    circuit_breaker_drop: float = 0.22
    halt_ticks: int = 3
    dividend_tick_interval: int = 120


@dataclass(frozen=True)
class TradingConfig:
    """Tuning for order execution."""

    commission_rate: float = 0.0025
    commission_min: int = 1
    commission_max: int = 5_000
    slippage_coefficient: float = 0.35
    max_slippage: float = 0.12
    min_short_collateral_ratio: float = 1.5
    margin_call_ratio: float = 0.75
    limit_order_expiry_ticks: int = 240
    short_borrow_fee_rate: float = 0.0004


@dataclass(frozen=True)
class BotConfig:
    token: str = field(default_factory=lambda: os.getenv("DISCORD_TOKEN", ""))
    guild_id: int | None = field(
        default_factory=lambda: (
            int(os.environ["DISCORD_GUILD_ID"])
            if os.getenv("DISCORD_GUILD_ID", "").strip().isdigit()
            else None
        )
    )
    market_channel_id: int | None = field(
        default_factory=lambda: (
            int(os.environ["STOCK_NEWS_CHANNEL_ID"])
            if os.getenv("STOCK_NEWS_CHANNEL_ID", "").strip().isdigit()
            else None
        )
    )
    db_path: Path = field(
        default_factory=lambda: Path(
            os.getenv("DATABASE_PATH", str(REPO_ROOT / "data" / "hera.db"))
        )
    )
    prefix: str = field(default_factory=lambda: os.getenv("COMMAND_PREFIX", "!") or "!")
    currency_symbol: str = field(default_factory=lambda: os.getenv("CURRENCY_SYMBOL", "🪙"))
    currency_name: str = field(default_factory=lambda: os.getenv("CURRENCY_NAME", "credits"))
    embed_color: int = 0x2ECC71
    error_color: int = 0xE74C3C
    run_market_on_startup: bool = field(
        default_factory=lambda: _env_bool("STOCK_RUN_ON_STARTUP", False)
    )
    economy: EconomyConfig = field(default_factory=EconomyConfig)
    market: MarketConfig = field(default_factory=MarketConfig)
    trading: TradingConfig = field(default_factory=TradingConfig)

    def validate(self) -> None:
        if not self.token:
            raise RuntimeError(
                "DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in."
            )
        if not self.prefix.strip():
            raise RuntimeError("COMMAND_PREFIX cannot be blank; leave it unset to use '!'.")


config = BotConfig()
