"""Server-side SVG charts for the web dashboard.

The Discord side renders PNGs through matplotlib; the dashboard needs images
that stay crisp at any width, so these are hand-rolled SVG. Keeping the markup
here (rather than in the browser) means the page still shows a graph with
JavaScript disabled, and the API can hand a chart to any client as an image.

Everything is emitted as a ``data:image/svg+xml`` URI so the API stays a single
JSON document with no second request.
"""

from __future__ import annotations

from base64 import b64encode
from html import escape

from ..ui.charts import ACCENT, DARK_BG, DOWN, GRID, TEXT, UP

SVG_NS = "http://www.w3.org/2000/svg"
# The dashboard background. Kept here so the chart's face blends with the page.
PAGE_BG = "#14161c"

_DEFAULT_PALETTE = (UP, ACCENT, "#f1c40f", DOWN, "#9b59b6", "#1abc9c", "#e67e22")


def _format_price(value: float) -> str:
    """Match the bot's adaptive precision for sub-dollar listings."""
    if abs(value) < 1:
        return f"{value:,.4f}"
    if abs(value) < 100:
        return f"{value:,.3f}"
    return f"{value:,.2f}"


def _nice_ticks(low: float, high: float, count: int = 4) -> list[float]:
    """A handful of round numbers spanning ``low``..``high`` for the y-axis."""
    if high <= low:
        return [low]
    span = high - low
    raw_step = span / max(1, count)
    magnitude = 10 ** int(_floor_log10(raw_step))
    for factor in (1, 2, 2.5, 5, 10):
        step = magnitude * factor
        if step >= raw_step:
            break
    start = _ceil_to(low, step)
    ticks: list[float] = []
    value = start
    while value <= high + step * 0.001 and len(ticks) < 12:
        ticks.append(value)
        value += step
    return ticks or [low, high]


def _floor_log10(value: float) -> float:
    import math

    return math.floor(math.log10(value)) if value > 0 else 0


def _ceil_to(value: float, step: float) -> float:
    import math

    if step <= 0:
        return value
    return math.ceil(value / step) * step


def _polyline(points: list[tuple[float, float]]) -> str:
    return " ".join(f"{x:.1f},{y:.1f}" for x, y in points)


def render_price_chart(
    symbol: str,
    name: str,
    history: list[tuple[int, float]],
    *,
    width: int = 900,
    height: int = 320,
) -> str:
    """A filled line chart of one listing's price history, as inline SVG."""
    if len(history) < 2:
        return ""

    ticks = [tick for tick, _ in history]
    prices = [value for _, value in history]
    low, high = min(prices), max(prices)
    padding = (high - low) * 0.12 or max(high, 1.0) * 0.01
    low -= padding
    high += padding

    left, right, top, bottom = 72, 22, 46, 34
    plot_w = width - left - right
    plot_h = height - top - bottom

    def x_at(index: int) -> float:
        return left + plot_w * (index / max(1, len(prices) - 1))

    def y_at(value: float) -> float:
        return top + plot_h * (1 - (value - low) / (high - low))

    rising = prices[-1] >= prices[0]
    line_color = UP if rising else DOWN
    change = (prices[-1] - prices[0]) / prices[0] * 100 if prices[0] else 0.0

    y_ticks = _nice_ticks(low, high)
    grid_parts = []
    for value in y_ticks:
        y = y_at(value)
        grid_parts.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{left + plot_w}" y2="{y:.1f}" '
            f'stroke="{GRID}" stroke-width="1" opacity="0.45"/>'
            f'<text x="{left - 10}" y="{y + 4:.1f}" fill="{TEXT}" font-size="11" '
            f'text-anchor="end">{escape(_format_price(value))}</text>'
        )

    points = [(x_at(i), y_at(value)) for i, value in enumerate(prices)]
    area = (
        f"{left},{top + plot_h} "
        + _polyline(points)
        + f" {left + plot_w},{top + plot_h}"
    )

    x_step = max(1, len(ticks) // 5)
    x_parts = []
    for i in range(0, len(ticks), x_step):
        x = x_at(i)
        x_parts.append(
            f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top + plot_h}" '
            f'stroke="{GRID}" stroke-width="1" opacity="0.22"/>'
            f'<text x="{x:.1f}" y="{height - 12}" fill="{TEXT}" font-size="11" '
            f'text-anchor="middle">t{ticks[i]:,}</text>'
        )

    change_color = UP if change >= 0 else DOWN

    return (
        f'<svg xmlns="{SVG_NS}" viewBox="0 0 {width} {height}" '
        f'width="100%" height="{height}" role="img" '
        f'aria-label="{escape(symbol)} price chart">'
        f'<rect width="{width}" height="{height}" fill="{DARK_BG}" rx="10"/>'
        f'<text x="{left}" y="26" fill="{TEXT}" font-size="14" font-weight="600">'
        f"{escape(symbol)} — {escape(name)}</text>"
        f'<text x="{width - right}" y="26" fill="{change_color}" font-size="13" '
        f'text-anchor="end" font-weight="600">'
        f"{escape(_format_price(prices[-1]))}  {change:+.2f}%</text>"
        f"{''.join(grid_parts)}{''.join(x_parts)}"
        f'<polygon points="{area}" fill="{line_color}" opacity="0.16"/>'
        f'<polyline points="{_polyline(points)}" fill="none" stroke="{line_color}" '
        f'stroke-width="2.2" stroke-linejoin="round"/>'
        "</svg>"
    )


def render_sparkline(
    prices: list[float],
    *,
    width: int = 120,
    height: int = 34,
) -> str:
    """A compact trend line for a table row, as inline SVG."""
    if len(prices) < 2:
        return ""

    low, high = min(prices), max(prices)
    span = high - low or max(abs(high), 1.0) * 0.01
    pad = 4.0
    step = (width - pad * 2) / max(1, len(prices) - 1)
    color = UP if prices[-1] >= prices[0] else DOWN

    points = [
        (pad + i * step, pad + (height - pad * 2) * (1 - (value - low) / span))
        for i, value in enumerate(prices)
    ]
    area = (
        f"{pad},{height - pad} "
        + _polyline(points)
        + f" {padding_last(points)} ,{height - pad}"
    )
    return (
        f'<svg xmlns="{SVG_NS}" viewBox="0 0 {width} {height}" width="{width}" '
        f'height="{height}" role="img" aria-label="price trend">'
        f'<polygon points="{area}" fill="{color}" opacity="0.18"/>'
        f'<polyline points="{_polyline(points)}" fill="none" stroke="{color}" '
        f'stroke-width="1.6" stroke-linejoin="round"/></svg>'
    )


def padding_last(points: list[tuple[float, float]]) -> float:
    """X of the final point, used to close a sparkline's fill polygon."""
    return points[-1][0] if points else 0.0


def chart_data_uri(svg: str) -> str:
    """Encode an SVG document as a data URI usable in ``<img src=...>``."""
    if not svg:
        return ""
    encoded = b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def render_comparison_chart(
    series: dict[str, list[float]],
    *,
    title: str = "Relative performance",
    width: int = 900,
    height: int = 320,
) -> str:
    """Overlay several normalised (percentage-change) series on one chart."""
    prepared = {label: values for label, values in series.items() if len(values) >= 2}
    if not prepared:
        return ""

    left, right, top, bottom = 72, 22, 46, 34
    plot_w = width - left - right
    plot_h = height - top - bottom

    normalised: dict[str, list[float]] = {}
    for label, values in prepared.items():
        base = values[0] or 1.0
        normalised[label] = [(value / base - 1) * 100 for value in values]

    all_values = [value for values in normalised.values() for value in values]
    low, high = min(all_values + [0.0]), max(all_values + [0.0])
    span = high - low or 1.0
    low -= span * 0.1
    high += span * 0.1

    longest = max(len(values) for values in normalised.values())

    def x_at(index: int) -> float:
        return left + plot_w * (index / max(1, longest - 1))

    def y_at(value: float) -> float:
        return top + plot_h * (1 - (value - low) / (high - low))

    grid_parts = []
    for value in _nice_ticks(low, high):
        y = y_at(value)
        grid_parts.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{left + plot_w}" y2="{y:.1f}" '
            f'stroke="{GRID}" stroke-width="1" opacity="0.45"/>'
            f'<text x="{left - 10}" y="{y + 4:.1f}" fill="{TEXT}" font-size="11" '
            f'text-anchor="end">{value:+.1f}%</text>'
        )

    zero_y = y_at(0.0)
    lines = []
    legend = []
    for index, (label, values) in enumerate(normalised.items()):
        color = _DEFAULT_PALETTE[index % len(_DEFAULT_PALETTE)]
        points = [(x_at(i), y_at(value)) for i, value in enumerate(values)]
        lines.append(
            f'<polyline points="{_polyline(points)}" fill="none" stroke="{color}" '
            f'stroke-width="1.9" stroke-linejoin="round"/>'
        )
        legend.append((label, color))

    legend_parts = []
    cursor = left
    for label, color in legend:
        legend_parts.append(
            f'<rect x="{cursor}" y="{height - 16}" width="10" height="10" rx="2" fill="{color}"/>'
            f'<text x="{cursor + 15}" y="{height - 7}" fill="{TEXT}" '
            f'font-size="12">{escape(label)}</text>'
        )
        cursor += 34 + len(label) * 7.4

    return (
        f'<svg xmlns="{SVG_NS}" viewBox="0 0 {width} {height}" '
        f'width="100%" height="{height}" role="img" aria-label="{escape(title)}">'
        f'<rect width="{width}" height="{height}" fill="{DARK_BG}" rx="10"/>'
        f'<text x="{left}" y="26" fill="{TEXT}" font-size="14" '
        f'font-weight="600">{escape(title)}</text>'
        f"{''.join(grid_parts)}"
        f'<line x1="{left}" y1="{zero_y:.1f}" x2="{left + plot_w}" y2="{zero_y:.1f}" '
        f'stroke="{GRID}" stroke-width="1.4"/>'
        f"{''.join(lines)}{''.join(legend_parts)}</svg>"
    )
