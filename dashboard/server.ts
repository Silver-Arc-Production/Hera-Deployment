/**
 * The Hera web dashboard: a small read-only site beside the Discord bot.
 *
 * It reads the same SQLite file the bot writes to. It is strictly read-only: it
 * exposes JSON endpoints and two HTML pages, and never mutates the economy.
 *
 * Two run modes: standalone (its own process, opening the database itself) or
 * in-process with the bot, which passes its live {@link Database} and
 * {@link MarketService} in and keeps ownership of them.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { config } from '../hera/config';
import { Database } from '../hera/database';
import { MarketService } from '../hera/services/market';
import { DashboardService, fallbackChart } from './service';

const STATIC_DIR = resolve(__dirname, 'static');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendFile(response: ServerResponse, path: string): void {
  if (!existsSync(path)) {
    sendText(response, 404, 'Not found', 'text/plain; charset=utf-8');
    return;
  }
  const body = readFileSync(path);
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
    'content-length': body.length,
  });
  response.end(body);
}

export interface DashboardOptions {
  /** Which guild's market to show. Defaults to ``DISCORD_GUILD_ID``. */
  guildId?: string;
  /**
   * Services to serve from. The bot passes its live database and market service
   * so the dashboard shares one database handle with the ticker; standalone mode
   * opens its own from ``DATABASE_PATH``.
   */
  db?: Database;
  market?: MarketService;
}

/**
 * The dashboard HTTP app. It renders the market that :class:`MarketService`
 * exposes -- either the bot's live service or one it opens itself.
 */
export class Dashboard {
  readonly service: DashboardService;
  private readonly db: Database;
  /** Only set when this class opened the database and is responsible for it. */
  private readonly ownedDb: Database | null;
  private readonly server: Server;

  constructor(options: DashboardOptions = {}) {
    const guildId = options.guildId ?? config.guildId;
    if (!guildId) {
      throw new Error(
        'The dashboard needs a guild to show. Set DISCORD_GUILD_ID, or pass an explicit guildId.',
      );
    }
    // Only a database this class opened itself is closed on stop(); a borrowed
    // one belongs to the bot, which closes it during its own shutdown.
    if (options.db) {
      this.db = options.db;
      this.ownedDb = null;
    } else {
      this.db = new Database(config.dbPath);
      this.ownedDb = this.db;
    }
    const market = options.market ?? new MarketService(this.db, config.market);
    this.service = new DashboardService(market, guildId);
    this.server = createServer((request, response) => this.handle(request, response));
  }

  /** Start listening. Resolves once the socket is bound. */
  start(host = config.web.host, port = config.web.port): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        const address = this.server.address();
        const boundPort = typeof address === 'object' && address ? address.port : port;
        // eslint-disable-next-line no-console
        console.log(`dashboard listening on http://${host}:${boundPort}`);
        resolvePromise();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolvePromise) => {
      this.server.close(() => {
        // A borrowed database belongs to the bot, which closes it on shutdown.
        if (this.ownedDb) this.db.close();
        resolvePromise();
      });
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    try {
      if (path === '/' || path === '/stocks') {
        sendFile(response, join(STATIC_DIR, path === '/' ? 'index.html' : 'stocks.html'));
        return;
      }
      if (path.startsWith('/static/')) {
        // Resolve against the static directory so ``..`` cannot escape it.
        const relative = path.slice('/static/'.length);
        const target = resolve(STATIC_DIR, relative);
        if (!target.startsWith(STATIC_DIR)) {
          sendText(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
          return;
        }
        sendFile(response, target);
        return;
      }
      if (path === '/api/market') {
        void this.service.marketPayload().then((payload) => sendJson(response, 200, payload));
        return;
      }
      if (path === '/api/stocks') {
        void this.service.marketPayload().then((payload) =>
          sendJson(response, 200, {
            generated_at: payload.generated_at,
            tick: payload.tick,
            regime: payload.regime,
            index: payload.index,
            stocks: payload.stocks,
          }),
        );
        return;
      }
      if (path === '/api/charts/index.svg') {
        const svg = this.service.indexChartSvg();
        sendText(response, 200, svg ?? fallbackChart(), 'image/svg+xml');
        return;
      }
      const chartMatch = /^\/api\/charts\/([^/]+)\.svg$/.exec(path);
      if (chartMatch) {
        const svg = this.service.stockChartSvg(decodeURIComponent(chartMatch[1]));
        if (svg === null) {
          sendJson(response, 404, { error: `no listing matches ${chartMatch[1].toUpperCase()}` });
          return;
        }
        sendText(response, 200, svg, 'image/svg+xml');
        return;
      }
      if (path === '/healthz') {
        sendJson(response, 200, this.service.health());
        return;
      }
      sendText(response, 404, 'Not found', 'text/plain; charset=utf-8');
    } catch (error) {
      sendJson(response, 500, { error: (error as Error).message });
    }
  }
}

/** Build and start a dashboard, wiring SIGTERM/SIGINT to a clean shutdown. */
export async function runDashboard(): Promise<Dashboard> {
  if (!config.web.enabled) {
    // eslint-disable-next-line no-console
    console.log('web dashboard disabled (set WEB_ENABLED=true to serve it)');
    process.exit(0);
  }
  const dashboard = new Dashboard();
  await dashboard.start();
  const shutdown = (): void => {
    void dashboard.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return dashboard;
}
