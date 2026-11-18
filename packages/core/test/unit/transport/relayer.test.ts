import { expect } from "chai";
import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  type Address,
  type Hex,
} from "viem";
import { brandVerifiedDeploymentInfrastructureForTestsOnly, type VerifiedDeploymentInfrastructure } from "../../../../sdk/src/config/deployments";
import { queueFingerprint } from "../../../../sdk/src/queue/delay";
import { SAFE_TX_TYPES, type SafeTxMessage } from "../../../../sdk/src/signers/types";
import { submissionRequestHash, type DelayExecutionRequest, type SafeExecutionRequest } from "../../../../sdk/src/transport/validate";
import {
  deploymentInfrastructureHash,
  encodeDelayExecutionCalldata,
  encodeSafeExecutionCalldata,
  type CanonicalReceipt,
  type RelayerContext,
  validateAndBroadcast,
} from "../../../../sdk/src/transport/relayer";

process.env.NODE_ENV = "test";

const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const zero = a(0);
const sig = `0x${"33".repeat(65)}` as Hex;

const safe = a(1);
const guard = a(2);
const asset = zero;
const delay = a(3);
const recipient = a(4);

const transaction: SafeTxMessage = {
  to: recipient,
  value: 11n,
  data: "0x" as Hex,
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: zero,
  refundReceiver: zero,
  nonce: 5n,
};

function verifiedDeployments(): VerifiedDeploymentInfrastructure {
  const dependency = Object.freeze({
    name: "test",
    version: "1.5.0",
    address: a(90),
    runtimeCodeHash: h(90),
    evidence: "verified" as const,
    source: "unit test",
  });
  return brandVerifiedDeploymentInfrastructureForTestsOnly(Object.freeze({
    chainId: 31337,
    deployer: a(80),
    observedDeployerNonce: 0n,
    safeSingleton: dependency,
    safeProxyFactory: dependency,
    passkeySignerFactory: dependency,
    passkeySignerVerifier: dependency,
    multiSendCallOnly: dependency,
    passkeySigner: Object.freeze({ name: "passkeySigner" as const, address: a(91), runtimeCodeHash: h(91), bindingHash: h(92), source: "unit test" }),
    dependencies: Object.freeze({
      safeSingleton: dependency,
      safeProxyFactory: dependency,
      passkeySignerFactory: dependency,
      passkeySignerVerifier: dependency,
      multiSendCallOnly: dependency,
    }),
  }));
}

const deployments = verifiedDeployments();
const deploymentsHash = deploymentInfrastructureHash(deployments);
const policyHash = h(77);

function safeRequest(): SafeExecutionRequest {
  return {
    version: 1,
    kind: "safe-execution",
    idempotencyKey: h(1),
    chainId: 31337,
    deploymentsHash,
    policyHash,
    safe,
    guard,
    asset,
    transaction,
    safeTxHash: hashTypedData({ domain: { chainId: 31337, verifyingContract: safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: transaction }),
    signatures: sig,
    expectedSpend: { window: 86400n, baseSpent: 0n, instantSpent: 11n },
  };
}

function delayRequest(): DelayExecutionRequest {
  const request = {
    version: 1 as const,
    kind: "delay-execution" as const,
    idempotencyKey: h(2),
    chainId: 31337,
    deploymentsHash,
    policyHash,
    safe,
    guard,
    delay,
    queueNonce: 8n,
    queueFingerprint: "0x" as Hex,
    to: recipient,
    value: 22n,
    data: "0x1234" as Hex,
    operation: 0 as const,
    createdAt: 100n,
    cooldownSeconds: 10n,
    expirationSeconds: 60n,
  };
  return { ...request, queueFingerprint: queueFingerprint(request) };
}

function context(overrides: Partial<RelayerContext["readers"]> = {}, receipts: Record<string, CanonicalReceipt | undefined> = {}): RelayerContext & { safeCalls: { target: Address; data: Hex }[]; delayCalls: { target: Address; data: Hex }[] } {
  const safeCalls: { target: Address; data: Hex }[] = [];
  const delayCalls: { target: Address; data: Hex }[] = [];
  const readers: RelayerContext["readers"] = {
    chainId: async () => 31337,
    deployments: async () => deployments,
    topology: async () => ({ ok: true, failures: [], checked: ["unit"] }),
    safeNonce: async () => 5n,
    policyHash: async () => policyHash,
    spendState: async () => ({ window: 86400n, baseSpent: 0n, instantSpent: 11n }),
    delayItem: async () => ({ txHash: delayRequest().queueFingerprint, createdAt: 100n, to: recipient, value: 22n, data: "0x1234" as Hex, operation: 0 }),
    delayNonce: async () => delayRequest().queueNonce,
    blockTimestamp: async () => 111n,
    receipt: async (hash: Hex) => receipts[hash.toLowerCase()],
    ...overrides,
  };
  return {
    readers,
    broadcaster: {
      executeSafe: async (target, exactCalldata) => {
        safeCalls.push({ target, data: exactCalldata });
        return h(500);
      },
      executeDelay: async (target, exactCalldata) => {
        delayCalls.push({ target, data: exactCalldata });
        return h(501);
      },
    },
    safeCalls,
    delayCalls,
  };
}

describe("relayer validation", () => {
  it("encodes only canonical Safe and Delay calldata bytes", () => {
    expect(encodeSafeExecutionCalldata(safeRequest())).to.equal(encodeFunctionData({
      abi: [{ type: "function", name: "execTransaction", stateMutability: "nonpayable", inputs: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "signatures", type: "bytes" },
      ], outputs: [{ type: "bool" }] }],
      functionName: "execTransaction",
      args: [recipient, 11n, "0x", 0, 0n, 0n, 0n, zero, zero, sig],
    }));
    expect(encodeDelayExecutionCalldata(delayRequest())).to.equal(encodeFunctionData({
      abi: [{ type: "function", name: "executeNextTx", stateMutability: "nonpayable", inputs: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
      ], outputs: [] }],
      functionName: "executeNextTx",
      args: [recipient, 22n, "0x1234", 0],
    }));
  });

  it("rejects stale or inconsistent Safe requests before any broadcaster call", async () => {
    const scenarios: readonly [string, Partial<RelayerContext["readers"]>, Partial<SafeExecutionRequest>?][] = [
      ["wrong chain", { chainId: async () => 1 }],
      ["unverified deployment aggregate", { deployments: async () => ({ ...deployments }) as VerifiedDeploymentInfrastructure }],
      ["deployment hash drift", {}, { deploymentsHash: h(999) }],
      ["topology failure", { topology: async () => ({ ok: false, failures: ["guard"], checked: [] }) }],
      ["nonce drift", { safeNonce: async () => 6n }],
      ["policy hash drift", { policyHash: async () => h(778) }],
      ["counter drift", { spendState: async () => ({ window: 86400n, baseSpent: 1n, instantSpent: 11n }) }],
      ["safe tx hash mutation", {}, { safeTxHash: h(444) }],
      ["malformed calldata", {}, { signatures: "0x12" as Hex }],
    ];

    for (const [label, readers, patch] of scenarios) {
      const ctx = context(readers);
      const result = await validateAndBroadcast({ ...safeRequest(), ...patch } as SafeExecutionRequest, ctx);
      expect(result.kind, label).not.to.equal("submitted");
      expect(ctx.safeCalls, label).to.have.length(0);
      expect(ctx.delayCalls, label).to.have.length(0);
    }
  });

  it("rejects stale or inconsistent Delay requests before any broadcaster call", async () => {
    const scenarios: readonly [string, Partial<RelayerContext["readers"]>, Partial<DelayExecutionRequest>?][] = [
      ["policy hash drift", { policyHash: async () => h(700) }],
      ["queue tuple drift", { delayItem: async () => ({ txHash: delayRequest().queueFingerprint, createdAt: 100n, to: a(55), value: 22n, data: "0x1234" as Hex, operation: 0 }) }],
      ["queue nonce cancellation drift", { delayItem: async () => ({ txHash: h(1), createdAt: 0n, to: recipient, value: 22n, data: "0x1234" as Hex, operation: 0 }) }],
      ["cooldown drift", { blockTimestamp: async () => 109n }],
      ["expiration drift", { blockTimestamp: async () => 171n }],
      ["fingerprint mutation", {}, { queueFingerprint: h(222) }],
    ];

    for (const [label, readers, patch] of scenarios) {
      const ctx = context(readers);
      const result = await validateAndBroadcast({ ...delayRequest(), ...patch } as DelayExecutionRequest, ctx);
      expect(result.kind, label).not.to.equal("submitted");
      expect(ctx.safeCalls, label).to.have.length(0);
      expect(ctx.delayCalls, label).to.have.length(0);
    }
  });

  it("broadcasts exact canonical bytes after revalidating nonce or queue immediately before the call", async () => {
    const safeCtx = context();
    const safeResult = await validateAndBroadcast(safeRequest(), safeCtx);
    expect(safeResult).to.include({ kind: "submitted", transactionHash: h(500), requestHash: submissionRequestHash(safeRequest()) });
    expect(safeCtx.safeCalls).to.deep.equal([{ target: safe, data: encodeSafeExecutionCalldata(safeRequest()) }]);

    const delayCtx = context();
    const delayResult = await validateAndBroadcast(delayRequest(), delayCtx);
    expect(delayResult).to.include({ kind: "submitted", transactionHash: h(501), requestHash: submissionRequestHash(delayRequest()) });
    expect(delayCtx.delayCalls).to.deep.equal([{ target: delay, data: encodeDelayExecutionCalldata(delayRequest()) }]);
  });

  it("rejects Safe state drift during the final pre-broadcast re-read with zero broadcaster calls", async () => {
    let spendReads = 0;
    const ctx = context({
      spendState: async () => {
        spendReads++;
        return spendReads === 1
          ? { window: 86400n, baseSpent: 0n, instantSpent: 11n }
          : { window: 86400n, baseSpent: 1n, instantSpent: 11n };
      },
    });

    const result = await validateAndBroadcast(safeRequest(), ctx);

    expect(result.kind).to.equal("stale");
    expect(ctx.safeCalls).to.have.length(0);
    expect(ctx.delayCalls).to.have.length(0);
  });

  it("rejects Delay state drift during the final pre-broadcast re-read with zero broadcaster calls", async () => {
    let timestampReads = 0;
    const ctx = context({
      blockTimestamp: async () => {
        timestampReads++;
        return timestampReads === 1 ? 111n : 171n;
      },
    });

    const result = await validateAndBroadcast(delayRequest(), ctx);

    expect(result.kind).to.equal("stale");
    expect(ctx.safeCalls).to.have.length(0);
    expect(ctx.delayCalls).to.have.length(0);
  });

  it("rejects Delay cancellation nonce advancement before any broadcaster call", async () => {
    const ctx = context({ delayNonce: async () => delayRequest().queueNonce + 1n } as Partial<RelayerContext["readers"]>);

    const result = await validateAndBroadcast(delayRequest(), ctx);

    expect(result.kind).to.equal("stale");
    expect(ctx.safeCalls).to.have.length(0);
    expect(ctx.delayCalls).to.have.length(0);
  });

  it("rejects future Delay queue items that are not the live executable head", async () => {
    const ctx = context({ delayNonce: async () => delayRequest().queueNonce - 1n });

    const result = await validateAndBroadcast(delayRequest(), ctx);

    expect(result.kind).to.equal("stale");
    expect(ctx.safeCalls).to.have.length(0);
    expect(ctx.delayCalls).to.have.length(0);
  });

  it("reconciles an accepted broadcaster timeout by known transaction hash and never rebroadcasts changed data", async () => {
    const acceptedHash = h(700);
    const receipt: CanonicalReceipt = { transactionHash: acceptedHash, blockNumber: 123n, blockHash: h(701), status: "success" };
    const ctx = context({}, { [acceptedHash.toLowerCase()]: receipt });
    (ctx.broadcaster as { executeSafe(target: Address, exactCalldata: Hex): Promise<Hex> }).executeSafe = async (target, exactCalldata) => {
      ctx.safeCalls.push({ target, data: exactCalldata });
      const error = new Error("timeout after accept") as Error & { transactionHash: Hex };
      error.transactionHash = acceptedHash;
      throw error;
    };

    const result = await validateAndBroadcast(safeRequest(), ctx);

    expect(result).to.deep.equal({ kind: "confirmed", requestHash: submissionRequestHash(safeRequest()), transactionHash: acceptedHash, blockNumber: 123n, blockHash: h(701) });
    expect(ctx.safeCalls).to.deep.equal([{ target: safe, data: encodeSafeExecutionCalldata(safeRequest()) }]);
  });
});
