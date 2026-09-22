"""Domain errors that map cleanly onto user-facing messages."""

from __future__ import annotations


class HeraError(Exception):
    """Base class for expected, user-facing failures."""


class InsufficientFunds(HeraError):
    def __init__(self, needed: int, available: int) -> None:
        self.needed = needed
        self.available = available
        super().__init__(f"needs {needed:,}, only {available:,} available")


class InsufficientShares(HeraError):
    def __init__(self, symbol: str, needed: int, available: int) -> None:
        self.symbol = symbol
        self.needed = needed
        self.available = available
        super().__init__(f"needs {needed:,} {symbol}, only {available:,} held")


class InsufficientCollateral(HeraError):
    def __init__(self, needed: int, available: int) -> None:
        self.needed = needed
        self.available = available
        super().__init__(f"needs {needed:,} collateral, only {available:,} available")


class UnknownSymbol(HeraError):
    def __init__(self, symbol: str) -> None:
        self.symbol = symbol
        super().__init__(f"unknown symbol {symbol}")


class MarketHalted(HeraError):
    def __init__(self, symbol: str) -> None:
        self.symbol = symbol
        super().__init__(f"trading in {symbol} is halted by a circuit breaker")


class BankFull(HeraError):
    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        super().__init__(f"bank capacity of {capacity:,} reached")


class CooldownActive(HeraError):
    def __init__(self, seconds_remaining: float) -> None:
        self.seconds_remaining = seconds_remaining
        super().__init__(f"on cooldown for {seconds_remaining:.0f}s")


class InvalidOrder(HeraError):
    """Raised when an order request is malformed or not executable."""
