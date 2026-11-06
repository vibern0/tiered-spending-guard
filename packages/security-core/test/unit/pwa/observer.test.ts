import { expect } from "chai";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  observePwaReceipt,
  serializePwaObserverRecord,
  type PwaObservedState,
  type PwaObserverBinding,
  type PwaObserverClient,
  type PwaObserverReceipt,
  type PwaObserverTransaction,
} from "../../../src/pwa/observer";
import {
  brandVerifiedPwaSnapshotForTestsOnly,
  preparePwaIntent,
  type PreparedPwaIntent,
  type VerifiedPwaSnapshot,
} from "../../../src/pwa";
import { PWA_RECIPIENT, SEPOLIA_USDC_ADDRESS } from "../../../src/pwa/profile";
import { queueFingerprint } from "../../../src/queue/delay";
import { policyHash } from "../../../src/topology/build";
import type { VaultPolicy } from "../../../src/config/policy";

const a = (value: number) => getAddress(`0x${value.toString(16).padStart(40, "0")}`);
const h = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hex;
const SAFE_ABI = parseAbi([
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
]);
const GUARD_ABI = parseAbi([
  "event TransferAuthorized(uint8 tier,address token,address recipient,uint256 amount,uint256 baseSpent,uint256 instantSpent,uint256 window)",
]);
const DELAY_ABI = parseAbi([
  "event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)",
  "event TxNonceSet(uint256 nonce)",
]);

const safe = a(1);
const guard = a(2);
const delay = a(3);
const primary = a(4);
const secondary = a(5);
const usdc = SEPOLIA_USDC_ADDRESS;
const recipient = PWA_RECIPIENT;

function policy(recipients: readonly Address[] = [recipient]): VaultPolicy {
  return { chainId: 11155111, safe, primary, passkey: primary, secondaryProfile: "contract-only", ecdsaSecondary: a(0), secondaries: [{ address: secondary, role: "secondary", kind: "safe-contract", enabled: true }], delay, periodSeconds: 86400, periodAnchor: 0n, cooldownSeconds: 120, expirationSeconds: 600, assets: [{ token: usdc, basePerTransaction: 1_000_000n, stepUpPerTransaction: 3_000_000n, baseDailyLimit: 1_000_000n, instantDailyLimit: 3_000_000n, baseRecipientMode: "any-valid-address", recipients }] };
}

function queued(createdAt = 800n) {
  const data = `0xa9059cbb${recipient.slice(2).padStart(64, "0")}${(4_000_000n).toString(16).padStart(64, "0")}`.toLowerCase() as Hex;
  const item = { safe, delay, to: usdc, value: 0n, data, operation: 0 as const, queueNonce: 4n };
  return Object.freeze({
    ...item,
    queueFingerprint: queueFingerprint(item),
    createdAt,
    readyAt: createdAt + 120n,
    expiresAt: createdAt + 720n,
  });
}

function snapshot(overrides: Partial<VerifiedPwaSnapshot> = {}): VerifiedPwaSnapshot {
  process.env.NODE_ENV = "test";
  return brandVerifiedPwaSnapshotForTestsOnly(Object.freeze({
    formatVersion: 2,
    chainId: 11155111,
    blockNumber: 90n,
    blockHash: h(90),
    timestamp: 1_000n,
    deploymentsHash: h(91),
    policyHash: policyHash(policy()),
    safe,
    guard,
    delay,
    usdc,
    baseRecipientMode: "any-valid-address",
    elevatedRecipients: [recipient] as const,
    primaryPasskey: primary,
    secondaryPasskey: secondary,
    safeNonce: 9n,
    spendState: Object.freeze({ window: 0n, baseSpent: 0n, instantSpent: 0n }),
    limits: Object.freeze({ basePerTransaction: 1_000_000n, baseDailyLimit: 1_000_000n, stepUpPerTransaction: 3_000_000n, instantDailyLimit: 3_000_000n }),
    cooldownSeconds: 120n,
    expirationSeconds: 600n,
    queueHeadNonce: 4n,
    queueTailNonce: 4n,
    queueHead: null,
    ...overrides,
  }));
}

type Kind = "base" | "step-up" | "queue" | "cancel" | "execute" | "add" | "repair" | "skip";

function prepared(kind: Kind): PreparedPwaIntent {
  if (kind === "add") return preparePwaIntent(snapshot(), { kind: "add-recipient", recipient: a(99) });
  if (kind === "repair" || kind === "skip") {
    const addition = preparePwaIntent(snapshot(), { kind: "add-recipient", recipient: a(99) });
    const queueHead = { ...addition.queue!, safe, delay, createdAt: 800n, readyAt: 920n, expiresAt: 1520n };
    return preparePwaIntent(snapshot({ queueHead, queueTailNonce: 5n, timestamp: kind === "skip" ? 1600n : 1000n }), { kind: kind === "skip" ? "skip-expired" : "execute-ready", queueNonce: 4n, queueFingerprint: queueHead.queueFingerprint });
  }
  if (kind === "base") return preparePwaIntent(snapshot(), { kind: "transfer", recipient, amount: 1_000_000n });
  if (kind === "step-up") return preparePwaIntent(snapshot({ spendState: { window: 0n, baseSpent: 1_000_000n, instantSpent: 1_000_000n } }), { kind: "transfer", recipient, amount: 2_000_000n });
  if (kind === "queue") return preparePwaIntent(snapshot(), { kind: "transfer", recipient, amount: 4_000_000n });
  const queueHead = queued();
  const withQueue = snapshot({ queueHead, queueHeadNonce: 4n, queueTailNonce: 5n });
  const binding = { queueNonce: queueHead.queueNonce, queueFingerprint: queueHead.queueFingerprint };
  return preparePwaIntent(withQueue, kind === "cancel" ? { kind: "cancel-queued", ...binding } : { kind: "execute-ready", ...binding });
}

function state(intent: PreparedPwaIntent, phase: "before" | "after"): PwaObservedState {
  const beforeQueue = intent.kind === "cancel-queued" || intent.kind === "execute-ready" || intent.kind === "skip-expired" ? { ...intent.queue!, safe, delay } : null;
  const amount = intent.amount;
  const isSigned = "safeTx" in intent;
  const beforeSpend = "expectedSpend" in intent ? intent.expectedSpend : { window: 0n, baseSpent: 0n, instantSpent: 0n };
  let queueHead = beforeQueue;
  let queueHeadNonce = 4n;
  let queueTailNonce = beforeQueue ? 5n : 4n;
  let safeNonce = 9n;
  let safeUsdcBalance = 8_000_000n;
  let recipientUsdcBalance = 10_000_000n;
  let spendState = { ...beforeSpend };
  if (phase === "after") {
    if (isSigned) safeNonce += 1n;
    if (intent.kind === "base-transfer") {
      safeUsdcBalance -= amount;
      recipientUsdcBalance += amount;
      spendState = { ...beforeSpend, baseSpent: beforeSpend.baseSpent + amount, instantSpent: beforeSpend.instantSpent + amount };
    } else if (intent.kind === "step-up-transfer") {
      safeUsdcBalance -= amount;
      recipientUsdcBalance += amount;
      spendState = { ...beforeSpend, instantSpent: beforeSpend.instantSpent + amount };
    } else if (intent.kind === "queue-transfer" || intent.kind === "add-recipient") {
      const queuedIntent = intent.queue!;
      queueTailNonce = 5n;
      queueHead = {
        safe,
        delay,
        to: queuedIntent.to,
        value: queuedIntent.value,
        data: queuedIntent.data,
        operation: queuedIntent.operation,
        queueNonce: queuedIntent.queueNonce,
        queueFingerprint: queuedIntent.queueFingerprint,
        createdAt: 1000n,
        readyAt: 1120n,
        expiresAt: 1720n,
      };
    } else if (intent.kind === "cancel-queued" || intent.kind === "skip-expired") {
      queueHeadNonce = 5n;
      queueHead = null;
    } else if (intent.kind === "execute-ready") {
      queueHeadNonce = 5n;
      queueHead = null;
      safeUsdcBalance -= amount;
      recipientUsdcBalance += amount;
    }
  }
  return Object.freeze({
    safeNonce,
    queueHeadNonce,
    queueTailNonce,
    safeUsdcBalance,
    recipientUsdcBalance,
    spendState: Object.freeze(spendState),
    queueHead,
    deploymentsHash: intent.deploymentsHash,
    policy: policy(phase === "after" && intent.kind === "execute-ready" && intent.queue.to === guard ? [recipient, a(99)] : [recipient]),
    policyHash: policyHash(policy(phase === "after" && intent.kind === "execute-ready" && intent.queue.to === guard ? [recipient, a(99)] : [recipient])),
    topologyReportHash: h(93),
  });
}

function eventLog(address: Address, topics: readonly Hex[], data: Hex, index: number) {
  return Object.freeze({ address, blockNumber: 100n, blockHash: h(100), transactionHash: h(500), logIndex: index, topics, data, removed: false });
}

function logs(intent: PreparedPwaIntent, failure = false) {
  const output = [];
  if ("safeTx" in intent) {
    output.push(eventLog(safe, encodeEventTopics({ abi: SAFE_ABI, eventName: failure ? "ExecutionFailure" : "ExecutionSuccess", args: { txHash: intent.safeTxHash } }), encodeAbiParameters([{ type: "uint256" }], [0n]), 0));
  }
  if (intent.kind === "base-transfer" || intent.kind === "step-up-transfer") {
    const after = state(intent, "after").spendState;
    output.push(eventLog(guard, encodeEventTopics({ abi: GUARD_ABI, eventName: "TransferAuthorized" }), encodeAbiParameters([
      { type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
    ], [intent.kind === "base-transfer" ? 0 : 1, usdc, recipient, intent.amount, after.baseSpent, after.instantSpent, after.window]), 1));
  } else if (intent.kind === "queue-transfer" || intent.kind === "add-recipient") {
    output.push(eventLog(delay, encodeEventTopics({ abi: DELAY_ABI, eventName: "TransactionAdded", args: { queueNonce: intent.queue!.queueNonce, txHash: intent.queue!.queueFingerprint } }), encodeAbiParameters([
      { type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" },
    ], [intent.queue!.to, intent.queue!.value, intent.queue!.data, intent.queue!.operation]), 1));
  } else if (intent.kind === "cancel-queued") {
    output.push(eventLog(delay, encodeEventTopics({ abi: DELAY_ABI, eventName: "TxNonceSet" }), encodeAbiParameters([{ type: "uint256" }], [5n]), 1));
  }
  return Object.freeze(output);
}

function transaction(intent: PreparedPwaIntent): PwaObserverTransaction {
  if ("safeTx" in intent) {
    return Object.freeze({
      hash: h(500),
      to: safe,
      value: 0n,
      input: encodeFunctionData({
        abi: SAFE_ABI,
        functionName: "execTransaction",
        args: [intent.safeTx.to, intent.safeTx.value, intent.safeTx.data, intent.safeTx.operation, intent.safeTx.safeTxGas, intent.safeTx.baseGas, intent.safeTx.gasPrice, intent.safeTx.gasToken, intent.safeTx.refundReceiver, `0x${"11".repeat(65)}`],
      }),
    });
  }
  return Object.freeze({ hash: h(500), to: intent.call.to, value: intent.call.value, input: intent.call.data });
}

function receipt(intent: PreparedPwaIntent, failure = false): PwaObserverReceipt {
  return Object.freeze({ transactionHash: h(500), status: "success", blockNumber: 100n, blockHash: h(100), logs: logs(intent, failure) });
}

function client(intent: PreparedPwaIntent, source: string, overrides: Partial<PwaObserverClient> = {}): PwaObserverClient {
  const before = state(intent, "before");
  const after = state(intent, "after");
  return Object.freeze({
    source,
    async getBlockNumber() { return 105n; },
    async getTransactionReceipt() { return receipt(intent); },
    async getTransaction() { return transaction(intent); },
    async getBlock({ blockNumber }) { return Object.freeze({ number: blockNumber, hash: blockNumber === 100n ? h(100) : h(99), timestamp: blockNumber === 100n ? 1_000n : 999n }); },
    async readStateAt(blockNumber) { return blockNumber === 100n ? after : before; },
    ...overrides,
  });
}

function binding(intent: PreparedPwaIntent, overrides: Partial<PwaObserverBinding> = {}): PwaObserverBinding {
  return Object.freeze({
    intent,
    profileHash: h(94),
    topologyReportHash: h(93),
    confirmations: 6,
    observer: Object.freeze({ processId: "observer-fixture-1", executableHash: h(95), startedAt: "2026-10-31T20:00:00.000Z" }),
    clients: Object.freeze([client(intent, "provider-a"), client(intent, "provider-b")]),
    ...overrides,
  });
}

describe("independent PWA receipt observer", () => {
  it("observes delayed recipient addition, exact policy execution and expired maintenance skip", async () => {
    for (const kind of ["add", "repair", "skip"] as const) {
      const intent = prepared(kind);
      const at = kind === "skip" ? { async getBlock({ blockNumber }: { blockNumber: bigint }) { return { number: blockNumber, hash: blockNumber === 100n ? h(100) : h(99), timestamp: 1600n }; } } : {};
      const record = await observePwaReceipt(binding(intent, { clients: [client(intent, "a", at), client(intent, "b", at)] }), h(500));
      expect(record.kind).to.equal(intent.kind);
      expect(JSON.parse(serializePwaObserverRecord(record)).kind).to.equal(intent.kind);
    }
    const intent = prepared("repair");
    const wrongPolicy = policy([recipient, a(98)]);
    const badState = { ...state(intent, "after"), policy: wrongPolicy, policyHash: policyHash(wrongPolicy) };
    const wrong = { async readStateAt(block: bigint) { return block === 100n ? badState : state(intent, "before"); } };
    await expect(observePwaReceipt(binding(intent, { clients: [client(intent, "a", wrong), client(intent, "b", wrong)] }), h(500))).to.be.rejectedWith(/policy|repair|recipient/i);
  });

  it("accepts canonical X, Y, queue, cancel, and ready execution receipts", async () => {
    for (const kind of ["base", "step-up", "queue", "cancel", "execute"] as const) {
      const intent = prepared(kind);
      const record = await observePwaReceipt(binding(intent), h(500));
      expect(record).to.include({ kind: intent.kind, transactionHash: h(500), blockHash: h(100), profileHash: h(94), topologyReportHash: h(93), notificationDelivery: "not-claimed" });
      expect(record.observer.processId).to.equal("observer-fixture-1");
      expect(record.sources).to.deep.equal(["provider-a", "provider-b"]);
    }
  });

  it("observes the first send and daily rollover using effective anchored counters", async () => {
    for (const beforeSpend of [{ window: 0n, baseSpent: 0n, instantSpent: 0n }, { window: 0n, baseSpent: 1_000_000n, instantSpent: 3_000_000n }]) {
      const intent = preparePwaIntent(snapshot({ timestamp: 172_801n, spendState: beforeSpend }), { kind: "transfer", recipient, amount: 1_000_000n });
      const before = { ...state(intent, "before"), spendState: beforeSpend };
      const after = { ...state(intent, "after"), spendState: { window: 172_800n, baseSpent: 1_000_000n, instantSpent: 1_000_000n } };
      const overrides: Partial<PwaObserverClient> = {
        async readStateAt(block) { return block === 100n ? after : before; },
        async getBlock({ blockNumber }) { return { number: blockNumber, hash: blockNumber === 100n ? h(100) : h(99), timestamp: 172_801n }; },
        async getTransactionReceipt() {
          const original = receipt(intent);
          const transfer = eventLog(guard, encodeEventTopics({ abi: GUARD_ABI, eventName: "TransferAuthorized" }), encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [0, usdc, recipient, 1_000_000n, 1_000_000n, 1_000_000n, 172_800n]), 1);
          return { ...original, logs: [original.logs[0]!, transfer] };
        },
      };
      expect((await observePwaReceipt(binding(intent, { clients: [client(intent, "a", overrides), client(intent, "b", overrides)] }), h(500))).kind).to.equal("base-transfer");
      const future = { ...overrides, async readStateAt(block: bigint) { return block === 100n ? after : { ...before, spendState: { ...beforeSpend, window: 259_200n } }; } };
      await expect(observePwaReceipt(binding(intent, { clients: [client(intent, "a", future), client(intent, "b", future)] }), h(500))).to.be.rejectedWith(/future|window/i);
    }
  });

  it("observes self-alias base, step-up, queued and delayed transfers with exact token effects", async () => {
    const selfPolicy = policy([recipient, safe]);
    const selfSnapshot = (overrides: Partial<VerifiedPwaSnapshot> = {}) => snapshot({ elevatedRecipients: [recipient, safe], policyHash: policyHash(selfPolicy), ...overrides });
    const queuedIntent = preparePwaIntent(selfSnapshot(), { kind: "transfer", recipient: safe, amount: 4_000_000n });
    const queueHead = { ...queuedIntent.queue!, safe, delay, createdAt: 800n, readyAt: 920n, expiresAt: 1520n };
    const delayed = preparePwaIntent(selfSnapshot({ queueHead, queueTailNonce: 5n }), { kind: "execute-ready", queueNonce: queueHead.queueNonce, queueFingerprint: queueHead.queueFingerprint });
    const transferAbi = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
    const intents = [
      preparePwaIntent(selfSnapshot(), { kind: "transfer", recipient: safe, amount: 1_000_000n }),
      preparePwaIntent(selfSnapshot({ spendState: { window: 0n, baseSpent: 1_000_000n, instantSpent: 1_000_000n } }), { kind: "transfer", recipient: safe, amount: 2_000_000n }),
      queuedIntent,
      delayed,
    ];
    for (const intent of intents) {
      const isTransfer = intent.kind !== "queue-transfer";
      const observedState = (phase: "before" | "after"): PwaObservedState => ({ ...state(intent, phase), policy: selfPolicy, policyHash: policyHash(selfPolicy), safeUsdcBalance: 8_000_000n, recipientUsdcBalance: 8_000_000n });
      const transfer = (amount = intent.amount) => eventLog(usdc, encodeEventTopics({ abi: transferAbi, eventName: "Transfer", args: { from: safe, to: safe } }), encodeAbiParameters([{ type: "uint256" }], [amount]), 3);
      const selfReceipt = () => {
        const original = receipt(intent);
        const output = original.logs.filter(log => log.address !== guard);
        if (intent.kind === "base-transfer" || intent.kind === "step-up-transfer") {
          const spent = observedState("after").spendState;
          output.push(eventLog(guard, encodeEventTopics({ abi: GUARD_ABI, eventName: "TransferAuthorized" }), encodeAbiParameters([{ type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [intent.kind === "base-transfer" ? 0 : 1, usdc, safe, intent.amount, spent.baseSpent, spent.instantSpent, spent.window]), 1));
        }
        if (isTransfer) output.push(transfer());
        return { ...original, logs: output };
      };
      const ownClient = (source: string, overrides: Partial<PwaObserverClient> = {}) => client(intent, source, { async readStateAt(block) { return observedState(block === 100n ? "after" : "before"); }, async getTransactionReceipt() { return selfReceipt(); }, ...overrides });
      const run = (overrides: Partial<PwaObserverClient> = {}) => observePwaReceipt(binding(intent, { clients: [ownClient("a", overrides), ownClient("b", overrides)] }), h(500));
      expect((await run()).kind).to.equal(intent.kind);
      if (isTransfer) {
        await expect(run({ async getTransactionReceipt() { const original = selfReceipt(); return { ...original, logs: original.logs.filter(log => log.address !== usdc) }; } })).to.be.rejectedWith(/self|transfer|token/i);
        await expect(run({ async getTransactionReceipt() { const original = selfReceipt(); return { ...original, logs: [...original.logs.filter(log => log.address !== usdc), transfer(intent.amount + 1n)] }; } })).to.be.rejectedWith(/self|transfer|token/i);
        await expect(run({ async readStateAt(block) { const current = observedState(block === 100n ? "after" : "before"); return { ...current, recipientUsdcBalance: current.recipientUsdcBalance + 1n }; } })).to.be.rejectedWith(/self|balance|alias/i);
        await expect(run({ async getTransactionReceipt() { const original = selfReceipt(); return { ...original, logs: [...original.logs, transfer()] }; } })).to.be.rejectedWith(/self|transfer|token/i);
        await expect(run({ async readStateAt(block) { const current = observedState(block === 100n ? "after" : "before"); return block === 100n ? { ...current, safeUsdcBalance: current.safeUsdcBalance + 1n, recipientUsdcBalance: current.recipientUsdcBalance + 1n } : current; } })).to.be.rejectedWith(/self|balance|alias/i);
      }
    }
    expect(queuedIntent.queue!.data).not.to.equal(preparePwaIntent(snapshot(), { kind: "transfer", recipient, amount: 4_000_000n }).queue!.data);
    expect(queuedIntent.queue!.queueFingerprint).not.to.equal(preparePwaIntent(snapshot(), { kind: "transfer", recipient, amount: 4_000_000n }).queue!.queueFingerprint);
  });

  it("rejects outer success with inner failure, wrong events, stale queues, and state-effect mismatches", async () => {
    const base = prepared("base");
    await expect(observePwaReceipt(binding(base, { clients: [client(base, "a", { async getTransactionReceipt() { return receipt(base, true); } }), client(base, "b", { async getTransactionReceipt() { return receipt(base, true); } })] }), h(500))).to.be.rejectedWith(/inner|failure/i);
    await expect(observePwaReceipt(binding(base, { clients: [client(base, "a", { async getTransactionReceipt() { return { ...receipt(base), logs: receipt(base).logs.slice(0, 1) }; } }), client(base, "b", { async getTransactionReceipt() { return { ...receipt(base), logs: receipt(base).logs.slice(0, 1) }; } })] }), h(500))).to.be.rejectedWith(/event|effect/i);

    const cancel = prepared("cancel");
    const stale = { ...state(cancel, "after"), queueHeadNonce: 4n, queueHead: queued() };
    await expect(observePwaReceipt(binding(cancel, { clients: [client(cancel, "a", { async readStateAt(block) { return block === 100n ? stale : state(cancel, "before"); } }), client(cancel, "b", { async readStateAt(block) { return block === 100n ? stale : state(cancel, "before"); } })] }), h(500))).to.be.rejectedWith(/queue|effect/i);

    const execute = prepared("execute");
    const wrongBalance = { ...state(execute, "after"), safeUsdcBalance: 8_000_000n };
    await expect(observePwaReceipt(binding(execute, { clients: [client(execute, "a", { async readStateAt(block) { return block === 100n ? wrongBalance : state(execute, "before"); } }), client(execute, "b", { async readStateAt(block) { return block === 100n ? wrongBalance : state(execute, "before"); } })] }), h(500))).to.be.rejectedWith(/balance|effect/i);
  });

  it("rejects missing/unconfirmed/reorged receipts and disagreement between independent RPC views", async () => {
    const intent = prepared("base");
    await expect(observePwaReceipt(binding(intent, { clients: [client(intent, "a", { async getTransactionReceipt() { return null; } }), client(intent, "b")] }), h(500))).to.be.rejectedWith(/missing|receipt/i);
    await expect(observePwaReceipt(binding(intent, { clients: [client(intent, "a", { async getBlockNumber() { return 104n; } }), client(intent, "b", { async getBlockNumber() { return 104n; } })] }), h(500))).to.be.rejectedWith(/confirmation/i);
    await expect(observePwaReceipt(binding(intent, { clients: [client(intent, "a", { async getBlock() { return { number: 100n, hash: h(999), timestamp: 1_000n }; } }), client(intent, "b", { async getBlock() { return { number: 100n, hash: h(999), timestamp: 1_000n }; } })] }), h(500))).to.be.rejectedWith(/canonical|reorg|block/i);
    await expect(observePwaReceipt(binding(intent, { clients: [client(intent, "same-provider"), client(intent, "same-provider")] }), h(500))).to.be.rejectedWith(/independent|source/i);
    await expect(observePwaReceipt(binding(intent, { clients: [client(intent, "a"), client(intent, "b", { async getTransaction() { return { ...transaction(intent), input: "0x" }; } })] }), h(500))).to.be.rejectedWith(/disagree|envelope/i);
    await expect(observePwaReceipt(binding(intent, { clients: [client(intent, "https://rpc.example/?apiKey=secret"), client(intent, "provider-b")] }), h(500))).to.be.rejectedWith(/source|identifier/i);
  });

  it("accepts harmless provider head drift and enforces the half-open Delay execution interval", async () => {
    const base = prepared("base");
    const observed = await observePwaReceipt(binding(base, { clients: [client(base, "a", { async getBlockNumber() { return 105n; } }), client(base, "b", { async getBlockNumber() { return 106n; } })] }), h(500));
    expect(observed.transactionHash).to.equal(h(500));

    const execute = prepared("execute");
    const at = (timestamp: bigint) => ({ async getBlock({ blockNumber }: { blockNumber: bigint }) { return { number: blockNumber, hash: blockNumber === 100n ? h(100) : h(99), timestamp: blockNumber === 100n ? timestamp : timestamp - 1n }; } });
    await expect(observePwaReceipt(binding(execute, { clients: [client(execute, "a", at(919n)), client(execute, "b", at(919n))] }), h(500))).to.be.rejectedWith(/ready interval/i);
    await expect(observePwaReceipt(binding(execute, { clients: [client(execute, "a", at(1520n)), client(execute, "b", at(1520n))] }), h(500))).to.be.rejectedWith(/ready interval/i);
  });

  it("rejects clients with signing/write capability and any notification-delivery claim", async () => {
    const intent = prepared("base");
    const writable = { ...client(intent, "provider-a"), sendRawTransaction: async () => h(1) } as unknown as PwaObserverClient;
    await expect(observePwaReceipt(binding(intent, { clients: [writable, client(intent, "provider-b")] }), h(500))).to.be.rejectedWith(/read.only|write|sign/i);
    const inheritedWrite = Object.assign(Object.create({ sendRawTransaction: async () => h(1) }), client(intent, "provider-a")) as PwaObserverClient;
    await expect(observePwaReceipt(binding(intent, { clients: [inheritedWrite, client(intent, "provider-b")] }), h(500))).to.be.rejectedWith(/plain|read.only|write|sign/i);
    await expect(observePwaReceipt({ ...binding(intent), notificationDelivery: "delivered" } as unknown as PwaObserverBinding, h(500))).to.be.rejectedWith(/notification/i);
  });
});
