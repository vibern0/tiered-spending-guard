import { describe, expect, it } from "vitest";
import { dailyUsage, transferTier, tokenAmount, X, Y } from "./transfer";

describe("GLD transfer review", () => {
  it("accepts exact positive token units", () => {
    expect(tokenAmount("1.000000000000000001")).toBe(10n ** 18n + 1n);
    for (const text of [
      "0",
      "-1",
      "1e3",
      "1.0000000000000000001",
      "0x20",
      "",
    ]) {
      expect(() => tokenAmount(text)).toThrow();
    }
  });
  it("honors the shared daily limit and resets at the contract's day boundary", () => {
    expect(transferTier(X, { base: 0n, combined: 0n })).toBe("base");
    expect(transferTier(1n, { base: X, combined: X })).toBe("step-up");
    expect(transferTier(1n, { base: 0n, combined: Y })).toBe("delayed");
    expect(transferTier(Y, { base: 0n, combined: 0n })).toBe("step-up");
    expect(transferTier(1n, dailyUsage([0n, X, Y], 86400n))).toBe("base");
  });
});
