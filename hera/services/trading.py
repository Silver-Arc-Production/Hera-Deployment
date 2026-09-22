"""Order execution, positions, portfolio valuation and risk checks.

Conventions
-----------
* All cash movements go through :class:`~hera.services.economy.EconomyService`
  so they are journalled in ``transactions``.
* Execution uses the *live* price from the engine plus slippage proportional to
  order size relative to average volume, so large orders visibly cost more.
* Shorts are tracked in ``short_positions`` separately from longs, with cash
  collateral posted on open and returned on cover.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from ..config import TradingConfig
from ..database import Database
from ..errors import (
    HeraError,
    InsufficientCollateral,
    InsufficientFunds,
    InsufficientShares,
    InvalidOrder,
    MarketHalted,
    UnknownSymbol,
)
from ..market.engine import CompanyState
from .economy import EconomyService
from .market import MarketService

# Typical daily volume per company, used to size slippage. Expressed as a
# fraction of shares outstanding so it scales with the float.
TURNOVER_FRACTION = 0.004


@dataclass
class Position:
    symbol: str
    quantity: int
    average_cost: float
    realized_pnl: int
    price: float = 0.0

    @property
    def market_value(self) -> float:
        return self.quantity * self.price

    @property
    def cost_basis(self) -> float:
        return self.quantity * self.average_cost

    @property
    def unrealized_pnl(self) -> float:
        return self.market_value - self.cost_basis

    @property
    def unrealized_pct(self) -> float:
        if self.cost_basis == 0:
            return 0.0
        return self.unrealized_pnl / self.cost_basis * 100


@dataclass
class ShortPosition:
    symbol: str
    quantity: int
    average_price: float
    collateral: int
    realized_pnl: int
    price: float = 0.0

    @property
    def market_value(self) -> float:
        return self.quantity * self.price

    @property
    def unrealized_pnl(self) -> float:
        """Profit is the fall in price: we sold high and must buy back."""
        return (self.average_price - self.price) * self.quantity

    @property
    def unrealized_pct(self) -> float:
        if self.average_price == 0:
            return 0.0
        return (self.average_price - self.price) / self.average_price * 100


@dataclass
class Fill:
    symbol: str
    side: str
    quantity: int
    price: float
    gross: float
    commission: int
    slippage_pct: float
    realized_pnl: int = 0
    message: str = ""


@dataclass
class Portfolio:
    wallet: int
    bank: int
    positions: list[Position] = field(default_factory=list)
    shorts: list[ShortPosition] = field(default_factory=list)

    @property
    def long_value(self) -> float:
        return sum(p.market_value for p in self.positions)

    @property
    def short_value(self) -> float:
        return sum(s.market_value for s in self.shorts)

    @property
    def collateral(self) -> int:
        return sum(s.collateral for s in self.shorts)

    @property
    def unrealized_pnl(self) -> float:
        return sum(p.unrealized_pnl for p in self.positions) + sum(
            s.unrealized_pnl for s in self.shorts
        )

    @property
    def realized_pnl(self) -> int:
        return sum(p.realized_pnl for p in self.positions) + sum(
            s.realized_pnl for s in self.shorts
        )

    @property
    def net_worth(self) -> float:
        """Cash plus long value, less the cost to close shorts."""
        return (
            self.wallet
            + self.bank
            + self.long_value
            - self.short_value
        )


class TradingService:
    """Executes trades and values portfolios."""

    def __init__(
        self,
        db: Database,
        economy: EconomyService,
        market: MarketService,
        trading_config: TradingConfig,
    ) -> None:
        self.db = db
        self.economy = economy
        self.market = market
        self.config = trading_config

    # ---------------------------------------------------------------- pricing

    @staticmethod
    def _average_daily_volume(company: CompanyState) -> float:
        return max(1_000.0, company.shares_outstanding * TURNOVER_FRACTION)

    def estimate_execution_price(
        self, company: CompanyState, quantity: int, *, side: str
    ) -> tuple[float, float]:
        """Return (price, slippage_fraction) for an order of ``quantity`` shares.

        Slippage grows with the square root of order size relative to typical
        volume -- the standard market-impact shape -- and is capped so an
        enormous order cannot produce an absurd fill.
        """
        adv = self._average_daily_volume(company)
        ratio = max(0.0, quantity / adv)
        impact = min(self.config.max_slippage, self.config.slippage_coefficient * math.sqrt(ratio))
        direction = 1.0 if side == "buy" else -1.0
        price = company.price * (1 + direction * impact)
        return max(0.01, price), impact

    def commission_for(self, gross: float) -> int:
        raw = gross * self.config.commission_rate
        return int(max(self.config.commission_min, min(self.config.commission_max, round(raw))))

    # ------------------------------------------------------------------ reads

    async def get_position(self, user_id: int, guild_id: int, symbol: str) -> Position | None:
        row = await self.db.fetchone(
            "SELECT * FROM positions WHERE user_id = ? AND guild_id = ? AND symbol = ?",
            (user_id, guild_id, symbol.upper()),
        )
        if row is None or int(row["quantity"]) <= 0:
            return None
        company = await self.market.get_company(guild_id, symbol)
        return Position(
            symbol=row["symbol"],
            quantity=int(row["quantity"]),
            average_cost=float(row["average_cost"]),
            realized_pnl=int(row["realized_pnl"]),
            price=company.price if company else float(row["average_cost"]),
        )

    async def get_short(self, user_id: int, guild_id: int, symbol: str) -> ShortPosition | None:
        row = await self.db.fetchone(
            "SELECT * FROM short_positions WHERE user_id = ? AND guild_id = ? AND symbol = ?",
            (user_id, guild_id, symbol.upper()),
        )
        if row is None or int(row["quantity"]) <= 0:
            return None
        company = await self.market.get_company(guild_id, symbol)
        return ShortPosition(
            symbol=row["symbol"],
            quantity=int(row["quantity"]),
            average_price=float(row["average_price"]),
            collateral=int(row["collateral"]),
            realized_pnl=int(row["realized_pnl"]),
            price=company.price if company else float(row["average_price"]),
        )

    async def get_portfolio(self, user_id: int, guild_id: int) -> Portfolio:
        account = await self.economy.get_account(user_id, guild_id)
        engine = await self.market.get_engine(guild_id)

        rows = await self.db.fetchall(
            "SELECT * FROM positions WHERE user_id = ? AND guild_id = ? AND quantity > 0",
            (user_id, guild_id),
        )
        positions = [
            Position(
                symbol=row["symbol"],
                quantity=int(row["quantity"]),
                average_cost=float(row["average_cost"]),
                realized_pnl=int(row["realized_pnl"]),
                price=engine.companies[row["symbol"]].price
                if row["symbol"] in engine.companies
                else float(row["average_cost"]),
            )
            for row in rows
        ]

        short_rows = await self.db.fetchall(
            "SELECT * FROM short_positions WHERE user_id = ? AND guild_id = ? AND quantity > 0",
            (user_id, guild_id),
        )
        shorts = [
            ShortPosition(
                symbol=row["symbol"],
                quantity=int(row["quantity"]),
                average_price=float(row["average_price"]),
                collateral=int(row["collateral"]),
                realized_pnl=int(row["realized_pnl"]),
                price=engine.companies[row["symbol"]].price
                if row["symbol"] in engine.companies
                else float(row["average_price"]),
            )
            for row in short_rows
        ]

        positions.sort(key=lambda p: p.market_value, reverse=True)
        shorts.sort(key=lambda s: s.market_value, reverse=True)
        return Portfolio(wallet=account.wallet, bank=account.bank, positions=positions, shorts=shorts)

    # ----------------------------------------------------------------- buying

    async def buy(
        self, user_id: int, guild_id: int, symbol: str, quantity: int
    ) -> Fill:
        if quantity <= 0:
            raise InvalidOrder("Quantity must be a positive whole number.")
        company = await self._require_tradable(guild_id, symbol)
        symbol = company.symbol

        exec_price, slippage = self.estimate_execution_price(company, quantity, side="buy")
        gross = exec_price * quantity
        commission = self.commission_for(gross)
        total = int(math.ceil(gross)) + commission

        account = await self.economy.get_account(user_id, guild_id)
        if account.wallet < total:
            raise InsufficientFunds(total, account.wallet)

        await self.economy.debit(
            user_id,
            guild_id,
            total,
            kind="stock_buy",
            note=f"Bought {quantity:,} {symbol} @ {exec_price:,.2f}",
        )

        async with self.db.transaction() as conn:
            row = await self._position_row(conn, user_id, guild_id, symbol)
            if row is None:
                await conn.execute(
                    """
                    INSERT INTO positions (user_id, guild_id, symbol, quantity, average_cost)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (user_id, guild_id, symbol, quantity, exec_price),
                )
            else:
                old_qty = int(row["quantity"])
                old_cost = float(row["average_cost"])
                new_qty = old_qty + quantity
                # Weighted average cost, so partial sells keep an honest basis.
                new_cost = (old_qty * old_cost + quantity * exec_price) / new_qty
                await conn.execute(
                    """
                    UPDATE positions
                    SET quantity = ?, average_cost = ?, updated_at = unixepoch('subsec')
                    WHERE user_id = ? AND guild_id = ? AND symbol = ?
                    """,
                    (new_qty, new_cost, user_id, guild_id, symbol),
                )

        return Fill(
            symbol=symbol,
            side="buy",
            quantity=quantity,
            price=exec_price,
            gross=gross,
            commission=commission,
            slippage_pct=slippage * 100,
            message=f"Bought {quantity:,} {symbol} at {exec_price:,.2f}",
        )

    # ----------------------------------------------------------------- selling

    async def sell(self, user_id: int, guild_id: int, symbol: str, quantity: int) -> Fill:
        if quantity <= 0:
            raise InvalidOrder("Quantity must be a positive whole number.")
        company = await self._require_tradable(guild_id, symbol)
        symbol = company.symbol

        position = await self.get_position(user_id, guild_id, symbol)
        if position is None or position.quantity < quantity:
            held = position.quantity if position else 0
            raise InsufficientShares(symbol, quantity, held)

        exec_price, slippage = self.estimate_execution_price(company, quantity, side="sell")
        gross = exec_price * quantity
        commission = self.commission_for(gross)
        proceeds = int(math.floor(gross)) - commission
        realized = int(round((exec_price - position.average_cost) * quantity)) - commission

        async with self.db.transaction() as conn:
            remaining = position.quantity - quantity
            if remaining == 0:
                await conn.execute(
                    """
                    UPDATE positions SET quantity = 0, average_cost = 0,
                        realized_pnl = realized_pnl + ?, updated_at = unixepoch('subsec')
                    WHERE user_id = ? AND guild_id = ? AND symbol = ?
                    """,
                    (realized, user_id, guild_id, symbol),
                )
            else:
                await conn.execute(
                    """
                    UPDATE positions SET quantity = ?,
                        realized_pnl = realized_pnl + ?, updated_at = unixepoch('subsec')
                    WHERE user_id = ? AND guild_id = ? AND symbol = ?
                    """,
                    (remaining, realized, user_id, guild_id, symbol),
                )

        await self.economy.credit(
            user_id,
            guild_id,
            max(0, proceeds),
            kind="stock_sell",
            note=f"Sold {quantity:,} {symbol} @ {exec_price:,.2f}",
        )

        return Fill(
            symbol=symbol,
            side="sell",
            quantity=quantity,
            price=exec_price,
            gross=gross,
            commission=commission,
            slippage_pct=slippage * 100,
            realized_pnl=realized,
            message=f"Sold {quantity:,} {symbol} at {exec_price:,.2f}",
        )

    # ------------------------------------------------------------------ shorts

    def required_collateral(self, company: CompanyState, quantity: int) -> int:
        """Cash posted when opening a short, at the configured coverage ratio."""
        return int(
            math.ceil(company.price * quantity * self.config.min_short_collateral_ratio)
        )

    async def short(self, user_id: int, guild_id: int, symbol: str, quantity: int) -> Fill:
        if quantity <= 0:
            raise InvalidOrder("Quantity must be a positive whole number.")
        company = await self._require_tradable(guild_id, symbol)
        symbol = company.symbol

        collateral = self.required_collateral(company, quantity)
        account = await self.economy.get_account(user_id, guild_id)
        if account.wallet < collateral:
            raise InsufficientCollateral(collateral, account.wallet)

        exec_price, slippage = self.estimate_execution_price(company, quantity, side="sell")
        commission = self.commission_for(exec_price * quantity)

        await self.economy.debit(
            user_id,
            guild_id,
            collateral + commission,
            kind="short_open",
            note=f"Collateral for {quantity:,} {symbol} short",
        )

        async with self.db.transaction() as conn:
            row = await self._short_row(conn, user_id, guild_id, symbol)
            if row is None:
                await conn.execute(
                    """
                    INSERT INTO short_positions
                        (user_id, guild_id, symbol, quantity, average_price, collateral, opened_tick)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (user_id, guild_id, symbol, quantity, exec_price, collateral,
                     await self._current_tick(guild_id)),
                )
            else:
                old_qty = int(row["quantity"])
                old_price = float(row["average_price"])
                new_qty = old_qty + quantity
                new_price = (old_qty * old_price + quantity * exec_price) / new_qty
                await conn.execute(
                    """
                    UPDATE short_positions
                    SET quantity = ?, average_price = ?, collateral = collateral + ?,
                        updated_at = unixepoch('subsec')
                    WHERE user_id = ? AND guild_id = ? AND symbol = ?
                    """,
                    (new_qty, new_price, collateral, user_id, guild_id, symbol),
                )

        return Fill(
            symbol=symbol,
            side="short",
            quantity=quantity,
            price=exec_price,
            gross=exec_price * quantity,
            commission=commission,
            slippage_pct=slippage * 100,
            message=(
                f"Shorted {quantity:,} {symbol} at {exec_price:,.2f} "
                f"with {collateral:,} collateral"
            ),
        )

    async def cover(self, user_id: int, guild_id: int, symbol: str, quantity: int) -> Fill:
        if quantity <= 0:
            raise InvalidOrder("Quantity must be a positive whole number.")
        company = await self._require_tradable(guild_id, symbol)
        symbol = company.symbol

        short = await self.get_short(user_id, guild_id, symbol)
        if short is None or short.quantity < quantity:
            held = short.quantity if short else 0
            raise InsufficientShares(symbol, quantity, held)

        exec_price, slippage = self.estimate_execution_price(company, quantity, side="buy")
        gross = exec_price * quantity
        commission = self.commission_for(gross)
        realized = int(round((short.average_price - exec_price) * quantity)) - commission

        # Release the proportional share of posted collateral.
        released = int(short.collateral * (quantity / short.quantity))
        if quantity == short.quantity:
            released = short.collateral

        async with self.db.transaction() as conn:
            remaining = short.quantity - quantity
            if remaining == 0:
                await conn.execute(
                    """
                    UPDATE short_positions
                    SET quantity = 0, average_price = 0, collateral = 0,
                        realized_pnl = realized_pnl + ?, updated_at = unixepoch('subsec')
                    WHERE user_id = ? AND guild_id = ? AND symbol = ?
                    """,
                    (realized, user_id, guild_id, symbol),
                )
            else:
                await conn.execute(
                    """
                    UPDATE short_positions
                    SET quantity = ?, collateral = collateral - ?,
                        realized_pnl = realized_pnl + ?, updated_at = unixepoch('subsec')
                    WHERE user_id = ? AND guild_id = ? AND symbol = ?
                    """,
                    (remaining, released, realized, user_id, guild_id, symbol),
                )

        # Collateral returns to the wallet; the P/L is settled from it.
        await self.economy.credit(
            user_id,
            guild_id,
            max(0, released + realized),
            kind="short_cover",
            note=f"Covered {quantity:,} {symbol} @ {exec_price:,.2f}",
        )

        return Fill(
            symbol=symbol,
            side="cover",
            quantity=quantity,
            price=exec_price,
            gross=gross,
            commission=commission,
            slippage_pct=slippage * 100,
            realized_pnl=realized,
            message=f"Covered {quantity:,} {symbol} at {exec_price:,.2f}",
        )

    # ------------------------------------------------------------------ orders

    async def place_limit_order(
        self,
        user_id: int,
        guild_id: int,
        symbol: str,
        side: str,
        quantity: int,
        limit_price: float,
    ) -> int:
        """Queue a limit order. Returns the order id."""
        if quantity <= 0:
            raise InvalidOrder("Quantity must be a positive whole number.")
        if limit_price <= 0:
            raise InvalidOrder("Limit price must be greater than zero.")
        side = side.lower()
        if side not in {"buy", "sell", "short", "cover"}:
            raise InvalidOrder("Side must be buy, sell, short or cover.")
        company = await self.market.resolve_symbol(guild_id, symbol)
        if company is None:
            raise UnknownSymbol(symbol)

        engine = await self.market.get_engine(guild_id)
        tick = engine.tick

        # Reserve buying power so a queued order cannot be spent twice.
        if side in {"buy", "cover"}:
            reservation = int(math.ceil(limit_price * quantity * 1.05))
            account = await self.economy.get_account(user_id, guild_id)
            if account.wallet < reservation:
                raise InsufficientFunds(reservation, account.wallet)
            await self.economy.debit(
                user_id,
                guild_id,
                reservation,
                kind="order_reserve",
                note=f"Reserved for {side} {quantity:,} {company.symbol}",
            )
        elif side == "sell":
            position = await self.get_position(user_id, guild_id, company.symbol)
            if position is None or position.quantity < quantity:
                raise InsufficientShares(company.symbol, quantity, position.quantity if position else 0)
        elif side == "short":
            collateral = self.required_collateral(company, quantity)
            account = await self.economy.get_account(user_id, guild_id)
            if account.wallet < collateral:
                raise InsufficientCollateral(collateral, account.wallet)
            await self.economy.debit(
                user_id,
                guild_id,
                collateral,
                kind="order_reserve",
                note=f"Reserved for short {quantity:,} {company.symbol}",
            )

        async with self.db.transaction() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO orders
                    (user_id, guild_id, symbol, side, quantity, limit_price,
                     created_tick, expires_tick)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    guild_id,
                    company.symbol,
                    side,
                    quantity,
                    limit_price,
                    tick,
                    tick + self.config.limit_order_expiry_ticks,
                ),
            )
            return int(cursor.lastrowid or 0)

    async def process_open_orders(self, guild_id: int) -> list[tuple[int, Fill]]:
        """Fill any resting orders whose limit has been reached; expire the rest.

        Returns ``(user_id, fill)`` pairs so the caller can notify the owners.

        A resting order has already had its cash reserved. Before executing we
        hand the reservation back, so the normal buy/short path sees the full
        wallet balance and there is no double-charge.
        """
        engine = await self.market.get_engine(guild_id)
        rows = await self.db.fetchall(
            "SELECT * FROM orders WHERE guild_id = ? AND status = 'open' ORDER BY id",
            (guild_id,),
        )
        fills: list[tuple[int, Fill]] = []
        for row in rows:
            order_id = int(row["id"])
            user_id = int(row["user_id"])
            symbol = row["symbol"]
            side = row["side"]
            quantity = int(row["quantity"]) - int(row["filled_quantity"])
            limit_price = float(row["limit_price"])
            company = engine.companies.get(symbol)
            if company is None or quantity <= 0:
                await self._cancel_order(order_id, "cancelled", refund=True)
                continue
            if int(row["expires_tick"]) and engine.tick > int(row["expires_tick"]):
                await self._cancel_order(order_id, "expired", refund=True)
                continue
            if company.halted_until_tick > engine.tick:
                continue

            # A buy fills when the market trades at or below the limit.
            market_price = company.price
            triggered = (
                market_price <= limit_price
                if side in {"buy", "cover"}
                else market_price >= limit_price
            )
            if not triggered:
                continue

            await self._refund_reservation(user_id, guild_id, symbol, side, limit_price, quantity)
            try:
                if side == "buy":
                    fill = await self.buy(user_id, guild_id, symbol, quantity)
                elif side == "sell":
                    fill = await self.sell(user_id, guild_id, symbol, quantity)
                elif side == "short":
                    fill = await self.short(user_id, guild_id, symbol, quantity)
                else:
                    fill = await self.cover(user_id, guild_id, symbol, quantity)
            except HeraError:
                # Funds withdrawn or position closed while the order rested.
                await self._cancel_order(order_id, "cancelled", refund=False)
                continue

            await self.db.execute(
                """
                UPDATE orders SET filled_quantity = quantity, average_fill = ?,
                    status = 'filled', updated_at = unixepoch('subsec')
                WHERE id = ?
                """,
                (fill.price, order_id),
            )
            fills.append((user_id, fill))
        return fills

    def _reservation_for(self, side: str, limit_price: float, quantity: int) -> int:
        """Cash set aside when the order was placed (mirrors place_limit_order)."""
        if side == "short":
            return int(math.ceil(limit_price * quantity * self.config.min_short_collateral_ratio))
        if side in {"buy", "cover"}:
            return int(math.ceil(limit_price * quantity * 1.05))
        return 0

    async def _refund_reservation(
        self, user_id: int, guild_id: int, symbol: str, side: str, limit_price: float, quantity: int
    ) -> None:
        reserved = self._reservation_for(side, limit_price, quantity)
        if reserved <= 0:
            return
        await self.economy.credit(
            user_id,
            guild_id,
            reserved,
            kind="order_refund",
            note=f"Reservation released for {symbol}",
        )

    async def _cancel_order(self, order_id: int, status: str, *, refund: bool = False) -> None:
        row = await self.db.fetchone("SELECT * FROM orders WHERE id = ?", (order_id,))
        if row is None:
            return
        await self.db.execute(
            "UPDATE orders SET status = ?, updated_at = unixepoch('subsec') WHERE id = ?",
            (status, order_id),
        )
        if not refund:
            return
        quantity = int(row["quantity"]) - int(row["filled_quantity"])
        if quantity <= 0:
            return
        await self._refund_reservation(
            int(row["user_id"]),
            int(row["guild_id"]),
            row["symbol"],
            row["side"],
            float(row["limit_price"]),
            quantity,
        )

    async def cancel_order(self, user_id: int, guild_id: int, order_id: int) -> bool:
        row = await self.db.fetchone(
            "SELECT * FROM orders WHERE id = ? AND user_id = ? AND guild_id = ?",
            (order_id, user_id, guild_id),
        )
        if row is None or row["status"] != "open":
            return False
        await self._cancel_order(order_id, "cancelled", refund=True)
        return True

    async def open_orders(self, user_id: int, guild_id: int):
        return await self.db.fetchall(
            """
            SELECT * FROM orders WHERE user_id = ? AND guild_id = ? AND status = 'open'
            ORDER BY id
            """,
            (user_id, guild_id),
        )

    # ------------------------------------------------------------------ alerts

    async def create_alert(
        self, user_id: int, guild_id: int, symbol: str, direction: str, threshold: float,
        note: str | None = None,
    ) -> int:
        direction = direction.lower()
        if direction not in {"above", "below"}:
            raise InvalidOrder("Direction must be 'above' or 'below'.")
        company = await self.market.resolve_symbol(guild_id, symbol)
        if company is None:
            raise UnknownSymbol(symbol)
        async with self.db.transaction() as conn:
            cursor = await conn.execute(
                """
                INSERT INTO alerts (user_id, guild_id, symbol, direction, threshold, note)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (user_id, guild_id, company.symbol, direction, threshold, note),
            )
            return int(cursor.lastrowid or 0)

    async def triggered_alerts(self, guild_id: int) -> list[dict]:
        """Find and deactivate alerts whose threshold has been crossed."""
        engine = await self.market.get_engine(guild_id)
        rows = await self.db.fetchall(
            "SELECT * FROM alerts WHERE guild_id = ? AND active = 1", (guild_id,)
        )
        hits: list[dict] = []
        for row in rows:
            company = engine.companies.get(row["symbol"])
            if company is None:
                continue
            price = company.price
            crossed = (
                price >= float(row["threshold"])
                if row["direction"] == "above"
                else price <= float(row["threshold"])
            )
            if not crossed:
                continue
            hits.append(
                {
                    "id": int(row["id"]),
                    "user_id": int(row["user_id"]),
                    "symbol": row["symbol"],
                    "direction": row["direction"],
                    "threshold": float(row["threshold"]),
                    "price": price,
                    "note": row["note"],
                }
            )
        if hits:
            await self.db.executemany(
                "UPDATE alerts SET active = 0 WHERE id = ?", [(hit["id"],) for hit in hits]
            )
        return hits

    async def list_alerts(self, user_id: int, guild_id: int):
        return await self.db.fetchall(
            "SELECT * FROM alerts WHERE user_id = ? AND guild_id = ? AND active = 1 ORDER BY id",
            (user_id, guild_id),
        )

    async def delete_alert(self, user_id: int, guild_id: int, alert_id: int) -> bool:
        row = await self.db.fetchone(
            "SELECT id FROM alerts WHERE id = ? AND user_id = ? AND guild_id = ? AND active = 1",
            (alert_id, user_id, guild_id),
        )
        if row is None:
            return False
        await self.db.execute("UPDATE alerts SET active = 0 WHERE id = ?", (alert_id,))
        return True

    # --------------------------------------------------------------- watchlist

    async def add_watch(self, user_id: int, guild_id: int, symbol: str) -> bool:
        company = await self.market.resolve_symbol(guild_id, symbol)
        if company is None:
            raise UnknownSymbol(symbol)
        existing = await self.db.fetchone(
            "SELECT symbol FROM watchlists WHERE user_id = ? AND guild_id = ? AND symbol = ?",
            (user_id, guild_id, company.symbol),
        )
        if existing is not None:
            return False
        await self.db.execute(
            "INSERT INTO watchlists (user_id, guild_id, symbol) VALUES (?, ?, ?)",
            (user_id, guild_id, company.symbol),
        )
        return True

    async def remove_watch(self, user_id: int, guild_id: int, symbol: str) -> bool:
        row = await self.db.fetchone(
            "SELECT symbol FROM watchlists WHERE user_id = ? AND guild_id = ? AND symbol = ?",
            (user_id, guild_id, symbol.upper()),
        )
        if row is None:
            return False
        await self.db.execute(
            "DELETE FROM watchlists WHERE user_id = ? AND guild_id = ? AND symbol = ?",
            (user_id, guild_id, symbol.upper()),
        )
        return True

    async def watchlist(self, user_id: int, guild_id: int) -> list[str]:
        rows = await self.db.fetchall(
            "SELECT symbol FROM watchlists WHERE user_id = ? AND guild_id = ? ORDER BY symbol",
            (user_id, guild_id),
        )
        return [row["symbol"] for row in rows]

    # --------------------------------------------------------------- risk/divs

    async def apply_dividends(self, guild_id: int, dividends: dict[str, float]) -> dict[int, float]:
        """Pay per-share dividends to every long holder. Returns {user_id: total}."""
        if not dividends:
            return {}
        payouts: dict[int, float] = {}
        for symbol, per_share in dividends.items():
            rows = await self.db.fetchall(
                """
                SELECT user_id, quantity FROM positions
                WHERE guild_id = ? AND symbol = ? AND quantity > 0
                """,
                (guild_id, symbol),
            )
            for row in rows:
                amount = float(row["quantity"]) * per_share
                if amount <= 0:
                    continue
                user_id = int(row["user_id"])
                payouts[user_id] = payouts.get(user_id, 0.0) + amount
                await self.economy.credit(
                    user_id,
                    guild_id,
                    max(1, int(amount)),
                    kind="dividend",
                    note=f"Dividend on {row['quantity']:,} {symbol}",
                )
        return payouts

    async def margin_calls(self, guild_id: int) -> list[dict]:
        """Flag shorts whose loss has eaten into the posted collateral.

        Returns the affected accounts so the caller can warn them. Positions are
        not force-closed automatically -- the owner gets a warning first.
        """
        engine = await self.market.get_engine(guild_id)
        rows = await self.db.fetchall(
            "SELECT * FROM short_positions WHERE guild_id = ? AND quantity > 0", (guild_id,)
        )
        calls: list[dict] = []
        for row in rows:
            symbol = row["symbol"]
            company = engine.companies.get(symbol)
            if company is None:
                continue
            quantity = int(row["quantity"])
            entry = float(row["average_price"])
            collateral = int(row["collateral"])
            if collateral <= 0:
                continue
            loss = (company.price - entry) * quantity
            if loss <= 0:
                continue
            if loss >= collateral * self.config.margin_call_ratio:
                calls.append(
                    {
                        "user_id": int(row["user_id"]),
                        "symbol": symbol,
                        "quantity": quantity,
                        "entry": entry,
                        "price": company.price,
                        "collateral": collateral,
                        "loss": loss,
                    }
                )
        return calls

    async def leaderboard(self, guild_id: int, limit: int = 10) -> list[dict]:
        """Rank members by portfolio net worth (cash + longs - short liability)."""
        engine = await self.market.get_engine(guild_id)
        accounts = await self.db.fetchall(
            "SELECT user_id, wallet, bank FROM accounts WHERE guild_id = ?", (guild_id,)
        )
        positions = await self.db.fetchall(
            "SELECT user_id, symbol, quantity, average_cost FROM positions WHERE guild_id = ? AND quantity > 0",
            (guild_id,),
        )
        shorts = await self.db.fetchall(
            "SELECT user_id, symbol, quantity FROM short_positions WHERE guild_id = ? AND quantity > 0",
            (guild_id,),
        )

        net: dict[int, float] = {
            int(row["user_id"]): float(row["wallet"] + row["bank"]) for row in accounts
        }
        for row in positions:
            company = engine.companies.get(row["symbol"])
            if company is None:
                continue
            net[int(row["user_id"])] = net.get(int(row["user_id"]), 0.0) + (
                company.price * int(row["quantity"])
            )
        for row in shorts:
            company = engine.companies.get(row["symbol"])
            if company is None:
                continue
            net[int(row["user_id"])] = net.get(int(row["user_id"]), 0.0) - (
                company.price * int(row["quantity"])
            )

        ranked = sorted(net.items(), key=lambda item: item[1], reverse=True)[:limit]
        return [{"user_id": user_id, "net_worth": value} for user_id, value in ranked]

    # -------------------------------------------------------------- internals

    async def _require_tradable(self, guild_id: int, symbol: str) -> CompanyState:
        company = await self.market.resolve_symbol(guild_id, symbol)
        if company is None:
            raise UnknownSymbol(symbol)
        engine = await self.market.get_engine(guild_id)
        if company.halted_until_tick > engine.tick:
            raise MarketHalted(company.symbol)
        return company

    async def _current_tick(self, guild_id: int) -> int:
        engine = await self.market.get_engine(guild_id)
        return engine.tick

    @staticmethod
    async def _position_row(conn, user_id: int, guild_id: int, symbol: str):
        async with conn.execute(
            "SELECT * FROM positions WHERE user_id = ? AND guild_id = ? AND symbol = ?",
            (user_id, guild_id, symbol),
        ) as cursor:
            return await cursor.fetchone()

    @staticmethod
    async def _short_row(conn, user_id: int, guild_id: int, symbol: str):
        async with conn.execute(
            "SELECT * FROM short_positions WHERE user_id = ? AND guild_id = ? AND symbol = ?",
            (user_id, guild_id, symbol),
        ) as cursor:
            return await cursor.fetchone()
