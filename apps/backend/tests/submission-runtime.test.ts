import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePacked, keccak256, type Address, type Hex } from "viem";
import type { BackendVaultRecord } from "../src/handlers";
import { loadBackendConfig } from "../src/config";

// Unit boundary only: the separate EVM integration suite uses original branded proofs.
const f = vi.hoisted(() => ({ prepare: vi.fn(), snapshot: {} as any, policy: {} as any }));
vi.mock("@tiered-spending-guard/security-core/pwa", async (original) => {
  const actual = await original<any>();
  const core = actual.default ?? actual;
  return {
    ...core,
    default: undefined,
    verifyPwaSubmissionState: async ({ vault }: any) => ({
      vault,
      policy: f.policy,
      deployments: {},
      topologyReportHash: `0x${"ab".repeat(32)}`,
    }),
    captureVerifiedPwaSnapshot: async () => f.snapshot,
    preparePwaIntent: (snapshot: any, intent: any) => {
      f.prepare(intent);
      return {
        ...snapshot,
        kind: "base-transfer",
        requiredApprovals: ["primary"],
        recipient: intent.recipient,
        amount: intent.amount,
      };
    },
    simulatePwaIntent: async () => ({ ok: true }),
  };
});
import {
  createSubmissionReadClient,
  createSubmissionRuntimeForTestsOnly,
} from "../src/submission-runtime";

const address = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Address;
const blockHash = `0x${"ab".repeat(32)}` as Hex;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pwa-runtime-unit-"));
  const config = loadBackendConfig({
    BACKEND_PROFILE: "local",
    BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    BACKEND_RPC_URL: "https://unused.invalid",
    BACKEND_JOURNAL_PATH: join(dir, "submissions.json"),
    BACKEND_PROVISIONING_JOURNAL_PATH: join(dir, "provisioning.json"),
    BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(dir, "reviews"),
  });
  const vault = {
    safe: address(1),
    guard: address(2),
    delay: address(3),
    usdc: address(4),
    provisioningPlan: {},
    verifiedProvisioning: { setupReceipt: { blockNumber: 1n } },
  } as unknown as BackendVaultRecord;
  const client = (source: string) => ({
    source,
    getTransactionReceipt: vi.fn(async (_input: unknown): Promise<any> => null),
    getBlockNumber: async () => 10n,
    getBlock: async () => ({ number: 10n, hash: blockHash, timestamp: 100n }),
    readContract: async ({ functionName }: any): Promise<any> =>
      functionName === "spendState" ? [0n, 0n, 0n] : functionName === "frozen" ? false : 0n,
  });
  const a = client("unit-a"),
    b = client("unit-b");
  const runtime = createSubmissionRuntimeForTestsOnly(config, {
    providers: [a, b],
    relay: a,
    sendRawTransaction: vi.fn(),
  } as any);
  return { vault, runtime, clients: [a, b] };
}
beforeEach(() => {
  vi.clearAllMocks();
  f.snapshot = {
    blockNumber: 10n,
    blockHash,
    timestamp: 100n,
    safeNonce: 0n,
    policyHash: blockHash,
  };
  f.policy = {
    assets: [
      {
        recipients: [address(5)],
        basePerTransaction: 1n,
        stepUpPerTransaction: 2n,
        baseDailyLimit: 1n,
        instantDailyLimit: 3n,
      },
    ],
  };
});
describe("concrete submission runtime boundary", () => {
  it("accepts canonical HTTP decimal amounts", async () => {
    const { runtime, vault } = fixture();
    await runtime.prepare({
      vault,
      request: {
        kind: "transfer",
        amount: "10000",
        recipient: address(6),
        idempotencyKey: "http-decimal",
      },
    });
    expect(f.prepare).toHaveBeenCalledWith({
      kind: "transfer",
      amount: 10000n,
      recipient: address(6),
    });
  });
  it("reads Delay events in provider-safe block windows", async () => {
    const { runtime, vault, clients } = fixture();
    const to = address(6),
      data = "0x1234" as Hex;
    const fingerprint = keccak256(
      encodePacked(["address", "uint256", "bytes", "uint8"], [to, 0n, data, 0]),
    );
    for (const client of clients) {
      client.getBlockNumber = async () => 20_001n;
      client.getBlock = async () => ({ number: 20_001n, hash: blockHash, timestamp: 100n });
      client.readContract = async ({ functionName }: any) =>
        functionName === "spendState"
          ? [0n, 0n, 0n]
          : functionName === "frozen"
            ? false
            : functionName === "queueNonce"
              ? 1n
              : functionName === "getTxHash"
                ? fingerprint
                : functionName === "getTxCreatedAt"
                  ? 10n
                  : 0n;
      Object.assign(client, {
        getLogs: vi.fn(async ({ fromBlock }: { fromBlock: bigint }) =>
          fromBlock === 1n
            ? [
                {
                  removed: false,
                  args: { queueNonce: 0n, txHash: fingerprint, to, value: 0n, data, operation: 0 },
                },
              ]
            : [],
        ),
      });
    }
    f.snapshot = { ...f.snapshot, blockNumber: 20_001n };

    await runtime.prepare({
      vault,
      request: {
        kind: "transfer",
        amount: "10000",
        recipient: address(7),
        idempotencyKey: "bounded-delay-logs",
      },
    });

    for (const client of clients) {
      expect(
        (client as any).getLogs.mock.calls.map(([input]: any[]) => [
          input.fromBlock,
          input.toBlock,
        ]),
      ).toEqual([
        [1n, 10_000n],
        [10_001n, 20_000n],
        [20_001n, 20_001n],
      ]);
    }
  });
  it.each(["01", "1e3", "-1", " 1", 1, null])(
    "rejects noncanonical HTTP amount %s",
    async (amount) => {
      const { runtime, vault } = fixture();
      await expect(
        runtime.prepare({
          vault,
          request: {
            kind: "transfer",
            amount,
            recipient: address(6),
            idempotencyKey: "bad-decimal",
          },
        }),
      ).rejects.toThrow(/nonnegative|canonical/);
      expect(f.prepare).not.toHaveBeenCalled();
    },
  );
  it("revalidates the immutable journal-normalized copy retained by the submission service", async () => {
    const { runtime, vault } = fixture();
    const prepared = await runtime.prepare({
      vault,
      request: {
        kind: "transfer",
        amount: 10000n,
        recipient: address(6),
        idempotencyKey: "cloned-prepared",
      },
    });
    const clone = JSON.parse(
      JSON.stringify(prepared, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
    await expect(runtime.revalidate(clone)).resolves.toBeUndefined();
    await expect(runtime.revalidate({ ...clone, kind: "execute-ready" })).rejects.toThrow(
      /server-held/,
    );
    await expect(
      runtime.revalidate({ ...clone, publicRequest: { ...clone.publicRequest, amount: "999" } }),
    ).rejects.toThrow(/server-held/);
  });
  it("assigns opaque observer identities without putting RPC URLs into records", () => {
    expect(
      createSubmissionReadClient(
        "https://unused.invalid/path?secret=not-a-real-key",
        "submission identity 1",
      ).source,
    ).toBe("submission-identity-1");
  });
  it("deduplicates concurrent identical preparation and rejects an ID conflict", async () => {
    const { runtime, vault } = fixture();
    const input = {
      vault,
      request: {
        kind: "transfer" as const,
        amount: 10000n,
        recipient: address(6),
        idempotencyKey: "concurrent",
      },
    };
    const [first, second] = await Promise.all([runtime.prepare(input), runtime.prepare(input)]);
    expect(second).toBe(first);
    await expect(runtime.revalidate(first)).resolves.toBeUndefined();
    await expect(
      runtime.prepare({ ...input, request: { ...input.request, amount: 10001n } }),
    ).rejects.toThrow(/bound/);
  });
  it("rejects a reorg during collection of the complete submission state", async () => {
    const { runtime, vault, clients } = fixture();
    let changed = false;
    const original = clients[0]!.readContract;
    clients[0]!.readContract = async (input) => {
      const value = await original(input);
      changed = true;
      return value;
    };
    clients[0]!.getBlock = async () => ({
      number: 10n,
      hash: changed ? (`0x${"cd".repeat(32)}` as Hex) : blockHash,
      timestamp: 100n,
    });
    await expect(
      runtime.prepare({
        vault,
        request: {
          kind: "transfer",
          amount: 10000n,
          recipient: address(6),
          idempotencyKey: "reorg",
        },
      }),
    ).rejects.toThrow(/block changed|reorg/);
  });
  it("rejects malformed receipt status and a different transaction hash before terminal reconciliation", async () => {
    const { runtime, clients } = fixture();
    clients.forEach((client) =>
      client.getTransactionReceipt.mockResolvedValue({
        transactionHash: blockHash,
        status: "unknown",
        blockNumber: 10n,
        blockHash,
      }),
    );
    await expect(runtime.reconcile(blockHash)).rejects.toThrow(/receipt.*status/);
    clients.forEach((client) =>
      client.getTransactionReceipt.mockResolvedValue({
        transactionHash: `0x${"cd".repeat(32)}`,
        status: "reverted",
        blockNumber: 10n,
        blockHash,
      }),
    );
    await expect(runtime.reconcile(blockHash)).rejects.toThrow(/durable submission hash/);
  });
});
