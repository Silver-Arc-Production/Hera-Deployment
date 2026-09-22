"""Tests for the price simulation engine (pure, no database)."""

from __future__ import annotations

import math
import random

import pytest

from hera.config import MarketConfig
from hera.market.companies import COMPANIES
from hera.market.engine import REGIMES, MarketEngine


@pytest.fixture
def engine():
    return MarketEngine(MarketConfig(), rng=random.Random(7))


def test_has_twenty_distinct_companies():
    assert len(COMPANIES) == 20
    assert len({c.symbol for c in COMPANIES}) == 20
    assert len({c.name for c in COMPANIES}) == 20


def test_engine_starts_with_every_listing(engine):
    assert len(engine.companies) == 20
    assert engine.tick == 0


def test_prices_stay_within_bounds_over_a_long_run(engine):
    for _ in range(2_000):
        engine.advance()
    for company in engine.companies.values():
        assert engine.config.min_price <= company.price <= engine.config.max_price
        assert company.price > 0


def test_no_single_tick_move_exceeds_the_cap(engine):
    previous = {s: c.price for s, c in engine.companies.items()}
    for _ in range(500):
        engine.advance()
        for symbol, company in engine.companies.items():
            change = abs(math.log(company.price / previous[symbol]))
            # The cap plus a small allowance for the fair-value re-anchor.
            assert change <= engine.config.max_tick_move + 1e-6
        previous = {s: c.price for s, c in engine.companies.items()}


def test_index_moves_with_the_market(engine):
    start = engine.index_value
    for _ in range(200):
        engine.advance()
    assert engine.index_value != start
    assert engine.index_value > 0


def test_regime_is_always_valid(engine):
    seen = set()
    for _ in range(500):
        engine.advance()
        seen.add(engine.regime)
        assert engine.regime in REGIMES
    # Over 500 ticks the regime should not be stuck on one value.
    assert len(seen) > 1


def test_new_day_resets_session_counters(engine):
    for _ in range(30):
        engine.advance()
    company = engine.companies["NOVA"]
    company.day_high = company.price * 5
    company.day_low = company.price * 0.2
    engine.advance(new_day=True)
    refreshed = engine.companies["NOVA"]
    # The rollover discards the artificial extremes; the tick that follows may
    # still widen the range, so assert the stale values are gone.
    assert refreshed.day_high < company.price * 5
    assert refreshed.day_low > company.price * 0.2
    assert refreshed.day_low <= refreshed.price <= refreshed.day_high
    assert refreshed.open_price == refreshed.previous_close


def test_dividends_pay_out_and_reduce_price(engine):
    engine.config = MarketConfig(dividend_tick_interval=5)
    payouts = []
    for _ in range(200):
        result = engine.advance()
        if result.dividends:
            payouts.append(result.dividends)
    assert payouts, "a dividend payer should have gone ex-dividend within 200 ticks"
    for payout in payouts:
        for per_share in payout.values():
            assert per_share > 0


def test_circuit_breaker_halts_a_collapsing_stock(engine):
    """A name that collapses past the threshold is halted on the next tick."""
    company = engine.companies["NOVA"]
    company.previous_close = company.price
    company.day_low = company.price
    engine.advance()
    # Drop the live price far below the previous close, then tick once more.
    company.price = company.previous_close * 0.5
    engine.advance()
    assert company.halted_until_tick > engine.tick


def test_halted_company_does_not_move(engine):
    company = engine.companies["TERA"]
    company.halted_until_tick = engine.tick + 5
    frozen = company.price
    engine.advance()
    assert company.price == frozen


def test_events_are_generated_and_decay(engine):
    engine.config = MarketConfig(event_chance=1.0)
    headlines = []
    for _ in range(50):
        result = engine.advance()
        headlines.extend(result.news)
    assert headlines, "events should fire when the chance is 100%"
    for company in engine.companies.values():
        assert company.event_ticks_left >= 0


def test_snapshot_and_movers_are_consistent(engine):
    for _ in range(20):
        engine.advance()
    snapshot = engine.snapshot()
    assert [c.symbol for c in snapshot] == sorted(engine.companies)
    gainers, losers = engine.top_movers(3)
    assert len(gainers) == 3 and len(losers) == 3
    assert gainers[0].day_change_fraction >= losers[-1].day_change_fraction


def test_sector_performance_covers_every_sector(engine):
    for _ in range(10):
        engine.advance()
    performance = engine.sector_performance()
    assert performance
    assert all(isinstance(value, float) for value in performance.values())


def test_same_seed_produces_identical_paths():
    a = MarketEngine(MarketConfig(), rng=random.Random(99))
    b = MarketEngine(MarketConfig(), rng=random.Random(99))
    for _ in range(50):
        a.advance()
        b.advance()
    for symbol in a.companies:
        assert a.companies[symbol].price == pytest.approx(b.companies[symbol].price)


def test_mean_reversion_pulls_a_dislocated_price_back():
    """A price far above fair value should tend to fall over many ticks."""
    engine = MarketEngine(MarketConfig(event_chance=0.0), rng=random.Random(5))
    company = engine.companies["LEDG"]
    company.fair_value = company.price
    company.price = company.price * 1.8
    start = company.price
    for _ in range(400):
        engine.advance()
    # Reversion is deliberately weak, so assert direction rather than equality.
    assert engine.companies["LEDG"].price < start


@pytest.mark.parametrize("seed", [11, 22, 33, 44, 55])
def test_long_run_market_stays_within_a_healthy_band(seed):
    """Guard the growth dial: a month of ticks must not inflate or bleed out.

    The drift multiplier is finely balanced against volatility drag, so this
    test fails loudly if a change to volatility, regimes or drift tips the
    simulated economy into runaway growth or a death spiral.
    """
    engine = MarketEngine(MarketConfig(), rng=random.Random(seed))
    for _ in range(8_640):  # 30 days at the default 5-minute tick
        engine.advance()

    change = engine.index_value / engine.config.starting_index - 1
    assert -0.40 < change < 0.60, f"30-day index change was {change:+.1%}"

    for company in engine.companies.values():
        assert engine.config.min_price <= company.price <= engine.config.max_price
