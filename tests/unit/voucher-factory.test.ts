import { describe, it, expect } from "vitest";
import { VoucherFactory } from "../../src/vouchers/voucher-factory";
import { PaymentVoucherStrategy } from "../../src/vouchers/payment-voucher";
import { ReceiptVoucherStrategy } from "../../src/vouchers/receipt-voucher";
import { UnknownVoucherTypeError } from "../../src/errors";

describe("VoucherFactory", () => {
  it("resolves a registered voucher type", () => {
    const paymentStrategy = VoucherFactory.resolve("PAYMENT_VOUCHER");
    expect(paymentStrategy).toBeDefined();
    expect(paymentStrategy.voucherType).toBe("PAYMENT_VOUCHER");

    const receiptStrategy = VoucherFactory.resolve("RECEIPT_VOUCHER");
    expect(receiptStrategy).toBeDefined();
    expect(receiptStrategy.voucherType).toBe("RECEIPT_VOUCHER");
  });

  it("throws UnknownVoucherTypeError for unregistered types", () => {
    expect(() => VoucherFactory.resolve("NONEXISTENT")).toThrow(UnknownVoucherTypeError);
  });

  it("allows registering new strategies at runtime", () => {
    const mockStrategy = { voucherType: "MOCK_VOUCHER" } as any;
    VoucherFactory.register(mockStrategy);
    expect(() => VoucherFactory.resolve("MOCK_VOUCHER")).not.toThrow();
  });
});
