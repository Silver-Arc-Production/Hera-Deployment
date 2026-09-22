# Hera

A multipurpose economy Discord bot, written in TypeScript. This repository
implements the **stock market system** end to end: a simulated exchange with 20
fictional listings, order execution, portfolios, and a full wallet/bank economy
underneath it — plus a read-only web dashboard.

## What is in here

**The exchange**

- 20 invented companies across 8 sectors, each with its own volatility, growth
  drift, market beta and dividend yield.
- A price engine that runs on a background tick: geometric random walk, mean
  reversion to a drifting fair value, sector and company news events, and
  bull/neutral/bear market regimes that scale each stock by its beta.
- Circuit breakers that halt a listing after a sharp collapse.
- Dividends that go ex-div on a schedule and pay every long holder.
- A market index, sector heatmap, news wire and a rolling price history.

**Trading**

- Market buy and sell, with commission and size-dependent slippage.
- Short selling with posted collateral, plus a margin-call warning when a
  short moves against you.
- Resting limit orders for buy/sell/short/cover, with cash reservation, expiry
  and refunds.
- Price alerts that DM the owner when a level is crossed.
- Watchlists, per-position drill-downs and a trader leaderboard.

**Economy**

- Wallet and bank with an upgradeable storage cap.
- `/work`, `/daily` with a streak bonus, `/pay`, `/rob`, `/deposit`,
  `/withdraw` and a full transaction ledger.

**Presentation**

- PNG price charts (with your average cost overlaid), multi-stock comparison
  charts and a portfolio allocation donut.
- Paginated embeds for the stock board.
- A read-only web dashboard with SVG charts, served on its own port.

## Quick start

```bash
npm install
cp .env.example .env        # then set DISCORD_TOKEN
npm run dev                 # or: npm run build && npm start
```

Requires **Node 22.5 or newer**: the database uses the built-in `node:sqlite`
module and the charts use a prebuilt `@napi-rs/canvas` binary, so there is no
native build step.

The bot needs the **Message Content** intent because every command also has a
prefix form (see below). Set `DISCORD_GUILD_ID` to register commands instantly in
one server instead of waiting for global propagation.

> **Enable the Message Content intent** in the Discord Developer Portal
> (Bot > Privileged Gateway Intents), or typed commands will not be delivered. If
> you leave it off the bot still boots and slash commands still work.

Set `STOCK_NEWS_CHANNEL_ID` to have market headlines posted to a channel.

### Commands are one file each

Every command is a single TypeScript file under `hera/commands/<category>/`, and
each file declares **both** its slash command and its prefix command. There is no
second registration step: the loader walks the category folders at startup, so
adding a command means adding a file.

```ts
// hera/commands/market/quote.ts
import { symbolArg, type CommandDefinition } from '../../framework/types';

export const command: CommandDefinition = {
  name: 'quote',
  category: 'market',
  description: 'Show a full quote for one listing.',
  args: [symbolArg('symbol', 'Ticker or company name.', symbolAutocomplete(), { required: true })],
  async execute(ctx, args, services) {
    // ctx is the same for a slash interaction and for a `!quote NOVA` message.
    // services holds the market, trading and economy services.
  },
};
```

To add a casino game later, drop `hera/commands/casino/blackjack.ts` next to the
existing folders — nothing else needs editing. (No casino commands ship today.)

### Commands work two ways

Every command is available as a slash command and as a prefixed message command.
Both run the same `execute`, so the behaviour is identical:

```
/market            !market
/buy NOVA 10       !buy NOVA 10
/limit buy NOVA 5 2500    !limit buy NOVA 5 2500
/alert NOVA above 250     !alert NOVA above 250
```

The prefix defaults to `!` and is configurable with `COMMAND_PREFIX`. Prefix
commands do not have Discord's autocomplete, so tickers and fixed-choice arguments
are validated locally instead — `!limit` still only accepts `buy`, `sell`,
`short` or `cover`, and tells you the accepted values if you mistype.

Because a message command has no ephemeral replies, any command that answers
privately (balances, order results, alerts) **direct messages you** instead. If
your DMs are closed the answer is posted in the channel with a note explaining
why.

Use `/help` (or `!help`) for a paginated directory of every command, and
`/help <command>` to read one in detail. `/markethelp` explains the simulation.

### Configuration

Every knob has a sane default and is overridable in `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token (required) |
| `DISCORD_GUILD_ID` | global | Register slash commands in one guild |
| `STOCK_NEWS_CHANNEL_ID` | — | Channel for market news |
| `COMMAND_PREFIX` | `!` | Prefix for message commands |
| `HERA_OWNER_ID` | guild owner | User allowed to run operator commands |
| `WEB_ENABLED` | auto | Serve the read-only dashboard. Unset means "serve it when the host injects `PORT`" |
| `WEB_BIND_HOST` | `0.0.0.0` | Interface the dashboard binds |
| `WEB_PORT` | `8080` | Dashboard port; a host-injected `PORT` takes precedence |
| `DATABASE_PATH` | `data/hera.db` | SQLite file |
| `CURRENCY_SYMBOL` / `CURRENCY_NAME` | `🪙` / `credits` | Display currency |
| `STOCK_TICK_SECONDS` | `300` | Seconds between market ticks |

Deeper tuning (volatility, commission, slippage, collateral ratio, event rates)
lives in `hera/config.ts`.

## Web dashboard

The dashboard is a read-only view over the same SQLite file the bot writes to.
It can run in one of two ways:

- **In the bot process** — set `WEB_ENABLED=true` and the bot also serves the
  dashboard, sharing its live market and one database handle. This is what
  `render.yaml` deploys.
- **As its own process** — `npm run web` opens the database itself and serves the
  site.

On a host that injects `PORT` (Render, Heroku, most PaaS) the dashboard is served
without setting anything: an injected `PORT` means the host is running this as a
web service and routes traffic and health checks to exactly that port, so the bot
binds it. Locally, where no `PORT` exists, set `WEB_PORT` and `WEB_ENABLED=true`.

```bash
npm run build
# Standalone.
DATABASE_PATH=/data/hera.db DISCORD_GUILD_ID=your-server-id WEB_PORT=8080 WEB_ENABLED=true npm run web
# Or in the bot process.
DISCORD_TOKEN=... DISCORD_GUILD_ID=... WEB_ENABLED=true WEB_PORT=8080 npm start
# On a host that injects PORT, this is enough:
DISCORD_TOKEN=... DISCORD_GUILD_ID=... PORT=10000 npm start
```

Either way the site is strictly read-only — there is no trading over HTTP.

```
http://localhost:8080/           overview: index, movers, wire, sector heatmap
http://localhost:8080/stocks     every company stock, with a price graph
```

Pages:

- **Overview** — index with its own chart, market regime, breadth, total market
  cap, top movers, sector heatmap and the news wire.
- **Stocks** — a sortable, filterable table of all 20 listings with price,
  change, day range, market cap, dividend yield and a trend sparkline. Clicking a
  row opens that company's full price chart.

JSON endpoints, if you would rather build your own front end:

| Endpoint | Returns |
| --- | --- |
| `GET /api/market` | The whole snapshot: index, sectors, stocks, news |
| `GET /api/stocks` | Just the listings array |
| `GET /api/charts/<symbol>.svg` | One listing's price chart as SVG |
| `GET /api/charts/index.svg` | The market index chart as SVG |
| `GET /healthz` | Liveness plus the current tick |

Charts are rendered server-side. The Discord side emits PNGs through
`@napi-rs/canvas`; the dashboard emits SVG (`dashboard/charts.ts`) so the graphs
stay sharp at any width and work with JavaScript disabled. The sparkline beside
each listing is embedded as a data URI, and the API is a single JSON document
with no second request.

The dashboard shows one guild's market: `DISCORD_GUILD_ID` if set, otherwise
start-up fails with a message telling you to set it.

## Deploying to Render

`render.yaml` is a blueprint for this deployment: a single **web service** that
runs the bot and serves the dashboard on the same port, with a persistent disk at
`/data`.

One service, not two, because **a Render persistent disk can be attached to only
one service at a time** — a separate dashboard service could not read the bot's
SQLite file. Since the bot process is long-running and binds a port, the web
service shape fits it exactly.

Render injects `PORT` (default `10000`) and routes inbound traffic *and the health
check* to that exact port, so the bot binds `PORT`. Do not add `WEB_PORT` in the
Render dashboard: `PORT` takes precedence, and a hard-coded `WEB_PORT` that
disagrees with `PORT` is the usual cause of a deploy failing with *no open ports
detected*.

1. Create a Blueprint from this repository and let Render read `render.yaml`.
2. Fill in the `sync: false` secrets: `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, and
   `STOCK_NEWS_CHANNEL_ID` if you want the news wire.
3. Render attaches the disk and sets `DATABASE_PATH=/data/hera.db`.

If you would rather split the bot and the dashboard, run them as two services with
a shared Postgres instead of a disk — but note the dashboard's service layer reads
SQLite, so that is a larger change.

The mount path and `DATABASE_PATH` must agree. The image defaults to
`/data/hera.db`; only override `DATABASE_PATH` if you mount the disk elsewhere
(and keep it *inside* the mount path).

Because the disk makes deploys non-zero-downtime, Render stops the old instance
before starting the new one. The container handles `SIGTERM`: the dashboard stops
first, then the market ticker is cancelled and the database closed. SQLite runs in
WAL mode, so committed ticks survive even an abrupt kill.

The image runs as uid/gid `10001`, and Render chowns the disk to that group
automatically, so the database is writable on first boot.

### Build and run with Docker

```bash
docker build -t hera-bot .

# Bot plus dashboard in one container.
docker run --rm -it \
  -e DISCORD_TOKEN=your-token \
  -e DISCORD_GUILD_ID=your-server-id \
  -e WEB_ENABLED=true \
  -p 8080:8080 \
  -v hera-data:/data \
  hera-bot

# Dashboard only, from the same image.
docker run --rm -it \
  -e DISCORD_GUILD_ID=your-server-id \
  -e WEB_ENABLED=true \
  -p 8080:8080 \
  -v hera-data:/data \
  hera-bot node --disable-warning=ExperimentalWarning dist/dashboard/index.js
```

Then open <http://localhost:8080/>.

## Commands

Every command below works with a `/` or the `!` prefix. Arguments are shown
without the sigil. Each is one file: the path in brackets is where it lives.

**Market** — `hera/commands/market/`

| Command | What it does |
| --- | --- |
| `market` | Index, top movers, active stories |
| `list [sector]` | Paginated board of all 20 listings |
| `quote <symbol>` | Full quote, plus your position if you hold one |
| `chart <symbol> [points]` | Price chart with your average cost |
| `compare <symbols>` | Normalised performance of up to 5 stocks |
| `sectors` | Sector performance heatmap |
| `news` | Latest headlines |
| `markethelp` | Paginated guide to how the market works |
| `buy <symbol> <qty>` | Market buy |
| `sell <symbol> <qty\|all>` | Market sell |
| `short <symbol> <qty>` | Open a short with collateral |
| `cover <symbol> <qty\|all>` | Close a short |
| `limit <side> <symbol> <qty> <price>` | Resting limit order |
| `orders`, `cancel <id>` | Manage resting orders |
| `portfolio [member]` | Holdings, cash and P/L |
| `position <symbol>` | Drill into one position |
| `allocation` | Allocation donut chart |
| `traders` | Net-worth leaderboard |
| `alert <symbol> <above\|below> <price>` | Set a price alert |
| `alerts`, `unalert <id>` | Manage alerts |
| `watch <add\|remove> <symbol>`, `watchlist` | Manage the watchlist |

**Economy** — `hera/commands/economy/`

`balance [member]`, `work`, `daily`, `deposit`, `withdraw`, `pay`,
`bankupgrade`, `rob`, `history`, `richest`

**Admin** — `hera/commands/admin/` (Manage Server)

`tick [count]` advances the market by hand — useful for testing.
`wipe` clears a member's account, for operators.

**Help** — `hera/commands/help/`

`help [command]` lists every command, grouped by category, with one detail page
per command.

Quantity arguments accept `10`, `25k`, `2.5m`, `all` and `half`.

## How the simulation works

Each tick every listing moves by

```
log return = drift + regime·vol·beta + mean reversion + event + noise
```

- **Drift** is each company's long-run growth, scaled by a growth multiplier.
- **Regime** is a market-wide bull/neutral/bear state; multiplying by beta makes
  high-beta tech names swing harder than defensive staples.
- **Mean reversion** pulls price toward a slowly drifting fair value. This is
  what stops a positive drift compounding without bound over months of uptime.
- **Events** are sector or company headlines that apply a signed pull for a
  bounded number of ticks, so news produces a trend rather than a jump.

Company volatility and drift are expressed as *daily* figures and normalised by
the number of ticks in a day, so changing `STOCK_TICK_SECONDS` does not change
the market's character.

The growth dial is finely balanced against volatility drag: the bear regime
carries a higher volatility multiplier, which pulls the index down. Above a
certain drift the market inflates without bound; below it, it bleeds out. The
long-run engine test simulates a month of ticks and asserts the index stays in a
healthy band.

## Architecture

```
hera/
  index.ts          Entrypoint, SIGTERM/SIGINT shutdown
  bot.ts            Bot wiring, background ticker, prefix dispatch, error handling
  config.ts         All tunable settings
  database.ts       Schema + node:sqlite wrapper
  errors.ts         Domain errors mapped to user-facing messages
  formatting.ts     Money/percent/duration rendering
  parsing.ts        "25k" / "all" argument parsing
  framework/
    types.ts        The CommandDefinition model shared by every command file
    context.ts      One command body, both Discord front ends
    register.ts     Definition -> slash payload, prefix parsing and dispatch
    registry.ts     Discovers hera/commands/<category>/*.ts
    autocomplete.ts Live ticker suggestions (slash only)
    helpers.ts      Shared error/argument plumbing
  market/
    companies.ts    The 20 listings
    events.ts       Headline templates
    engine.ts       Price simulation (pure, seedable)
    random.ts       Seeded RNG
  services/
    economy.ts      Wallets, bank, cooldowns, ledger
    market.ts       Engine persistence and queries
    trading.ts      Order execution, positions, orders, alerts
  ui/
    charts.ts       PNG rendering via @napi-rs/canvas
    embeds.ts       Embeds, paginator, confirmation view
    views.ts        Interactive component registry
    guide.ts        The market explainer pages
  events/
    index.ts        Guild join/leave wiring
    marketevents.ts Tick results rendered into Discord messages
  commands/
    market/*.ts     One file per exchange command
    economy/*.ts    One file per currency command
    admin/*.ts      Operator controls
    help/*.ts       The command directory

dashboard/
  index.ts          Entrypoint (`npm run web`)
  server.ts         HTTP routes for the pages, JSON API and SVG charts
  service.ts        Read-only market snapshots serialised to JSON
  charts.ts         Hand-rolled SVG charts
  static/           The two pages, stylesheet and front-end script

tests/              node:test suites, run with `npm test`
```

### How one command serves two front ends

A slash command receives a `ChatInputCommandInteraction`, a prefix command
receives a `Message`, and the two share almost nothing. Rather than write every
command twice, `hera/framework/context.ts` adapts both onto a `CommandContext`,
and command bodies talk only to that.

`framework/register.ts` then builds the Discord slash payload from each
definition and resolves prefix invocations from message text against the same
definitions. Fixed-choice arguments are validated locally for prefix users, and
user arguments accept a mention or a raw id. The translation is limited to the
public shape of the command, so the logic cannot drift apart.

The one honest asymmetry is ephemerality: a message command cannot reply
privately, so `PrefixContext` sends those answers as direct messages and falls
back to a clearly-labelled channel post when DMs are closed.

`MarketEngine` takes an injected `Random`, so a seeded run replays exactly — that
is what makes the simulation testable.

All money movements are journalled in `transactions`, and the ledger sums to the
member's total balance. Tests assert this after a busy trading session.

## Tests

```bash
npm test              # all suites
npm run typecheck     # tsc --noEmit
```

The suite uses `node:test` through `tsx` and covers the price engine (bounds,
determinism, regimes, dividends, circuit breakers, long-run balance), trading
(fills, weighted average cost, partial sells, shorts, collateral, limit-order
reservation and refunds, expiry, alerts), the economy (cooldowns, streaks, bank
capacity, ledger reconciliation), the parsers and formatters, the wiring layer
(slash/prefix argument parity, the help directory and its pagination), and the
web dashboard. The web suite drives real HTTP requests against a live dashboard
bound to an ephemeral port, checks the SVGs are well-formed, confirms the
payloads agree with the market, and asserts no route mutates the database.

Tests run against a real temporary SQLite database and the real services — there
are no mocks.
