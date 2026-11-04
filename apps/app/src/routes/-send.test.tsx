import { describe, expect, it } from "vitest";
import { usdc } from "@/lib/usdc";
import { classify, emptyState } from "@/lib/vault-store";

const RECIPIENT = "0x1111111111111111111111111111111111111111";

describe("send policy boundary", () => {
  it("never offers a send lane for an unprovisioned or unhealthy vault", () => {
    const state = {
      ...emptyState(),
      balance: usdc(100),
      recipients: [{ name: "Test", address: RECIPIENT }],
    };
    expect(classify(state, RECIPIENT, usdc(1))).toMatchObject({ lane: "blocked" });
  });

  it("allows any valid recipient in the base lane but keeps elevated lanes allowlisted", () => {
    const state = {
      ...emptyState(),
      writable: true,
      health: [],
      safe: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      balance: usdc(1000),
      recipients: [{ name: "Test", address: RECIPIENT }],
    };
    expect(classify(state, RECIPIENT, usdc(1))).toMatchObject({ lane: "base" });
    expect(classify(state, RECIPIENT, usdc(2))).toMatchObject({ lane: "step-up" });
    expect(classify(state, RECIPIENT, usdc(4))).toMatchObject({ lane: "delayed" });
    expect(classify(state, "0x2222222222222222222222222222222222222222", usdc(1))).toMatchObject({ lane: "base" });
    expect(classify(state, "0x2222222222222222222222222222222222222222", usdc(2))).toMatchObject({ lane: "blocked" });
  });
});
