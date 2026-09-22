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
