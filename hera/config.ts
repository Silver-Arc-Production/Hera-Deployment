export interface EconomyConfig {
  startingWallet: number;
  startingBankCapacity: number;
  workMin: number;
  workMax: number;
  workCooldownSeconds: number;
  dailyAmount: number;
  dailyCooldownSeconds: number;
  dailyStreakBonus: number;
  dailyStreakCap: number;
  bankUpgradeBaseCost: number;
  bankUpgradeCapacity: number;
  robCooldownSeconds: number;
  robSuccessChance: number;
  robMaxStealFraction: number;
  robFine: number;
}

export interface MarketConfig {
  tickSeconds: number;
  historyLimit: number;
  /** Ticks per trading session. At the default 300s tick this is a 2-hour day. */
  sessionTicks: number;
  startingIndex: number;
  meanReversion: number;
  maxTickMove: number;
  minPrice: number;
  maxPrice: number;
  eventChance: number;
  eventTicksMin: number;
  eventTicksMax: number;
  regimeMinTicks: number;
  regimeMaxTicks: number;
  circuitBreakerDrop: number;
  haltTicks: number;
  dividendTickInterval: number;
}

export interface TradingConfig {
  commissionRate: number;
  commissionMin: number;
  commissionMax: number;
  slippageCoefficient: number;
  maxSlippage: number;
  minShortCollateralRatio: number;
  marginCallRatio: number;
  limitOrderExpiryTicks: number;
  shortBorrowFeeRate: number;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface BotConfig {
  token: string;
  /** Discord user id of the operator, allowed to run admin commands. */
  ownerId: string | null;
  guildId: string | null;
  marketChannelId: string | null;
  dbPath: string;
  prefix: string;
  currencySymbol: string;
  currencyName: string;
  embedColor: number;
  errorColor: number;
  runMarketOnStartup: boolean;
  economy: EconomyConfig;
  market: MarketConfig;
  trading: TradingConfig;
  web: WebConfig;
}

/** The subset of ``process.env`` the config reads, injectable so tests can vary it. */
export type Env = Record<string, string | undefined>;

const processEnv: Env = process.env;

function envInt(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}

function envBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function envId(env: Env, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * Resolve the dashboard's bind settings.
 *
 * ``PORT`` is what Render (and most container hosts) inject for a web service,
 * and Render routes inbound traffic and health checks to exactly that port. So
 * ``PORT`` wins over ``WEB_PORT`` when both are set; ``WEB_PORT`` remains the
 * knob for hosts that don't inject ``PORT``.
 *
 * A host that injects ``PORT`` is declaring that this process is the web
 * service, so the dashboard is served even when ``WEB_ENABLED`` is unset --
 * otherwise the deploy binds nothing and the host's port scan fails. An
 * explicit ``WEB_ENABLED`` still wins in both directions, so operators can turn
 * the dashboard off (or on) regardless.
 */
export function resolveWebConfig(env: Env): WebConfig {
  const port = envInt(env, 'PORT', envInt(env, 'WEB_PORT', 8080));
  // No explicit WEB_ENABLED leaves the decision to the host: a PORT means it is
  // running us as a web service and expects a listener on that port.
  const rawEnabled = env['WEB_ENABLED'];
  const enabled =
    rawEnabled === undefined ? env['PORT'] !== undefined : envBool(env, 'WEB_ENABLED', false);
  return {
    enabled,
    host: env['WEB_BIND_HOST'] ?? '0.0.0.0',
    port,
  };
}

/** Default economy tuning, exported so tests can build configs without env vars. */
export const economyDefaults: EconomyConfig = {
  startingWallet: 500,
  startingBankCapacity: 50_000,
  workMin: 120,
  workMax: 480,
  workCooldownSeconds: 3_600,
  dailyAmount: 1_000,
  dailyCooldownSeconds: 86_400,
  dailyStreakBonus: 150,
  dailyStreakCap: 7,
  bankUpgradeBaseCost: 25_000,
  bankUpgradeCapacity: 50_000,
  robCooldownSeconds: 7_200,
  robSuccessChance: 0.45,
  robMaxStealFraction: 0.25,
  robFine: 250,
};

/** Default market tuning; tick length is the one value read from the environment. */
export const marketDefaults: MarketConfig = {
  tickSeconds: envInt(processEnv, 'STOCK_TICK_SECONDS', 300),
  historyLimit: 720,
  sessionTicks: 24,
  startingIndex: 1_000.0,
  meanReversion: 0.004,
  maxTickMove: 0.18,
  minPrice: 1.0,
  maxPrice: 100_000.0,
  eventChance: 0.22,
  eventTicksMin: 3,
  eventTicksMax: 12,
  regimeMinTicks: 20,
  regimeMaxTicks: 70,
  circuitBreakerDrop: 0.22,
  haltTicks: 3,
  dividendTickInterval: 120,
};

/** Default trading tuning, exported so tests can build configs without env vars. */
export const tradingDefaults: TradingConfig = {
  commissionRate: 0.0025,
  commissionMin: 1,
  commissionMax: 5_000,
  slippageCoefficient: 0.35,
  maxSlippage: 0.12,
  minShortCollateralRatio: 1.5,
  marginCallRatio: 0.75,
  limitOrderExpiryTicks: 240,
  shortBorrowFeeRate: 0.0004,
};

export const config: BotConfig = {
  token: process.env.DISCORD_TOKEN ?? '',
  ownerId: envId(processEnv, 'HERA_OWNER_ID'),
  guildId: envId(processEnv, 'DISCORD_GUILD_ID'),
  marketChannelId: envId(processEnv, 'STOCK_NEWS_CHANNEL_ID'),
  dbPath: process.env.DATABASE_PATH ?? 'data/hera.db',
  prefix: process.env.COMMAND_PREFIX || '!',
  currencySymbol: process.env.CURRENCY_SYMBOL ?? '\u{1FA99}',
  currencyName: process.env.CURRENCY_NAME ?? 'credits',
  embedColor: 0x2ecc71,
  errorColor: 0xe74c3c,
  runMarketOnStartup: envBool(processEnv, 'STOCK_RUN_ON_STARTUP', false),
  economy: economyDefaults,
  market: marketDefaults,
  trading: tradingDefaults,
  web: resolveWebConfig(processEnv),
};

export function validateConfig(): void {
  if (!config.token) {
    throw new Error(
      'DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.',
    );
  }
  if (!config.prefix.trim()) {
    throw new Error("COMMAND_PREFIX cannot be blank; leave it unset to use '!'.");
  }
}
