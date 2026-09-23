/** Domain errors that map cleanly onto user-facing messages. */
export class HeraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InsufficientFunds extends HeraError {
  constructor(
    public readonly needed: number,
    public readonly available: number,
  ) {
    super(`needs ${needed.toLocaleString()}, only ${available.toLocaleString()} available`);
  }
}

export class InsufficientShares extends HeraError {
  constructor(
    public readonly symbol: string,
    public readonly needed: number,
    public readonly available: number,
  ) {
    super(
      `needs ${needed.toLocaleString()} ${symbol}, only ${available.toLocaleString()} held`,
    );
  }
}

export class InsufficientCollateral extends HeraError {
  constructor(
    public readonly needed: number,
    public readonly available: number,
  ) {
    super(
      `needs ${needed.toLocaleString()} collateral, only ${available.toLocaleString()} available`,
    );
  }
}

export class UnknownSymbol extends HeraError {
  constructor(public readonly symbol: string) {
    super(`unknown symbol ${symbol}`);
  }
}

export class BankFull extends HeraError {
  constructor(public readonly capacity: number) {
    super(`bank capacity of ${capacity.toLocaleString()} reached`);
  }
}

export class CooldownActive extends HeraError {
  constructor(public readonly secondsRemaining: number) {
    super(`on cooldown for ${Math.round(secondsRemaining)}s`);
  }
}

/** Raised when an order request is malformed or not executable. */
export class InvalidOrder extends HeraError {}

/** Raised when a wager is below the floor of the player's current gambling level. */
export class BetTooSmall extends HeraError {
  constructor(
    public readonly minimum: number,
    public readonly levelName: string,
  ) {
    super(`the ${levelName} table has a minimum bet of ${minimum.toLocaleString()}`);
  }
}

/** Raised when a wager exceeds the ceiling of the player's current gambling level. */
export class BetTooLarge extends HeraError {
  constructor(
    public readonly maximum: number,
    public readonly levelName: string,
  ) {
    super(`the ${levelName} table caps bets at ${maximum.toLocaleString()}`);
  }
}

/** Raised when a bet request is malformed (non-positive, or not a whole number). */
export class InvalidBet extends HeraError {}
