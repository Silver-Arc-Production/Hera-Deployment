"""Market-moving events: sector shocks, earnings surprises and scandals.

Events are the main source of non-random movement. Each active event applies a
per-tick pull to a company's price for a bounded number of ticks, so a headline
produces a visible trend rather than a single instantaneous jump.
"""

from __future__ import annotations

import random
from dataclasses import dataclass


@dataclass(frozen=True)
class EventTemplate:
    key: str
    headline: str
    magnitude: float
    """Per-tick drift contribution while the event is active (signed)."""
    weight: float = 1.0
    sector_wide: bool = False
    good: bool = True


EVENT_TEMPLATES: tuple[EventTemplate, ...] = (
    EventTemplate("earnings_beat", "{name} smashes quarterly estimates", 0.016, 1.4),
    EventTemplate("earnings_miss", "{name} misses revenue guidance", -0.017, 1.4, good=False),
    EventTemplate("upgrade", "Analysts upgrade {symbol} to outperform", 0.010, 1.2),
    EventTemplate("downgrade", "Analysts downgrade {symbol} on valuation concerns", -0.011, 1.2, good=False),
    EventTemplate("contract", "{name} lands a multi-year government contract", 0.013, 1.0),
    EventTemplate("recall", "{name} recalls a flagship product line", -0.019, 1.0, good=False),
    EventTemplate("buyback", "{name} announces a share buyback programme", 0.012, 0.9),
    EventTemplate("lawsuit", "{name} faces a class-action lawsuit", -0.014, 0.9, good=False),
    EventTemplate("breakthrough", "{name} publishes a breakthrough trial result", 0.022, 0.7),
    EventTemplate("breach", "{name} discloses a customer data breach", -0.021, 0.7, good=False),
    EventTemplate("ceo_exit", "Shock resignation of {name}'s chief executive", -0.013, 0.8, good=False),
    EventTemplate("merger", "Rumours swirl around a {name} takeover", 0.020, 0.6),
    EventTemplate("regulation", "Regulators open a probe into {name}", -0.016, 0.7, good=False),
    EventTemplate("expansion", "{name} opens operations in two new markets", 0.009, 1.1),
    EventTemplate("supply", "Supply constraints squeeze {name} margins", -0.012, 0.9, good=False),
    EventTemplate("dividend_hike", "{name} raises its dividend payout", 0.008, 0.8),
)

SECTOR_TEMPLATES: tuple[EventTemplate, ...] = (
    EventTemplate("sector_rally", "Broad rally lifts the {sector} sector", 0.009, 1.0, True),
    EventTemplate("sector_selloff", "Selloff sweeps the {sector} sector", -0.010, 1.0, True, good=False),
    EventTemplate("sector_tariff", "New tariffs hit {sector} importers", -0.011, 0.9, True, good=False),
    EventTemplate("sector_subsidy", "Subsidy package boosts {sector} names", 0.010, 0.9, True),
)


def pick_event(sector: str, rng: random.Random) -> EventTemplate:
    """Choose a company-specific event, biased toward headline-worthy ones.

    ``rng`` is passed in rather than using the module-level generator so a
    seeded engine replays exactly.
    """
    return rng.choices(
        EVENT_TEMPLATES, weights=[template.weight for template in EVENT_TEMPLATES], k=1
    )[0]


def pick_sector_event(sector: str, rng: random.Random) -> EventTemplate:
    return rng.choice(SECTOR_TEMPLATES)


def render_headline(template: EventTemplate, *, symbol: str, name: str, sector: str) -> str:
    return template.headline.format(symbol=symbol, name=name, sector=sector)
