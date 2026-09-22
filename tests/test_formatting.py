"""Tests for the quantity/price parsers and the display formatters."""

from __future__ import annotations

import pytest

from hera.errors import InvalidOrder
from hera.formatting import compact, duration, money, percent, price, progress_bar, signed
from hera.parsing import parse_amount, parse_price


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("10", 10),
        ("1,000", 1000),
        ("5k", 5000),
        ("2.5m", 2_500_000),
        ("1b", 1_000_000_000),
        ("  42  ", 42),
    ],
)
def test_parse_amount_accepts_numbers_and_suffixes(raw, expected):
    assert parse_amount(raw) == expected


def test_parse_amount_supports_all_and_half():
    assert parse_amount("all", maximum=100) == 100
    assert parse_amount("half", maximum=101) == 50
    assert parse_amount("max", maximum=7) == 7


@pytest.mark.parametrize("raw", ["", "abc", "1.2.3", "--5", "5x"])
def test_parse_amount_rejects_garbage(raw):
    with pytest.raises(InvalidOrder):
        parse_amount(raw)


def test_parse_amount_rejects_zero():
    with pytest.raises(InvalidOrder):
        parse_amount("0")


def test_parse_amount_needs_a_maximum_for_all():
    with pytest.raises(InvalidOrder):
        parse_amount("all")


@pytest.mark.parametrize(("raw", "expected"), [("100", 100.0), ("1,250.50", 1250.5), ("2k", 2000.0)])
def test_parse_price(raw, expected):
    assert parse_price(raw) == expected


@pytest.mark.parametrize("raw", ["", "free", "-1", "0"])
def test_parse_price_rejects_invalid(raw):
    with pytest.raises(InvalidOrder):
        parse_price(raw)


def test_money_formats_with_the_currency_symbol():
    assert "1,234.50" in money(1234.5)
    assert money(1000).startswith("🪙")


def test_price_adapts_precision_to_magnitude():
    assert price(0.5) == "0.5000"
    assert price(12.5) == "12.500"
    assert price(1234.5) == "1,234.50"


def test_signed_always_shows_a_sign():
    assert signed(10).startswith("+")
    assert signed(-10).startswith("-")


def test_percent_renders_two_decimals():
    assert percent(1.234) == "+1.23%"
    assert percent(-1.234) == "-1.23%"
    assert percent(5.0, signed_output=False) == "5.00%"


def test_compact_abbreviates_large_numbers():
    assert compact(1_500) == "1.50K"
    assert compact(2_500_000) == "2.50M"
    assert compact(3_000_000_000) == "3.00B"
    assert compact(999) == "999"


def test_duration_formats_each_scale():
    assert duration(45) == "45s"
    assert duration(90) == "1m 30s"
    assert duration(3661) == "1h 01m 01s"
    assert duration(-5) == "0s"


def test_progress_bar_is_bounded():
    assert len(progress_bar(0, 100, width=10)) == 10
    assert progress_bar(0, 100, width=10).count("█") == 0
    assert progress_bar(100, 100, width=10).count("█") == 10
    assert progress_bar(50, 0, width=4) == "░░░░"
