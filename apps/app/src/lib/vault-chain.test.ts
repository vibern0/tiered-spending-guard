import { describe, expect, it, vi } from "vitest";
import {
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { readVaultSnapshot, validateUsdc, type VaultConfig } from "./vault-chain";
import { TEST_USDC_ADDRESS, TEST_USDC_RUNTIME } from "./usdc-test-fixture";
import { HISTORICAL_GUARD_RUNTIME, decodeHistoricalPolicy } from "./historical-guard-test-fixture";

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const GUARD = "0x2222222222222222222222222222222222222222" as Address;
const DELAY = "0x3333333333333333333333333333333333333333" as Address;
const USDC = TEST_USDC_ADDRESS;

function client(overrides: Record<string, unknown> = {}): PublicClient {
  return {
    getChainId: vi.fn().mockResolvedValue(11155111),
    getBlockNumber: vi.fn().mockResolvedValue(123n),
    getBlock: vi.fn().mockResolvedValue({ hash: `0x${"ab".repeat(32)}`, timestamp: 456n }),
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
        assetPolicy: [100_000_000n, 200_000_000n, 250_000_000n, 1_000_000_000n, 1],
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
  it("decodes the pinned historical guard's four-word policy and preserves a read-only snapshot", async () => {
    expect(keccak256(HISTORICAL_GUARD_RUNTIME)).toBe(
      "0x596a66022b0aa360ed7faa0ba2fa550480f6b750a3ccc44da125ff14eff38428",
    );
    const historical = client({
      getBytecode: vi.fn(async ({ address }: { address: Address }) =>
        address === GUARD ? HISTORICAL_GUARD_RUNTIME : TEST_USDC_RUNTIME,
      ),
    });
    const baseRead = vi.mocked(historical.readContract).getMockImplementation()!;
    vi.mocked(historical.readContract).mockImplementation(async (input) =>
      input.functionName === "assetPolicy"
        ? (decodeHistoricalPolicy(input.abi) as never)
        : baseRead(input),
    );

    const snapshot = await readVaultSnapshot(historical, config);

    expect(snapshot).toMatchObject({
      writable: false,
      health: [],
      usdcBalance: 12_345_678n,
      safeNonce: 7n,
      observedBlock: 123n,
      compatibility: { mode: "read-only", profileVersion: "sepolia-pwa-phase-one-allowlisted-v1" },
    });
    expect(snapshot.policy).toMatchObject({
      baseRecipientMode: "allowlisted",
      baseDailyLimit: 250_000_000n,
      recipients: ["0x7777777777777777777777777777777777777777"],
    });
    expect(historical.getBytecode).toHaveBeenCalledWith({ address: GUARD, blockNumber: 123n });
  });

  it("does not retry an unknown guard's truncated modern policy as a historical policy", async () => {
    const unknown = client();
    const baseRead = vi.mocked(unknown.readContract).getMockImplementation()!;
    vi.mocked(unknown.readContract).mockImplementation(async (input) =>
      input.functionName === "assetPolicy"
        ? (decodeHistoricalPolicy(input.abi) as never)
        : baseRead(input),
    );
    const snapshot = await readVaultSnapshot(unknown, config);
    expect(snapshot.writable).toBe(false);
    expect(snapshot.compatibility).toBeUndefined();
    expect(snapshot.policy).toBeUndefined();
    expect(snapshot.health).toEqual([
      expect.objectContaining({ code: "rpc-inconsistent", blocking: true }),
    ]);
  });

  it("retains real topology failures when displaying the recognized historical version", async () => {
    const historical = client({
      getBytecode: vi.fn(async ({ address }: { address: Address }) =>
        address === GUARD ? HISTORICAL_GUARD_RUNTIME : TEST_USDC_RUNTIME,
      ),
      getStorageAt: vi.fn(async () => `0x${"0".repeat(64)}`),
    });
    const baseRead = vi.mocked(historical.readContract).getMockImplementation()!;
    vi.mocked(historical.readContract).mockImplementation(async (input) =>
      input.functionName === "assetPolicy"
        ? (decodeHistoricalPolicy(input.abi) as never)
        : baseRead(input),
    );
    const snapshot = await readVaultSnapshot(historical, config);
    expect(snapshot.policy?.baseRecipientMode).toBe("allowlisted");
    expect(snapshot.writable).toBe(false);
    expect(snapshot.health.map((f) => f.code)).toEqual(
      expect.arrayContaining(["guard-drift", "module-guard-drift"]),
    );
  });

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

  it("pins every mutable read to one block and rejects a block-hash change", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    const pinned = client({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      getBlock: vi.fn().mockResolvedValue({ hash, timestamp: 456n }),
    });

    const snapshot = await readVaultSnapshot(pinned, config);

    expect(snapshot).toMatchObject({
      writable: true,
      observedBlock: 123n,
      observedTimestamp: 456n,
    });
    for (const [input] of vi.mocked(pinned.readContract).mock.calls)
      expect(input).toMatchObject({ blockNumber: 123n });
    expect(pinned.getBytecode).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 123n }));
    expect(pinned.getBalance).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 123n }));
    for (const [input] of vi.mocked(pinned.getStorageAt).mock.calls)
      expect(input).toMatchObject({ blockNumber: 123n });

    const changed = client({
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      getBlock: vi
        .fn()
        .mockResolvedValueOnce({ hash, timestamp: 456n })
        .mockResolvedValueOnce({ hash: `0x${"cd".repeat(32)}`, timestamp: 456n }),
    });
    await expect(readVaultSnapshot(changed, config)).resolves.toMatchObject({
      writable: false,
      health: [expect.objectContaining({ code: "rpc-inconsistent" })],
    });
  });

  it("reconstructs each pending Delay tuple from its canonical indexed event", async () => {
    const recipient = "0x7777777777777777777777777777777777777777" as Address;
    const data = encodeFunctionData({
      abi: parseAbi(["function transfer(address,uint256) returns (bool)"]),
      functionName: "transfer",
      args: [recipient, 4_000_000n],
    });
    const txHash = keccak256(
      encodePacked(["address", "uint256", "bytes", "uint8"], [USDC, 0n, data, 0]),
    );
    const queued = client();
    const baseRead = vi.mocked(queued.readContract).getMockImplementation();
    if (!baseRead) throw new Error("test reader is missing its base implementation");
    vi.mocked(queued.readContract).mockImplementation(async (input) => {
      if (input.functionName === "queueNonce") return 1n as never;
      if (input.functionName === "getTxHash") return txHash as never;
      if (input.functionName === "getTxCreatedAt") return 100n as never;
      return baseRead(input) as never;
    });
    vi.mocked(queued.getLogs).mockResolvedValue([
      { args: { queueNonce: 0n, txHash, to: USDC, value: 0n, data, operation: 0 } },
    ] as never);

    const snapshot = await readVaultSnapshot(queued, { ...config, fromBlock: 100n });

    expect(snapshot.queueItems).toEqual([
      {
        queueNonce: 0n,
        txHash,
        createdAt: 100n,
        to: USDC,
        value: 0n,
        data,
        operation: 0,
        status: "pending",
      },
    ]);
  });

  it("fails closed when the verified Delay scan boundary is in the future", async () => {
    const snapshot = await readVaultSnapshot(client(), { ...config, fromBlock: 124n });

    expect(snapshot).toMatchObject({
      writable: false,
      health: [expect.objectContaining({ code: "rpc-inconsistent" })],
    });
  });

  it("redacts RPC endpoint credentials from chain-read health failures", async () => {
    const snapshot = await readVaultSnapshot(
      client({
        getBlockNumber: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "HTTP request failed. Status: 429 URL: https://sepolia.infura.io/v3/private-project-id",
            ),
          ),
      }),
      config,
    );

    expect(snapshot.health[0]?.message).toContain("Status: 429");
    expect(snapshot.health[0]?.message).toContain("[redacted]");
    expect(snapshot.health[0]?.message).not.toContain("private-project-id");
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
