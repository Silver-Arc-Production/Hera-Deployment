/**
 * Order execution, positions, portfolio valuation and risk checks.
 *
 * Conventions
 * -----------
 * * All cash movements go through :class:`EconomyService` so they are journalled
 *   in ``transactions``.
 * * Execution uses the *live* price from the engine plus slippage proportional to
 *   order size relative to average volume, so large orders visibly cost more.
 * * Shorts are tracked in ``short_positions`` separately from longs, with cash
 *   collateral posted on open and returned on cover.
 */
import type { TradingConfig } from '../config';
import type { Database } from '../database';
import {
  HeraError,
  InsufficientCollateral,
  InsufficientFunds,
  InsufficientShares,
  InvalidOrder,
  MarketHalted,
  UnknownSymbol,
} from '../errors';
import type { CompanyState } from '../market/engine';
import type { EconomyService } from './economy';
import type { MarketService } from './market';

/** Typical daily volume per company, used to size slippage. Expressed as a
 * fraction of shares outstanding so it scales with the float. */
const TURNOVER_FRACTION = 0.004;

export type OrderSide = 'buy' | 'sell' | 'short' | 'cover';

export class Position {
  constructor(
    public symbol: string,
    public quantity: number,
    public averageCost: number,
    public realizedPnl: number,
    public price = 0.0,
  ) {}

  get marketValue(): number {
    return this.quantity * this.price;
  }

  get costBasis(): number {
    return this.quantity * this.averageCost;
  }

  get unrealizedPnl(): number {
    return this.marketValue - this.costBasis;
  }

  get unrealizedPct(): number {
    if (this.costBasis === 0) return 0.0;
    return (this.unrealizedPnl / this.costBasis) * 100;
  }
}

export class ShortPosition {
  constructor(
    public symbol: string,
    public quantity: number,
    public averagePrice: number,
    public collateral: number,
    public realizedPnl: number,
    public price = 0.0,
  ) {}

  get marketValue(): number {
    return this.quantity * this.price;
  }

  /** Profit is the fall in price: we sold high and must buy back. */
  get unrealizedPnl(): number {
    return (this.averagePrice - this.price) * this.quantity;
  }

  get unrealizedPct(): number {
    if (this.averagePrice === 0) return 0.0;
    return ((this.averagePrice - this.price) / this.averagePrice) * 100;
  }
}

export interface Fill {
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  gross: number;
  commission: number;
  slippagePct: number;
  realizedPnl: number;
  message: string;
}

export class Portfolio {
  constructor(
    public wallet: number,
    public bank: number,
    public positions: Position[] = [],
    public shorts: ShortPosition[] = [],
  ) {}

  get longValue(): number {
    return this.positions.reduce((sum, p) => sum + p.marketValue, 0);
  }

  get shortValue(): number {
    return this.shorts.reduce((sum, s) => sum + s.marketValue, 0);
  }

  get collateral(): number {
    return this.shorts.reduce((sum, s) => sum + s.collateral, 0);
  }

  get unrealizedPnl(): number {
    return (
      this.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0) +
      this.shorts.reduce((sum, s) => sum + s.unrealizedPnl, 0)
    );
  }

  get realizedPnl(): number {
    return (
      this.positions.reduce((sum, p) => sum + p.realizedPnl, 0) +
      this.shorts.reduce((sum, s) => sum + s.realizedPnl, 0)
    );
  }

  /** Cash plus long value, less the cost to close shorts. */
  get netWorth(): number {
    return this.wallet + this.bank + this.longValue - this.shortValue;
  }
}

interface PositionRow {
  symbol: string;
  quantity: number;
  average_cost: number;
  realized_pnl: number;
}

interface ShortRow {
  symbol: string;
  quantity: number;
  average_price: number;
  collateral: number;
  realized_pnl: number;
}

export interface OrderRow {
  id: number;
  user_id: string;
  guild_id: string;
  symbol: string;
  side: string;
  quantity: number;
  limit_price: number;
  filled_quantity: number;
  status: string;
  created_tick: number;
  expires_tick: number | null;
}

export interface AlertRow {
  id: number;
  user_id: string;
  guild_id: string;
  symbol: string;
  direction: string;
  threshold: number;
  note: string | null;
}

export class TradingService {
  constructor(
    private readonly db: Database,
    private readonly economy: EconomyService,
    private readonly market: MarketService,
    public readonly config: TradingConfig,
  ) {}

  // ---------------------------------------------------------------- pricing

  private static averageDailyVolume(company: CompanyState): number {
    return Math.max(1_000.0, company.sharesOutstanding * TURNOVER_FRACTION);
  }

  /**
   * Return [price, slippageFraction] for an order of ``quantity`` shares.
   *
   * Slippage grows with the square root of order size relative to typical volume
   * -- the standard market-impact shape -- and is capped so an enormous order
   * cannot produce an absurd fill.
   */
  estimateExecutionPrice(
    company: CompanyState,
    quantity: number,
    side: 'buy' | 'sell',
  ): [number, number] {
    const adv = TradingService.averageDailyVolume(company);
    const ratio = Math.max(0.0, quantity / adv);
    const impact = Math.min(this.config.maxSlippage, this.config.slippageCoefficient * Math.sqrt(ratio));
    const direction = side === 'buy' ? 1.0 : -1.0;
    const price = company.price * (1 + direction * impact);
    return [Math.max(0.01, price), impact];
  }

  commissionFor(gross: number): number {
    const raw = gross * this.config.commissionRate;
    const rounded = Math.round(raw);
    return Math.trunc(Math.max(this.config.commissionMin, Math.min(this.config.commissionMax, rounded)));
  }

  // ------------------------------------------------------------------ reads

  getPosition(userId: string, guildId: string, symbol: string): Position | undefined {
    const row = this.db.fetchone<PositionRow>(
      'SELECT * FROM positions WHERE user_id = ? AND guild_id = ? AND symbol = ?',
      [userId, guildId, symbol.toUpperCase()],
    );
    if (!row || Number(row.quantity) <= 0) return undefined;
    const company = this.market.getCompany(guildId, symbol);
    return new Position(
      row.symbol,
      Number(row.quantity),
      Number(row.average_cost),
      Number(row.realized_pnl),
      company ? company.price : Number(row.average_cost),
    );
  }

  getShort(userId: string, guildId: string, symbol: string): ShortPosition | undefined {
    const row = this.db.fetchone<ShortRow>(
      'SELECT * FROM short_positions WHERE user_id = ? AND guild_id = ? AND symbol = ?',
      [userId, guildId, symbol.toUpperCase()],
    );
    if (!row || Number(row.quantity) <= 0) return undefined;
    const company = this.market.getCompany(guildId, symbol);
    return new ShortPosition(
      row.symbol,
      Number(row.quantity),
      Number(row.average_price),
      Number(row.collateral),
      Number(row.realized_pnl),
      company ? company.price : Number(row.average_price),
    );
  }

  getPortfolio(userId: string, guildId: string): Portfolio {
    const account = this.economy.getAccount(userId, guildId);
    const engine = this.market.getEngine(guildId);

    const rows = this.db.fetchall<PositionRow>(
      'SELECT * FROM positions WHERE user_id = ? AND guild_id = ? AND quantity > 0',
      [userId, guildId],
    );
    const positions = rows.map(
      (row) =>
        new Position(
          row.symbol,
          Number(row.quantity),
          Number(row.average_cost),
          Number(row.realized_pnl),
          engine.companies[row.symbol] ? engine.companies[row.symbol].price : Number(row.average_cost),
        ),
    );

    const shortRows = this.db.fetchall<ShortRow>(
      'SELECT * FROM short_positions WHERE user_id = ? AND guild_id = ? AND quantity > 0',
      [userId, guildId],
    );
    const shorts = shortRows.map(
      (row) =>
        new ShortPosition(
          row.symbol,
          Number(row.quantity),
          Number(row.average_price),
          Number(row.collateral),
          Number(row.realized_pnl),
          engine.companies[row.symbol] ? engine.companies[row.symbol].price : Number(row.average_price),
        ),
    );

    positions.sort((a, b) => b.marketValue - a.marketValue);
    shorts.sort((a, b) => b.marketValue - a.marketValue);
    return new Portfolio(account.wallet, account.bank, positions, shorts);
  }

  // ----------------------------------------------------------------- buying

  buy(userId: string, guildId: string, symbol: string, quantity: number): Fill {
    if (quantity <= 0) throw new InvalidOrder('Quantity must be a positive whole number.');
    const company = this.requireTradable(guildId, symbol);
    symbol = company.symbol;

    const [execPrice, slippage] = this.estimateExecutionPrice(company, quantity, 'buy');
    const gross = execPrice * quantity;
    const commission = this.commissionFor(gross);
    const total = Math.ceil(gross) + commission;

    const account = this.economy.getAccount(userId, guildId);
    if (account.wallet < total) throw new InsufficientFunds(total, account.wallet);

    this.economy.debit(userId, guildId, total, {
      kind: 'stock_buy',
      note: `Bought ${quantity.toLocaleString()} ${symbol} @ ${execPrice.toFixed(2)}`,
    });

    this.db.transaction(() => {
      const row = this.positionRow(userId, guildId, symbol);
      if (!row) {
        this.db.execute(
          'INSERT INTO positions (user_id, guild_id, symbol, quantity, average_cost) VALUES (?, ?, ?, ?, ?)',
          [userId, guildId, symbol, quantity, execPrice],
        );
      } else {
        const oldQty = Number(row.quantity);
        const oldCost = Number(row.average_cost);
        const newQty = oldQty + quantity;
        // Weighted average cost, so partial sells keep an honest basis.
        const newCost = (oldQty * oldCost + quantity * execPrice) / newQty;
        this.db.execute(
          `UPDATE positions SET quantity = ?, average_cost = ?, updated_at = unixepoch('subsec')
           WHERE user_id = ? AND guild_id = ? AND symbol = ?`,
          [newQty, newCost, userId, guildId, symbol],
        );
      }
    });

    return {
      symbol,
      side: 'buy',
      quantity,
      price: execPrice,
      gross,
      commission,
      slippagePct: slippage * 100,
      realizedPnl: 0,
      message: `Bought ${quantity.toLocaleString()} ${symbol} at ${execPrice.toFixed(2)}`,
    };
  }

  // ----------------------------------------------------------------- selling

  sell(userId: string, guildId: string, symbol: string, quantity: number): Fill {
    if (quantity <= 0) throw new InvalidOrder('Quantity must be a positive whole number.');
    const company = this.requireTradable(guildId, symbol);
    symbol = company.symbol;

    const position = this.getPosition(userId, guildId, symbol);
    if (!position || position.quantity < quantity) {
      throw new InsufficientShares(symbol, quantity, position ? position.quantity : 0);
    }

    const [execPrice, slippage] = this.estimateExecutionPrice(company, quantity, 'sell');
    const gross = execPrice * quantity;
    const commission = this.commissionFor(gross);
    const proceeds = Math.floor(gross) - commission;
    const realized = Math.round((execPrice - position.averageCost) * quantity) - commission;

    this.db.transaction(() => {
      const remaining = position.quantity - quantity;
      if (remaining === 0) {
        this.db.execute(
          `UPDATE positions SET quantity = 0, average_cost = 0,
              realized_pnl = realized_pnl + ?, updated_at = unixepoch('subsec')
           WHERE user_id = ? AND guild_id = ? AND symbol = ?`,
          [realized, userId, guildId, symbol],
        );
      } else {
        this.db.execute(
          `UPDATE positions SET quantity = ?, realized_pnl = realized_pnl + ?,
              updated_at = unixepoch('subsec')
           WHERE user_id = ? AND guild_id = ? AND symbol = ?`,
          [remaining, realized, userId, guildId, symbol],
        );
      }
    });

    this.economy.credit(userId, guildId, Math.max(0, proceeds), {
      kind: 'stock_sell',
      note: `Sold ${quantity.toLocaleString()} ${symbol} @ ${execPrice.toFixed(2)}`,
    });

    return {
      symbol,
      side: 'sell',
      quantity,
      price: execPrice,
      gross,
      commission,
      slippagePct: slippage * 100,
      realizedPnl: realized,
      message: `Sold ${quantity.toLocaleString()} ${symbol} at ${execPrice.toFixed(2)}`,
    };
  }

  // ------------------------------------------------------------------ shorts

  /** Cash posted when opening a short, at the configured coverage ratio. */
  requiredCollateral(company: CompanyState, quantity: number): number {
    return Math.ceil(company.price * quantity * this.config.minShortCollateralRatio);
  }

  short(userId: string, guildId: string, symbol: string, quantity: number): Fill {
    if (quantity <= 0) throw new InvalidOrder('Quantity must be a positive whole number.');
    const company = this.requireTradable(guildId, symbol);
    symbol = company.symbol;

    const collateral = this.requiredCollateral(company, quantity);
    const account = this.economy.getAccount(userId, guildId);
    if (account.wallet < collateral) throw new InsufficientCollateral(collateral, account.wallet);

    const [execPrice, slippage] = this.estimateExecutionPrice(company, quantity, 'sell');
    const commission = this.commissionFor(execPrice * quantity);

    this.economy.debit(userId, guildId, collateral + commission, {
      kind: 'short_open',
      note: `Collateral for ${quantity.toLocaleString()} ${symbol} short`,
    });

    this.db.transaction(() => {
      const row = this.shortRow(userId, guildId, symbol);
      if (!row) {
        this.db.execute(
          `INSERT INTO short_positions
              (user_id, guild_id, symbol, quantity, average_price, collateral, opened_tick)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, guildId, symbol, quantity, execPrice, collateral, this.currentTick(guildId)],
        );
      } else {
        const oldQty = Number(row.quantity);
        const oldPrice = Number(row.average_price);
        const newQty = oldQty + quantity;
        const newPrice = (oldQty * oldPrice + quantity * execPrice) / newQty;
        this.db.execute(
          `UPDATE short_positions SET quantity = ?, average_price = ?, collateral = collateral + ?,
              updated_at = unixepoch('subsec')
           WHERE user_id = ? AND guild_id = ? AND symbol = ?`,
          [newQty, newPrice, collateral, userId, guildId, symbol],
        );
      }
    });

    return {
      symbol,
      side: 'short',
      quantity,
      price: execPrice,
      gross: execPrice * quantity,
      commission,
      slippagePct: slippage * 100,
      realizedPnl: 0,
      message: `Shorted ${quantity.toLocaleString()} ${symbol} at ${execPrice.toFixed(2)} with ${collateral.toLocaleString()} collateral`,
    };
  }

  cover(userId: string, guildId: string, symbol: string, quantity: number): Fill {
    if (quantity <= 0) throw new InvalidOrder('Quantity must be a positive whole number.');
    const company = this.requireTradable(guildId, symbol);
    symbol = company.symbol;

    const short = this.getShort(userId, guildId, symbol);
    if (!short || short.quantity < quantity) {
      throw new InsufficientShares(symbol, quantity, short ? short.quantity : 0);
    }

    const [execPrice, slippage] = this.estimateExecutionPrice(company, quantity, 'buy');
    const gross = execPrice * quantity;
    const commission = this.commissionFor(gross);
    const realized = Math.round((short.averagePrice - execPrice) * quantity) - commission;

    // Release the proportional share of posted collateral.
    let released = Math.trunc(short.collateral * (quantity / short.quantity));
    if (quantity === short.quantity) released = short.collateral;

    this.db.transaction(() => {
      const remaining = short.quantity - quantity;
      if (remaining === 0) {
        this.db.execute(
          `UPDATE short_positions SET quantity = 0, average_price = 0, collateral = 0,
              realized_pnl = realized_pnl + ?, updated_at = unixepoch('subsec')
           WHERE user_id = ? AND guild_id = ? AND symbol = ?`,
          [realized, userId, guildId, symbol],
        );
      } else {
        this.db.execute(
          `UPDATE short_positions SET quantity = ?, collateral = collateral - ?,
              realized_pnl = realized_pnl + ?, updated_at = unixepoch('subsec')
           WHERE user_id = ? AND guild_id = ? AND symbol = ?`,
          [remaining, released, realized, userId, guildId, symbol],
        );
      }
    });

    // Collateral returns to the wallet; the P/L is settled from it.
    this.economy.credit(userId, guildId, Math.max(0, released + realized), {
      kind: 'short_cover',
      note: `Covered ${quantity.toLocaleString()} ${symbol} @ ${execPrice.toFixed(2)}`,
    });

    return {
      symbol,
      side: 'cover',
      quantity,
      price: execPrice,
      gross,
      commission,
      slippagePct: slippage * 100,
      realizedPnl: realized,
      message: `Covered ${quantity.toLocaleString()} ${symbol} at ${execPrice.toFixed(2)}`,
    };
  }

  // ------------------------------------------------------------------ orders

  /** Queue a limit order. Returns the order id. */
  placeLimitOrder(
    userId: string,
    guildId: string,
    symbol: string,
    side: string,
    quantity: number,
    limitPrice: number,
  ): number {
    if (quantity <= 0) throw new InvalidOrder('Quantity must be a positive whole number.');
    if (limitPrice <= 0) throw new InvalidOrder('Limit price must be greater than zero.');
    const normalizedSide = side.toLowerCase();
    if (!['buy', 'sell', 'short', 'cover'].includes(normalizedSide)) {
      throw new InvalidOrder('Side must be buy, sell, short or cover.');
    }
    const company = this.market.resolveSymbol(guildId, symbol);
    if (!company) throw new UnknownSymbol(symbol);

    const engine = this.market.getEngine(guildId);
    const tick = engine.tick;

    // Reserve buying power so a queued order cannot be spent twice.
    if (normalizedSide === 'buy' || normalizedSide === 'cover') {
      const reservation = Math.ceil(limitPrice * quantity * 1.05);
      const account = this.economy.getAccount(userId, guildId);
      if (account.wallet < reservation) throw new InsufficientFunds(reservation, account.wallet);
      this.economy.debit(userId, guildId, reservation, {
        kind: 'order_reserve',
        note: `Reserved for ${normalizedSide} ${quantity.toLocaleString()} ${company.symbol}`,
      });
    } else if (normalizedSide === 'sell') {
      const position = this.getPosition(userId, guildId, company.symbol);
      if (!position || position.quantity < quantity) {
        throw new InsufficientShares(company.symbol, quantity, position ? position.quantity : 0);
      }
    } else if (normalizedSide === 'short') {
      const collateral = this.requiredCollateral(company, quantity);
      const account = this.economy.getAccount(userId, guildId);
      if (account.wallet < collateral) throw new InsufficientCollateral(collateral, account.wallet);
      this.economy.debit(userId, guildId, collateral, {
        kind: 'order_reserve',
        note: `Reserved for short ${quantity.toLocaleString()} ${company.symbol}`,
      });
    }

    return this.db.transaction(() =>
      this.db.insert(
        `INSERT INTO orders
            (user_id, guild_id, symbol, side, quantity, limit_price, created_tick, expires_tick)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          guildId,
          company.symbol,
          normalizedSide,
          quantity,
          limitPrice,
          tick,
          tick + this.config.limitOrderExpiryTicks,
        ],
      ),
    );
  }

  /**
   * Fill any resting orders whose limit has been reached; expire the rest.
   *
   * Returns ``[userId, fill]`` pairs so the caller can notify the owners. A
   * resting order has already had its cash reserved. Before executing we hand the
   * reservation back, so the normal buy/short path sees the full wallet balance
   * and there is no double-charge.
   */
  processOpenOrders(guildId: string): [string, Fill][] {
    const engine = this.market.getEngine(guildId);
    const rows = this.openOrdersForGuild(guildId);
    const fills: [string, Fill][] = [];
    for (const row of rows) {
      const orderId = Number(row.id);
      const userId = String(row.user_id);
      const symbol = row.symbol;
      const side = row.side;
      const quantity = Number(row.quantity) - Number(row.filled_quantity);
      const limitPrice = Number(row.limit_price);
      const company = engine.companies[symbol];
      if (!company || quantity <= 0) {
        this.cancelOrderRow(orderId, 'cancelled', true);
        continue;
      }
      if (row.expires_tick && engine.tick > Number(row.expires_tick)) {
        this.cancelOrderRow(orderId, 'expired', true);
        continue;
      }
      if (company.haltedUntilTick > engine.tick) continue;

      // A buy fills when the market trades at or below the limit.
      const marketPrice = company.price;
      const triggered =
        side === 'buy' || side === 'cover' ? marketPrice <= limitPrice : marketPrice >= limitPrice;
      if (!triggered) continue;

      this.refundReservation(userId, guildId, symbol, side, limitPrice, quantity);
      let fill: Fill;
      try {
        if (side === 'buy') fill = this.buy(userId, guildId, symbol, quantity);
        else if (side === 'sell') fill = this.sell(userId, guildId, symbol, quantity);
        else if (side === 'short') fill = this.short(userId, guildId, symbol, quantity);
        else fill = this.cover(userId, guildId, symbol, quantity);
      } catch (error) {
        if (error instanceof HeraError) {
          // Funds withdrawn or position closed while the order rested.
          this.cancelOrderRow(orderId, 'cancelled', false);
          continue;
        }
        throw error;
      }

      this.db.execute(
        `UPDATE orders SET filled_quantity = quantity, average_fill = ?, status = 'filled',
            updated_at = unixepoch('subsec')
         WHERE id = ?`,
        [fill.price, orderId],
      );
      fills.push([userId, fill]);
    }
    return fills;
  }

  private openOrdersForGuild(guildId: string): OrderRow[] {
    return this.db.fetchall<OrderRow>(
      "SELECT * FROM orders WHERE guild_id = ? AND status = 'open' ORDER BY id",
      [guildId],
    );
  }

  /** Cash set aside when the order was placed (mirrors placeLimitOrder). */
  private reservationFor(side: string, limitPrice: number, quantity: number): number {
    if (side === 'short') {
      return Math.ceil(limitPrice * quantity * this.config.minShortCollateralRatio);
    }
    if (side === 'buy' || side === 'cover') return Math.ceil(limitPrice * quantity * 1.05);
    return 0;
  }

  private refundReservation(
    userId: string,
    guildId: string,
    symbol: string,
    side: string,
    limitPrice: number,
    quantity: number,
  ): void {
    const reserved = this.reservationFor(side, limitPrice, quantity);
    if (reserved <= 0) return;
    this.economy.credit(userId, guildId, reserved, {
      kind: 'order_refund',
      note: `Reservation released for ${symbol}`,
    });
  }

  private cancelOrderRow(orderId: number, status: string, refund: boolean): void {
    const row = this.db.fetchone<OrderRow>('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!row) return;
    this.db.execute("UPDATE orders SET status = ?, updated_at = unixepoch('subsec') WHERE id = ?", [
      status,
      orderId,
    ]);
    if (!refund) return;
    const quantity = Number(row.quantity) - Number(row.filled_quantity);
    if (quantity <= 0) return;
    this.refundReservation(
      String(row.user_id),
      String(row.guild_id),
      row.symbol,
      row.side,
      Number(row.limit_price),
      quantity,
    );
  }

  cancelOrder(userId: string, guildId: string, orderId: number): boolean {
    const row = this.db.fetchone<OrderRow>(
      'SELECT * FROM orders WHERE id = ? AND user_id = ? AND guild_id = ?',
      [orderId, userId, guildId],
    );
    if (!row || row.status !== 'open') return false;
    this.cancelOrderRow(orderId, 'cancelled', true);
    return true;
  }

  openOrders(userId: string, guildId: string): OrderRow[] {
    return this.db.fetchall<OrderRow>(
      "SELECT * FROM orders WHERE user_id = ? AND guild_id = ? AND status = 'open' ORDER BY id",
      [userId, guildId],
    );
  }

  // ------------------------------------------------------------------ alerts

  createAlert(
    userId: string,
    guildId: string,
    symbol: string,
    direction: string,
    threshold: number,
    note?: string | null,
  ): number {
    const normalized = direction.toLowerCase();
    if (normalized !== 'above' && normalized !== 'below') {
      throw new InvalidOrder("Direction must be 'above' or 'below'.");
    }
    const company = this.market.resolveSymbol(guildId, symbol);
    if (!company) throw new UnknownSymbol(symbol);
    return this.db.transaction(() =>
      this.db.insert(
        `INSERT INTO alerts (user_id, guild_id, symbol, direction, threshold, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, guildId, company.symbol, normalized, threshold, note ?? null],
      ),
    );
  }

  /** Find and deactivate alerts whose threshold has been crossed. */
  triggeredAlerts(guildId: string): AlertHit[] {
    const engine = this.market.getEngine(guildId);
    const rows = this.db.fetchall<AlertRow>(
      'SELECT * FROM alerts WHERE guild_id = ? AND active = 1',
      [guildId],
    );
    const hits: AlertHit[] = [];
    for (const row of rows) {
      const company = engine.companies[row.symbol];
      if (!company) continue;
      const price = company.price;
      const crossed =
        row.direction === 'above' ? price >= Number(row.threshold) : price <= Number(row.threshold);
      if (!crossed) continue;
      hits.push({
        id: Number(row.id),
        userId: String(row.user_id),
        symbol: row.symbol,
        direction: row.direction,
        threshold: Number(row.threshold),
        price,
        note: row.note,
      });
    }
    if (hits.length > 0) {
      this.db.executemany(
        'UPDATE alerts SET active = 0 WHERE id = ?',
        hits.map((hit) => [hit.id]),
      );
    }
    return hits;
  }

  listAlerts(userId: string, guildId: string): AlertRow[] {
    return this.db.fetchall<AlertRow>(
      'SELECT * FROM alerts WHERE user_id = ? AND guild_id = ? AND active = 1 ORDER BY id',
      [userId, guildId],
    );
  }

  deleteAlert(userId: string, guildId: string, alertId: number): boolean {
    const row = this.db.fetchone<{ id: number }>(
      'SELECT id FROM alerts WHERE id = ? AND user_id = ? AND guild_id = ? AND active = 1',
      [alertId, userId, guildId],
    );
    if (!row) return false;
    this.db.execute('UPDATE alerts SET active = 0 WHERE id = ?', [alertId]);
    return true;
  }

  // --------------------------------------------------------------- watchlist

  addWatch(userId: string, guildId: string, symbol: string): boolean {
    const company = this.market.resolveSymbol(guildId, symbol);
    if (!company) throw new UnknownSymbol(symbol);
    const existing = this.db.fetchone(
      'SELECT symbol FROM watchlists WHERE user_id = ? AND guild_id = ? AND symbol = ?',
      [userId, guildId, company.symbol],
    );
    if (existing) return false;
    this.db.execute('INSERT INTO watchlists (user_id, guild_id, symbol) VALUES (?, ?, ?)', [
      userId,
      guildId,
      company.symbol,
    ]);
    return true;
  }

  removeWatch(userId: string, guildId: string, symbol: string): boolean {
    const row = this.db.fetchone(
      'SELECT symbol FROM watchlists WHERE user_id = ? AND guild_id = ? AND symbol = ?',
      [userId, guildId, symbol.toUpperCase()],
    );
    if (!row) return false;
    this.db.execute('DELETE FROM watchlists WHERE user_id = ? AND guild_id = ? AND symbol = ?', [
      userId,
      guildId,
      symbol.toUpperCase(),
    ]);
    return true;
  }

  watchlist(userId: string, guildId: string): string[] {
    const rows = this.db.fetchall<{ symbol: string }>(
      'SELECT symbol FROM watchlists WHERE user_id = ? AND guild_id = ? ORDER BY symbol',
      [userId, guildId],
    );
    return rows.map((row) => row.symbol);
  }

  // --------------------------------------------------------------- risk/divs

  /** Pay per-share dividends to every long holder. Returns ``{userId: total}``. */
  applyDividends(guildId: string, dividends: Record<string, number>): Record<string, number> {
    const payouts: Record<string, number> = {};
    for (const [symbol, perShare] of Object.entries(dividends)) {
      const rows = this.db.fetchall<{ user_id: string; quantity: number }>(
        'SELECT user_id, quantity FROM positions WHERE guild_id = ? AND symbol = ? AND quantity > 0',
        [guildId, symbol],
      );
      for (const row of rows) {
        const amount = Number(row.quantity) * perShare;
        if (amount <= 0) continue;
        const userId = String(row.user_id);
        payouts[userId] = (payouts[userId] ?? 0) + amount;
        this.economy.credit(userId, guildId, Math.max(1, Math.trunc(amount)), {
          kind: 'dividend',
          note: `Dividend on ${Number(row.quantity).toLocaleString()} ${symbol}`,
        });
      }
    }
    return payouts;
  }

  /**
   * Flag shorts whose loss has eaten into the posted collateral.
   *
   * Returns the affected accounts so the caller can warn them. Positions are not
   * force-closed automatically -- the owner gets a warning first.
   */
  marginCalls(guildId: string): MarginCall[] {
    const engine = this.market.getEngine(guildId);
    const rows = this.db.fetchall<ShortRow & { user_id: string }>(
      'SELECT * FROM short_positions WHERE guild_id = ? AND quantity > 0',
      [guildId],
    );
    const calls: MarginCall[] = [];
    for (const row of rows) {
      const symbol = row.symbol;
      const company = engine.companies[symbol];
      if (!company) continue;
      const quantity = Number(row.quantity);
      const entry = Number(row.average_price);
      const collateral = Number(row.collateral);
      if (collateral <= 0) continue;
      const loss = (company.price - entry) * quantity;
      if (loss <= 0) continue;
      if (loss >= collateral * this.config.marginCallRatio) {
        calls.push({
          userId: String(row.user_id),
          symbol,
          quantity,
          entry,
          price: company.price,
          collateral,
          loss,
        });
      }
    }
    return calls;
  }

  /** Rank members by portfolio net worth (cash + longs - short liability). */
  leaderboard(guildId: string, limit = 10): { userId: string; netWorth: number }[] {
    const engine = this.market.getEngine(guildId);
    const accounts = this.db.fetchall<{ user_id: string; wallet: number; bank: number }>(
      'SELECT user_id, wallet, bank FROM accounts WHERE guild_id = ?',
      [guildId],
    );
    const positions = this.db.fetchall<{ user_id: string; symbol: string; quantity: number }>(
      'SELECT user_id, symbol, quantity FROM positions WHERE guild_id = ? AND quantity > 0',
      [guildId],
    );
    const shorts = this.db.fetchall<{ user_id: string; symbol: string; quantity: number }>(
      'SELECT user_id, symbol, quantity FROM short_positions WHERE guild_id = ? AND quantity > 0',
      [guildId],
    );

    const net = new Map<string, number>();
    for (const row of accounts) {
      net.set(String(row.user_id), Number(row.wallet) + Number(row.bank));
    }
    for (const row of positions) {
      const company = engine.companies[row.symbol];
      if (!company) continue;
      const userId = String(row.user_id);
      net.set(userId, (net.get(userId) ?? 0) + company.price * Number(row.quantity));
    }
    for (const row of shorts) {
      const company = engine.companies[row.symbol];
      if (!company) continue;
      const userId = String(row.user_id);
      net.set(userId, (net.get(userId) ?? 0) - company.price * Number(row.quantity));
    }

    return [...net.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([userId, netWorth]) => ({ userId, netWorth }));
  }

  // -------------------------------------------------------------- internals

  private requireTradable(guildId: string, symbol: string): CompanyState {
    const company = this.market.resolveSymbol(guildId, symbol);
    if (!company) throw new UnknownSymbol(symbol);
    const engine = this.market.getEngine(guildId);
    if (company.haltedUntilTick > engine.tick) throw new MarketHalted(company.symbol);
    return company;
  }

  private currentTick(guildId: string): number {
    return this.market.getEngine(guildId).tick;
  }

  private positionRow(userId: string, guildId: string, symbol: string): PositionRow | undefined {
    return this.db.fetchone<PositionRow>(
      'SELECT * FROM positions WHERE user_id = ? AND guild_id = ? AND symbol = ?',
      [userId, guildId, symbol],
    );
  }

  private shortRow(userId: string, guildId: string, symbol: string): ShortRow | undefined {
    return this.db.fetchone<ShortRow>(
      'SELECT * FROM short_positions WHERE user_id = ? AND guild_id = ? AND symbol = ?',
      [userId, guildId, symbol],
    );
  }
}

export interface AlertHit {
  id: number;
  userId: string;
  symbol: string;
  direction: string;
  threshold: number;
  price: number;
  note: string | null;
}

export interface MarginCall {
  userId: string;
  symbol: string;
  quantity: number;
  entry: number;
  price: number;
  collateral: number;
  loss: number;
}
