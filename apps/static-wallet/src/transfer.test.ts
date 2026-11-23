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
  it("fills the one-passkey threshold with all instant spending", () => {
    const first = tokenAmount("1");
    const second = tokenAmount("9.1");
    const afterFirst = dailyUsage([0n, first, first], 1n);
    expect(afterFirst).toEqual({ onePasskey: first, combined: first });
    expect(transferTier(second, afterFirst)).toBe("step-up");
    const afterSecond = dailyUsage([0n, first, first + second], 1n);
    expect(afterSecond).toEqual({
      onePasskey: X,
      combined: tokenAmount("10.1"),
    });
    expect(transferTier(1n, afterSecond)).toBe("step-up");
    expect(transferTier(tokenAmount("19.9"), afterSecond)).toBe("step-up");
    expect(transferTier(tokenAmount("19.9") + 1n, afterSecond)).toBe("delayed");
    expect(dailyUsage([0n, first, first + second], 86400n)).toEqual({
      onePasskey: 0n,
      combined: 0n,
    });
  });
  it("honors the shared daily limit and resets at the contract's day boundary", () => {
    expect(transferTier(X, { combined: 0n })).toBe("base");
    expect(transferTier(1n, { combined: X })).toBe("step-up");
    expect(transferTier(1n, { combined: Y })).toBe("delayed");
    expect(transferTier(Y, { combined: 0n })).toBe("step-up");
    expect(transferTier(1n, dailyUsage([0n, X, Y], 86400n))).toBe("base");
  });
});
