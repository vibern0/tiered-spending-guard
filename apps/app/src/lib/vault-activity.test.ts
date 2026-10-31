import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  projectAlerts,
  projectVaultActivity,
  prepareRecipientPolicyRepair,
  type VaultActivityLog,
} from "./vault-activity";
import type { VaultSnapshot } from "./vault-chain";

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const GUARD = "0x2222222222222222222222222222222222222222" as Address;
const DELAY = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x4444444444444444444444444444444444444444" as Address;
const RECIPIENT = "0x5555555555555555555555555555555555555555" as Address;
const TX = `0x${"aa".repeat(32)}` as Hex;

const snapshot: VaultSnapshot = {
  chainId: 11155111,
  safe: SAFE,
  usdc: { address: USDC, runtimeCodeHash: TX, name: "USDC", symbol: "USDC", decimals: 6 },
  usdcBalance: 100000000n,
  safeNonce: 4n,
  nativeBalance: 1n,
  topology: {
    guard: GUARD,
    moduleGuard: GUARD,
    modules: [DELAY],
    fallbackHandler: "0x0000000000000000000000000000000000000000",
    delay: {
      address: DELAY,
      owner: SAFE,
      avatar: SAFE,
      target: SAFE,
      cooldownSeconds: 120n,
      expirationSeconds: 600n,
    },
    frozen: false,
  },
  policy: {
    token: USDC,
    basePerTransaction: 100000000n,
    stepUpPerTransaction: 200000000n,
    baseDailyLimit: 250000000n,
    instantDailyLimit: 1000000000n,
    recipients: [],
  },
  spendState: { window: 0n, baseSpent: 0n, instantSpent: 900000000n },
  queueItems: [
    {
      queueNonce: 1n,
      txHash: TX,
      createdAt: 1n,
      to: RECIPIENT,
      value: 0n,
      data: "0x",
      operation: 0,
      status: "pending",
    },
  ],
  health: [],
  writable: true,
};

describe("vault activity and policy boundaries", () => {
  it("projects verified guard and Delay logs and deduplicates transaction/log identity", () => {
    const logs: VaultActivityLog[] = [
      {
        address: GUARD,
        eventName: "TransferAuthorized",
        transactionHash: TX,
        logIndex: 0,
        blockTimestamp: 100,
        args: { tier: 1, token: USDC, recipient: RECIPIENT, amount: 200000000n },
      },
      {
        address: GUARD,
        eventName: "TransferAuthorized",
        transactionHash: TX,
        logIndex: 0,
        blockTimestamp: 100,
        args: { tier: 1, token: USDC, recipient: RECIPIENT, amount: 200000000n },
      },
      {
        address: DELAY,
        eventName: "TransactionAdded",
        transactionHash: `0x${"bb".repeat(32)}`,
        logIndex: 1,
        blockTimestamp: 100,
        args: {
          queueNonce: 2n,
          txHash: `0x${"cc".repeat(32)}`,
          to: RECIPIENT,
          value: 0n,
          data: "0x",
          operation: 0,
        },
      },
    ];

    const items = projectVaultActivity(logs, snapshot, 100_000);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      lane: "step-up",
      status: "executed",
      amount: 200000000n,
      txHash: TX,
    });
    expect(items[1]).toMatchObject({ lane: "delayed", status: "queued", counterparty: RECIPIENT });
  });

  it("turns topology, near-limit, and queue state into read-only alerts", () => {
    expect(projectAlerts(snapshot).map((alert) => alert.code)).toEqual(
      expect.arrayContaining(["near-instant-limit", "queued-delay"]),
    );
    expect(
      projectAlerts({
        ...snapshot,
        health: [{ code: "guard-drift", message: "guard changed", blocking: true }],
      }).map((alert) => alert.code),
    ).toContain("guard-drift");
  });

  it("uses canonical snapshot time instead of a later device clock", () => {
    const [item] = projectVaultActivity(
      [
        {
          address: DELAY,
          eventName: "TransactionAdded",
          transactionHash: TX,
          logIndex: 1,
          blockTimestamp: 100,
          args: { queueNonce: 2n, txHash: TX, to: RECIPIENT, value: 0n },
        },
      ],
      { ...snapshot, observedTimestamp: 150n },
      999_999_999,
    );
    expect(item).toMatchObject({ status: "queued", canonicalNow: 150_000 });
  });

  it("creates a delayed guard-policy repair request for an unlisted recipient", async () => {
    const repair = await prepareRecipientPolicyRepair({ snapshot, recipient: RECIPIENT });
    expect(repair.transaction.to).toBe(DELAY);
    expect(repair.transaction.value).toBe(0n);
    expect(repair.transaction.data.slice(0, 10)).not.toBe("0x");
    await expect(
      prepareRecipientPolicyRepair({
        snapshot: {
          ...snapshot,
          policy: {
            token: USDC,
            basePerTransaction: 100000000n,
            stepUpPerTransaction: 200000000n,
            baseDailyLimit: 250000000n,
            instantDailyLimit: 1000000000n,
            recipients: [RECIPIENT],
          },
        },
        recipient: RECIPIENT,
      }),
    ).rejects.toThrow(/already/i);
  });
});
