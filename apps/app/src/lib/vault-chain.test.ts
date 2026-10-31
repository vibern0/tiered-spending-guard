import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import { readVaultSnapshot, validateUsdc, type VaultConfig } from "./vault-chain";
import { TEST_USDC_ADDRESS, TEST_USDC_RUNTIME } from "./usdc-test-fixture";

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const GUARD = "0x2222222222222222222222222222222222222222" as Address;
const DELAY = "0x3333333333333333333333333333333333333333" as Address;
const USDC = TEST_USDC_ADDRESS;

function client(overrides: Record<string, unknown> = {}): PublicClient {
  return {
    getChainId: vi.fn().mockResolvedValue(11155111),
    getBytecode: vi.fn().mockResolvedValue(TEST_USDC_RUNTIME),
    getBalance: vi.fn().mockResolvedValue(2_000_000_000_000_000n),
    getTransactionCount: vi.fn().mockResolvedValue(7),
    getStorageAt: vi.fn().mockImplementation(async ({ slot }: { slot: string }) => {
      if (slot.endsWith("c34c8") || slot.endsWith("9947"))
        return `0x${GUARD.slice(2).padStart(64, "0")}`;
      return "0x0000000000000000000000000000000000000000000000000000000000000000";
    }),
    readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
      const values: Record<string, unknown> = {
        name: "USDC",
        symbol: "USDC",
        decimals: 6,
        balanceOf: 12_345_678n,
        nonce: 7n,
        getGuard: GUARD,
        getModuleGuard: GUARD,
        getModulesPaginated: [[DELAY], "0x0000000000000000000000000000000000000001"],
        fallbackHandler: "0x0000000000000000000000000000000000000000",
        config: [
          SAFE,
          "0x5555555555555555555555555555555555555555",
          "0x6666666666666666666666666666666666666666",
          DELAY,
          86400n,
          0n,
        ],
        getConfiguredTokens: [USDC],
        assetPolicy: [100_000_000n, 200_000_000n, 250_000_000n, 1_000_000_000n],
        getPolicyRecipients: ["0x7777777777777777777777777777777777777777"],
        spendState: [0n, 0n, 0n],
        owner: SAFE,
        avatar: SAFE,
        target: SAFE,
        txCooldown: 120n,
        txExpiration: 600n,
        txNonce: 0n,
        queueNonce: 0n,
      };
      return values[functionName];
    }),
    getLogs: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as PublicClient;
}

const config: VaultConfig = {
  chainId: 11155111,
  safe: SAFE,
  guard: GUARD,
  delay: DELAY,
  usdc: USDC,
  usdcCandidates: [USDC],
};

describe("validateUsdc", () => {
  it("accepts Sepolia USDC only when runtime code and metadata match", async () => {
    await expect(validateUsdc(client(), USDC)).resolves.toMatchObject({
      address: USDC,
      symbol: "USDC",
      decimals: 6,
    });
  });

  it("rejects wrong symbol or decimals as a blocking health failure", async () => {
    const invalid = client({
      readContract: vi
        .fn()
        .mockImplementation(async ({ functionName }: { functionName: string }) => {
          if (functionName === "name") return "Not USDC";
          if (functionName === "symbol") return "NOPE";
          if (functionName === "decimals") return 18;
          return undefined;
        }),
    });

    await expect(validateUsdc(invalid, USDC)).rejects.toMatchObject({
      code: "usdc-metadata-mismatch",
      blocking: true,
    });
  });

  it("rejects runtime bytecode that differs from the reviewed two-provider artifact", async () => {
    await expect(
      validateUsdc(client({ getBytecode: vi.fn().mockResolvedValue("0x6001600155") }), USDC),
    ).rejects.toMatchObject({
      code: "usdc-runtime-mismatch",
      blocking: true,
    });
  });
});

describe("readVaultSnapshot", () => {
  it("returns a writable chain-derived snapshot for a healthy fresh vault", async () => {
    const snapshot = await readVaultSnapshot(client(), config);

    expect(snapshot.writable).toBe(true);
    expect(snapshot.health).toEqual([]);
    expect(snapshot.safeNonce).toBe(7n);
    expect(snapshot.usdcBalance).toBe(12_345_678n);
    if (!snapshot.topology || !snapshot.policy) throw new Error("healthy snapshot is incomplete");
    expect(snapshot.topology).toMatchObject({
      guard: GUARD,
      moduleGuard: GUARD,
      delay: { address: DELAY },
    });
    expect(snapshot.topology.modules).toEqual([DELAY]);
    expect(snapshot.policy.baseDailyLimit).toBe(250_000_000n);
  });

  it("blocks writes on the wrong chain", async () => {
    const snapshot = await readVaultSnapshot(
      client({ getChainId: vi.fn().mockResolvedValue(1) }),
      config,
    );

    expect(snapshot.writable).toBe(false);
    expect(snapshot.health).toEqual([
      expect.objectContaining({ code: "wrong-chain", blocking: true }),
    ]);
    expect(snapshot.usdcBalance).toBeUndefined();
  });

  it("blocks writes when USDC has no runtime bytecode", async () => {
    const snapshot = await readVaultSnapshot(
      client({ getBytecode: vi.fn().mockResolvedValue(undefined) }),
      config,
    );

    expect(snapshot.writable).toBe(false);
    expect(snapshot.health).toEqual([
      expect.objectContaining({ code: "usdc-runtime-missing", blocking: true }),
    ]);
    expect(snapshot.usdcBalance).toBeUndefined();
  });
});
