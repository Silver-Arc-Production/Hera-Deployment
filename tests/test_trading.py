"""Tests for order execution, positions, orders, alerts and risk checks."""

from __future__ import annotations

import math

import pytest

from hera.errors import (
    InsufficientCollateral,
    InsufficientFunds,
    InsufficientShares,
    InvalidOrder,
    UnknownSymbol,
)
from tests.conftest import GUILD


async def _wallet(economy, user_id: int) -> int:
    account = await economy.get_account(user_id, GUILD)
    return account.wallet


# --------------------------------------------------------------------- buying


async def test_buy_creates_position_and_debits_wallet(trading, economy, funded):
    await funded(1)
    before = await _wallet(economy, 1)
    fill = await trading.buy(1, GUILD, "NOVA", 10)
    after = await _wallet(economy, 1)

    position = await trading.get_position(1, GUILD, "NOVA")
    assert position is not None
    assert position.quantity == 10
    assert position.average_cost == pytest.approx(fill.price)
    # Cash is charged in whole credits, rounded up so the house never undercharges.
    assert after == before - math.ceil(fill.gross) - fill.commission
    assert fill.commission >= trading.config.commission_min


async def test_buy_uses_weighted_average_cost(trading, funded):
    await funded(2)
    first = await trading.buy(2, GUILD, "BREW", 10)
    second = await trading.buy(2, GUILD, "BREW", 30)

    position = await trading.get_position(2, GUILD, "BREW")
    assert position is not None
    assert position.quantity == 40
    expected = (10 * first.price + 30 * second.price) / 40
    assert position.average_cost == pytest.approx(expected)


async def test_buy_accepts_a_company_name(trading, funded):
    await funded(3)
    fill = await trading.buy(3, GUILD, "novadyne", 1)
    assert fill.symbol == "NOVA"


async def test_buy_rejects_unknown_symbol(trading, funded):
    await funded(4)
    with pytest.raises(UnknownSymbol):
        await trading.buy(4, GUILD, "ZZZZ", 1)


async def test_buy_rejects_zero_or_negative_quantity(trading, funded):
    await funded(5)
    with pytest.raises(InvalidOrder):
        await trading.buy(5, GUILD, "NOVA", 0)
    with pytest.raises(InvalidOrder):
        await trading.buy(5, GUILD, "NOVA", -3)


async def test_buy_without_funds_raises(trading, economy):
    account = await economy.get_account(99, GUILD)
    assert account.wallet > 0
    with pytest.raises(InsufficientFunds):
        await trading.buy(99, GUILD, "NOVA", 100_000)


async def test_large_orders_incur_more_slippage(trading):
    company = await trading.market.get_company(GUILD, "NOVA")
    _, small = trading.estimate_execution_price(company, 10, side="buy")
    _, large = trading.estimate_execution_price(company, 500_000, side="buy")
    assert large > small
    assert large <= trading.config.max_slippage


# -------------------------------------------------------------------- selling


async def test_sell_partial_keeps_remaining_shares(trading, funded):
    await funded(10)
    await trading.buy(10, GUILD, "TERA", 20)
    fill = await trading.sell(10, GUILD, "TERA", 5)

    position = await trading.get_position(10, GUILD, "TERA")
    assert position is not None
    assert position.quantity == 15
    assert fill.side == "sell"


async def test_sell_everything_clears_the_position(trading, funded):
    await funded(11)
    await trading.buy(11, GUILD, "TERA", 4)
    await trading.sell(11, GUILD, "TERA", 4)
    assert await trading.get_position(11, GUILD, "TERA") is None


async def test_selling_more_than_held_raises(trading, funded):
    await funded(12)
    await trading.buy(12, GUILD, "TERA", 3)
    with pytest.raises(InsufficientShares):
        await trading.sell(12, GUILD, "TERA", 4)


async def test_selling_without_a_position_raises(trading, funded):
    await funded(13)
    with pytest.raises(InsufficientShares):
        await trading.sell(13, GUILD, "TERA", 1)


async def test_sell_credits_proceeds_and_records_realized_pnl(trading, economy, funded):
    await funded(14)
    await trading.buy(14, GUILD, "BREW", 10)
    before = await _wallet(economy, 14)
    fill = await trading.sell(14, GUILD, "BREW", 10)
    after = await _wallet(economy, 14)

    assert after > before
    position = await trading.get_position(14, GUILD, "BREW")
    assert position is None
    row = await trading.db.fetchone(
        "SELECT realized_pnl FROM positions WHERE user_id = ? AND symbol = 'BREW'", (14,)
    )
    assert int(row["realized_pnl"]) == fill.realized_pnl


# --------------------------------------------------------------------- shorts


async def test_short_posts_collateral_and_creates_position(trading, economy, funded):
    await funded(20)
    before = await _wallet(economy, 20)
    fill = await trading.short(20, GUILD, "NOVA", 5)

    short = await trading.get_short(20, GUILD, "NOVA")
    assert short is not None
    assert short.quantity == 5
    assert short.collateral > 0
    # Collateral plus commission leaves the wallet.
    assert await _wallet(economy, 20) == before - short.collateral - fill.commission


async def test_short_requires_enough_collateral(trading, funded):
    await funded(21, amount=100)
    company = await trading.market.get_company(GUILD, "NOVA")
    needed = trading.required_collateral(company, 5)
    with pytest.raises(InsufficientCollateral):
        await trading.short(21, GUILD, "NOVA", 5)
    assert needed > 100


async def test_cover_returns_collateral_and_realizes_pnl(trading, economy, funded):
    await funded(22)
    await trading.short(22, GUILD, "NOVA", 5)
    short = await trading.get_short(22, GUILD, "NOVA")
    assert short is not None
    collateral = short.collateral
    before = await _wallet(economy, 22)
    fill = await trading.cover(22, GUILD, "NOVA", 5)
    after = await _wallet(economy, 22)

    assert await trading.get_short(22, GUILD, "NOVA") is None
    assert after > before
    # The posted collateral comes back, adjusted by the trade's profit or loss.
    assert after == before + collateral + fill.realized_pnl


async def test_cover_more_than_shorted_raises(trading, funded):
    await funded(23)
    await trading.short(23, GUILD, "NOVA", 2)
    with pytest.raises(InsufficientShares):
        await trading.cover(23, GUILD, "NOVA", 3)


async def test_short_profits_when_price_falls(trading, funded):
    await funded(24)
    await trading.short(24, GUILD, "NOVA", 10)
    company = await trading.market.get_company(GUILD, "NOVA")
    company.price *= 0.5  # simulate a crash
    short = await trading.get_short(24, GUILD, "NOVA")
    assert short is not None
    assert short.unrealized_pnl > 0


# --------------------------------------------------------------- limit orders


async def test_limit_order_reserves_cash_and_fills_when_triggered(trading, economy, funded):
    await funded(30)
    company = await trading.market.get_company(GUILD, "NOVA")
    before = await _wallet(economy, 30)
    # A limit far above market triggers immediately on the next processing pass.
    order_id = await trading.place_limit_order(
        30, GUILD, "NOVA", "buy", 2, company.price * 1.5
    )
    reserved = await _wallet(economy, 30)
    assert reserved < before

    fills = await trading.process_open_orders(GUILD)
    assert len(fills) == 1
    user_id, fill = fills[0]
    assert user_id == 30
    assert fill.side == "buy"

    position = await trading.get_position(30, GUILD, "NOVA")
    assert position.quantity == 2
    row = await trading.db.fetchone("SELECT status FROM orders WHERE id = ?", (order_id,))
    assert row["status"] == "filled"


async def test_limit_order_that_does_not_trigger_stays_open(trading, funded):
    await funded(31)
    company = await trading.market.get_company(GUILD, "NOVA")
    order_id = await trading.place_limit_order(
        31, GUILD, "NOVA", "buy", 2, company.price * 0.5
    )
    fills = await trading.process_open_orders(GUILD)
    assert fills == []
    row = await trading.db.fetchone("SELECT status FROM orders WHERE id = ?", (order_id,))
    assert row["status"] == "open"


async def test_cancelling_an_order_refunds_the_reservation(trading, economy, funded):
    await funded(32)
    company = await trading.market.get_company(GUILD, "NOVA")
    before = await _wallet(economy, 32)
    order_id = await trading.place_limit_order(
        32, GUILD, "NOVA", "buy", 2, company.price * 0.5
    )
    assert await _wallet(economy, 32) < before

    assert await trading.cancel_order(32, GUILD, order_id) is True
    assert await _wallet(economy, 32) == before


async def test_expired_order_is_cancelled_and_refunded(trading, economy, funded):
    await funded(33)
    company = await trading.market.get_company(GUILD, "NOVA")
    before = await _wallet(economy, 33)
    order_id = await trading.place_limit_order(
        33, GUILD, "NOVA", "buy", 2, company.price * 0.5
    )
    # Advance well past the expiry horizon without triggering the order.
    engine = await trading.market.get_engine(GUILD)
    engine.tick += trading.config.limit_order_expiry_ticks + 5

    await trading.process_open_orders(GUILD)
    row = await trading.db.fetchone("SELECT status FROM orders WHERE id = ?", (order_id,))
    assert row["status"] == "expired"
    assert await _wallet(economy, 33) == before


async def test_orders_are_isolated_per_user(trading, funded):
    await funded(34)
    await funded(35)
    company = await trading.market.get_company(GUILD, "NOVA")
    await trading.place_limit_order(34, GUILD, "NOVA", "buy", 1, company.price * 0.5)

    assert len(await trading.open_orders(34, GUILD)) == 1
    assert await trading.open_orders(35, GUILD) == []
    assert await trading.cancel_order(35, GUILD, 1) is False


async def test_limit_order_requires_valid_side(trading, funded):
    await funded(36)
    with pytest.raises(InvalidOrder):
        await trading.place_limit_order(36, GUILD, "NOVA", "yolo", 1, 100)


# --------------------------------------------------------------------- alerts


async def test_alert_triggers_once_when_price_crosses(trading, funded):
    await funded(40)
    company = await trading.market.get_company(GUILD, "NOVA")
    await trading.create_alert(40, GUILD, "NOVA", "above", company.price * 0.9)

    hits = await trading.triggered_alerts(GUILD)
    assert len(hits) == 1
    assert hits[0]["user_id"] == 40

    # Deactivated after firing.
    assert await trading.triggered_alerts(GUILD) == []


async def test_alert_does_not_trigger_before_the_threshold(trading, funded):
    await funded(41)
    company = await trading.market.get_company(GUILD, "NOVA")
    await trading.create_alert(41, GUILD, "NOVA", "above", company.price * 10)
    assert await trading.triggered_alerts(GUILD) == []


async def test_alert_below_direction(trading, funded):
    await funded(42)
    company = await trading.market.get_company(GUILD, "NOVA")
    await trading.create_alert(42, GUILD, "NOVA", "below", company.price * 1.1)
    hits = await trading.triggered_alerts(GUILD)
    assert len(hits) == 1
    assert hits[0]["direction"] == "below"


async def test_alert_rejects_bad_direction(trading, funded):
    await funded(43)
    with pytest.raises(InvalidOrder):
        await trading.create_alert(43, GUILD, "NOVA", "sideways", 10)


async def test_delete_alert(trading, funded):
    await funded(44)
    alert_id = await trading.create_alert(44, GUILD, "NOVA", "above", 1_000_000)
    assert await trading.delete_alert(44, GUILD, alert_id) is True
    assert await trading.list_alerts(44, GUILD) == []
    assert await trading.delete_alert(45, GUILD, alert_id) is False


# ------------------------------------------------------------------ watchlist


async def test_watchlist_add_remove(trading, funded):
    await funded(50)
    assert await trading.add_watch(50, GUILD, "NOVA") is True
    assert await trading.add_watch(50, GUILD, "NOVA") is False  # duplicate
    assert await trading.add_watch(50, GUILD, "terrafirma") is True
    assert await trading.watchlist(50, GUILD) == ["NOVA", "TERA"]
    assert await trading.remove_watch(50, GUILD, "NOVA") is True
    assert await trading.remove_watch(50, GUILD, "NOVA") is False
    assert await trading.watchlist(50, GUILD) == ["TERA"]


async def test_watchlist_rejects_unknown_symbol(trading, funded):
    await funded(51)
    with pytest.raises(UnknownSymbol):
        await trading.add_watch(51, GUILD, "NOPE")


# ------------------------------------------------------------------ portfolio


async def test_portfolio_reports_cash_positions_and_pnl(trading, funded):
    await funded(60)
    await trading.buy(60, GUILD, "NOVA", 3)
    await trading.short(60, GUILD, "TERA", 2)

    portfolio = await trading.get_portfolio(60, GUILD)
    assert len(portfolio.positions) == 1
    assert len(portfolio.shorts) == 1
    assert portfolio.positions[0].symbol == "NOVA"
    assert portfolio.shorts[0].symbol == "TERA"
    assert portfolio.long_value > 0
    assert portfolio.short_value > 0
    assert portfolio.collateral > 0
    assert portfolio.net_worth > 0


async def test_net_worth_tracks_the_cash_balance_for_an_all_cash_account(trading, funded):
    await funded(61, amount=1_000)
    portfolio = await trading.get_portfolio(61, GUILD)
    assert portfolio.positions == []
    assert portfolio.shorts == []
    assert portfolio.net_worth == pytest.approx(portfolio.wallet + portfolio.bank)


async def test_position_gains_value_when_price_rises(trading, funded):
    await funded(62)
    await trading.buy(62, GUILD, "NOVA", 5)
    company = await trading.market.get_company(GUILD, "NOVA")
    company.price *= 2
    position = await trading.get_position(62, GUILD, "NOVA")
    assert position.unrealized_pnl > 0
    assert position.unrealized_pct > 0


# --------------------------------------------------------------- dividends/risk


async def test_dividends_are_paid_to_long_holders(trading, economy, funded):
    await funded(70)
    await trading.buy(70, GUILD, "BREW", 100)
    before = await _wallet(economy, 70)
    payouts = await trading.apply_dividends(GUILD, {"BREW": 0.5})
    assert payouts[70] == pytest.approx(50.0)
    assert await _wallet(economy, 70) == before + 50


async def test_dividends_skip_non_holders(trading, funded):
    await funded(71)
    payouts = await trading.apply_dividends(GUILD, {"BREW": 0.5})
    assert 71 not in payouts


async def test_margin_call_fires_when_a_short_goes_badly_wrong(trading, funded):
    await funded(72)
    await trading.short(72, GUILD, "NOVA", 10)
    company = await trading.market.get_company(GUILD, "NOVA")
    company.price *= 3  # a squeeze

    calls = await trading.margin_calls(GUILD)
    assert len(calls) == 1
    assert calls[0]["user_id"] == 72
    assert calls[0]["symbol"] == "NOVA"


async def test_no_margin_call_for_a_healthy_short(trading, funded):
    await funded(73)
    await trading.short(73, GUILD, "NOVA", 5)
    assert await trading.margin_calls(GUILD) == []


async def test_trader_leaderboard_ranks_by_net_worth(trading, funded):
    await funded(80, amount=1_000)
    await funded(81, amount=9_000)
    rows = await trading.leaderboard(GUILD, limit=5)
    ranked = {row["user_id"]: row["net_worth"] for row in rows}
    assert ranked[81] > ranked[80]


# ------------------------------------------------------------------- ledger


async def test_every_trade_is_journalled(trading, economy, funded):
    await funded(90)
    await trading.buy(90, GUILD, "NOVA", 2)
    await trading.sell(90, GUILD, "NOVA", 2)
    await trading.short(90, GUILD, "TERA", 1)
    await trading.cover(90, GUILD, "TERA", 1)

    rows = await economy.history(90, GUILD, limit=50)
    kinds = {row["kind"] for row in rows}
    assert {"stock_buy", "stock_sell", "short_open", "short_cover"} <= kinds


async def test_wallet_matches_the_sum_of_its_transactions(trading, economy, funded):
    """The ledger must reconcile with the live balance after a busy session."""
    await funded(91, amount=100_000)
    await trading.buy(91, GUILD, "BREW", 10)
    await trading.sell(91, GUILD, "BREW", 4)
    await trading.short(91, GUILD, "TERA", 3)
    await trading.cover(91, GUILD, "TERA", 3)

    account = await economy.get_account(91, GUILD)
    rows = await trading.db.fetchall(
        """
        SELECT SUM(amount) AS delta FROM transactions
        WHERE user_id = ? AND guild_id = ? AND kind != 'deposit' AND kind != 'withdraw'
        """,
        (91, GUILD),
    )
    # Wallet movements only: bank transfers are net-zero on the wallet.
    wallet_rows = await trading.db.fetchall(
        """
        SELECT kind, amount FROM transactions
        WHERE user_id = ? AND guild_id = ? AND kind NOT IN ('deposit', 'withdraw')
        """,
        (91, GUILD),
    )
    expected = sum(int(row["amount"]) for row in wallet_rows)
    assert account.wallet == expected
    assert rows is not None
