import { describe, expect, it } from "vitest";
import { formatUsdc, parseUsdc, usdc } from "./usdc";
import { classify, emptyState } from "./vault-store";

describe("usdc", () => {
  it("parses without floats", () => {
    expect(parseUsdc("0.1")).toBe(100000n);
    expect(parseUsdc("1.234,56")).toBe(1234560000n);
    expect(parseUsdc("abc")).toBeNull();
  });
  it("formats", () => {
    expect(formatUsdc(usdc(8600))).toBe("8,600.00 USDC");
  });
});

describe("classify", () => {
  const s = {
    ...emptyState(),
    balance: usdc(5000),
    writable: true,
    health: [],
    safe: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    recipients: [{ name: "Test", address: "0x1111111111111111111111111111111111111111" }],
  };
  const to = s.recipients[0]?.address ?? "0x1111111111111111111111111111111111111111";
  it("assigns lanes", () => {
    expect(classify(s, to, usdc(1)).lane).toBe("base");
    expect(classify(s, to, usdc(2)).lane).toBe("step-up");
    expect(classify(s, to, usdc(4)).lane).toBe("delayed");
    expect(classify(s, "0x" + "9".repeat(40), usdc(1)).lane).toBe("base");
    expect(classify({ ...s, frozen: true }, to, usdc(1)).lane).toBe("blocked");
  });
});
