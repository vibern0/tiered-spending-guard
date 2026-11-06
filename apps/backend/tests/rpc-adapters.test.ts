import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

const rpc = vi.hoisted(() => ({ getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getCode: vi.fn(async (_args: unknown) => "0x01"), getBlock: vi.fn(async () => ({ number: 12n, hash: `0x${"ab".repeat(32)}`, timestamp: 123n, baseFeePerGas: 1n, gasLimit: 30_000_000n })) }));
vi.mock("viem", async original => ({ ...await original<any>(), createPublicClient: () => rpc }));
import { createReadClient, createRelayClient } from "../src/provisioner";

describe("configured provisioning relay pinned reads", () => {
  it("normalizes only viem transaction absence into pending evidence", async () => {
    const client = createReadClient("https://unused.invalid", "test reader");
    const hash = `0x${"ab".repeat(32)}` as Hex;
    rpc.getTransaction.mockRejectedValue(Object.assign(new Error("missing"), { name: "TransactionNotFoundError" }));
    rpc.getTransactionReceipt.mockRejectedValue(Object.assign(new Error("missing"), { name: "TransactionReceiptNotFoundError" }));
    expect(await client.getTransaction({ hash })).toBeNull();
    expect(await client.getTransactionReceipt({ hash })).toBeNull();
    rpc.getTransactionReceipt.mockRejectedValue(new Error("transport failure"));
    await expect(client.getTransactionReceipt({ hash })).rejects.toThrow(/Sepolia RPC request failed/);
  });
  it("keeps the selected block for runtime verification and includes the block timestamp", async () => {
    const client = createRelayClient("https://unused.invalid");
    const address = `0x${"12".repeat(20)}` as Address;
    await client.getBytecode({ address, blockNumber: 12n });
    expect(rpc.getCode).toHaveBeenCalledExactlyOnceWith({ address, blockNumber: 12n });
    expect(await client.getBlock({ blockNumber: 12n })).toMatchObject({ number: 12n, timestamp: 123n });
  });
});
