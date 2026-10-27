import { expect } from "chai";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { createRpcGuardBinding, type GuardRpcClient } from "../../../src/monitoring/guard-rpc-binding";

const safe = getAddress("0x0000000000000000000000000000000000000011");
const guard = getAddress("0x0000000000000000000000000000000000000012");
const delay = getAddress("0x0000000000000000000000000000000000000013");
const recipient = getAddress("0x0000000000000000000000000000000000000014");
const other = getAddress("0x0000000000000000000000000000000000000015");
const zero = getAddress("0x0000000000000000000000000000000000000000");
const blockHash = keccak256(toHex("target block"));
const parentHash = keccak256(toHex("parent block"));
const priorHash = keccak256(toHex("prior tx"));
const targetHash = keccak256(toHex("target tx"));
const canonicalSafeHash = keccak256(toHex("safe hash at nonce eight"));
const wrongSafeHash = keccak256(toHex("wrong safe hash"));

const execAbi = parseAbi([
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)",
]);

function executionLog(kind: "ExecutionSuccess" | "ExecutionFailure", txHash = canonicalSafeHash, address: Address = safe) {
  const item = parseAbiItem(`event ${kind}(bytes32 indexed txHash,uint256 payment)`);
  return {
    address,
    topics: encodeEventTopics({ abi: [item], eventName: kind, args: { txHash } }) as readonly Hex[],
    data: encodeAbiParameters([{ type: "uint256" }], [0n]),
    blockNumber: 20n,
    blockHash,
    transactionHash: targetHash,
    logIndex: 0,
  };
}

function fixture(overrides: Record<string, unknown> = {}): GuardRpcClient {
  const input = encodeFunctionData({
    abi: execAbi,
    functionName: "execTransaction",
    args: [recipient, 25n, "0x", 0, 999n, 2n, 3n, zero, zero, "0x1234"],
  });
  const targetTx = { hash: targetHash, to: safe, input, blockNumber: 20n, blockHash, transactionIndex: 1, ...(overrides.targetTxPatch as object ?? {}) };
  const priorTx = { hash: priorHash, to: other, input: "0x", blockNumber: 20n, blockHash, transactionIndex: 0 };
  const targetReceipt = { transactionHash: targetHash, blockNumber: 20n, blockHash, transactionIndex: 1, status: "success", logs: [executionLog("ExecutionSuccess")] };
  const priorReceipt = { transactionHash: priorHash, blockNumber: 20n, blockHash, transactionIndex: 0, status: "success", logs: [{ ...executionLog("ExecutionFailure", wrongSafeHash), transactionHash: priorHash }] };
  const values: Record<string, unknown> = { targetTx, priorTx, targetReceipt, priorReceipt, blockHash, parentHash, preNonce: 7n, safeHash: canonicalSafeHash, spend: [44n, 5n, 25n], ...overrides };
  return {
    getTransaction: async ({ hash }) => hash === targetHash ? values.targetTx as never : values.priorTx as never,
    getTransactionReceipt: async ({ hash }) => hash === targetHash ? values.targetReceipt as never : values.priorReceipt as never,
    getBlock: async ({ blockNumber }) => blockNumber === 19n
      ? { number: 19n, hash: values.parentHash, parentHash: keccak256(toHex("grandparent")), transactions: [] } as never
      : { number: 20n, hash: values.blockHash, parentHash: values.blockParentHash ?? values.parentHash, transactions: values.blockTransactions ?? [values.priorTx, values.targetTx] } as never,
    readContract: async ({ address, functionName, args, blockNumber }) => {
      if (functionName === "nonce") {
        expect(address).to.equal(safe);
        expect(blockNumber).to.equal(19n);
        return values.preNonce;
      }
      if (functionName === "getTransactionHash") return (args as readonly unknown[])[9] === 8n ? values.safeHash : wrongSafeHash;
      if (functionName === "spendState") return values.spend;
      throw new Error(`unexpected read ${String(functionName)}`);
    },
  };
}

describe("read-only Safe guard RPC binding", () => {
  const identity = { chainId: 31337, safe, guard, delay, confirmations: 2 };

  it("derives the target nonce from prior persisted same-block Safe events and maps the spend tuple", async () => {
    const binding = createRpcGuardBinding(fixture(), identity);
    const tx = await binding.readSafeTransaction(targetHash, 20n, blockHash);
    expect(tx).to.deep.equal({ safe, to: recipient, value: 25n, data: "0x", operation: 0, nonce: 8n });
    expect(tx.nonce).to.not.equal(999n);
    expect(await binding.readSpendState(zero, 20n)).to.deep.equal({ window: 44n, baseSpent: 5n, instantSpent: 25n });
  });

  it("does not count a reverted outer transaction without a persisted Safe event", async () => {
    const reverted = { transactionHash: priorHash, blockNumber: 20n, blockHash, transactionIndex: 0, status: "reverted", logs: [] };
    const binding = createRpcGuardBinding(fixture({ priorReceipt: reverted, preNonce: 8n }), identity);
    expect((await binding.readSafeTransaction(targetHash, 20n, blockHash)).nonce).to.equal(8n);
  });

  it("counts an earlier persisted ExecutionSuccess just like ExecutionFailure", async () => {
    const priorReceipt = { transactionHash: priorHash, blockNumber: 20n, blockHash, transactionIndex: 0, status: "success", logs: [{ ...executionLog("ExecutionSuccess", wrongSafeHash), transactionHash: priorHash }] };
    expect((await createRpcGuardBinding(fixture({ priorReceipt }), identity).readSafeTransaction(targetHash, 20n, blockHash)).nonce).to.equal(8n);
  });

  for (const [name, override, message] of [
    ["wrong target block", { targetReceipt: { transactionHash: targetHash, blockNumber: 21n, blockHash, transactionIndex: 1, status: "success", logs: [executionLog("ExecutionSuccess")] } }, /block/i],
    ["wrong outer Safe", { targetTxPatch: { to: other } }, /configured Safe/i],
    ["wrong target position", { targetReceipt: { transactionHash: targetHash, blockNumber: 20n, blockHash, transactionIndex: 0, status: "success", logs: [executionLog("ExecutionSuccess")] } }, /position/i],
    ["missing full-block membership", { blockTransactions: [priorHash, priorHash] }, /full block position/i],
    ["wrong parent identity", { blockParentHash: keccak256(toHex("wrong parent")) }, /parent/i],
    ["reorged canonical block", { blockHash: keccak256(toHex("replacement")) }, /canonical|block/i],
    ["missing historical nonce", { preNonce: undefined }, /nonce|historical/i],
    ["wrong event Safe", { targetReceipt: { transactionHash: targetHash, blockNumber: 20n, blockHash, transactionIndex: 1, status: "success", logs: [executionLog("ExecutionSuccess", canonicalSafeHash, other)] } }, /execution|Safe/i],
    ["duplicate target execution", { targetReceipt: { transactionHash: targetHash, blockNumber: 20n, blockHash, transactionIndex: 1, status: "success", logs: [executionLog("ExecutionSuccess"), executionLog("ExecutionSuccess")] } }, /exactly one|ambiguous/i],
    ["malformed target execution", { targetReceipt: { transactionHash: targetHash, blockNumber: 20n, blockHash, transactionIndex: 1, status: "success", logs: [executionLog("ExecutionSuccess"), { ...executionLog("ExecutionFailure"), data: "0x12" }] } }, /malformed/i],
    ["target failure", { targetReceipt: { transactionHash: targetHash, blockNumber: 20n, blockHash, transactionIndex: 1, status: "success", logs: [executionLog("ExecutionSuccess"), executionLog("ExecutionFailure")] } }, /failure/i],
    ["fake digest", { safeHash: wrongSafeHash }, /hash/i],
  ] as const) {
    it(`fails closed on ${name}`, async () => {
      await expect(createRpcGuardBinding(fixture(override as Record<string, unknown>), identity).readSafeTransaction(targetHash, 20n, blockHash)).to.be.rejectedWith(message);
    });
  }

  it("rejects a guard event block hash that is not the canonical receipt block", async () => {
    await expect(createRpcGuardBinding(fixture(), identity).readSafeTransaction(targetHash, 20n, keccak256(toHex("wrong event block")))).to.be.rejectedWith(/event block hash/i);
  });
});
