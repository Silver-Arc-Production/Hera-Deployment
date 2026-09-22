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
- `render.yaml` intentionally deploys ONE web service. A Render persistent disk
  can be attached to only one service, so a separate dashboard service could not
  read the bot's SQLite file. Splitting them would require replacing SQLite with
  a networked database.
- `DATABASE_PATH` must live inside the mounted disk path (`/data`). The image
  defaults to `/data/hera.db` and runs as uid/gid 10001.
- `node scripts/copy-assets.mjs` and `tsconfig.build.json` are both required by
  the Dockerfile build stage; keep them in the `COPY` list.

## Conventions

- Style: 2-space indent, single quotes, semicolons, ~100 column lines.
- Comments explain *why* (an invariant, a workaround, a non-obvious trade-off),
  never *what* the next line does. Most files open with a short module docstring.
- Never commit `.env`, `data/`, `dist/` or `node_modules/` — `.gitignore` and
  `.dockerignore` both cover them.
