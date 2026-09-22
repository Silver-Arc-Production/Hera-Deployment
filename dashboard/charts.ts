/**
 * Server-side SVG charts for the dashboard.
 *
 * The Discord side renders PNGs through ``@napi-rs/canvas``; the dashboard needs
 * images that stay crisp at any width, so these are hand-rolled SVG. Keeping the
 * markup here (rather than in the browser) means the page still shows a graph
 * with JavaScript disabled, and the API can hand a chart to any client as an
 * image.
 *
 * Everything is emitted as a ``data:image/svg+xml`` URI so the API stays a single
 * JSON document with no second request.
 */

/** Palette shared with the bot's Discord charts. */
export const DARK_BG = '#1b1d23';
const GRID = '#3a3f4b';
const UP = '#2ecc71';
const DOWN = '#e74c3c';
const TEXT = '#d7dae0';
const ACCENT = '#5b9bd5';

const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_PALETTE = [UP, ACCENT, '#f1c40f', DOWN, '#9b59b6', '#1abc9c', '#e67e22'];

type Point = [number, number];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Match the bot's adaptive precision for sub-dollar listings. */
function formatPrice(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1) return value.toFixed(4);
  if (abs < 100) return value.toFixed(3);
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A handful of round numbers spanning ``low``..``high`` for the y-axis. */
function niceTicks(low: number, high: number, count = 4): number[] {
  if (high <= low) return [low];
  const span = high - low;
  const rawStep = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  let step = magnitude;
  for (const factor of [1, 2, 2.5, 5, 10]) {
    step = magnitude * factor;
    if (step >= rawStep) break;
  }
  const start = step > 0 ? Math.ceil(low / step) * step : low;
  const ticks: number[] = [];
  let value = start;
  while (value <= high + step * 0.001 && ticks.length < 12) {
    ticks.push(value);
    value += step;
  }
  return ticks.length > 0 ? ticks : [low, high];
}

function polyline(points: Point[]): string {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

/** A filled line chart of one listing's price history, as inline SVG. */
export function renderPriceChart(
  symbol: string,
  name: string,
  history: Point[],
  options: { width?: number; height?: number } = {},
): string {
  if (history.length < 2) return '';
  const width = options.width ?? 900;
  const height = options.height ?? 320;

  const ticks = history.map(([tick]) => tick);
  const prices = history.map(([, value]) => value);
  let low = Math.min(...prices);
  let high = Math.max(...prices);
  const padding = (high - low) * 0.12 || Math.max(high, 1.0) * 0.01;
  low -= padding;
  high += padding;

  const left = 72;
  const right = 22;
  const top = 46;
  const bottom = 34;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const xAt = (index: number): number => left + plotW * (index / Math.max(1, prices.length - 1));
  const yAt = (value: number): number => top + plotH * (1 - (value - low) / (high - low));

  const first = prices[0];
  const last = prices[prices.length - 1];
  const rising = last >= first;
  const lineColor = rising ? UP : DOWN;
  const change = first ? ((last - first) / first) * 100 : 0.0;

  const gridParts = niceTicks(low, high).map((value) => {
    const y = yAt(value);
    return (
      `<line x1="${left}" y1="${y.toFixed(1)}" x2="${left + plotW}" y2="${y.toFixed(1)}" ` +
      `stroke="${GRID}" stroke-width="1" opacity="0.45"/>` +
      `<text x="${left - 10}" y="${(y + 4).toFixed(1)}" fill="${TEXT}" font-size="11" ` +
      `text-anchor="end">${escapeXml(formatPrice(value))}</text>`
    );
  });

  const points: Point[] = prices.map((value, index) => [xAt(index), yAt(value)]);
  const area = `${left},${top + plotH} ${polyline(points)} ${left + plotW},${top + plotH}`;

  const xStep = Math.max(1, Math.floor(ticks.length / 5));
  const xParts: string[] = [];
  for (let i = 0; i < ticks.length; i += xStep) {
    const x = xAt(i);
    xParts.push(
      `<line x1="${x.toFixed(1)}" y1="${top}" x2="${x.toFixed(1)}" y2="${top + plotH}" ` +
        `stroke="${GRID}" stroke-width="1" opacity="0.22"/>` +
        `<text x="${x.toFixed(1)}" y="${height - 12}" fill="${TEXT}" font-size="11" ` +
        `text-anchor="middle">t${ticks[i].toLocaleString('en-US')}</text>`,
    );
  }

  const changeColor = change >= 0 ? UP : DOWN;

  return (
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" ` +
    `role="img" aria-label="${escapeXml(symbol)} price chart">` +
    `<rect width="${width}" height="${height}" fill="${DARK_BG}" rx="10"/>` +
    `<text x="${left}" y="26" fill="${TEXT}" font-size="14" font-weight="600">` +
    `${escapeXml(symbol)} \u2014 ${escapeXml(name)}</text>` +
    `<text x="${width - right}" y="26" fill="${changeColor}" font-size="13" ` +
    `text-anchor="end" font-weight="600">${escapeXml(formatPrice(last))}  ` +
    `${change >= 0 ? '+' : ''}${change.toFixed(2)}%</text>` +
    `${gridParts.join('')}${xParts.join('')}` +
    `<polygon points="${area}" fill="${lineColor}" opacity="0.16"/>` +
    `<polyline points="${polyline(points)}" fill="none" stroke="${lineColor}" ` +
    `stroke-width="2.2" stroke-linejoin="round"/></svg>`
  );
}

/** A compact trend line for a table row, as inline SVG. */
export function renderSparkline(
  prices: number[],
  options: { width?: number; height?: number } = {},
): string {
  if (prices.length < 2) return '';
  const width = options.width ?? 120;
  const height = options.height ?? 34;

  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const span = high - low || Math.max(Math.abs(high), 1.0) * 0.01;
  const pad = 4.0;
  const step = (width - pad * 2) / Math.max(1, prices.length - 1);
  const color = prices[prices.length - 1] >= prices[0] ? UP : DOWN;

  const points: Point[] = prices.map((value, index) => [
    pad + index * step,
    pad + (height - pad * 2) * (1 - (value - low) / span),
  ]);
  const lastX = points[points.length - 1][0];
  const area = `${pad},${height - pad} ${polyline(points)} ${lastX.toFixed(1)},${height - pad}`;

  return (
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="price trend">` +
    `<polygon points="${area}" fill="${color}" opacity="0.18"/>` +
    `<polyline points="${polyline(points)}" fill="none" stroke="${color}" ` +
    `stroke-width="1.6" stroke-linejoin="round"/></svg>`
  );
}

/** Overlay several normalised (percentage-change) series on one chart. */
export function renderComparisonChart(
  series: Record<string, number[]>,
  options: { title?: string; width?: number; height?: number } = {},
): string {
  const title = options.title ?? 'Relative performance';
  const prepared = Object.entries(series).filter(([, values]) => values.length >= 2);
  if (prepared.length === 0) return '';
  const width = options.width ?? 900;
  const height = options.height ?? 320;

  const left = 72;
  const right = 22;
  const top = 46;
  const bottom = 34;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const normalised: Record<string, number[]> = {};
  for (const [label, values] of prepared) {
    const base = values[0] || 1.0;
    normalised[label] = values.map((value) => (value / base - 1) * 100);
  }

  const allValues = Object.values(normalised).flat();
  let low = Math.min(...allValues, 0.0);
  let high = Math.max(...allValues, 0.0);
  const span = high - low || 1.0;
  low -= span * 0.1;
  high += span * 0.1;

  const longest = Math.max(...Object.values(normalised).map((values) => values.length));
  const xAt = (index: number): number => left + plotW * (index / Math.max(1, longest - 1));
  const yAt = (value: number): number => top + plotH * (1 - (value - low) / (high - low));

  const gridParts = niceTicks(low, high).map((value) => {
    const y = yAt(value);
    return (
      `<line x1="${left}" y1="${y.toFixed(1)}" x2="${left + plotW}" y2="${y.toFixed(1)}" ` +
      `stroke="${GRID}" stroke-width="1" opacity="0.45"/>` +
      `<text x="${left - 10}" y="${(y + 4).toFixed(1)}" fill="${TEXT}" font-size="11" ` +
      `text-anchor="end">${value >= 0 ? '+' : ''}${value.toFixed(1)}%</text>`
    );
  });

  const zeroY = yAt(0.0);
  const lines: string[] = [];
  const legend: [string, string][] = [];
  Object.entries(normalised).forEach(([label, values], index) => {
    const color = DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
    const points: Point[] = values.map((value, i) => [xAt(i), yAt(value)]);
    lines.push(
      `<polyline points="${polyline(points)}" fill="none" stroke="${color}" ` +
        `stroke-width="1.9" stroke-linejoin="round"/>`,
    );
    legend.push([label, color]);
  });

  const legendParts: string[] = [];
  let cursor = left;
  for (const [label, color] of legend) {
    legendParts.push(
      `<rect x="${cursor}" y="${height - 16}" width="10" height="10" rx="2" fill="${color}"/>` +
        `<text x="${cursor + 15}" y="${height - 7}" fill="${TEXT}" font-size="12">${escapeXml(label)}</text>`,
    );
    cursor += 34 + label.length * 7.4;
  }

  return (
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" ` +
    `role="img" aria-label="${escapeXml(title)}">` +
    `<rect width="${width}" height="${height}" fill="${DARK_BG}" rx="10"/>` +
    `<text x="${left}" y="26" fill="${TEXT}" font-size="14" font-weight="600">${escapeXml(title)}</text>` +
    `${gridParts.join('')}` +
    `<line x1="${left}" y1="${zeroY.toFixed(1)}" x2="${left + plotW}" y2="${zeroY.toFixed(1)}" ` +
    `stroke="${GRID}" stroke-width="1.4"/>` +
    `${lines.join('')}${legendParts.join('')}</svg>`
  );
}

/** A tiny placeholder so an empty chart is still a valid image. */
export function fallbackChart(message = 'Not enough history yet'): string {
  return (
    `<svg xmlns="${SVG_NS}" viewBox="0 0 900 320" width="100%" height="320">` +
    `<rect width="900" height="320" fill="${DARK_BG}" rx="10"/>` +
    `<text x="450" y="160" fill="${TEXT}" font-size="16" text-anchor="middle">${escapeXml(message)}</text>` +
    `<line x1="72" y1="240" x2="878" y2="240" stroke="${GRID}" stroke-width="1"/></svg>`
  );
}

/** Encode an SVG document as a data URI usable in ``<img src=...>``. */
export function chartDataUri(svg: string): string {
  if (!svg) return '';
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`;
}
