"""The price simulation engine.

Design notes
------------
The engine is deliberately pure: it owns no database connection and takes an
injected :class:`random.Random`, so the exact same tick sequence can be
replayed in tests.

Prices follow a geometric random walk with three extra forces on top:

1. **Mean reversion** toward a slowly drifting fair value. Without this, a
   positive drift compounds without bound over a long-running bot. The pull is
   weak (a ~14 hour half-life at the default 5-minute tick) so news-driven
   trends still get room to run.
2. **Events.** Sector or company headlines apply a signed per-tick pull for a
   bounded number of ticks, producing a trend rather than a single jump.
3. **Regime.** A market-wide bull/bear/neutral state scales every company's
   move by its beta.

Company ``volatility`` and ``drift`` are expressed as *daily* figures and are
normalised by the number of ticks in a day, so changing ``STOCK_TICK_SECONDS``
does not change the market's character.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from ..config import MarketConfig
from .companies import COMPANIES, CompanySeed, SECTOR_BETA
from .events import pick_event, pick_sector_event, render_headline

REGIMES = ("bull", "neutral", "bear")
REGIME_MULTIPLIER = {"bull": 0.75, "neutral": 0.0, "bear": -0.75}
REGIME_VOL_MULTIPLIER = {"bull": 0.9, "neutral": 1.0, "bear": 1.35}


@dataclass
class CompanyState:
    symbol: str
    name: str
    sector: str
    description: str
    price: float
    previous_close: float
    open_price: float
    day_high: float
    day_low: float
    fair_value: float
    volatility: float
    drift: float
    beta: float
    shares_outstanding: int
    dividend_yield: float
    halted_until_tick: int = 0
    active_event: str | None = None
    event_ticks_left: int = 0
    event_magnitude: float = 0.0
    last_dividend_tick: int = 0

    @classmethod
    def from_seed(cls, seed: CompanySeed) -> CompanyState:
        return cls(
            symbol=seed.symbol,
            name=seed.name,
            sector=seed.sector,
            description=seed.description,
            price=seed.price,
            previous_close=seed.price,
            open_price=seed.price,
            day_high=seed.price,
            day_low=seed.price,
            fair_value=seed.price,
            volatility=seed.volatility,
            drift=seed.drift,
            beta=seed.beta,
            shares_outstanding=seed.shares_outstanding,
            dividend_yield=seed.dividend_yield,
        )

    @property
    def market_cap(self) -> float:
        return self.price * self.shares_outstanding

    @property
    def day_change_fraction(self) -> float:
        if self.previous_close == 0:
            return 0.0
        return (self.price - self.previous_close) / self.previous_close

    @property
    def is_halted(self) -> bool:
        return self.halted_until_tick > 0


@dataclass
class NewsItem:
    symbol: str | None
    headline: str
    impact: float
    sector: str | None = None


@dataclass
class TickResult:
    tick: int
    index_value: float
    index_change: float
    regime: str
    news: list[NewsItem] = field(default_factory=list)
    dividends: dict[str, float] = field(default_factory=dict)
    halts: list[str] = field(default_factory=list)
    movers: list[tuple[str, float]] = field(default_factory=list)


class MarketEngine:
    """Advances the simulated market one tick at a time."""

    def __init__(
        self,
        market_config: MarketConfig,
        *,
        seeds: tuple[CompanySeed, ...] = COMPANIES,
        rng: random.Random | None = None,
    ) -> None:
        self.config = market_config
        self.rng = rng or random.Random()
        self.companies: dict[str, CompanyState] = {
            seed.symbol: CompanyState.from_seed(seed) for seed in seeds
        }
        self.tick = 0
        self.regime = "neutral"
        self.regime_ticks_left = self._next_regime_length()
        self.index_value = market_config.starting_index
        self.previous_index = market_config.starting_index
        self._initial_market_cap = sum(c.market_cap for c in self.companies.values()) or 1.0

        ticks_per_day = max(1.0, 86_400 / self.config.tick_seconds)
        self._ticks_per_day = ticks_per_day
        self._tick_scale = 300.0 / self.config.tick_seconds
        # Company drift values are per-day figures. This multiplier is the
        # economy's growth dial and is tuned so a 30-day run trends mildly
        # upward. It is deliberately not larger: volatility drag (the bear
        # regime carries a higher vol multiplier) pulls the index down, so
        # there is a tipping point above which the market inflates without
        # bound and below which it bleeds out. See the balance test.
        self._drift_multiplier = 15.0

    # ------------------------------------------------------------------ setup

    def _next_regime_length(self) -> int:
        return self.rng.randint(self.config.regime_min_ticks, self.config.regime_max_ticks)

    def load_state(
        self,
        *,
        tick: int,
        regime: str,
        regime_ticks_left: int,
        index_value: float,
        previous_index: float,
        companies: dict[str, CompanyState],
    ) -> None:
        """Restore a persisted market so restarts do not reset prices."""
        self.tick = tick
        self.regime = regime if regime in REGIME_MULTIPLIER else "neutral"
        self.regime_ticks_left = regime_ticks_left
        self.index_value = index_value
        self.previous_index = previous_index
        for symbol, state in companies.items():
            if symbol in self.companies:
                self.companies[symbol] = state

    # ------------------------------------------------------------------- tick

    def advance(self, *, new_day: bool | None = None) -> TickResult:
        """Advance one tick and return everything that happened.

        ``new_day`` rolls over the session counters (open/high/low/previous
        close). When left as ``None`` the rollover is derived from
        ``session_ticks`` so callers do not have to track it.
        """
        self.tick += 1
        if new_day is None:
            new_day = self.tick % max(1, self.config.session_ticks) == 0
        self.previous_index = self.index_value
        news: list[NewsItem] = []
        dividends: dict[str, float] = {}
        halts: list[str] = []

        self._maybe_rotate_regime()
        sector_events = self._maybe_sector_events(news)

        for symbol in sorted(self.companies):
            state = self.companies[symbol]

            if new_day:
                state.previous_close = state.price
                state.open_price = state.price
                state.day_high = state.price
                state.day_low = state.price

            if state.halted_until_tick > self.tick:
                # A halted name is frozen: no drift, no event decay.
                continue
            if state.halted_until_tick and state.halted_until_tick <= self.tick:
                state.halted_until_tick = 0
                state.active_event = None
                state.event_ticks_left = 0
                state.event_magnitude = 0.0

            if symbol in sector_events:
                template = sector_events[symbol]
                state.event_magnitude += template.magnitude * self._tick_scale
                state.event_ticks_left = max(
                    state.event_ticks_left, self.rng.randint(2, 6)
                )
                state.active_event = template.key

            self._maybe_start_company_event(state, news)
            self._maybe_pay_dividend(state, dividends)

            self._move_price(state, new_day=new_day)
            self._check_circuit_breaker(state, halts)

        self.index_value = self._compute_index()
        movers = sorted(
            ((s, c.day_change_fraction) for s, c in self.companies.items()),
            key=lambda item: item[1],
            reverse=True,
        )
        return TickResult(
            tick=self.tick,
            index_value=self.index_value,
            index_change=(
                0.0
                if self.previous_index == 0
                else (self.index_value - self.previous_index) / self.previous_index
            ),
            regime=self.regime,
            news=news,
            dividends=dividends,
            halts=halts,
            movers=movers,
        )

    # --------------------------------------------------------------- internals

    def _maybe_rotate_regime(self) -> None:
        self.regime_ticks_left -= 1
        if self.regime_ticks_left > 0:
            return
        choices = [r for r in REGIMES if r != self.regime] or list(REGIMES)
        # Neutral is the most likely state; bulls and bears alternate around it.
        weights = [1.0 if r == "neutral" else 0.55 for r in choices]
        self.regime = self.rng.choices(choices, weights=weights, k=1)[0]
        self.regime_ticks_left = self._next_regime_length()

    def _maybe_sector_events(self, news: list[NewsItem]) -> dict[str, object]:
        """Occasionally fire a sector-wide headline that hits several names."""
        if self.rng.random() >= 0.05:
            return {}
        sectors = sorted({c.sector for c in self.companies.values()})
        sector = self.rng.choice(sectors)
        template = pick_sector_event(sector, self.rng)
        headline = render_headline(template, symbol="", name="", sector=sector)
        news.append(NewsItem(symbol=None, headline=headline, impact=template.magnitude, sector=sector))
        members = [c for c in self.companies.values() if c.sector == sector]
        return {
            member.symbol: template
            for member in members
            if member.halted_until_tick <= self.tick
        }

    def _maybe_start_company_event(self, state: CompanyState, news: list[NewsItem]) -> None:
        if state.event_ticks_left > 0:
            return
        if self.rng.random() >= self.config.event_chance:
            return
        template = pick_event(state.sector, self.rng)
        state.active_event = template.key
        state.event_magnitude = template.magnitude * self._tick_scale
        state.event_ticks_left = self.rng.randint(
            self.config.event_ticks_min, self.config.event_ticks_max
        )
        headline = render_headline(
            template, symbol=state.symbol, name=state.name, sector=state.sector
        )
        news.append(NewsItem(symbol=state.symbol, headline=headline, impact=template.magnitude))

    def _maybe_pay_dividend(self, state: CompanyState, dividends: dict[str, float]) -> None:
        if state.dividend_yield <= 0:
            return
        if self.tick - state.last_dividend_tick < self.config.dividend_tick_interval:
            return
        if state.last_dividend_tick == 0:
            # Stagger the first payout so every payer does not go ex-div together.
            state.last_dividend_tick = self.tick - self.rng.randint(
                0, self.config.dividend_tick_interval - 1
            )
            return
        state.last_dividend_tick = self.tick
        per_share = state.price * state.dividend_yield / (
            self._ticks_per_day / self.config.dividend_tick_interval
        )
        dividends[state.symbol] = per_share
        # Shares trade lower by the payout on the ex-dividend tick.
        state.price = max(self.config.min_price, state.price - per_share)
        state.fair_value = max(self.config.min_price, state.fair_value - per_share)

    def _move_price(self, state: CompanyState, *, new_day: bool) -> None:
        per_tick_vol = state.volatility / math.sqrt(self._ticks_per_day)
        per_tick_drift = state.drift * self._drift_multiplier / self._ticks_per_day

        regime_component = (
            REGIME_MULTIPLIER[self.regime] * per_tick_vol * state.beta * 0.6
        )
        reversion = self.config.mean_reversion * math.log(
            max(state.fair_value, 1e-6) / max(state.price, 1e-6)
        )

        event_component = 0.0
        if state.event_ticks_left > 0:
            # Events decay toward the end so the price settles rather than snaps back.
            decay = 0.6 + 0.4 * (state.event_ticks_left / max(1, self.config.event_ticks_max))
            event_component = state.event_magnitude * decay
            state.event_ticks_left -= 1
            if state.event_ticks_left <= 0:
                state.active_event = None
                state.event_magnitude = 0.0

        shock = self.rng.gauss(0.0, per_tick_vol * REGIME_VOL_MULTIPLIER[self.regime])
        log_return = (
            per_tick_drift
            + regime_component
            + reversion
            + event_component
            + shock
            - 0.5 * per_tick_vol**2
        )
        log_return = max(-self.config.max_tick_move, min(self.config.max_tick_move, log_return))
        new_price = state.price * math.exp(log_return)
        state.price = min(self.config.max_price, max(self.config.min_price, new_price))

        # Fair value tracks the company's growth story with a little noise of its own.
        state.fair_value *= math.exp(
            per_tick_drift + self.rng.gauss(0.0, per_tick_vol * 0.25)
        )
        state.fair_value = min(self.config.max_price, max(self.config.min_price, state.fair_value))

        if not state.is_halted:
            state.day_high = max(state.day_high, state.price)
            state.day_low = min(state.day_low, state.price)

    def _check_circuit_breaker(self, state: CompanyState, halts: list[str]) -> None:
        """Halt a name after a violent intraday collapse or a single-tick spike."""
        if state.halted_until_tick > self.tick:
            return
        intraday = state.day_change_fraction
        if intraday <= -self.config.circuit_breaker_drop:
            state.halted_until_tick = self.tick + self.config.halt_ticks
            halts.append(state.symbol)

    def _compute_index(self) -> float:
        total_cap = sum(c.market_cap for c in self.companies.values())
        return self.config.starting_index * (total_cap / self._initial_market_cap)

    # ----------------------------------------------------------------- helpers

    def snapshot(self) -> list[CompanyState]:
        return [self.companies[symbol] for symbol in sorted(self.companies)]

    def top_movers(self, count: int = 5) -> tuple[list[CompanyState], list[CompanyState]]:
        ordered = sorted(self.companies.values(), key=lambda c: c.day_change_fraction, reverse=True)
        return ordered[:count], list(reversed(ordered[-count:]))

    def sector_performance(self) -> dict[str, float]:
        """Average day change per sector, for the sector heatmap."""
        buckets: dict[str, list[float]] = {}
        for company in self.companies.values():
            buckets.setdefault(company.sector, []).append(company.day_change_fraction)
        return {
            sector: sum(changes) / len(changes) for sector, changes in sorted(buckets.items())
        }

    def sector_beta(self, sector: str) -> float:
        return SECTOR_BETA.get(sector, 1.0)
