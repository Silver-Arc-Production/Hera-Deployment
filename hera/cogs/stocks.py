"""Slash commands for the stock market: quotes, trading, portfolios and alerts."""

from __future__ import annotations

import io

import discord
from discord import app_commands
from discord.ext import commands

from ..config import config
from ..context import CommandContext, bind_contexts
from ..errors import HeraError, InsufficientShares
from ..formatting import money, percent, price, signed
from ..market.companies import SECTORS
from ..parsing import parse_amount, parse_price
from ..services.market import MarketService
from ..services.trading import TradingService
from ..ui import charts
from ..ui.guide import guide_pages
from ..ui.embeds import (
    Paginator,
    alerts_embed,
    error_embed,
    leaderboard_embed,
    listing_embed,
    market_overview_embed,
    news_embed,
    order_book_embed,
    portfolio_embed,
    sector_embed,
    stock_list_embed,
    trade_result_embed,
    watchlist_embed,
)

PER_PAGE = 5


@bind_contexts
class Stocks(commands.Cog):
    """Everything the exchange offers."""

    def __init__(self, bot: commands.Bot) -> None:
        self.bot = bot
        self.market: MarketService = bot.market  # type: ignore[attr-defined]
        self.trading: TradingService = bot.trading  # type: ignore[attr-defined]

    # ------------------------------------------------------------------ helpers

    async def _company_or_error(self, ctx: CommandContext, symbol: str):
        company = await self.market.resolve_symbol(ctx.guild_id, symbol)
        if company is None:
            await ctx.send(
                embed=error_embed(f"No listing matches `{symbol}`."), ephemeral=True
            )
        return company

    async def _symbol_autocomplete(
        self, interaction: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        if interaction.guild_id is None:
            return []
        engine = await self.market.get_engine(interaction.guild_id)
        current = current.upper()
        matches = [
            app_commands.Choice(
                name=f"{company.symbol} — {company.name} ({price(company.price)})",
                value=company.symbol,
            )
            for company in engine.companies.values()
            if current in company.symbol or current in company.name.upper()
        ]
        return matches[:25]

    # -------------------------------------------------------------- market info

    @app_commands.command(name="market", description="Market overview: index, movers and headlines.")
    async def market_overview(self, ctx: CommandContext) -> None:
        snapshot = await self.market.snapshot(ctx.guild_id)
        embed = market_overview_embed(
            index_value=snapshot.index_value,
            index_change=snapshot.index_change,
            regime=snapshot.regime,
            tick=snapshot.tick,
            companies=snapshot.companies,
        )
        await ctx.send(embed=embed)

    @app_commands.command(name="list", description="Browse every listed company.")
    @app_commands.describe(sector="Filter the board to a single sector.")
    @app_commands.choices(
        sector=[app_commands.Choice(name=s, value=s) for s in SECTORS]
    )
    async def list_stocks(
        self, ctx: CommandContext, sector: app_commands.Choice[str] | None = None
    ) -> None:
        snapshot = await self.market.snapshot(ctx.guild_id)
        companies = snapshot.companies
        if sector is not None:
            companies = [c for c in companies if c.sector == sector.value]
        companies = sorted(companies, key=lambda c: c.symbol)
        pages = max(1, (len(companies) + PER_PAGE - 1) // PER_PAGE)
        view = Paginator(
            author_id=ctx.user.id,
            total_pages=pages,
            build=lambda page: stock_list_embed(
                companies,
                page=page,
                per_page=PER_PAGE,
                sector=sector.value if sector else None,
            ),
        )
        await ctx.send(embed=view.build(0), view=view)

    @app_commands.command(name="quote", description="Show the full quote for one company.")
    @app_commands.describe(symbol="Ticker or company name.")
    @app_commands.autocomplete(symbol=_symbol_autocomplete)
    async def quote(self, ctx: CommandContext, symbol: str) -> None:
        company = await self._company_or_error(ctx, symbol)
        if company is None:
            return
        position = await self.trading.get_position(ctx.user.id, ctx.guild_id, company.symbol)
        embed = listing_embed(
            company,
            held=position.quantity if position else 0,
            average_cost=position.average_cost if position else 0.0,
        )
        await ctx.send(embed=embed)

    @app_commands.command(name="chart", description="Render a price chart for a company.")
    @app_commands.describe(
        symbol="Ticker or company name.", points="How many ticks of history to plot."
    )
    @app_commands.autocomplete(symbol=_symbol_autocomplete)
    async def chart(
        self, ctx: CommandContext, symbol: str, points: int = 120
    ) -> None:
        company = await self._company_or_error(ctx, symbol)
        if company is None:
            return
        points = max(10, min(400, points))
        await ctx.defer()
        history = await self.market.history(company.symbol, points)
        position = await self.trading.get_position(
            ctx.user.id, ctx.guild_id, company.symbol
        )
        image = await charts.price_chart(
            company.symbol,
            company.name,
            history,
            average_cost=position.average_cost if position else None,
        )
        if image is None:
            await ctx.followup_send(
                embed=error_embed(
                    "Not enough price history yet — the chart fills in as the market ticks."
                )
            )
            return
        file = discord.File(fp=io.BytesIO(image), filename=f"{company.symbol}.png")
        embed = discord.Embed(
            title=f"{company.symbol} — {company.name}",
            description=(
                f"**{price(company.price)}** {percent(company.day_change_fraction * 100)} "
                f"• {points} ticks • {company.sector}"
            ),
            color=config.embed_color,
        )
        embed.set_image(url=f"attachment://{company.symbol}.png")
        await ctx.followup_send(embed=embed, file=file)

    @app_commands.command(name="compare", description="Chart several companies against each other.")
    @app_commands.describe(symbols="Up to 5 tickers separated by spaces.")
    async def compare(self, ctx: CommandContext, symbols: str) -> None:
        tokens = [token for token in symbols.replace(",", " ").split() if token][:5]
        if len(tokens) < 2:
            await ctx.send(
                embed=error_embed("Give at least two tickers, e.g. `NOVA TERA BREW`."),
                ephemeral=True,
            )
            return
        series: dict[str, list[float]] = {}
        missing: list[str] = []
        for token in tokens:
            company = await self.market.resolve_symbol(ctx.guild_id, token)
            if company is None:
                missing.append(token)
                continue
            history = await self.market.history(company.symbol, 120)
            if history:
                series[company.symbol] = [value for _, value in history]

        if len(series) < 2:
            await ctx.send(
                embed=error_embed(
                    "Need history for at least two of those tickers"
                    + (f" (unknown: {', '.join(missing)})" if missing else ".")
                ),
                ephemeral=True,
            )
            return

        await ctx.defer()
        image = await charts.comparison_chart(series, title="Relative performance (last 120 ticks)")
        if image is None:
            await ctx.followup_send(embed=error_embed("Could not build that chart."))
            return
        file = discord.File(fp=io.BytesIO(image), filename="compare.png")
        embed = discord.Embed(
            title="📊 Comparison",
            description="Each line is normalised to 0% at the start of the window.",
            color=config.embed_color,
        )
        embed.set_image(url="attachment://compare.png")
        await ctx.followup_send(embed=embed, file=file)

    @app_commands.command(name="sectors", description="See how each sector is performing today.")
    async def sectors(self, ctx: CommandContext) -> None:
        engine = await self.market.get_engine(ctx.guild_id)
        await ctx.send(embed=sector_embed(engine.sector_performance()))

    @app_commands.command(name="news", description="Read the latest market headlines.")
    async def news(self, ctx: CommandContext) -> None:
        items = await self.market.news(ctx.guild_id, 8)
        await ctx.send(embed=news_embed(items))

    # ------------------------------------------------------------------ trading

    @app_commands.command(name="buy", description="Buy shares at the current market price.")
    @app_commands.describe(symbol="Ticker or company name.", quantity="How many shares.")
    @app_commands.autocomplete(symbol=_symbol_autocomplete)
    async def buy(self, ctx: CommandContext, symbol: str, quantity: str) -> None:
        try:
            company = await self.market.resolve_symbol(ctx.guild_id, symbol)
            if company is None:
                raise HeraError(f"No listing matches `{symbol}`.")
            estimate, _ = self.trading.estimate_execution_price(company, 1, side="buy")
            account = await self.bot.economy.get_account(  # type: ignore[attr-defined]
                ctx.user.id, ctx.guild_id
            )
            max_shares = max(0, int(account.wallet // max(estimate, 0.01)))
            qty = parse_amount(quantity, maximum=max_shares)
            fill = await self.trading.buy(ctx.user.id, ctx.guild_id, symbol, qty)
        except HeraError as exc:
            await ctx.send(embed=error_embed(str(exc)), ephemeral=True)
            return

        embed = trade_result_embed(
            title="✅ Order filled",
            description=fill.message,
            color=config.embed_color,
            fields=[
                ("Shares", f"{fill.quantity:,}"),
                ("Fill price", price(fill.price)),
                ("Gross", money(fill.gross)),
                ("Commission", money(fill.commission)),
                ("Slippage", f"{fill.slippage_pct:.2f}%"),
            ],
        )
        await ctx.send(embed=embed)

    @app_commands.command(name="sell", description="Sell shares you own.")
    @app_commands.describe(symbol="Ticker or company name.", quantity="How many shares, or 'all'.")
    @app_commands.autocomplete(symbol=_symbol_autocomplete)
    async def sell(self, ctx: CommandContext, symbol: str, quantity: str) -> None:
        try:
            company = await self.market.resolve_symbol(ctx.guild_id, symbol)
            if company is None:
                raise HeraError(f"No listing matches `{symbol}`.")
            position = await self.trading.get_position(
                ctx.user.id, ctx.guild_id, company.symbol
            )
            held = position.quantity if position else 0
            if held <= 0:
                raise InsufficientShares(company.symbol, 1, 0)
            qty = parse_amount(quantity, maximum=held)
            fill = await self.trading.sell(ctx.user.id, ctx.guild_id, symbol, qty)
        except HeraError as exc:
            await ctx.send(embed=error_embed(str(exc)), ephemeral=True)
            return

        embed = trade_result_embed(
            title="✅ Position closed" if quantity.strip().lower() == "all" else "✅ Order filled",
            description=fill.message,
            color=config.embed_color if fill.realized_pnl >= 0 else config.error_color,
            fields=[
                ("Shares", f"{fill.quantity:,}"),
                ("Fill price", price(fill.price)),
                ("Net proceeds", money(fill.gross - fill.commission)),
                ("Realised P/L", signed(fill.realized_pnl)),
            ],
        )
        await ctx.send(embed=embed)

    @app_commands.command(name="short", description="Open a short position with posted collateral.")
    @app_commands.describe(symbol="Ticker or company name.", quantity="How many shares to short.")
    @app_commands.autocomplete(symbol=_symbol_autocomplete)
    async def short(self, ctx: CommandContext, symbol: str, quantity: str) -> None:
        try:
            company = await self.market.resolve_symbol(ctx.guild_id, symbol)
            if company is None:
                raise HeraError(f"No listing matches `{symbol}`.")
            qty = parse_amount(quantity)
            fill = await self.trading.short(ctx.user.id, ctx.guild_id, symbol, qty)
        except HeraError as exc:
            await ctx.send(embed=error_embed(str(exc)), ephemeral=True)
            return

        embed = trade_result_embed(
            title="📉 Short opened",
            description=fill.message,
            color=config.error_color,
            fields=[
                ("Shares", f"{fill.quantity:,}"),
                ("Entry price", price(fill.price)),
                ("Commission", money(fill.commission)),
                ("Slippage", f"{fill.slippage_pct:.2f}%"),
            ],
        )
        embed.set_footer(text="Profit if the price falls. Collateral is returned when you cover.")
        await ctx.send(embed=embed)

    @app_commands.command(name="cover", description="Close part or all of a short position.")
    @app_commands.describe(symbol="Ticker or company name.", quantity="How many shares, or 'all'.")
    @app_commands.autocomplete(symbol=_symbol_autocomplete)
    async def cover(self, ctx: CommandContext, symbol: str, quantity: str) -> None:
        try:
            company = await self.market.resolve_symbol(ctx.guild_id, symbol)
            if company is None:
                raise HeraError(f"No listing matches `{symbol}`.")
            short = await self.trading.get_short(
                ctx.user.id, ctx.guild_id, company.symbol
            )
            held = short.quantity if short else 0
            if held <= 0:
                raise InsufficientShares(company.symbol, 1, 0)
            qty = parse_amount(quantity, maximum=held)
            fill = await self.trading.cover(ctx.user.id, ctx.guild_id, symbol, qty)
        except HeraError as exc:
            await ctx.send(embed=error_embed(str(exc)), ephemeral=True)
            return

        embed = trade_result_embed(
            title="✅ Short covered",
            description=fill.message,
            color=config.embed_color if fill.realized_pnl >= 0 else config.error_color,
            fields=[
                ("Shares", f"{fill.quantity:,}"),
                ("Cover price", price(fill.price)),
                ("Realised P/L", signed(fill.realized_pnl)),
            ],
        )
        await ctx.send(embed=embed)

    @app_commands.command(name="limit", description="Place a resting limit order.")
    @app_commands.describe(
        side="buy, sell, short or cover",
        symbol="Ticker or company name.",
        quantity="How many shares.",
        limit_price="Only fill at this price or better.",
    )
    @app_commands.choices(
        side=[
            app_commands.Choice(name="buy", value="buy"),
            app_commands.Choice(name="sell", value="sell"),
            app_commands.Choice(name="short", value="short"),
            app_commands.Choice(name="cover", value="cover"),
        ]
    )
    @app_commands.autocomplete(symbol=_symbol_autocomplete)
    async def limit(
        self,
        ctx: CommandContext,
        side: app_commands.Choice[str],
        symbol: str,
        quantity: str,
        limit_price: str,
    ) -> None:
        try:
            qty = parse_amount(quantity)
            target = parse_price(limit_price)
            order_id = await self.trading.place_limit_order(
                ctx.user.id, ctx.guild_id, symbol, side.value, qty, target
            )
        except HeraError as exc:
            await ctx.send(embed=error_embed(str(exc)), ephemeral=True)
            return

        embed = trade_result_embed(
            title="🧾 Limit order placed",
            description=f"Order **#{order_id}**: {side.value} {qty:,} {symbol.upper()} at {price(target)}",
            color=config.embed_color,
            fields=[
                ("Expires", f"after {config.trading.limit_order_expiry_ticks} ticks"),
                ("Manage", "`/orders` to review, `/cancel` to pull it"),
            ],
        )
        await ctx.send(embed=embed)

    @app_commands.command(name="orders", description="Review your resting limit orders.")
    async def orders(self, ctx: CommandContext) -> None:
        rows = await self.trading.open_orders(ctx.user.id, ctx.guild_id)
        await ctx.send(
            embed=order_book_embed(rows, user=ctx.user), ephemeral=True
        )

    @app_commands.command(name="cancel", description="Cancel one of your resting orders.")
    @app_commands.describe(order_id="The order number shown by /orders.")
    async def cancel(self, ctx: CommandContext, order_id: int) -> None:
        ok = await self.trading.cancel_order(ctx.user.id, ctx.guild_id, order_id)
        if not ok:
            await ctx.send(
                embed=error_embed(f"No open order **#{order_id}** belongs to you."), ephemeral=True
            )
            return
        await ctx.send(
            embed=trade_result_embed(
                title="🗑️ Order cancelled",
                description=f"Order **#{order_id}** was cancelled and any reservation refunded.",
                color=config.embed_color,
            ),
            ephemeral=True,
        )

    # --------------------------------------------------------------- portfolio

    @app_commands.command(name="portfolio", description="Your holdings, cash and profit and loss.")
    @app_commands.describe(member="Inspect someone else's portfolio.")
    async def portfolio(
        self, ctx: CommandContext, member: discord.Member | None = None
    ) -> None:
        target = member or ctx.user
        result = await self.trading.get_portfolio(target.id, ctx.guild_id)
        await ctx.send(
            embed=portfolio_embed(result, user=target)
        )

    @app_commands.command(name="allocation", description="Chart how your portfolio is allocated.")
    async def allocation(self, ctx: CommandContext) -> None:
        result = await self.trading.get_portfolio(ctx.user.id, ctx.guild_id)
        labels = [position.symbol for position in result.positions]
        values = [position.market_value for position in result.positions]
        labels.append("Cash")
        values.append(float(result.wallet + result.bank))

        await ctx.defer()
        image = await charts.allocation_chart(labels, values)
        if image is None:
            await ctx.followup_send(embed=error_embed("You have nothing to allocate yet."))
            return
        file = discord.File(fp=io.BytesIO(image), filename="allocation.png")
        embed = discord.Embed(title="🥧 Portfolio allocation", color=config.embed_color)
        embed.set_image(url="attachment://allocation.png")
        await ctx.followup_send(embed=embed, file=file)

    @app_commands.command(name="position", description="Drill into one of your positions.")
    @app_commands.describe(symbol="Ticker or company name.")
    @app_commands.autocomplete(symbol=_symbol_autocomplete)
    async def position(self, ctx: CommandContext, symbol: str) -> None:
        company = await self._company_or_error(ctx, symbol)
        if company is None:
            return
        long_position = await self.trading.get_position(
            ctx.user.id, ctx.guild_id, company.symbol
        )
        short_position = await self.trading.get_short(
            ctx.user.id, ctx.guild_id, company.symbol
        )
        if long_position is None and short_position is None:
            await ctx.send(
                embed=error_embed(f"You have no open position in {company.symbol}."),
                ephemeral=True,
            )
            return
        embed = listing_embed(company)
        if long_position is not None:
            embed.add_field(
                name="Long",
                value=(
                    f"{long_position.quantity:,} @ {price(long_position.average_cost)}  "
                    f"{signed(long_position.unrealized_pnl)} ({percent(long_position.unrealized_pct)})"
                ),
                inline=False,
            )
        if short_position is not None:
            embed.add_field(
                name="Short",
                value=(
                    f"{short_position.quantity:,} @ {price(short_position.average_price)}  "
                    f"{signed(short_position.unrealized_pnl)} ({percent(short_position.unrealized_pct)})"
                ),
                inline=False,
            )
        await ctx.send(embed=embed)

    @app_commands.command(name="traders", description="Rank members by portfolio net worth.")
    async def traders(self, ctx: CommandContext) -> None:
        rows = await self.trading.leaderboard(ctx.guild_id)
        await ctx.send(
            embed=leaderboard_embed(rows, guild=ctx.guild, kind="Trader")
        )

    # ------------------------------------------------------------ alerts/watches

    @app_commands.command(name="alert", description="Get pinged when a price crosses a level.")
    @app_commands.describe(
        symbol="Ticker or company name.",
        direction="above or below",
        threshold="The price to watch for.",
    )
    @app_commands.choices(
        direction=[
            app_commands.Choice(name="above", value="above"),
            app_commands.Choice(name="below", value="below"),
        ]
    )
    @app_commands.autocomplete(symbol=_symbol_autocomplete)
    async def alert(
        self,
        ctx: CommandContext,
        symbol: str,
        direction: app_commands.Choice[str],
        threshold: str,
    ) -> None:
        try:
            value = parse_price(threshold)
            alert_id = await self.trading.create_alert(
                ctx.user.id, ctx.guild_id, symbol, direction.value, value
            )
        except HeraError as exc:
            await ctx.send(embed=error_embed(str(exc)), ephemeral=True)
            return
        await ctx.send(
            embed=trade_result_embed(
                title="🔔 Alert set",
                description=f"Alert **#{alert_id}** will fire when the price goes {direction.value} {price(value)}.",
                color=config.embed_color,
            ),
            ephemeral=True,
        )

    @app_commands.command(name="alerts", description="List your active price alerts.")
    async def alerts(self, ctx: CommandContext) -> None:
        rows = await self.trading.list_alerts(ctx.user.id, ctx.guild_id)
        await ctx.send(
            embed=alerts_embed(rows, user=ctx.user), ephemeral=True
        )

    @app_commands.command(name="unalert", description="Remove one of your price alerts.")
    @app_commands.describe(alert_id="The alert number shown by /alerts.")
    async def unalert(self, ctx: CommandContext, alert_id: int) -> None:
        ok = await self.trading.delete_alert(ctx.user.id, ctx.guild_id, alert_id)
        await ctx.send(
            embed=(
                trade_result_embed(
                    title="🗑️ Alert removed",
                    description=f"Alert **#{alert_id}** is no longer active.",
                    color=config.embed_color,
                )
                if ok
                else error_embed(f"No active alert **#{alert_id}** belongs to you.")
            ),
            ephemeral=True,
        )

    @app_commands.command(name="watch", description="Add or remove a company from your watchlist.")
    @app_commands.describe(action="add or remove", symbol="Ticker or company name.")
    @app_commands.choices(
        action=[
            app_commands.Choice(name="add", value="add"),
            app_commands.Choice(name="remove", value="remove"),
        ]
    )
    @app_commands.autocomplete(symbol=_symbol_autocomplete)
    async def watch(
        self, ctx: CommandContext, action: app_commands.Choice[str], symbol: str
    ) -> None:
        try:
            if action.value == "add":
                added = await self.trading.add_watch(ctx.user.id, ctx.guild_id, symbol)
                message = f"{symbol.upper()} added to your watchlist." if added else "Already on your watchlist."
            else:
                removed = await self.trading.remove_watch(ctx.user.id, ctx.guild_id, symbol)
                message = f"{symbol.upper()} removed." if removed else "That was not on your watchlist."
        except HeraError as exc:
            await ctx.send(embed=error_embed(str(exc)), ephemeral=True)
            return
        await ctx.send(
            embed=trade_result_embed(title="⭐ Watchlist", description=message, color=config.embed_color),
            ephemeral=True,
        )

    @app_commands.command(name="watchlist", description="Show your watchlist with live prices.")
    async def watchlist(self, ctx: CommandContext) -> None:
        symbols = await self.trading.watchlist(ctx.user.id, ctx.guild_id)
        engine = await self.market.get_engine(ctx.guild_id)
        companies = [engine.companies[s] for s in symbols if s in engine.companies]
        await ctx.send(
            embed=watchlist_embed(symbols, companies, user=ctx.user)
        )

    @app_commands.command(
        name="markethelp",
        description="How the market works: ticks, risk, trading and getting started.",
    )
    async def market_help(self, ctx: CommandContext) -> None:
        pages = guide_pages()
        view = Paginator(
            author_id=ctx.user.id,
            total_pages=len(pages),
            build=lambda index: pages[index].to_embed(page=index, total=len(pages)),
            timeout=240.0,
        )
        await ctx.send(embed=pages[0].to_embed(page=0, total=len(pages)), view=view)


async def setup(bot: commands.Bot) -> None:
    await bot.add_cog(Stocks(bot))
