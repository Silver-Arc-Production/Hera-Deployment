/**
 * Entrypoint for the standalone dashboard: ``npm run web``.
 *
 * A separate process from the bot that opens the same SQLite file and serves the
 * pages and JSON API on ``WEB_PORT``. The bot can also serve the dashboard in its
 * own process (set ``WEB_ENABLED=true``), which is what ``render.yaml`` uses.
 */
import 'dotenv/config';
import { runDashboard } from './server';

runDashboard().catch((error) => {
  console.error('dashboard failed to start', error);
  process.exit(1);
});
