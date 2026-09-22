# Hera

A multipurpose economy Discord bot. This repository currently implements the
**stock market system** end to end: a simulated exchange with 20 fictional
listings, order execution, portfolios, and a full wallet/bank economy
underneath it.

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

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env        # then set DISCORD_TOKEN
python -m hera
```

The bot needs the **Message Content** intent because every command also has a
prefix form (see below). Set `DISCORD_GUILD_ID` to register commands instantly in
one server instead of waiting for global propagation.

> **Enable the Message Content intent** in the Discord Developer Portal
> (Bot > Privileged Gateway Intents), or typed commands will not be delivered. If
> you leave it off the bot still boots and slash commands still work.

Set `STOCK_NEWS_CHANNEL_ID` to have market headlines posted to a channel.

### Commands work two ways

Every command is available as a slash command and as a prefixed message command.
Both run the same code, so the behaviour is identical:

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

Adding a new command needs only the slash version; its prefix twin is generated
automatically.

### Configuration

Every knob has a sane default and is overridable in `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Bot token (required) |
| `DISCORD_GUILD_ID` | global | Register slash commands in one guild |
| `STOCK_NEWS_CHANNEL_ID` | — | Channel for market news |
| `COMMAND_PREFIX` | `!` | Prefix for message commands |
| `DATABASE_PATH` | `data/hera.db` | SQLite file |
| `CURRENCY_SYMBOL` / `CURRENCY_NAME` | `🪙` / `credits` | Display currency |
| `STOCK_TICK_SECONDS` | `300` | Seconds between market ticks |

Deeper tuning (volatility, commission, slippage, collateral ratio, event rates)
lives in `hera/config.py`.

## Deploying to Northflank

The `Dockerfile` builds a self-contained image; no Render-style port binding is
involved because the bot is a gateway client.

### Build and run locally

```bash
docker build -t hera-bot .
docker run --rm -it \
  -e DISCORD_TOKEN=your-token \
  -e DISCORD_GUILD_ID=your-server-id \
  -v hera-data:/data \
  hera-bot
```

### On Northflank

1. Create a **service** from this repository and let it build with the
   `Dockerfile` (Deployment > Build > Dockerfile).
2. Set the environment variables `DISCORD_TOKEN`, `DISCORD_GUILD_ID` and
   `STOCK_NEWS_CHANNEL_ID` as secrets. Do not bake them into the image.
3. **Add a persistent volume mounted at `/data`.** This is the step that matters
   most: the SQLite file holding every balance and portfolio lives there.
   Without it the economy resets on every deploy, restart and scale-down.

The mount path and `DATABASE_PATH` must agree. The image already defaults to
`/data/hera.db`; only override `DATABASE_PATH` if you mount the volume elsewhere
(and keep it *inside* the mount path).

The image runs as uid/gid `10001`. Northflank assigns volume ownership to the
group configured in the image, so keep that group unless you also change the
Dockerfile. If a volume comes back owned by a different group and the bot cannot
write to `/data`, override the entrypoint with `bin/bash -c` and
`chown -R 10001:10001 /data && exec python -m hera`.

The container stops gracefully: `hera/__main__.py` installs a `SIGTERM` handler
that cancels the market ticker and closes the database before exiting. SQLite
runs in WAL mode, so committed ticks survive even an abrupt kill.

## Commands

Every command below works with a `/` or the `!` prefix. Arguments are shown
without the sigil.

**Market**

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

**Trading**

| Command | What it does |
| --- | --- |
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

**Alerts and watches**

`alert <symbol> <above\|below> <price>`, `alerts`, `unalert <id>`,
`watch <add\|remove> <symbol>`, `watchlist`

**Economy**

`balance [member]`, `work`, `daily`, `deposit`, `withdraw`, `pay`,
`bankupgrade`, `rob`, `history`, `richest`

**Admin** (Manage Server)

`tick [count]` advances the market by hand — useful for testing.

**Help**

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
certain drift the market inflates without bound; below it, it bleeds out.
`test_long_run_market_stays_within_a_healthy_band` guards this, simulating a
month of ticks across several seeds.

## Architecture

```
hera/
  bot.py            Bot wiring, background ticker, DM dispatch, error handling
  __main__.py       Entrypoint and SIGTERM/SIGINT shutdown handling
  config.py         All tunable settings
  context.py        One command body, both Discord front ends
  database.py       Schema + async SQLite wrapper
  errors.py         Domain errors mapped to user-facing messages
  formatting.py     Money/percent/duration rendering
  parsing.py        "25k" / "all" argument parsing
  market/
    companies.py    The 20 listings
    events.py       Headline templates
    engine.py       Price simulation (pure, seedable)
  services/
    economy.py      Wallets, bank, cooldowns, ledger
    market.py       Engine persistence and queries
    trading.py      Order execution, positions, orders, alerts
  ui/
    charts.py       matplotlib PNG rendering
    embeds.py       Embeds, paginator, confirmation view
    guide.py        The market explainer pages
  cogs/
    economy.py      Currency commands
    stocks.py       Exchange commands
    admin.py        Manual tick controls
    help.py         Command directory
```

### How one command serves two front ends

A slash command receives an `Interaction`, a message command receives a
`commands.Context`, and the two share almost nothing. Rather than write every
command twice, `hera/context.py` adapts both onto a `CommandContext`, and the
command bodies talk only to that.

`@bind_contexts` on a cog then derives a prefixed twin for each slash command. The
twin shares the callback, so the logic cannot drift, and the translation is limited
to the public shape: `Choice` parameters become `Literal`s (so `!limit` accepts only
the same four sides the slash command offers), and autocomplete-only conveniences
are simply absent. Failures on either front end reach `HeraBot.on_command_error`,
which reports a domain error, a mistyped argument and an unexpected crash in the
same shape.

The one honest asymmetry is ephemerality: a message command cannot reply
privately, so `PrefixContext` sends those answers as direct messages and falls back
to a clearly-labelled channel post when DMs are closed.

`MarketEngine` is pure and takes an injected `random.Random`, so a seeded run
replays exactly — that is what makes the simulation testable.

All money movements are journalled in `transactions`, and the ledger sums to the
member's total balance. Tests assert this after a busy trading session.

## Tests

```bash
pip install pytest pytest-asyncio
python -m pytest
```

The suite covers the price engine (bounds, determinism, regimes, dividends,
circuit breakers, long-run balance), trading (fills, weighted average cost,
partial sells, shorts, collateral, limit-order reservation and refunds, expiry,
alerts), the economy (cooldowns, streaks, bank capacity, ledger reconciliation),
the parsers and formatters, and the command layer (both context adapters, ephemeral
fallback, and the generated prefix twins). It runs against a real temporary SQLite
database — nothing is mocked.
