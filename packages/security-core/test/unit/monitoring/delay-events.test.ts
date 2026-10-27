import { expect } from "chai";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, parseAbiItem, toHex } from "viem";
import {
  decodeDelayLog,
  delayEventAbi,
  deriveDelayLifecycle,
  verifyDelayBinding,
  type DelayMonitoringContext,
} from "../../../src/monitoring/delay-events";
import { queueFingerprint } from "../../../src/queue/delay";
import { monitoringLog } from "../../helpers/monitoring";

const context: DelayMonitoringContext = {
  chainId: 31337,
  safe: getAddress("0x0000000000000000000000000000000000000001"),
  delay: getAddress("0x0000000000000000000000000000000000000003"),
  confirmations: 1,
  cooldownSeconds: 10n,
  expirationSeconds: 60n,
};

function log(eventName: "TransactionAdded" | "TxNonceSet", args: readonly unknown[], overrides = {}) {
  const item = parseAbiItem(eventName === "TransactionAdded"
    ? "event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)"
    : "event TxNonceSet(uint256 nonce)");
  const indexed = eventName === "TransactionAdded" ? 2 : 0;
  const types = eventName === "TransactionAdded"
    ? [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }]
    : [{ type: "uint256" }];
  const encoded = { topics: encodeEventTopics({ abi: [item], eventName, args: args as never }), data: encodeAbiParameters(types, args.slice(indexed) as never) };
  return monitoringLog(context.delay, context.chainId, encoded.topics as `0x${string}`[], encoded.data, {
    blockNumber: 20n,
    blockHash: keccak256(toHex("block")),
    transactionHash: keccak256(toHex("tx")),
    ...overrides,
  });
}

describe("Delay activity decoding", () => {
  const item = { txHash: queueFingerprint({ safe: context.safe, delay: context.delay, to: context.safe, value: 0n, data: "0x", operation: 0, queueNonce: 4n }), createdAt: 100n, to: context.safe, value: 0n, data: "0x" as const, operation: 0 };
  const binding = { readQueue: async () => item, readNonce: async () => 5n };

  it("decodes a confirmed queue item with the recomputed Zodiac hash", async () => {
    const result = await decodeDelayLog(log("TransactionAdded", [4n, item.txHash, context.safe, 0n, "0x", 0]), context, 21n, 100n, binding);
    if (result.kind !== "delayed-queued") throw new Error("expected delayed queue alert");
    expect(result.kind).to.equal("delayed-queued");
    expect(result.queueNonce).to.equal(4n);
    expect(result.queueFingerprint).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("rejects a fabricated indexed hash and unsupported lifecycle event", async () => {
    await expect(decodeDelayLog(log("TransactionAdded", [4n, keccak256(toHex("hash")), context.safe, 0n, "0x", 0]), context, 21n, 100n, binding)).to.be.rejectedWith(/hash/i);
  });

  it("fails closed on a wrong Delay, malformed log, and unbound queue target", async () => {
    await expect(decodeDelayLog(log("TxNonceSet", [5n], { address: context.safe }), context, 21n, 100n, binding)).to.be.rejectedWith(/identity/i);
    await expect(decodeDelayLog({ ...log("TxNonceSet", [5n]), data: "0x12" }, context, 21n, 100n, binding)).to.be.rejectedWith(/malformed/i);
    await expect(decodeDelayLog(log("TransactionAdded", [4n, item.txHash, context.delay, 0n, "0x", 0]), context, 21n, 100n, binding)).to.be.rejectedWith(/binding/i);
  });

  it("requires queue hash and tuple revalidation before a lifecycle alert", async () => {
    const result = await decodeDelayLog(log("TransactionAdded", [4n, item.txHash, context.safe, 0n, "0x", 0]), context, 21n, 100n, binding);
    await expect(verifyDelayBinding(result, binding, context)).to.be.fulfilled;
    await expect(verifyDelayBinding(result, { readQueue: async () => ({ ...item, value: 1n }), readNonce: binding.readNonce }, context)).to.be.rejectedWith(/binding/i);
  });

  it("uses the queue tuple and nonce as they existed at the event block", async () => {
    const readBlocks: bigint[] = [];
    const eventBinding = { readQueue: async (_nonce: bigint, blockNumber?: bigint) => { readBlocks.push(blockNumber!); return item; }, readNonce: async (blockNumber?: bigint) => { readBlocks.push(blockNumber!); return 5n; } };
    await decodeDelayLog(log("TransactionAdded", [4n, item.txHash, context.safe, 0n, "0x", 0]), context, 100n, 100n, eventBinding as never);
    expect(readBlocks).to.deep.equal([20n]);
  });

  it("does not accept an event ABI that is not emitted by the pinned Delay fixture", async () => {
    const item2 = parseAbiItem("event TransactionExecuted(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)");
    const encoded = encodeEventTopics({ abi: [item2], eventName: "TransactionExecuted", args: [4n, item.txHash, context.safe, 0n, "0x", 0] as never });
    await expect(decodeDelayLog({ ...log("TxNonceSet", [5n]), topics: encoded, data: "0x" } as never, context, 21n, 100n, binding)).to.be.rejectedWith(/malformed|unsupported/i);
  });

  it("derives execution only from an exact successful canonical receipt and queue transition", async () => {
    const executed = await deriveDelayLifecycle({
      kind: "delayed-queued", chainId: context.chainId, safe: context.safe, delay: context.delay,
      transactionHash: log("TransactionAdded", [4n, item.txHash, context.safe, 0n, "0x", 0]).transactionHash,
      blockNumber: 20n, logIndex: 0, queueNonce: 4n, queueFingerprint: item.txHash, createdAt: 100n,
      expiresAt: 170n, to: item.to, value: item.value, data: item.data, operation: item.operation,
    } as const, context, 200n, {
      ...binding,
      readNonce: async block => block < 40n ? 4n : 5n,
      readLifecycleReceipts: async () => [{ transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000040", blockNumber: 40n, blockHash: "0x0000000000000000000000000000000000000000000000000000000000000041", status: "success", to: context.delay, input: "0x" }],
      readCanonicalBlock: async block => ({ blockNumber: block, blockHash: "0x0000000000000000000000000000000000000000000000000000000000000041", timestamp: 150n }),
      decodeLifecycleCall: () => ({ functionName: "executeNextTx", args: [context.safe, 0n, "0x", 0] }),
    });
    expect(executed).to.deep.include({ kind: "delayed-executed", queueNonce: 4n, blockNumber: 40n });
  });

  it("does not derive execution or expiry from receipts below the configured confirmation depth", async () => {
    const confirmedContext = { ...context, confirmations: 2 } as const;
    const queued = {
      kind: "delayed-queued" as const, chainId: confirmedContext.chainId, safe: confirmedContext.safe, delay: confirmedContext.delay,
      transactionHash: item.txHash, blockNumber: 20n, logIndex: 0, queueNonce: 4n, queueFingerprint: item.txHash,
      createdAt: 100n, expiresAt: 170n, to: item.to, value: item.value, data: item.data, operation: item.operation,
    } as const;
    const lifecycle = {
      ...binding,
      readNonce: async (block: bigint) => block < 40n ? 4n : 5n,
      readLifecycleReceipts: async () => [{ transactionHash: item.txHash, blockNumber: 40n, blockHash: item.txHash, status: "success" as const, to: context.delay, input: "0x" as const }],
      readCanonicalBlock: async (block: bigint) => ({ blockNumber: block, blockHash: item.txHash, timestamp: 171n }),
      decodeLifecycleCall: () => ({ functionName: "executeNextTx" as const, args: [item.to, item.value, item.data, item.operation] }),
    };
    await expect(deriveDelayLifecycle(queued, confirmedContext, 40n, lifecycle)).to.eventually.equal(undefined);
    await expect(deriveDelayLifecycle(queued, confirmedContext, 40n, { ...lifecycle, decodeLifecycleCall: () => ({ functionName: "skipExpired" as const, args: [] }) })).to.eventually.equal(undefined);
  });

  it("derives expiry only from an exact successful skipExpired transition after canonical expiry", async () => {
    const expired = await deriveDelayLifecycle({
      kind: "delayed-queued", chainId: context.chainId, safe: context.safe, delay: context.delay,
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000020", blockNumber: 20n, logIndex: 0,
      queueNonce: 4n, queueFingerprint: item.txHash, createdAt: 100n, expiresAt: 170n,
      to: item.to, value: item.value, data: item.data, operation: item.operation,
    } as const, context, 200n, {
      ...binding,
      readNonce: async block => block < 50n ? 4n : 5n,
      readLifecycleReceipts: async () => [{ transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000050", blockNumber: 50n, blockHash: "0x0000000000000000000000000000000000000000000000000000000000000051", status: "success", to: context.delay, input: "0x" }],
      readCanonicalBlock: async block => ({ blockNumber: block, blockHash: "0x0000000000000000000000000000000000000000000000000000000000000051", timestamp: 171n }),
      decodeLifecycleCall: () => ({ functionName: "skipExpired", args: [] }),
    });
    expect(expired).to.deep.include({ kind: "delayed-expired", queueNonce: 4n, expiresAt: 170n, blockNumber: 50n });
  });

  it("suppresses derivation after cancellation but fails closed on a reorged lifecycle receipt", async () => {
    const queued = { kind: "delayed-queued" as const, chainId: context.chainId, safe: context.safe, delay: context.delay,
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000020" as `0x${string}`, blockNumber: 20n, logIndex: 0,
      queueNonce: 4n, queueFingerprint: item.txHash, createdAt: 100n, expiresAt: 170n, to: item.to, value: item.value, data: item.data, operation: item.operation } as const;
    const base = { ...binding, readNonce: async () => 5n, readCanonicalBlock: async (block: bigint) => ({ blockNumber: block, blockHash: "0x0000000000000000000000000000000000000000000000000000000000000061" as `0x${string}`, timestamp: 200n }) };
    await expect(deriveDelayLifecycle(queued, context, 200n, { ...base, readLifecycleReceipts: async () => [{ transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000060", blockNumber: 60n, blockHash: "0x0000000000000000000000000000000000000000000000000000000000000061", status: "success", to: context.delay, input: "0x" }], decodeLifecycleCall: () => ({ functionName: "setTxNonce", args: [5n] }) })).to.eventually.equal(undefined);
    await expect(deriveDelayLifecycle(queued, context, 200n, { ...base, readNonce: async () => 4n, readLifecycleReceipts: async () => [{ transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000070", blockNumber: 70n, blockHash: "0x0000000000000000000000000000000000000000000000000000000000000072", status: "success", to: context.delay, input: "0x" }], decodeLifecycleCall: () => ({ functionName: "skipExpired", args: [] }), readCanonicalBlock: async () => ({ blockNumber: 70n, blockHash: "0x0000000000000000000000000000000000000000000000000000000000000071", timestamp: 200n }) })).to.be.rejectedWith(/canonical|block/i);
  });
});
