import { expect } from "chai";
import { encodeFunctionData, getAddress, keccak256, toHex } from "viem";
import { decodeDelayLifecycleCall, delayLifecycleAbi } from "../../../src/monitoring/delay-lifecycle-decoder";
import { deriveDelayLifecycle, type DelayMonitoringContext } from "../../../src/monitoring/delay-events";
import { queueFingerprint } from "../../../src/queue/delay";

describe("Delay lifecycle calldata adapter", () => {
  const context: DelayMonitoringContext = {
    chainId: 31337,
    safe: getAddress("0x0000000000000000000000000000000000000001"),
    delay: getAddress("0x0000000000000000000000000000000000000003"),
    confirmations: 1,
    cooldownSeconds: 10n,
    expirationSeconds: 60n,
  };
  const blockHash = keccak256(toHex("expiry block"));
  const transactionHash = keccak256(toHex("expiry transaction"));
  const item = {
    txHash: queueFingerprint({ safe: context.safe, delay: context.delay, to: context.safe, value: 0n, data: "0x", operation: 0, queueNonce: 4n }),
    createdAt: 100n,
    to: context.safe,
    value: 0n,
    data: "0x" as const,
    operation: 0,
  };
  const queued = {
    kind: "delayed-queued" as const,
    chainId: context.chainId,
    safe: context.safe,
    delay: context.delay,
    transactionHash: keccak256(toHex("queue transaction")),
    blockNumber: 20n,
    logIndex: 0,
    queueNonce: 4n,
    queueFingerprint: item.txHash,
    createdAt: item.createdAt,
    expiresAt: 170n,
    to: item.to,
    value: item.value,
    data: item.data,
    operation: item.operation,
  };

  it("normalizes actual viem skipExpired calldata and derives expiry", async () => {
    const input = encodeFunctionData({ abi: delayLifecycleAbi, functionName: "skipExpired" });
    const expired = await deriveDelayLifecycle(queued, context, 50n, {
      readQueue: async () => item,
      readNonce: async block => block < 50n ? 4n : 5n,
      readLifecycleReceipts: async () => [{ transactionHash, blockNumber: 50n, blockHash, status: "success", to: context.delay, input }],
      readCanonicalBlock: async blockNumber => ({ blockNumber, blockHash, timestamp: 171n }),
      decodeLifecycleCall: decodeDelayLifecycleCall,
    });

    expect(expired).to.deep.include({ kind: "delayed-expired", queueNonce: 4n, blockNumber: 50n, transactionHash });
  });

  it("preserves actual viem arguments for executeNextTx and setTxNonce", () => {
    const execute = encodeFunctionData({ abi: delayLifecycleAbi, functionName: "executeNextTx", args: [item.to, item.value, item.data, item.operation] });
    const cancel = encodeFunctionData({ abi: delayLifecycleAbi, functionName: "setTxNonce", args: [5n] });

    expect(decodeDelayLifecycleCall(execute)).to.deep.equal({ functionName: "executeNextTx", args: [item.to, 0n, "0x", 0] });
    expect(decodeDelayLifecycleCall(cancel)).to.deep.equal({ functionName: "setTxNonce", args: [5n] });
  });

  it("rejects unknown selectors and malformed supported calldata", () => {
    expect(() => decodeDelayLifecycleCall("0x12345678")).to.throw();
    expect(() => decodeDelayLifecycleCall("0xb19d475800")).to.throw();
  });
});
