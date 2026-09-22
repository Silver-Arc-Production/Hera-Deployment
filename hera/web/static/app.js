/* Dashboard front end. Fetches the JSON API and renders both pages.
   Charts arrive pre-rendered as SVG data URIs so they display without any
   client-side charting library. */

const REFRESH_MS = 60_000;

function formatPrice(value) {
  if (value < 1) return value.toFixed(4);
  if (value < 100) return value.toFixed(3);
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatCompact(value) {
  const abs = Math.abs(value);
  for (const [threshold, suffix] of [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ]) {
    if (abs >= threshold) return (value / threshold).toFixed(2) + suffix;
  }
  return value.toFixed(0);
}

function formatPercent(value) {
  const sign = value >= 0 ? "+" : "";
  return sign + value.toFixed(2) + "%";
}

function trendClass(value) {
  if (value > 0.0001) return "up";
  if (value < -0.0001) return "down";
  return "flat";
}

async function fetchJSON(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

async function renderOverview() {
  let data;
  try {
    data = await fetchJSON("/api/market");
  } catch (error) {
    document.getElementById("headline-stats").innerHTML =
      `<div class="stat"><div class="label">Error</div><div class="value down">offline</div>` +
      `<div class="sub">${error.message}</div></div>`;
    return;
  }

  setText("index-value", formatPrice(data.index.value));
  const changeNode = document.getElementById("index-change");
  changeNode.textContent = formatPercent(data.index.change_pct) + " this tick";
  changeNode.className = "sub " + trendClass(data.index.change_pct);

  setText("regime", data.regime);
  setText("tick", "tick " + data.tick.toLocaleString());
  setText("breadth", `${data.totals.gainers} / ${data.totals.losers}`);
  setText("breadth-sub", `${data.totals.unchanged} unchanged · ${data.totals.halted} halted`);
  setText("market-cap", formatCompact(data.totals.market_cap));
  setText("listing-count", `${data.totals.listings} listings`);
  setText("generated-at", "updated " + new Date(data.generated_at).toLocaleString());

  const ordered = [...data.stocks].sort((a, b) => b.change_pct - a.change_pct);
  const movers = [...ordered.slice(0, 3), ...ordered.slice(-3).reverse()];
  document.getElementById("movers").innerHTML = movers
    .map(
      (stock) => `
      <a class="card sector-tile" href="/stocks#${stock.symbol}">
        <span>
          <strong>${stock.symbol}</strong>
          <span class="name">${stock.name}</span>
        </span>
        <span class="updown ${trendClass(stock.change_pct)}">
          ${formatPrice(stock.price)}<br />
          <span class="small">${formatPercent(stock.change_pct)}</span>
        </span>
      </a>`
    )
    .join("");

  document.getElementById("sectors").innerHTML = data.sectors
    .map(
      (sector) => `
      <div class="card sector-tile">
        <span>${sector.sector}<br /><span class="small muted">${sector.count} listings</span></span>
        <span class="${trendClass(sector.change_pct)}">${formatPercent(sector.change_pct)}</span>
      </div>`
    )
    .join("");

  const newsNode = document.getElementById("news");
  if (data.news.length === 0) {
    newsNode.innerHTML = '<li class="muted small">No headlines yet.</li>';
  } else {
    newsNode.innerHTML = data.news
      .map((item) => {
        const dot = item.impact >= 0 ? "🟢" : "🔴";
        const ticker = item.symbol ? `<strong>${item.symbol}</strong> ` : "";
        return `<li>${dot} ${ticker}${item.headline}</li>`;
      })
      .join("");
  }
}

function renderStocks() {
  const state = { rows: [], sortKey: "change_pct", descending: true, filter: "", sector: "" };

  function visibleRows() {
    const needle = state.filter.trim().toLowerCase();
    return state.rows
      .filter((row) => {
        if (state.sector && row.sector !== state.sector) return false;
        if (!needle) return true;
        return (
          row.symbol.toLowerCase().includes(needle) ||
          row.name.toLowerCase().includes(needle) ||
          row.sector.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => {
        const left = a[state.sortKey];
        const right = b[state.sortKey];
        const result =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right));
        return state.descending ? -result : result;
      });
  }

  function draw() {
    const rows = visibleRows();
    setText("count", `${rows.length} of ${state.rows.length} listings`);
    const body = document.getElementById("stocks-body");
    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="9" class="muted">No listings match.</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map(
        (row) => `
        <tr data-symbol="${row.symbol}">
          <td class="ticker">${row.symbol}${row.halted ? ' <span class="badge halt">halted</span>' : ""}</td>
          <td class="name">${row.name}</td>
          <td class="muted">${row.sector}</td>
          <td>${formatPrice(row.price)}</td>
          <td class="${trendClass(row.change_pct)}">${formatPercent(row.change_pct)}</td>
          <td class="muted small">${formatPrice(row.day_low)} – ${formatPrice(row.day_high)}</td>
          <td>${formatCompact(row.market_cap)}</td>
          <td class="muted">${row.dividend_yield > 0 ? (row.dividend_yield * 100).toFixed(2) + "%" : "—"}</td>
          <td>${
            row.sparkline
              ? `<img src="${row.sparkline}" width="120" height="34" alt="${row.symbol} trend" />`
              : '<span class="muted">—</span>'
          }</td>
        </tr>`
      )
      .join("");

    body.querySelectorAll("tr[data-symbol]").forEach((tr) => {
      tr.style.cursor = "pointer";
      tr.addEventListener("click", () => showDetail(tr.dataset.symbol));
    });

    if (location.hash) showDetail(location.hash.slice(1).toUpperCase(), false);
  }

  function showDetail(symbol, scroll = true) {
    const row = state.rows.find((item) => item.symbol === symbol);
    if (!row) return;
    const frame = document.getElementById("detail-chart-frame");
    frame.hidden = false;
    document.getElementById("detail-chart").src = `/api/charts/${symbol}.svg`;
    document.getElementById("detail-meta").textContent =
      `${row.symbol} — ${row.name} · ${row.sector} · ` +
      `${formatPrice(row.price)} (${formatPercent(row.change_pct)}) · ` +
      `${row.description}`;
    if (scroll) frame.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  document.getElementById("filter").addEventListener("input", (event) => {
    state.filter = event.target.value;
    draw();
  });

  const sectorSelect = document.getElementById("sector");
  sectorSelect.addEventListener("change", (event) => {
    state.sector = event.target.value;
    draw();
  });

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.descending = !state.descending;
      } else {
        state.sortKey = key;
        state.descending = key !== "symbol" && key !== "name" && key !== "sector";
      }
      draw();
    });
  });

  fetchJSON("/api/stocks")
    .then((data) => {
      state.rows = data.stocks;
      setText("generated-at", "updated " + new Date(data.generated_at).toLocaleString());
      sectorSelect.innerHTML =
        '<option value="">All sectors</option>' +
        [...new Set(data.stocks.map((row) => row.sector))]
          .sort()
          .map((sector) => `<option value="${sector}">${sector}</option>`)
          .join("");
      draw();
    })
    .catch((error) => {
      document.getElementById("stocks-body").innerHTML =
        `<tr><td colspan="9" class="down">Could not load listings: ${error.message}</td></tr>`;
    });
}
