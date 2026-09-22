"""The market guide: a plain-language tour of how the simulation behaves.

Everything here is derived from the live configuration so the guide cannot
drift out of step with the engine. If a value is retuned in ``config.py``, the
guide follows automatically.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import discord

from ..config import config
from ..formatting import money, percent
from ..market.companies import COMPANIES, SECTORS


@dataclass(frozen=True)
class GuidePage:
    """One page of the guide."""

    title: str
    description: str
    fields: list[tuple[str, str]] = field(default_factory=list)

    def to_embed(self, *, page: int, total: int) -> discord.Embed:
        embed = discord.Embed(
            title=self.title,
            description=self.description,
            color=config.embed_color,
        )
        for name, value in self.fields:
            embed.add_field(name=name, value=value, inline=False)
        embed.set_footer(text=f"Market guide — page {page + 1} of {total}")
        return embed


def _ticks_per_day() -> int:
    return config.market.session_ticks


def _session_hours() -> str:
    """Human-readable length of one trading session at the current tick rate."""
    seconds = _ticks_per_day() * config.market.tick_seconds
    if seconds % 3600 == 0:
        return f"{seconds // 3600} hours"
    return f"{seconds / 3600:.1f} hours"


def guide_pages() -> list[GuidePage]:
    """Build every guide page from the current configuration."""
    market = config.market
    trading = config.trading
    economy = config.economy

    return [
        GuidePage(
            title="📈 How the exchange works",
            description=(
                f"The exchange lists **{len(COMPANIES)} fictional companies** across "
                f"**{len(SECTORS)} sectors**. All names and tickers are invented.\n\n"
                "Everything is driven by a **tick** — one step of simulated time. "
                f"A tick runs every **{market.tick_seconds} seconds**, and "
                f"**{_ticks_per_day()} ticks** make up one trading day.\n\n"
                f"At the default rate a full day is about **{_session_hours()}**. "
                "The market runs continuously while the bot is online, so prices move "
                "even when nobody is watching. Use `/history`-style commands or "
                "`/market` to catch up."
            ),
            fields=[
                (
                    "The index",
                    f"The **Hera Index** starts at **{market.starting_index:,.0f}** and is "
                    "weighted by market capitalisation — that is, each company's share "
                    "price multiplied by its shares outstanding. Bigger companies move "
                    "the index more. `/market` shows its current level and change.",
                ),
                (
                    "Sectors",
                    "\n".join(f"• {sector}" for sector in SECTORS),
                ),
                (
                    "Sector tendencies",
                    "Each sector has a characteristic sensitivity to the wider market. "
                    "Technology and Entertainment swing hardest; Healthcare and Materials "
                    "are the steady ones. This sensitivity is called **beta** and is shown "
                    "on every quote.",
                ),
            ],
        ),
        GuidePage(
            title="🎲 What moves a price",
            description=(
                "Every tick, each company's price takes a small random step. The size of "
                "that step is the company's **volatility**, which is stated on every quote. "
                "Several forces are applied on top of the random step."
            ),
            fields=[
                (
                    "Drift",
                    "Each company leans gently in a direction over time — its growth story. "
                    "A high drift is a long-term tailwind, but it is small per tick and "
                    "easily overwhelmed by volatility in the short run.",
                ),
                (
                    "Mean reversion",
                    f"Prices are pulled faintly back toward fair value "
                    f"({market.mean_reversion:.4f} per tick). This keeps prices from "
                    "wandering off forever. It is weak, so it does not stop trends.",
                ),
                (
                    "Market regime",
                    f"The whole market sits in one of three regimes: **bull**, **neutral**, "
                    f"or **bear**. A bull market adds a steady upward tilt and calms "
                    f"volatility slightly; a bear market pushes down and makes everything "
                    f"choppier. Regimes last between {market.regime_min_ticks} and "
                    f"{market.regime_max_ticks} ticks, then rotate. `/market` shows the "
                    "current one.",
                ),
                (
                    "News events",
                    f"Roughly {market.event_chance:.0%} of ticks produce an event — good or "
                    f"bad news for one company or a whole sector. An event's effect decays "
                    f"over {market.event_ticks_min}–{market.event_ticks_max} ticks rather "
                    "than landing all at once, so headlines stay relevant for a while. "
                    "Read them with `/news`.",
                ),
                (
                    "Limits and halts",
                    f"No single tick can move a price more than "
                    f"{percent(market.max_tick_move * 100, signed_output=False)} — this "
                    "applies to the random component too, so a crash arrives as a series of "
                    f"bad ticks rather than one. If a company falls "
                    f"{percent(market.circuit_breaker_drop * 100, signed_output=False)} or "
                    f"more in a day, trading in it **halts** for {market.halt_ticks} ticks "
                    "and the price is frozen.",
                ),
            ],
        ),
        GuidePage(
            title="💸 Trading",
            description=(
                "You trade against the market itself, not against other members. Fills are "
                "immediate at the live price, adjusted for size and fees."
            ),
            fields=[
                (
                    "Slippage",
                    "You never fill at the screen price if your order is large. Slippage "
                    "grows with the square root of your order size relative to the "
                    f"company's typical daily volume, and is capped at "
                    f"{percent(trading.max_slippage * 100, signed_output=False)}. Splitting "
                    "a huge order across ticks is cheaper than sending it at once.",
                ),
                (
                    "Commission",
                    f"{percent(trading.commission_rate * 100, signed_output=False)} of the "
                    f"trade's value, with a minimum of {trading.commission_min} and a "
                    f"maximum of {trading.commission_max:,} per fill.",
                ),
                (
                    "Limit orders",
                    "A limit order rests until the market touches your price. It does not "
                    "guarantee a fill — it waits for one. Orders expire after "
                    f"{trading.limit_order_expiry_ticks} ticks, which is about "
                    f"{trading.limit_order_expiry_ticks // max(1, _ticks_per_day())} trading "
                    "days. Review them with `/orders` and pull them with `/cancel`.",
                ),
                (
                    "Short selling",
                    "Shorting lets you profit when a price falls, and your loss is "
                    "unbounded in theory, so it demands collateral. You must post "
                    f"{percent(trading.min_short_collateral_ratio * 100, signed_output=False)} "
                    "of the position's value up front. If the trade goes against you far "
                    "enough to eat into that collateral, you get a **margin call** warning "
                    "by DM. Positions are not force-closed — the decision stays yours.",
                ),
                (
                    "Dividends",
                    f"Some companies pay dividends roughly every "
                    f"{market.dividend_tick_interval} ticks. On the ex-dividend tick the "
                    "share price drops by the payout and holders receive cash for each "
                    "share they own. The drop is not a loss: it is the payout leaving the "
                    "company.",
                ),
            ],
        ),
        GuidePage(
            title="🏦 Money and risk",
            description=(
                "The economy is deliberately separate from the market. You earn through "
                "work and rewards, then choose how much to expose to the exchange."
            ),
            fields=[
                (
                    "Wallet versus bank",
                    "Your **wallet** is spendable and is what trading draws on. Your "
                    "**bank** is storage with a capacity limit, and it is safer: only your "
                    "wallet can be robbed. Move money with `/deposit` and `/withdraw`.",
                ),
                (
                    "Earning",
                    f"`/work` pays between {credits(economy.work_min)} and "
                    f"{credits(economy.work_max)} on a "
                    f"{economy.work_cooldown_seconds // 3600}h cooldown. `/daily` pays "
                    f"{credits(economy.daily_amount)} and grows with a streak up to "
                    f"{economy.daily_streak_cap} days. `/rob` is risky: it succeeds "
                    f"{economy.rob_success_chance:.0%} of the time and fines you "
                    f"{credits(economy.rob_fine)} when it fails.",
                ),
                (
                    "Bank upgrades",
                    f"Start with {credits(economy.starting_bank_capacity)} of storage. "
                    f"`/bankupgrade` costs {credits(economy.bank_upgrade_base_cost)} times "
                    f"your current level and adds "
                    f"{credits(economy.bank_upgrade_capacity)} more.",
                ),
                (
                    "Reading your portfolio",
                    "`/portfolio` splits your net worth into cash, long positions and short "
                    "collateral. `Unrealised` profit is what you would make by closing now; "
                    "`realised` is already banked. Watch the two separately — an open winner "
                    "is not yet money in hand.",
                ),
            ],
        ),
        GuidePage(
            title="🧭 A sensible first hour",
            description="A suggested path if you are new to the exchange.",
            fields=[
                (
                    "1. Get and keep some cash",
                    "Run `/daily` and `/work`. Keep a reserve in your bank rather than "
                    "spending everything — you need a cash buffer for opportunities and to "
                    "avoid forced selling.",
                ),
                (
                    "2. Learn the board",
                    "`/market` for the overall picture, `/list` to browse all 20 companies, "
                    "`/sectors` to see which parts of the market are strong today. Check the "
                    "regime: buying into a bear market is harder than it looks.",
                ),
                (
                    "3. Study a company before buying",
                    "`/quote NOVA` shows price, volatility, drift, beta and dividend yield. "
                    "`/chart NOVA` shows the price history. High volatility means bigger "
                    "swings in both directions.",
                ),
                (
                    "4. Place a small trade",
                    "`/buy NOVA 5` spends real money, so start small while you learn how "
                    "slippage and commission behave. `/position NOVA` tracks it afterwards.",
                ),
                (
                    "5. Automate your discipline",
                    "`/limit` to buy below the market or sell above it without watching the "
                    "chart. `/alert NOVA above 500` pings you when a price crosses a level. "
                    "`/watch NOVA add` puts it on your watchlist.",
                ),
                (
                    "Remember: this is a simulation",
                    "Prices here are generated, not real. Nothing on this market reflects an "
                    "actual company, and no strategy here works in real trading.",
                ),
            ],
        ),
    ]


def credits(amount: float) -> str:
    """Format a whole-credit config amount, e.g. ``🪙 50,000``."""
    return money(float(amount), decimals=0)
