"""Renders price charts to PNG for Discord embeds.

matplotlib is imported lazily and the Agg backend is forced, so importing this
module never requires a display and never blocks on a GUI toolkit. Chart
rendering happens in a worker thread because matplotlib is CPU-bound and would
otherwise stall the event loop.
"""

from __future__ import annotations

import asyncio
import io
from functools import lru_cache

DARK_BG = "#1b1d23"
GRID = "#3a3f4b"
UP = "#2ecc71"
DOWN = "#e74c3c"
TEXT = "#d7dae0"
ACCENT = "#5b9bd5"


@lru_cache(maxsize=1)
def _matplotlib():
    """Import matplotlib once, forcing the headless backend."""
    import matplotlib

    matplotlib.use("Agg", force=True)
    from matplotlib import pyplot as plt

    return plt


def _render_price_chart(
    symbol: str,
    name: str,
    prices: list[float],
    *,
    ticks: list[int] | None = None,
    average_cost: float | None = None,
    width: float = 9.0,
    height: float = 4.2,
) -> bytes:
    plt = _matplotlib()
    fig, ax = plt.subplots(figsize=(width, height), dpi=110)
    fig.patch.set_facecolor(DARK_BG)
    ax.set_facecolor(DARK_BG)

    x = list(range(len(prices)))
    color = UP if prices[-1] >= prices[0] else DOWN

    ax.plot(x, prices, color=color, linewidth=1.9, zorder=3)
    ax.fill_between(x, prices, min(prices) * 0.995, color=color, alpha=0.16, zorder=2)

    if average_cost is not None and average_cost > 0:
        ax.axhline(
            average_cost,
            color=ACCENT,
            linewidth=1.2,
            linestyle="--",
            alpha=0.9,
            zorder=4,
            label=f"Avg cost {average_cost:,.2f}",
        )
        ax.legend(facecolor=DARK_BG, edgecolor=GRID, labelcolor=TEXT, fontsize=9, loc="best")

    ax.set_title(f"{symbol} — {name}", color=TEXT, fontsize=13, loc="left", pad=12)
    ax.grid(color=GRID, linewidth=0.6, alpha=0.5)
    ax.tick_params(colors=TEXT, labelsize=8)
    for spine in ax.spines.values():
        spine.set_color(GRID)

    ax.set_xlim(0, max(1, len(prices) - 1))
    padding = (max(prices) - min(prices)) * 0.08 or max(prices) * 0.01
    ax.set_ylim(min(prices) - padding, max(prices) + padding)

    if ticks:
        step = max(1, len(ticks) // 6)
        positions = list(range(0, len(ticks), step))
        ax.set_xticks(positions)
        ax.set_xticklabels([f"t{ticks[i]}" for i in positions], rotation=0)

    change = (prices[-1] - prices[0]) / prices[0] * 100 if prices[0] else 0.0
    ax.text(
        0.995,
        0.03,
        f"last {prices[-1]:,.2f}   {change:+.2f}%",
        transform=ax.transAxes,
        ha="right",
        va="bottom",
        color=TEXT,
        fontsize=9,
        bbox=dict(facecolor=DARK_BG, edgecolor=GRID, boxstyle="round,pad=0.35"),
    )

    fig.tight_layout()
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", facecolor=fig.get_facecolor())
    plt.close(fig)
    buffer.seek(0)
    return buffer.read()


def _render_multi_chart(
    series: dict[str, list[float]], *, title: str, width: float = 9.0, height: float = 4.2
) -> bytes:
    """Overlay several normalised (percentage-change) series on one chart."""
    plt = _matplotlib()
    fig, ax = plt.subplots(figsize=(width, height), dpi=110)
    fig.patch.set_facecolor(DARK_BG)
    ax.set_facecolor(DARK_BG)

    palette = ["#2ecc71", "#5b9bd5", "#f1c40f", "#e74c3c", "#9b59b6", "#1abc9c", "#e67e22"]
    for index, (label, prices) in enumerate(series.items()):
        if not prices or prices[0] == 0:
            continue
        base = prices[0]
        normalised = [(value / base - 1) * 100 for value in prices]
        ax.plot(
            range(len(normalised)),
            normalised,
            label=label,
            linewidth=1.7,
            color=palette[index % len(palette)],
        )

    ax.axhline(0, color=GRID, linewidth=1.0)
    ax.set_title(title, color=TEXT, fontsize=13, loc="left", pad=12)
    ax.set_ylabel("change %", color=TEXT, fontsize=9)
    ax.grid(color=GRID, linewidth=0.6, alpha=0.5)
    ax.tick_params(colors=TEXT, labelsize=8)
    for spine in ax.spines.values():
        spine.set_color(GRID)
    legend = ax.legend(facecolor=DARK_BG, edgecolor=GRID, labelcolor=TEXT, fontsize=9, loc="best")
    if legend:
        legend.get_frame().set_alpha(0.9)

    fig.tight_layout()
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", facecolor=fig.get_facecolor())
    plt.close(fig)
    buffer.seek(0)
    return buffer.read()


def _render_allocation_chart(labels: list[str], values: list[float]) -> bytes:
    """Donut chart of portfolio allocation."""
    plt = _matplotlib()
    fig, ax = plt.subplots(figsize=(5.4, 4.4), dpi=110)
    fig.patch.set_facecolor(DARK_BG)
    ax.set_facecolor(DARK_BG)

    palette = ["#2ecc71", "#5b9bd5", "#f1c40f", "#e74c3c", "#9b59b6", "#1abc9c", "#e67e22", "#34495e"]
    colours = [palette[index % len(palette)] for index in range(len(values))]
    wedges, _ = ax.pie(
        values, colors=colours, startangle=90, wedgeprops=dict(width=0.42, edgecolor=DARK_BG)
    )
    ax.legend(
        wedges,
        [f"{label}  {value:,.0f}" for label, value in zip(labels, values)],
        facecolor=DARK_BG,
        edgecolor=GRID,
        labelcolor=TEXT,
        fontsize=9,
        loc="center left",
        bbox_to_anchor=(1.0, 0.5),
    )
    ax.set_title("Allocation", color=TEXT, fontsize=13, loc="left", pad=10)
    fig.tight_layout()
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", facecolor=fig.get_facecolor())
    plt.close(fig)
    buffer.seek(0)
    return buffer.read()


async def price_chart(
    symbol: str,
    name: str,
    history: list[tuple[int, float]],
    *,
    average_cost: float | None = None,
) -> bytes | None:
    if len(history) < 2:
        return None
    ticks = [tick for tick, _ in history]
    prices = [value for _, value in history]
    return await asyncio.to_thread(
        _render_price_chart, symbol, name, prices, ticks=ticks, average_cost=average_cost
    )


async def comparison_chart(series: dict[str, list[float]], *, title: str) -> bytes | None:
    if not series:
        return None
    return await asyncio.to_thread(_render_multi_chart, series, title=title)


async def allocation_chart(labels: list[str], values: list[float]) -> bytes | None:
    if not values or sum(values) <= 0:
        return None
    return await asyncio.to_thread(_render_allocation_chart, labels, values)
