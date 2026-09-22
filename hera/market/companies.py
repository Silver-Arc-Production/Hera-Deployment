"""The 20 fictional listings that make up the Hera exchange.

Each company carries the parameters the simulation engine needs: a starting
price, per-tick volatility, a long-run drift (its growth story), a beta that
controls how strongly it tracks the index, and a dividend yield. Names and
tickers are invented; any resemblance to real issuers is coincidental.
"""

from __future__ import annotations

from dataclasses import dataclass

SECTORS = (
    "Technology",
    "Energy",
    "Healthcare",
    "Finance",
    "Consumer",
    "Industrials",
    "Materials",
    "Entertainment",
)

SECTOR_BETA = {
    "Technology": 1.35,
    "Energy": 0.95,
    "Healthcare": 0.75,
    "Finance": 1.10,
    "Consumer": 0.90,
    "Industrials": 1.05,
    "Materials": 0.85,
    "Entertainment": 1.25,
}


@dataclass(frozen=True)
class CompanySeed:
    symbol: str
    name: str
    sector: str
    description: str
    price: float
    volatility: float
    drift: float
    beta: float
    shares_outstanding: int
    dividend_yield: float = 0.0


COMPANIES: tuple[CompanySeed, ...] = (
    CompanySeed(
        symbol="NOVA",
        name="Novadyne Systems",
        sector="Technology",
        description="Enterprise AI infrastructure and datacentre accelerators.",
        price=412.50,
        volatility=0.021,
        drift=0.0016,
        beta=1.45,
        shares_outstanding=1_800_000_000,
        dividend_yield=0.0,
    ),
    CompanySeed(
        symbol="QBTX",
        name="Qubitix Labs",
        sector="Technology",
        description="Quantum compute research and cryogenic hardware.",
        price=88.20,
        volatility=0.034,
        drift=0.0021,
        beta=1.70,
        shares_outstanding=640_000_000,
    ),
    CompanySeed(
        symbol="HLIX",
        name="Helix Forge",
        sector="Technology",
        description="Developer tooling and cloud-native build pipelines.",
        price=245.75,
        volatility=0.018,
        drift=0.0012,
        beta=1.25,
        shares_outstanding=1_100_000_000,
        dividend_yield=0.004,
    ),
    CompanySeed(
        symbol="ARCD",
        name="Arcadia Networks",
        sector="Technology",
        description="Undersea fibre and metro mesh networking gear.",
        price=63.40,
        volatility=0.024,
        drift=0.0008,
        beta=1.15,
        shares_outstanding=900_000_000,
        dividend_yield=0.011,
    ),
    CompanySeed(
        symbol="PYRA",
        name="Pyravolt Energy",
        sector="Energy",
        description="Grid-scale battery storage and inverter systems.",
        price=154.90,
        volatility=0.028,
        drift=0.0014,
        beta=1.10,
        shares_outstanding=520_000_000,
    ),
    CompanySeed(
        symbol="TERA",
        name="Terrafirma Fuels",
        sector="Energy",
        description="Conventional drilling with a legacy pipeline network.",
        price=47.15,
        volatility=0.019,
        drift=0.0002,
        beta=0.85,
        shares_outstanding=2_400_000_000,
        dividend_yield=0.048,
    ),
    CompanySeed(
        symbol="SOLR",
        name="Solaris Reach",
        sector="Energy",
        description="Utility-scale solar farms across three continents.",
        price=72.60,
        volatility=0.026,
        drift=0.0011,
        beta=1.05,
        shares_outstanding=780_000_000,
        dividend_yield=0.018,
    ),
    CompanySeed(
        symbol="MEDI",
        name="Medivance Pharma",
        sector="Healthcare",
        description="Oncology pipeline and specialty therapeutics.",
        price=198.30,
        volatility=0.023,
        drift=0.0009,
        beta=0.80,
        shares_outstanding=610_000_000,
        dividend_yield=0.021,
    ),
    CompanySeed(
        symbol="GENX",
        name="Geneworks Bio",
        sector="Healthcare",
        description="Gene-editing platforms and clinical trial services.",
        price=34.85,
        volatility=0.041,
        drift=0.0018,
        beta=1.35,
        shares_outstanding=430_000_000,
    ),
    CompanySeed(
        symbol="VITA",
        name="Vitaline Health",
        sector="Healthcare",
        description="Outpatient clinic chains and remote monitoring devices.",
        price=112.45,
        volatility=0.016,
        drift=0.0007,
        beta=0.70,
        shares_outstanding=1_300_000_000,
        dividend_yield=0.027,
    ),
    CompanySeed(
        symbol="AURE",
        name="Aurelia Capital",
        sector="Finance",
        description="Mid-market investment banking and advisory.",
        price=286.10,
        volatility=0.017,
        drift=0.0008,
        beta=1.20,
        shares_outstanding=700_000_000,
        dividend_yield=0.032,
    ),
    CompanySeed(
        symbol="LEDG",
        name="Ledgerstone Bank",
        sector="Finance",
        description="Regional retail banking and mortgage lending.",
        price=58.70,
        volatility=0.014,
        drift=0.0004,
        beta=0.95,
        shares_outstanding=2_100_000_000,
        dividend_yield=0.042,
    ),
    CompanySeed(
        symbol="MINT",
        name="Mintcoin Exchange",
        sector="Finance",
        description="Digital asset custody and settlement rails.",
        price=23.95,
        volatility=0.052,
        drift=0.0013,
        beta=1.85,
        shares_outstanding=380_000_000,
    ),
    CompanySeed(
        symbol="BREW",
        name="Brewster Provisions",
        sector="Consumer",
        description="Packaged foods and beverage distribution.",
        price=76.25,
        volatility=0.012,
        drift=0.0005,
        beta=0.65,
        shares_outstanding=1_500_000_000,
        dividend_yield=0.035,
    ),
    CompanySeed(
        symbol="STYL",
        name="Stylus Apparel",
        sector="Consumer",
        description="Direct-to-consumer fashion and licensed sportswear.",
        price=41.60,
        volatility=0.025,
        drift=0.0006,
        beta=1.00,
        shares_outstanding=820_000_000,
        dividend_yield=0.014,
    ),
    CompanySeed(
        symbol="FRST",
        name="Firstlight Retail",
        sector="Consumer",
        description="Grocery and general merchandise superstore chain.",
        price=129.80,
        volatility=0.015,
        drift=0.0006,
        beta=0.75,
        shares_outstanding=1_050_000_000,
        dividend_yield=0.019,
    ),
    CompanySeed(
        symbol="TITN",
        name="Titanworks Heavy",
        sector="Industrials",
        description="Earthmoving equipment and mining haul trucks.",
        price=214.35,
        volatility=0.022,
        drift=0.0009,
        beta=1.15,
        shares_outstanding=480_000_000,
        dividend_yield=0.023,
    ),
    CompanySeed(
        symbol="RAIL",
        name="Railcore Logistics",
        sector="Industrials",
        description="Freight rail corridors and intermodal terminals.",
        price=93.55,
        volatility=0.017,
        drift=0.0006,
        beta=0.90,
        shares_outstanding=950_000_000,
        dividend_yield=0.029,
    ),
    CompanySeed(
        symbol="COPR",
        name="Copperfield Metals",
        sector="Materials",
        description="Copper and rare-earth extraction and refining.",
        price=167.40,
        volatility=0.027,
        drift=0.0007,
        beta=1.05,
        shares_outstanding=540_000_000,
        dividend_yield=0.026,
    ),
    CompanySeed(
        symbol="PIXL",
        name="Pixelbound Studios",
        sector="Entertainment",
        description="Game publishing and interactive streaming IP.",
        price=51.30,
        volatility=0.038,
        drift=0.0015,
        beta=1.40,
        shares_outstanding=600_000_000,
    ),
)

COMPANIES_BY_SYMBOL = {company.symbol: company for company in COMPANIES}
