/**
 * Renders price charts to PNG for Discord embeds.
 *
 * Drawing is done with `@napi-rs/canvas`, a prebuilt native module that needs no
 * system libraries beyond what the Python image already ships. Rendering is
 * synchronous and fast, but chart generation happens off the reply path (after a
 * defer) so a slow render cannot trip Discord's three-second acknowledgement
 * deadline.
 */
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';

const DARK_BG = '#1b1d23';
const GRID = '#3a3f4b';
const UP = '#2ecc71';
const DOWN = '#e74c3c';
const TEXT = '#d7dae0';
const ACCENT = '#5b9bd5';
const PALETTE = ['#2ecc71', '#5b9bd5', '#f1c40f', '#e74c3c', '#9b59b6', '#1abc9c', '#e67e22'];

function newCanvas(width: number, height: number): { canvas: Canvas; ctx: SKRSContext2D } {
  const canvas: Canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = DARK_BG;
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx };
}

/** Axis helpers shared by the line charts. */
interface Plot {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function drawAxes(ctx: SKRSContext2D, plot: Plot, width: number, height: number): void {
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  ctx.stroke();

  ctx.fillStyle = TEXT;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  void width;
  void height;
}

function niceBounds(values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.08 || max * 0.01;
  return [min - pad, max + pad];
}

function mapY(value: number, min: number, max: number, plot: Plot): number {
  const ratio = max === min ? 0.5 : (value - min) / (max - min);
  return plot.bottom - ratio * (plot.bottom - plot.top);
}

function mapX(index: number, count: number, plot: Plot): number {
  if (count <= 1) return plot.left;
  return plot.left + (index / (count - 1)) * (plot.right - plot.left);
}

function renderPriceChart(
  symbol: string,
  name: string,
  prices: number[],
  options: { ticks?: number[]; averageCost?: number | null; width?: number; height?: number } = {},
): Buffer {
  const width = options.width ?? 900;
  const height = options.height ?? 420;
  const { canvas, ctx } = newCanvas(width, height);
  const plot: Plot = { left: 70, right: width - 24, top: 56, bottom: height - 40 };
  const [min, max] = niceBounds(prices);
  const color = prices[prices.length - 1] >= prices[0] ? UP : DOWN;

  drawAxes(ctx, plot, width, height);

  // Price gridlines and labels.
  ctx.font = '11px sans-serif';
  ctx.fillStyle = TEXT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let step = 0; step <= 4; step += 1) {
    const value = min + ((max - min) * step) / 4;
    const y = mapY(value, min, max, plot);
    ctx.strokeStyle = GRID;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(value.toFixed(2), plot.left - 8, y);
  }

  // Area fill under the line.
  ctx.beginPath();
  prices.forEach((value, index) => {
    const x = mapX(index, prices.length, plot);
    const y = mapY(value, min, max, plot);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(plot.right, plot.bottom);
  ctx.lineTo(plot.left, plot.bottom);
  ctx.closePath();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;

  // The price line.
  ctx.beginPath();
  prices.forEach((value, index) => {
    const x = mapX(index, prices.length, plot);
    const y = mapY(value, min, max, plot);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Average-cost marker.
  if (options.averageCost && options.averageCost > 0) {
    const y = mapY(options.averageCost, min, max, plot);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ACCENT;
    ctx.textAlign = 'left';
    ctx.fillText(`Avg cost ${options.averageCost.toFixed(2)}`, plot.left + 6, y - 10);
  }

  // Title.
  ctx.fillStyle = TEXT;
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${symbol} \u2014 ${name}`, plot.left, 30);

  // X tick labels.
  if (options.ticks && options.ticks.length > 0) {
    const step = Math.max(1, Math.floor(options.ticks.length / 6));
    ctx.font = '11px sans-serif';
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let index = 0; index < options.ticks.length; index += step) {
      const x = mapX(index, options.ticks.length, plot);
      ctx.fillText(`t${options.ticks[index]}`, x, plot.bottom + 8);
    }
  }

  // Last-price badge.
  const change = prices[0] ? ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100 : 0;
  const label = `last ${prices[prices.length - 1].toFixed(2)}   ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
  ctx.font = '12px sans-serif';
  const textWidth = ctx.measureText(label).width;
  ctx.fillStyle = DARK_BG;
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  roundRect(ctx, plot.right - textWidth - 22, plot.bottom - 34, textWidth + 16, 24, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = TEXT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, plot.right - textWidth - 14, plot.bottom - 22);

  return canvas.toBuffer('image/png');
}

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function renderMultiChart(series: Record<string, number[]>, title: string, width = 900, height = 420): Buffer {
  const { canvas, ctx } = newCanvas(width, height);
  const plot: Plot = { left: 70, right: width - 24, top: 56, bottom: height - 40 };

  const normalized: [string, number[]][] = [];
  for (const [label, prices] of Object.entries(series)) {
    if (prices.length === 0 || prices[0] === 0) continue;
    const base = prices[0];
    normalized.push([label, prices.map((value) => (value / base - 1) * 100)]);
  }
  const all = normalized.flatMap(([, values]) => values);
  const min = Math.min(0, ...all);
  const max = Math.max(0, ...all);
  const pad = (max - min) * 0.08 || 1;
  const lo = min - pad;
  const hi = max + pad;

  drawAxes(ctx, plot, width, height);

  for (let step = 0; step <= 4; step += 1) {
    const value = lo + ((hi - lo) * step) / 4;
    const y = mapY(value, lo, hi, plot);
    ctx.strokeStyle = GRID;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = TEXT;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${value.toFixed(1)}%`, plot.left - 8, y);
  }

  normalized.forEach(([label, values], index) => {
    ctx.beginPath();
    values.forEach((value, position) => {
      const x = mapX(position, values.length, plot);
      const y = mapY(value, lo, hi, plot);
      if (position === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = PALETTE[index % PALETTE.length];
    ctx.lineWidth = 1.8;
    ctx.stroke();
  });

  // Legend.
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let legendX = plot.left;
  normalized.forEach(([label], index) => {
    ctx.fillStyle = PALETTE[index % PALETTE.length];
    ctx.fillRect(legendX, 20, 12, 12);
    ctx.fillStyle = TEXT;
    ctx.fillText(label, legendX + 18, 26);
    legendX += 30 + ctx.measureText(label).width + 16;
  });

  ctx.fillStyle = TEXT;
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, plot.left, height - 12);

  return canvas.toBuffer('image/png');
}

function renderAllocationChart(labels: string[], values: number[]): Buffer {
  const width = 760;
  const height = 460;
  const { canvas, ctx } = newCanvas(width, height);
  const total = values.reduce((sum, value) => sum + value, 0);
  const centreX = 230;
  const centreY = 240;
  const outer = 150;
  const inner = 90;

  let angle = -Math.PI / 2;
  values.forEach((value, index) => {
    const slice = total > 0 ? (value / total) * Math.PI * 2 : 0;
    ctx.beginPath();
    ctx.moveTo(centreX, centreY);
    ctx.arc(centreX, centreY, outer, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = PALETTE[index % PALETTE.length];
    ctx.fill();
    // Punch the hole to make it a donut without an extra composite pass.
    ctx.beginPath();
    ctx.moveTo(centreX, centreY);
    ctx.arc(centreX, centreY, inner, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = DARK_BG;
    ctx.fill();
    angle += slice;
  });

  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  labels.forEach((label, index) => {
    const y = 120 + index * 26;
    ctx.fillStyle = PALETTE[index % PALETTE.length];
    ctx.fillRect(430, y - 6, 12, 12);
    ctx.fillStyle = TEXT;
    ctx.fillText(`${label}  ${values[index].toLocaleString('en-US', { maximumFractionDigits: 0 })}`, 450, y);
  });

  ctx.fillStyle = TEXT;
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('Allocation', 40, 44);

  return canvas.toBuffer('image/png');
}

export function priceChart(
  symbol: string,
  name: string,
  history: [number, number][],
  options: { averageCost?: number | null } = {},
): Buffer | null {
  if (history.length < 2) return null;
  const ticks = history.map(([tick]) => tick);
  const prices = history.map(([, value]) => value);
  return renderPriceChart(symbol, name, prices, {
    ticks,
    averageCost: options.averageCost ?? null,
  });
}

export function comparisonChart(series: Record<string, number[]>, title: string): Buffer | null {
  if (Object.keys(series).length === 0) return null;
  return renderMultiChart(series, title);
}

export function allocationChart(labels: string[], values: number[]): Buffer | null {
  if (values.length === 0 || values.reduce((sum, value) => sum + value, 0) <= 0) return null;
  return renderAllocationChart(labels, values);
}
