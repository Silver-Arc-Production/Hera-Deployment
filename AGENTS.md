# AGENTS.md

Repository notes for future work. Keep this current as the project evolves.

## What this is

Hera is a Discord bot (discord.js 14, TypeScript, CommonJS) with a simulated
stock exchange and a wallet/bank economy. It was ported from Python; there is no
Python left in the tree, so do not look for `requirements.txt`, `pytest.ini` or
`__pycache__` as a source of truth.

## Commands and layout

- Node >= 22.5 is required. The database uses the built-in `node:sqlite`
  (`DatabaseSync`) and charts use the prebuilt `@napi-rs/canvas` binding, so there
  is no native compile step. Do not add `better-sqlite3` or `canvas`.
- One command per file under `hera/commands/<category>/<name>.ts`. Each file
  exports exactly one `CommandDefinition` (as `export const command`), and each
  definition declares both the slash command and the prefix command. The loader
  (`hera/framework/registry.ts`) walks the category folders at runtime, so adding
  a command means adding a file only.
- `hera/framework/register.ts` builds the Discord slash payload from a definition
  and also matches prefix invocations from message text. When you add an argument
  with `choices`, prefix users are validated locally against them, so keep the
  choices list authoritative.
- A command body only ever sees `CommandContext`. Slash and prefix are adapted
  onto it in `hera/framework/context.ts`. Ephemeral replies become DMs for prefix
  users (there is no private reply for a message).
- Prefix dispatch needs BOTH `GatewayIntentBits.GuildMessages` and
  `GatewayIntentBits.MessageContent` in `hera/bot.ts`. `MessageContent` is
  privileged and fills in the text, but `GuildMessages` is what makes Discord
  deliver `MESSAGE_CREATE` at all. With only the former the bot boots and slash
  commands work while every typed command is silently invisible. Also enable
  Message Content in the Developer Portal, or Discord closes the socket.
  `tests/test_wiring.ts` asserts both intents are requested.

## Build and test

- `npm run typecheck` compiles `hera/`, `dashboard/` and `tests/` with no emit.
- `npm run build` uses `tsconfig.build.json` (excludes `tests/`) and then
  `scripts/copy-assets.mjs` copies `dashboard/static` to `dist/dashboard/static`.
  If you add static assets anywhere, add them to that copy list or they will be
  missing in production.
- `npm test` runs `tsx --test "tests/test_*.ts"`. Tests use the real services over
  a real (in-memory or temp-file) SQLite database; there are no mocks. The market
  engine takes a seeded `Random`, so assert on exact numbers only in tests that
  seed it (`tests/harness.ts` seeds 1234).

## Dashboard and deployment

- The dashboard is read-only. `Dashboard` accepts an injected `db` and `market`;
  when it does, it must NOT close the database on `stop()` because the bot owns
  it. `dashboard/server.ts` tracks this with `ownedDb`.
- Two run modes: standalone (`npm run web` → `dist/dashboard/index.js`) opens its
  own database; in-process (`WEB_ENABLED=true` with the bot) shares the bot's
  services and is what `render.yaml` deploys.
- The dashboard port resolution lives in `resolveWebConfig` in `hera/config.ts`:
  a host-injected `PORT` wins over `WEB_PORT`, and the mere presence of `PORT`
  enables the dashboard unless `WEB_ENABLED` is set explicitly. This is what
  keeps a Render web service from failing its port scan with "no open ports
  detected"; do not reintroduce a hard-coded `WEB_PORT` in `render.yaml`.
- `render.yaml` intentionally deploys ONE web service. A Render persistent disk
  can be attached to only one service, so a separate dashboard service could not
  read the bot's SQLite file. Splitting them would require replacing SQLite with
  a networked database.
- `DATABASE_PATH` must live inside the mounted disk path (`/data`). The image
  defaults to `/data/hera.db` and runs as uid/gid 10001.
- `node scripts/copy-assets.mjs` and `tsconfig.build.json` are both required by
  the Dockerfile build stage; keep them in the `COPY` list.

## Market and trading model

- The market is a continuous, always-open simulation. There are **no trading
  sessions and no circuit breakers**: `MarketEngine.advance()` never halts a
  listing, and no halt column or `MarketHalted` error exists. Do not reintroduce
  `circuitBreakerDrop`, `haltTicks` or `halted_until_tick`.
- `sessionTicks` still exists, but only to decide when the *reporting day* rolls
  over (resetting `previousClose`/`openPrice`/`dayHigh`/`dayLow`). It does not
  gate trading.
- Execution is commission-free and fills at the exact live price: no commission
  or slippage config, and `estimateExecutionPrice` returns the live price with a
  zero slippage component.
- Share quantities are **fractional**, stored as `REAL` in `positions`,
  `short_positions` and `orders`, and rounded to six decimal places by
  `roundShares`/`SHARE_PRECISION` in `hera/services/trading.ts`. Cash is still
  whole credits: buys round the total up and sells round proceeds down, so a
  round trip costs at most one credit.
- `/buy` and `/sell` accept either a share count (fractions allowed) or a dollar
  amount prefixed with `$`. `parseOrderSize` in `hera/parsing.ts` distinguishes
  the two; `buyByValue`/`sellByValue` size the order at the live price.
- Format share counts with `shares()` from `hera/formatting.ts`, never
  `toLocaleString()` directly, so fractions render correctly.

## Casino

- Games live in `hera/gambling/games.ts` as **pure functions** over an injected
  `Random`, each returning a `GameOutcome { payout, win, summary, detail? }`.
  They do not touch the database; `GamblingService` in `hera/gambling/service.ts`
  owns level gating, wager settlement and the ledger. Keep it that way — the
  games are what the tests seed and assert on.
- The `casino` command category is `hera/commands/casino/`. Game commands are
  thin: they parse a wager and call `wager()` from `hera/commands/casino/shared.ts`,
  which validates against the table limits, settles, and renders the result
  embed. `shared.ts` exports no `command`, so the registry ignores it.
- Six tiers live in `gamblingDefaults.levels` (`hera/config.ts`). A tier opens on
  **peak** net winnings (`gambling_profiles.peak_earned`), which only ever rises,
  so a losing streak never demotes anyone. `requiredEarned` is net profit, not
  turnover.
- Every game must keep a house edge. `tests/test_gambling.ts` runs a 200k-round
  Monte Carlo per game and asserts the return is between 85% and 100% — add new
  games to that list. Beware pushes that return the full stake: rps and war both
  needed their win multiplier trimmed below 2x to stay under 100% once ties
  returned the stake.
- Payouts go through `credits()` in `games.ts`, which floors to whole credits with
  a 1e-9 nudge so `100 * 2.3` pays 230 rather than 229. Wagers are whole credits;
  shares being fractional elsewhere does not apply here.
- `SLOT_TRIPLE_PAYOUTS` is keyed by the emoji in `SLOT_REELS`; changing a reel
  weight without rescaling the payouts will move the slot return.
- `hera/commands/casino/keno.ts` parses its `picks` string itself (space or comma
  separated) and validates before wagering; there is no list argument type.

## Conventions

- Style: 2-space indent, single quotes, semicolons, ~100 column lines.
- Comments explain *why* (an invariant, a workaround, a non-obvious trade-off),
  never *what* the next line does. Most files open with a short module docstring.
- Never commit `.env`, `data/`, `dist/` or `node_modules/` — `.gitignore` and
  `.dockerignore` both cover them.
