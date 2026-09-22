/**
 * Entrypoint: ``npm start`` (or ``node dist/hera/index.js``).
 *
 * Node sends SIGTERM on container stop/restart, so this installs handlers that
 * close the database and the Discord connection before exiting. SQLite's WAL mode
 * makes even an abrupt kill safe, but a clean close flushes the log and releases
 * the lock promptly.
 *
 * With ``WEB_ENABLED=true`` the read-only dashboard is served from this same
 * process, sharing the bot's live market and one database handle. A host that can
 * attach its persistent disk to only one service (Render, for instance) runs this
 * single process as its web service instead of splitting the two.
 */
import 'dotenv/config';
import { config, validateConfig } from './config';
import { HeraBot } from './bot';
import { Dashboard } from '../dashboard/server';

function log(message: string): void {
  console.log(`${new Date().toISOString()} INFO     hera: ${message}`);
}

function logError(message: string, error?: unknown): void {
  console.error(`${new Date().toISOString()} ERROR    hera: ${message}`, error ?? '');
}

const SHUTDOWN_TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  validateConfig();

  const bot = new HeraBot({ log, logError });

  // Serve the dashboard from the bot's own services when enabled, so both share
  // one database handle and the ticker's in-memory state.
  let dashboard: Dashboard | null = null;
  if (config.web.enabled) {
    dashboard = new Dashboard({ db: bot.db, market: bot.market });
    await dashboard.start();
    log(`dashboard listening on ${config.web.host}:${config.web.port}`);
  }

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received; closing Discord connection`);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
    try {
      await Promise.race([
        (async () => {
          // The dashboard is stopped first: it borrows the bot's database, which
          // bot.shutdown() closes.
          if (dashboard) await dashboard.stop();
          await bot.shutdown();
        })(),
        timeout,
      ]);
    } catch (error) {
      logError('error during shutdown', error);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await bot.start();
  } catch (error) {
    if (error instanceof Error && /invalid token/i.test(error.message)) {
      logError('Discord rejected the token; check DISCORD_TOKEN');
      process.exit(1);
    }
    throw error;
  }
}

main().catch((error) => {
  logError('fatal error', error);
  process.exit(1);
});
