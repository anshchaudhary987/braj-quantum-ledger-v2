import { VoucherStrategy } from "./voucher-strategy.js";
import { PaymentVoucherStrategy } from "./payment-voucher.js";
import { ReceiptVoucherStrategy } from "./receipt-voucher.js";
import { UnknownVoucherTypeError } from "../errors.js";

/**
 * Factory — registers all known voucher strategies and resolves
 * the correct implementation at runtime based on voucher_type.
 */
export class VoucherFactory {
  private static readonly strategies: Map<string, VoucherStrategy> = new Map();

  static {
    const payment = new PaymentVoucherStrategy();
    const receipt = new ReceiptVoucherStrategy();

    VoucherFactory.strategies.set(payment.voucherType, payment);
    VoucherFactory.strategies.set(receipt.voucherType, receipt);
  }

  static register(strategy: VoucherStrategy): void {
    VoucherFactory.strategies.set(strategy.voucherType, strategy);
  }

  static resolve(voucherType: string): VoucherStrategy {
    const strategy = VoucherFactory.strategies.get(voucherType);
    if (!strategy) {
      throw new UnknownVoucherTypeError(voucherType);
    }
    return strategy;
  }
}
