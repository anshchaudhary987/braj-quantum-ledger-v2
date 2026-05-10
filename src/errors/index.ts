export class DoubleEntryError extends Error {
  constructor(
    message: string,
    public readonly transactionId?: number
  ) {
    super(message);
    this.name = "DoubleEntryError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(
    message: string,
    public readonly existingTransactionId?: number
  ) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class InsufficientBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientBalanceError";
  }
}

export class UnknownVoucherTypeError extends Error {
  constructor(voucherType: string) {
    super(`Unknown voucher type: ${voucherType}`);
    this.name = "UnknownVoucherTypeError";
  }
}