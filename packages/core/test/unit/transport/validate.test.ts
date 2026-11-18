import { expect } from "chai";
import { getAddress, hashTypedData, keccak256, type Address, type Hex } from "viem";
import { queueFingerprint } from "../../../../sdk/src/queue/delay";
import { SAFE_TX_TYPES, type SafeTxMessage } from "../../../../sdk/src/signers/types";
import {
  snapshotSubmissionRequest,
  type DelayExecutionRequest,
  type SafeExecutionRequest,
  type SubmissionRequest,
} from "../../../../sdk/src/transport/validate";

const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const sig = `0x${"11".repeat(65)}` as Hex;

const safe = a(1);
const guard = a(2);
const asset = a(3);
const delay = a(4);
const recipient = a(5);
const zero = a(0);

const transaction: SafeTxMessage = {
  to: recipient,
  value: 42n,
  data: "0x" as Hex,
  operation: 0,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: zero,
  refundReceiver: zero,
  nonce: 9n,
};

const safeTxHash = hashTypedData({
  domain: { chainId: 11155111, verifyingContract: safe },
  types: { SafeTx: SAFE_TX_TYPES },
  primaryType: "SafeTx",
  message: transaction,
});

const safeRequest = (): SafeExecutionRequest => ({
  version: 1,
  kind: "safe-execution",
  idempotencyKey: h(100),
  chainId: 11155111,
  deploymentsHash: h(101),
  policyHash: h(102),
  safe,
  guard,
  asset,
  transaction,
  safeTxHash,
  signatures: sig,
  expectedSpend: { window: 86400n, baseSpent: 10n, instantSpent: 42n },
});

const delayRequest = (): DelayExecutionRequest => {
  const request = {
    version: 1,
    kind: "delay-execution",
    idempotencyKey: h(200),
    chainId: 11155111,
    deploymentsHash: h(201),
    policyHash: h(202),
    safe,
    guard,
    delay,
    queueNonce: 7n,
    queueFingerprint: "0x" as Hex,
    to: recipient,
    value: 44n,
    data: "0x1234" as Hex,
    operation: 0 as const,
    createdAt: 123n,
    cooldownSeconds: 3600n,
    expirationSeconds: 86400n,
  };
  return { ...request, queueFingerprint: queueFingerprint(request) };
};

describe("submission request validation", () => {
  it("snapshots safe execution requests with exact keys and immutable nested values", () => {
    const snapshot = snapshotSubmissionRequest(safeRequest());

    expect(snapshot).to.deep.equal(safeRequest());
    expect(Object.isFrozen(snapshot)).to.equal(true);
    expect(Object.isFrozen((snapshot as SafeExecutionRequest).transaction)).to.equal(true);
    expect(Object.isFrozen((snapshot as SafeExecutionRequest).expectedSpend)).to.equal(true);
  });

  it("rejects missing, unknown, and sensitive safe execution fields", () => {
    const missing = { ...safeRequest() } as Record<string, unknown>;
    delete missing.policyHash;
    expect(() => snapshotSubmissionRequest(missing)).to.throw(/policyHash|required|canonical|field/i);
    expect(() => snapshotSubmissionRequest({ ...safeRequest(), extra: true })).to.throw(/extra|unknown|sensitive/i);
    expect(() => snapshotSubmissionRequest({ ...safeRequest(), privateKey: h(1) })).to.throw(/privateKey|sensitive|unknown/i);
  });

  it("rejects one mutation or type mismatch in every safe execution field", () => {
    const cases: readonly Partial<Record<keyof SafeExecutionRequest, unknown>>[] = [
      { version: 2 },
      { kind: "delay-execution" },
      { idempotencyKey: "0x01" },
      { chainId: 1.5 },
      { deploymentsHash: "0x1234" },
      { policyHash: "0X" },
      { safe: "0x00000000000000000000000000000000000000aa" },
      { guard: "0x00000000000000000000000000000000000000zz" },
      { asset: 3 },
      { transaction: { ...transaction, value: "42" } },
      { safeTxHash: h(999) },
      { signatures: "0x1234" },
      { expectedSpend: { ...safeRequest().expectedSpend, baseSpent: -1n } },
    ];

    for (const patch of cases) {
      expect(() => snapshotSubmissionRequest({ ...safeRequest(), ...patch })).to.throw();
    }
  });

  it("rejects noncanonical nested Safe transaction and spend state values", () => {
    expect(() => snapshotSubmissionRequest({ ...safeRequest(), transaction: { ...transaction, operation: 1 } })).to.throw(/hash|operation|transaction/i);
    expect(() => snapshotSubmissionRequest({ ...safeRequest(), transaction: { ...transaction, extra: 1 } })).to.throw(/extra|transaction|unknown/i);
    expect(() => snapshotSubmissionRequest({ ...safeRequest(), expectedSpend: { ...safeRequest().expectedSpend, window: "86400" } })).to.throw(/window|bigint|spend/i);
  });

  it("accepts both Safe operation variants when the transaction hash binds the exact message", () => {
    const delegateCall = { ...transaction, operation: 1 as const };
    const safeTxHash = hashTypedData({
      domain: { chainId: 11155111, verifyingContract: safe },
      types: { SafeTx: SAFE_TX_TYPES },
      primaryType: "SafeTx",
      message: delegateCall,
    });

    const snapshot = snapshotSubmissionRequest({ ...safeRequest(), transaction: delegateCall, safeTxHash }) as SafeExecutionRequest;

    expect(snapshot.transaction.operation).to.equal(1);
  });

  it("snapshots delay execution requests and rejects fingerprint mismatches", () => {
    const snapshot = snapshotSubmissionRequest(delayRequest());

    expect(snapshot).to.deep.equal(delayRequest());
    expect(Object.isFrozen(snapshot)).to.equal(true);
    expect(() => snapshotSubmissionRequest({ ...delayRequest(), value: delayRequest().value + 1n })).to.throw(/fingerprint|queue/i);
    expect(() => snapshotSubmissionRequest({ ...delayRequest(), operation: 1 })).to.throw(/operation|fingerprint/i);
  });

  it("rejects one mutation or type mismatch in every delay execution field", () => {
    const cases: readonly Partial<Record<keyof DelayExecutionRequest, unknown>>[] = [
      { version: 2 },
      { kind: "safe-execution" },
      { idempotencyKey: "0x01" },
      { chainId: 0 },
      { deploymentsHash: "0x1234" },
      { policyHash: "0x1234" },
      { safe: "0x00000000000000000000000000000000000000aa" },
      { guard: 1 },
      { delay: "0x00000000000000000000000000000000000000ee" },
      { queueNonce: -1n },
      { queueFingerprint: h(999) },
      { to: "0x00000000000000000000000000000000000000cc" },
      { value: "44" },
      { data: "0x123" },
      { operation: 1 },
      { createdAt: 0 },
      { cooldownSeconds: -1n },
      { expirationSeconds: "86400" },
    ];

    for (const patch of cases) {
      expect(() => snapshotSubmissionRequest({ ...delayRequest(), ...patch })).to.throw();
    }
  });

  it("rejects malformed top-level input and unknown operation variants", () => {
    expect(() => snapshotSubmissionRequest(null)).to.throw(/object|request/i);
    expect(() => snapshotSubmissionRequest({ ...safeRequest(), kind: "other" })).to.throw(/kind|unsupported/i);
    expect(() => snapshotSubmissionRequest({ ...delayRequest(), extra: "field" })).to.throw(/extra|unknown|sensitive/i);
  });

  it("produces a snapshot isolated from later caller mutation", () => {
    const request = safeRequest();
    const snapshot = snapshotSubmissionRequest(request) as SubmissionRequest;
    (request.transaction as { value: bigint }).value = 999n;
    (request.expectedSpend as { baseSpent: bigint }).baseSpent = 999n;

    expect((snapshot as SafeExecutionRequest).transaction.value).to.equal(42n);
    expect((snapshot as SafeExecutionRequest).expectedSpend.baseSpent).to.equal(10n);
  });
});
