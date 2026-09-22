"""Embed builders and interactive Discord views.

Embeds are built as plain functions returning :class:`discord.Embed` so they can
be unit tested without a live bot. Views own the pagination and confirmation
state and expire on their own so they do not leak message references.
"""

from __future__ import annotations

from typing import Awaitable, Callable, Sequence

import discord

from ..config import config
from ..formatting import arrow, compact, money, percent, price, progress_bar, signed
from ..market.engine import CompanyState, NewsItem
from ..services.trading import Portfolio

REGIME_LABEL = {
    "bull": "🐂 Bull market",
    "neutral": "😐 Neutral market",
    "bear": "🐻 Bear market",
}
REGIME_COLOR = {"bull": 0x2ECC71, "neutral": 0x95A5A6, "bear": 0xE74C3C}


# ---------------------------------------------------------------- market views


def market_overview_embed(
    *,
    index_value: float,
    index_change: float,
    regime: str,
    tick: int,
    companies: Sequence[CompanyState],
) -> discord.Embed:
    embed = discord.Embed(
        title="📈 Hera Exchange",
        description=(
            f"**Index** {index_value:,.2f}  {arrow(index_change)} "
            f"{percent(index_change * 100)}\n"
            f"{REGIME_LABEL.get(regime, regime)}  •  tick **{tick:,}**"
        ),
        color=REGIME_COLOR.get(regime, config.embed_color),
    )

    gainers = sorted(companies, key=lambda c: c.day_change_fraction, reverse=True)[:5]
    losers = sorted(companies, key=lambda c: c.day_change_fraction)[:5]

    embed.add_field(
        name="🟢 Top gainers",
        value="\n".join(
            f"`{c.symbol:<4}` {price(c.price):>10}  {percent(c.day_change_fraction * 100)}"
            for c in gainers
        )
        or "—",
        inline=True,
    )
    embed.add_field(
        name="🔴 Top losers",
        value="\n".join(
            f"`{c.symbol:<4}` {price(c.price):>10}  {percent(c.day_change_fraction * 100)}"
            for c in losers
        )
        or "—",
        inline=True,
    )

    active = [c for c in companies if c.active_event]
    embed.add_field(
        name="📰 Active stories",
        value="\n".join(f"`{c.symbol}` {c.active_event.replace('_', ' ')}" for c in active[:5])
        or "A quiet session — no major headlines.",
        inline=False,
    )
    embed.set_footer(text="Use /stock list for the full board • /stock chart SYMBOL for a graph")
    return embed


def listing_embed(company: CompanyState, *, held: int = 0, average_cost: float = 0.0) -> discord.Embed:
    change = company.day_change_fraction
    embed = discord.Embed(
        title=f"{company.symbol} — {company.name}",
        description=company.description,
        color=config.embed_color if change >= 0 else config.error_color,
    )
    embed.add_field(name="Price", value=f"**{price(company.price)}**", inline=True)
    embed.add_field(name="Day", value=f"{arrow(change)} {percent(change * 100)}", inline=True)
    embed.add_field(name="Sector", value=company.sector, inline=True)
    embed.add_field(name="Open", value=price(company.open_price), inline=True)
    embed.add_field(name="High", value=price(company.day_high), inline=True)
    embed.add_field(name="Low", value=price(company.day_low), inline=True)
    embed.add_field(name="Market cap", value=f"{config.currency_symbol} {compact(company.market_cap)}", inline=True)
    embed.add_field(
        name="Dividend yield",
        value=percent(company.dividend_yield * 100, signed_output=False) if company.dividend_yield else "—",
        inline=True,
    )
    embed.add_field(name="Volatility", value=f"{company.volatility * 100:.1f}% daily", inline=True)
    if held:
        pnl = (company.price - average_cost) * held
        embed.add_field(
            name="Your position",
            value=(
                f"{held:,} shares @ {price(average_cost)}\n"
                f"{signed(pnl)} ({percent((company.price / average_cost - 1) * 100 if average_cost else 0)})"
            ),
            inline=False,
        )
    if company.halted_until_tick:
        embed.add_field(
            name="⛔ Trading halted",
            value="A circuit breaker paused this listing after a sharp drop.",
            inline=False,
        )
    if company.active_event:
        embed.add_field(
            name="📰 Active story",
            value=company.active_event.replace("_", " ").title(),
            inline=False,
        )
    return embed


def stock_list_embed(
    companies: Sequence[CompanyState], *, page: int, per_page: int, sector: str | None = None
) -> discord.Embed:
    start = page * per_page
    window = companies[start : start + per_page]
    total_pages = max(1, (len(companies) + per_page - 1) // per_page)
    title = f"📊 Stock board — {sector}" if sector else "📊 Stock board"
    embed = discord.Embed(
        title=title,
        description=f"Page {page + 1}/{total_pages} • {len(companies)} listings",
        color=config.embed_color,
    )
    for company in window:
        change = company.day_change_fraction
        embed.add_field(
            name=f"{arrow(change)} `{company.symbol}` {company.name}",
            value=(
                f"{price(company.price)}  {percent(change * 100)}  "
                f"• {company.sector}  • cap {config.currency_symbol}{compact(company.market_cap)}"
            ),
            inline=False,
        )
    return embed


def news_embed(items: Sequence[NewsItem]) -> discord.Embed:
    embed = discord.Embed(title="📰 Market wire", color=config.embed_color)
    if not items:
        embed.description = "No headlines yet. The wire fills up as the market ticks."
        return embed
    for item in items:
        tag = f"`{item.symbol}` " if item.symbol else "`SECTOR` "
        emoji = "🟢" if item.impact >= 0 else "🔴"
        embed.add_field(name=f"{emoji} {tag}", value=item.headline, inline=False)
    return embed


def portfolio_embed(
    portfolio: Portfolio,
    *,
    user: discord.abc.User,
    total_invested: int = 0,
) -> discord.Embed:
    embed = discord.Embed(
        title=f"💼 {user.display_name}'s portfolio",
        color=config.embed_color,
    )
    embed.add_field(name="Wallet", value=money(portfolio.wallet), inline=True)
    embed.add_field(name="Bank", value=money(portfolio.bank), inline=True)
    embed.add_field(name="Net worth", value=money(portfolio.net_worth), inline=True)

    embed.add_field(name="Holdings value", value=money(portfolio.long_value), inline=True)
    embed.add_field(
        name="Unrealised P/L",
        value=signed(portfolio.unrealized_pnl),
        inline=True,
    )
    embed.add_field(
        name="Realised P/L",
        value=signed(portfolio.realized_pnl),
        inline=True,
    )

    if portfolio.positions:
        lines = []
        for position in portfolio.positions[:10]:
            lines.append(
                f"{arrow(position.unrealized_pnl)} `{position.symbol}` "
                f"{position.quantity:,} @ {price(position.average_cost)} → {price(position.price)}  "
                f"{signed(position.unrealized_pnl)} ({percent(position.unrealized_pct)})"
            )
        embed.add_field(name="📈 Long positions", value="\n".join(lines), inline=False)

    if portfolio.shorts:
        lines = []
        for short in portfolio.shorts[:10]:
            lines.append(
                f"{arrow(short.unrealized_pnl)} `{short.symbol}` "
                f"short {short.quantity:,} @ {price(short.average_price)} → {price(short.price)}  "
                f"{signed(short.unrealized_pnl)} ({percent(short.unrealized_pct)})"
            )
        embed.add_field(name="📉 Short positions", value="\n".join(lines), inline=False)

    if not portfolio.positions and not portfolio.shorts:
        embed.add_field(
            name="No positions",
            value="You are all cash. Try `/stock buy NOVA 5` to open a position.",
            inline=False,
        )
    return embed


def order_book_embed(rows: Sequence, *, user: discord.abc.User) -> discord.Embed:
    embed = discord.Embed(title=f"🧾 {user.display_name}'s open orders", color=config.embed_color)
    if not rows:
        embed.description = "No resting orders. Use `/stock limit` to place one."
        return embed
    for row in rows:
        side = row["side"].upper()
        embed.add_field(
            name=f"#{row['id']} • {side} {row['quantity']:,} {row['symbol']}",
            value=(
                f"limit {price(float(row['limit_price']))} • filled {row['filled_quantity']:,} • "
                f"expires tick {row['expires_tick']}"
            ),
            inline=False,
        )
    return embed


def alerts_embed(rows: Sequence, *, user: discord.abc.User) -> discord.Embed:
    embed = discord.Embed(title=f"🔔 {user.display_name}'s price alerts", color=config.embed_color)
    if not rows:
        embed.description = "No alerts set. Use `/stock alert NOVA above 500`."
        return embed
    for row in rows:
        embed.add_field(
            name=f"#{row['id']} {row['symbol']} {row['direction']} {price(float(row['threshold']))}",
            value=row["note"] or "—",
            inline=False,
        )
    return embed


def watchlist_embed(
    symbols: Sequence[str], companies: Sequence[CompanyState], *, user: discord.abc.User
) -> discord.Embed:
    embed = discord.Embed(title=f"⭐ {user.display_name}'s watchlist", color=config.embed_color)
    if not companies:
        embed.description = "Your watchlist is empty. Use `/stock watch add NOVA`."
        return embed
    for company in companies:
        change = company.day_change_fraction
        embed.add_field(
            name=f"{arrow(change)} `{company.symbol}`",
            value=f"{price(company.price)}  {percent(change * 100)}",
            inline=True,
        )
    return embed


def leaderboard_embed(rows: Sequence, *, guild: discord.Guild, kind: str) -> discord.Embed:
    embed = discord.Embed(title=f"🏆 {kind} leaderboard", color=config.embed_color)
    medals = ["🥇", "🥈", "🥉"]
    lines = []
    for index, row in enumerate(rows):
        member = guild.get_member(int(row["user_id"]))
        name = member.display_name if member else f"User {row['user_id']}"
        prefix = medals[index] if index < len(medals) else f"`#{index + 1:>2}`"
        lines.append(f"{prefix} **{name}** — {money(float(row['net_worth']))}")
    embed.description = "\n".join(lines) or "Nobody has any wealth yet."
    return embed


def sector_embed(performance: dict[str, float]) -> discord.Embed:
    embed = discord.Embed(title="🏭 Sector performance", color=config.embed_color)
    for sector, change in sorted(performance.items(), key=lambda item: item[1], reverse=True):
        bar = progress_bar(abs(change), 0.05, width=10)
        embed.add_field(
            name=f"{arrow(change)} {sector}",
            value=f"{percent(change * 100)}  `{bar}`",
            inline=False,
        )
    return embed


def trade_result_embed(
    *,
    title: str,
    description: str,
    color: int,
    fields: Sequence[tuple[str, str]] = (),
) -> discord.Embed:
    embed = discord.Embed(title=title, description=description, color=color)
    for name, value in fields:
        embed.add_field(name=name, value=value, inline=True)
    return embed


def error_embed(message: str) -> discord.Embed:
    return discord.Embed(title="❌ " + message, color=config.error_color)


# ---------------------------------------------------------------------- views


class Paginator(discord.ui.View):
    """Generic prev/next paginator that rebuilds embeds on demand."""

    def __init__(
        self,
        *,
        author_id: int,
        total_pages: int,
        build: Callable[[int], discord.Embed],
        timeout: float = 120.0,
    ) -> None:
        super().__init__(timeout=timeout)
        self.author_id = author_id
        self.total_pages = max(1, total_pages)
        self.build = build
        self.page = 0
        self._sync()

    def _sync(self) -> None:
        self.previous.disabled = self.page <= 0
        self.next.disabled = self.page >= self.total_pages - 1
        self.counter.label = f"{self.page + 1}/{self.total_pages}"

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.author_id:
            await interaction.response.send_message(
                "These buttons belong to someone else. Run the command yourself.",
                ephemeral=True,
            )
            return False
        return True

    @discord.ui.button(label="◀", style=discord.ButtonStyle.secondary)
    async def previous(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        self.page = max(0, self.page - 1)
        self._sync()
        await interaction.response.edit_message(embed=self.build(self.page), view=self)

    @discord.ui.button(label="1/1", style=discord.ButtonStyle.primary, disabled=True)
    async def counter(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        pass

    @discord.ui.button(label="▶", style=discord.ButtonStyle.secondary)
    async def next(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        self.page = min(self.total_pages - 1, self.page + 1)
        self._sync()
        await interaction.response.edit_message(embed=self.build(self.page), view=self)


class ConfirmView(discord.ui.View):
    """Yes/No confirmation for destructive or expensive actions."""

    def __init__(self, *, author_id: int, on_confirm: Callable[[], Awaitable[None]]) -> None:
        super().__init__(timeout=60.0)
        self.author_id = author_id
        self.on_confirm = on_confirm

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.author_id:
            await interaction.response.send_message(
                "This confirmation is not for you.", ephemeral=True
            )
            return False
        return True

    @discord.ui.button(label="Confirm", style=discord.ButtonStyle.danger)
    async def confirm(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await self.on_confirm()
        await interaction.response.edit_message(content="✅ Done.", embed=None, view=None)
        self.stop()

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
    async def cancel(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.edit_message(content="Cancelled.", embed=None, view=None)
        self.stop()
