import { describe, expect, it, vi } from "vitest";
import {
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  keccak256,
  type PublicClient,
} from "viem";
import { delayedUsage, queueStatus, readQueue } from "./queue";

const token = "0x0000000000000000000000000000000000000001";
const recipient = "0x0000000000000000000000000000000000000002";
const delay = "0x0000000000000000000000000000000000000003";
const safe = "0x0000000000000000000000000000000000000004";
const data = encodeFunctionData({
  abi: erc20Abi,
  functionName: "transfer",
  args: [recipient, 25n],
});
const hash = keccak256(
  encodePacked(["address", "uint256", "bytes", "uint8"], [token, 0n, data, 0]),
);
const creation = {
  queueNonce: 1n,
  to: token,
  data,
  value: 0n,
  operation: 0,
  txHash: hash,
};

function fixture(logs = [creation], stored = hash) {
  const values: Record<string, unknown> = {
    txNonce: 1n,
    queueNonce: 2n,
    txHash: stored,
    txCreatedAt: 1000n,
    txCooldown: 120n,
    txExpiration: 600n,
  };
  return {
    readContract: vi.fn(async ({ functionName }) => values[functionName]),
    getLogs: vi.fn(async () => logs.map((args) => ({ args }))),
  } as unknown as PublicClient;
}

describe("local GLD withdrawal queue", () => {
  it("recovers the active head and applies the inclusive execution window", async () => {
    const [item] = await readQueue(
      fixture([{ ...creation, queueNonce: 0n }, creation]),
      delay,
      token,
      recipient,
      10n,
    );
    expect(item).toMatchObject({ nonce: 1n, amount: 25n, recipient, hash });
    expect(
      [1119n, 1120n, 1720n, 1721n].map((now) => queueStatus(item, now)),
    ).toEqual(["waiting", "ready", "ready", "expired"]);
  });
  it("refuses an incomplete queue, inconsistent hash or different approved recipient", async () => {
    await expect(
      readQueue(fixture([]), delay, token, recipient, 10n),
    ).rejects.toThrow("all pending");
    await expect(
      readQueue(
        fixture([creation], keccak256("0x")),
        delay,
        token,
        recipient,
        10n,
      ),
    ).rejects.toThrow("does not match");
    await expect(readQueue(fixture(), delay, token, safe, 10n)).rejects.toThrow(
      "Unrecognized",
    );
  });
  it("counts only paired GLD transfers executed by Delay on the current day", async () => {
    const successes = [
      { blockNumber: 1n, blockHash: "past", transactionHash: "a", logIndex: 2 },
      {
        blockNumber: 2n,
        blockHash: "today",
        transactionHash: "b",
        logIndex: 4,
      },
      {
        blockNumber: 2n,
        blockHash: "today",
        transactionHash: "c",
        logIndex: 8,
      },
    ];
    const transfers = [
      {
        blockHash: "past",
        transactionHash: "a",
        logIndex: 1,
        args: { value: 25n },
      },
      {
        blockHash: "today",
        transactionHash: "b",
        logIndex: 3,
        args: { value: 20n },
      },
      {
        blockHash: "today",
        transactionHash: "other",
        logIndex: 7,
        args: { value: 1n },
      },
    ];
    const client = {
      getLogs: vi
        .fn()
        .mockResolvedValueOnce(successes)
        .mockResolvedValueOnce(transfers),
      getBlock: vi.fn(async ({ blockHash }) => ({
        timestamp: blockHash === "past" ? 86399n : 86401n,
      })),
    } as unknown as PublicClient;
    expect(
      await delayedUsage(client, safe, delay, token, recipient, 2n, 86401n),
    ).toBe(20n);
  });
});
