import { createHash } from "node:crypto";
import { encodeFunctionData, hashTypedData, isAddress, type Address, type Hex } from "viem";
import { queueFingerprint } from "../../src/queue/delay";
import { SAFE_TX_TYPES } from "../../src/signers/types";
import { sha256 } from "../plan-deployment";
import { hashHistoricalPrefix, isVerifiedHashlessStateCertificate, type VerifiedHashlessStateCertificate } from "./ordinary-scenario-hashless-certificate";
import type { OrdinaryScenarioJournal, OrdinaryScenarioProposal } from "./ordinary-scenario-executor";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const APPROVED_ORIGINAL_PROPOSAL_HASH = "0x22770c7944ee289543c10090b3483bdcd87f0d2c193887df4f32916c5782e45f" as Hex;
const APPROVED_HISTORICAL_PREFIX_HASH = "0x299d8cf298cf0a905046e4fbe569c44c2329b54207e159db551d41fee1dbb83d" as Hex;
const PHASE_LIMIT = 50_000_000_000_000_000n;
const MINIMUM_OBSERVER_TTL = 604_800n;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const DELAY_MODULE_ABI = [{ type: "function", name: "execTransactionFromModule", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }], outputs: [{ type: "bool" }] }] as const;
const DELAY_ABI = [{ type: "function", name: "executeNextTx", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }] }, { type: "function", name: "skipExpired", stateMutability: "nonpayable", inputs: [] }] as const;

const USDC_IDS = Object.freeze([
  "usdc-base-x", "usdc-step-up-contract", "usdc-recycle-topup-step-up", "usdc-step-up-ecdsa", "usdc-direct-overspend-rejection",
  "usdc-replay-rejection", "usdc-unsupported-path-rejection", "usdc-recycle-topup-delayed", "usdc-queue-cancel", "usdc-queue-cancel-early-rejection",
  "usdc-queue-cancel-action", "usdc-queue-cancelled-execution-rejection", "usdc-queue-expiry", "usdc-queue-expiry-early-rejection",
  "usdc-queue-expiry-skip", "usdc-queue-expired-execution-rejection", "usdc-queue-execute", "usdc-queue-execute-early-rejection", "usdc-queue-ready-execute",
] as const);

export type ContinuationObserverBinding = Readonly<{ kind: "https-webhook"; publicId: string; endpointHash: Hex; probeEvidenceHash: Hex; independentFromProposer: true; readyAt: string; expiresAt: string }>;
export type ContinuationActionCaps = Readonly<{ fundingGasLimit: string; safeExecutionGasLimit: string; publicDelayGasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string }>;
export type ContinuationSourceBinding = Readonly<{ originalReviewPackageHash: Hex; originalProposalHash: Hex; originalReviewArtifactBytesHash: Hex; originalApprovalHash: Hex; historicalActionCount: 19; historicalLiveEntryCount: 10; historicalPrefixHash: Hex; stoppedRow: Readonly<{ id: "native-queue-ready-execute"; commitment: Hex; materializationHash: Hex; prestateHash: Hex; requestHash: Hex; signatureBundleHash: null; signedCalldataHash: Hex; simulationEvidenceHash: Hex; outerDataHash: Hex; outerNonce: 809 }> }>;
type ContinuationState = Readonly<{ safeNonce: string; delayQueueNonce: string; delayTxNonce: string; safeNativeBalance: string; safeUsdcBalance: string; funderUsdcBalance: string; nativeBaseSpent: string; nativeInstantSpent: string; usdcBaseSpent: string; usdcInstantSpent: string; queueStatus: string; queueNonce: string | null; queueFingerprint: Hex | null }>;
type SerializedSafeTx = Readonly<{ to: Address; value: string; data: Hex; operation: 0; safeTxGas: "0"; baseGas: "0"; gasPrice: "0"; gasToken: Address; refundReceiver: Address; nonce: string }>;
export type ExpiredHashlessContinuationAction = Readonly<{ id: string; kind: string; asset: "native" | "USDC"; expectedOutcome: "success" | "rejection"; signerRoles: readonly string[]; dependsOn: readonly string[]; transaction: Readonly<{ to: Address; value: string; data: Hex; operation: 0 }>; safeTransaction?: SerializedSafeTx; safeTxHash?: Hex; queue?: Readonly<{ queueNonce: string; fingerprint: Hex; monitoringFingerprint: Hex; to: Address; value: string; data: Hex; operation: 0 }>; before: ContinuationState; after: ContinuationState; gasLimitCap: string; maxFeePerGasCap: string; maxPriorityFeePerGasCap: string; commitment: Hex }>;
declare const proposalBrand: unique symbol;
export type ExpiredHashlessContinuationProposal = Readonly<{ schemaVersion: 1; recoveryKind: "FIRST38_NATIVE_READY_HASHLESS_EXPIRED_V1"; authorization: "NONE"; chainId: 11155111; source: ContinuationSourceBinding; originalProposalHash: Hex; historicalPrefixHash: Hex; certificateHash: Hex; sourceCurrentSnapshotHash: Hex; observer: ContinuationObserverBinding; caps: ContinuationActionCaps; derivations: Readonly<{ outerEoaNonce: "CURRENT_GREATER_THAN_809_ONLY"; fees: "FROZEN_AT_OR_BELOW_ACTION_CAPS_AND_CANONICAL_BASEFEE"; gas: "POSITIVE_ESTIMATE_AT_OR_BELOW_ACTION_CAP"; queueTiming: "CANONICAL_RECEIPT_CREATED_AT_ONLY"; safeNonce: "FIXED"; delayQueueNonce: "FIXED"; delayTxNonce: "FIXED" }>; maxBroadcastAttempts: 1; reservation: Readonly<{ phaseLimitWei: string; originalActualGasCostWei: string; originalPrincipalWei: string; continuationMaximumReservationWei: string; maximumRemainingReservationWei: string; maximumCumulativeOutlayWei: string }>; actions: readonly ExpiredHashlessContinuationAction[]; proposalHash: Hex; readonly [proposalBrand]: true }>;
declare const approvalBrand: unique symbol;
export type ExpiredHashlessContinuationApproval = Readonly<{ approvalHash: Hex; readonly [approvalBrand]: true }>;
export type HashlessContinuationStorage = Readonly<{ schemaVersion: 1; recoveryKind: "FIRST38_NATIVE_READY_HASHLESS_EXPIRED_V1"; source: ContinuationSourceBinding; historicalActionCount: 19; historicalLiveEntryCount: 10; historicalPrefixHash: Hex; originalProposalHash: Hex; certificateHash: Hex; proposalHash: Hex; approvalHash: Hex; actionCommitments: readonly Readonly<{ id: string; commitment: Hex }>[]; cumulativeContinuationReservationWei: string; actions: Array<{ id: string; commitment: Hex; status: "approved" }> }>;

const proposals = new WeakSet<object>();
const approvals = new WeakMap<object, ExpiredHashlessContinuationProposal>();
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const publicHash = (value: unknown): Hex => sha256(publicValue(value)) as Hex;
const rawHash = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };
const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string) => { const actual = Object.keys(value).sort(); const wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} shape mismatch`); };
const decimal = (value: unknown, label: string) => { if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`); return BigInt(value); };
const hash = (value: unknown, label: string) => { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a hash`); return value as Hex; };

function assertOriginal(original: OrdinaryScenarioProposal): void {
  if (!original || typeof original !== "object") throw new Error("original proposal is unavailable");
  const { proposalHash: _ignored, ...body } = original;
  const recomputed = publicHash(body);
  if (!same(recomputed, APPROVED_ORIGINAL_PROPOSAL_HASH) || !same(original.proposalHash, APPROVED_ORIGINAL_PROPOSAL_HASH)) throw new Error("original proposal hash does not match the exact approved original");
  if (original.actions.length !== 38 || USDC_IDS.some((id, index) => original.actions[index + 19]?.id !== id)) throw new Error("original proposal exact USDC semantic tail mismatch");
}

function validateObserver(value: ContinuationObserverBinding, certificate: VerifiedHashlessStateCertificate, original: OrdinaryScenarioProposal): ContinuationObserverBinding {
  const object = value as unknown as Record<string, unknown>; exactKeys(object, ["kind", "publicId", "endpointHash", "probeEvidenceHash", "independentFromProposer", "readyAt", "expiresAt"], "continuation observer");
  if (value.kind !== "https-webhook" || value.independentFromProposer !== true || !value.publicId.startsWith("temporary-test-receiver:") || !HASH.test(value.endpointHash) || !HASH.test(value.probeEvidenceHash) || !value.publicId.endsWith(value.endpointHash) || same(value.endpointHash, value.probeEvidenceHash)) throw new Error("continuation observer binding is invalid");
  const ready = decimal(value.readyAt, "observer readyAt"), expires = decimal(value.expiresAt, "observer expiresAt");
  if (ready < certificate.currentSnapshot.block.timestamp || expires - ready < MINIMUM_OBSERVER_TTL || same(value.probeEvidenceHash, certificate.controlledStateHash) || same(value.probeEvidenceHash, original.observerEvidenceHash) || same(value.endpointHash, original.observerEvidenceHash)) throw new Error("continuation observer TTL, expiry, or fresh probe is invalid");
  return freeze({ ...value });
}
function validateCaps(value: ContinuationActionCaps): ContinuationActionCaps {
  exactKeys(value as unknown as Record<string, unknown>, ["fundingGasLimit", "safeExecutionGasLimit", "publicDelayGasLimit", "maxFeePerGas", "maxPriorityFeePerGas"], "continuation caps");
  const funding = decimal(value.fundingGasLimit, "funding gas cap"), safeGas = decimal(value.safeExecutionGasLimit, "Safe gas cap"), delayGas = decimal(value.publicDelayGasLimit, "Delay gas cap"), fee = decimal(value.maxFeePerGas, "max fee cap"), priority = decimal(value.maxPriorityFeePerGas, "priority fee cap");
  if (funding <= 0n || safeGas <= 0n || delayGas <= 0n || fee <= 0n || priority <= 0n || priority > fee) throw new Error("continuation action caps are invalid");
  return freeze({ ...value });
}
function safeTxHash(chainId: number, safe: Address, tx: SerializedSafeTx): Hex {
  return hashTypedData({ domain: { chainId, verifyingContract: safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { to: tx.to, value: BigInt(tx.value), data: tx.data, operation: tx.operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: BigInt(tx.nonce) } });
}
const baseState = (overrides: Partial<ContinuationState> = {}): ContinuationState => freeze({ safeNonce: "7", delayQueueNonce: "3", delayTxNonce: "2", safeNativeBalance: "1", safeUsdcBalance: "20000000", funderUsdcBalance: "20000000", nativeBaseSpent: "10000000000000", nativeInstantSpent: "30000000000000", usdcBaseSpent: "0", usdcInstantSpent: "0", queueStatus: "EXPIRED", queueNonce: "2", queueFingerprint: "0xbc952941d43eba0cc5b9f3f0e3b98e7984a10e085ab43d623e15224af13f4e67", ...overrides });

function action(input: Omit<ExpiredHashlessContinuationAction, "commitment">): ExpiredHashlessContinuationAction { return freeze({ ...input, commitment: publicHash(input) }); }

function nativeActions(original: OrdinaryScenarioProposal, caps: ContinuationActionCaps): ExpiredHashlessContinuationAction[] {
  const inner = { to: original.recipient, value: 1n, data: "0x" as Hex, operation: 0 as const };
  const fingerprint = queueFingerprint({ safe: original.safe, delay: original.delay, ...inner, queueNonce: 3n });
  const monitoringFingerprint = publicHash({ chainId: original.chainId, safe: original.safe, delay: original.delay, queueNonce: "3", fingerprint });
  const skipData = encodeFunctionData({ abi: DELAY_ABI, functionName: "skipExpired" });
  const queueData = encodeFunctionData({ abi: DELAY_MODULE_ABI, functionName: "execTransactionFromModule", args: [inner.to, inner.value, inner.data, inner.operation] });
  const executeData = encodeFunctionData({ abi: DELAY_ABI, functionName: "executeNextTx", args: [inner.to, inner.value, inner.data, inner.operation] });
  const queueTx: SerializedSafeTx = freeze({ to: original.delay, value: "0", data: queueData, operation: 0, safeTxGas: "0", baseGas: "0", gasPrice: "0", gasToken: ZERO, refundReceiver: ZERO, nonce: "7" });
  const q = freeze({ queueNonce: "3", fingerprint, monitoringFingerprint, to: inner.to, value: "1", data: inner.data, operation: 0 as const });
  return [
    action({ id: "native-queue-ready-hashless-skip", kind: "queue-expiry", asset: "native", expectedOutcome: "success", signerRoles: [], dependsOn: [], transaction: { to: original.delay, value: "0", data: skipData, operation: 0 }, queue: freeze({ queueNonce: "2", fingerprint: baseState().queueFingerprint!, monitoringFingerprint: publicHash({ source: "historical-item-2" }), to: original.recipient, value: "1", data: "0x", operation: 0 }), before: baseState(), after: baseState({ delayTxNonce: "3", queueStatus: "EXPIRED_SKIPPED" }), gasLimitCap: caps.publicDelayGasLimit, maxFeePerGasCap: caps.maxFeePerGas, maxPriorityFeePerGasCap: caps.maxPriorityFeePerGas }),
    action({ id: "native-queue-ready-replacement", kind: "queue-proposal", asset: "native", expectedOutcome: "success", signerRoles: ["primary-passkey", "safe-contract-secondary"], dependsOn: ["native-queue-ready-hashless-skip"], transaction: { to: original.delay, value: "0", data: queueData, operation: 0 }, safeTransaction: queueTx, safeTxHash: safeTxHash(original.chainId, original.safe, queueTx), queue: q, before: baseState({ delayTxNonce: "3", queueStatus: "EXPIRED_SKIPPED" }), after: baseState({ safeNonce: "8", delayQueueNonce: "4", delayTxNonce: "3", queueStatus: "QUEUED", queueNonce: "3", queueFingerprint: fingerprint }), gasLimitCap: caps.safeExecutionGasLimit, maxFeePerGasCap: caps.maxFeePerGas, maxPriorityFeePerGasCap: caps.maxPriorityFeePerGas }),
    action({ id: "native-queue-ready-replacement-execute", kind: "ready-delay-execution", asset: "native", expectedOutcome: "success", signerRoles: [], dependsOn: ["native-queue-ready-replacement"], transaction: { to: original.delay, value: "0", data: executeData, operation: 0 }, queue: q, before: baseState({ safeNonce: "8", delayQueueNonce: "4", delayTxNonce: "3", queueStatus: "QUEUED", queueNonce: "3", queueFingerprint: fingerprint }), after: baseState({ safeNonce: "8", delayQueueNonce: "4", delayTxNonce: "4", safeNativeBalance: "0", queueStatus: "EXECUTED", queueNonce: "3", queueFingerprint: fingerprint }), gasLimitCap: caps.publicDelayGasLimit, maxFeePerGasCap: caps.maxFeePerGas, maxPriorityFeePerGasCap: caps.maxPriorityFeePerGas }),
  ];
}

function rebaseUsdc(original: OrdinaryScenarioProposal, caps: ContinuationActionCaps, replacementFingerprint: Hex): ExpiredHashlessContinuationAction[] {
  const queueMap = new Map<string, Readonly<{ queueNonce: string; fingerprint: Hex; monitoringFingerprint: Hex; to: Address; value: string; data: Hex; operation: 0 }>>();
  const fingerprintMap = new Map<string, Hex>([["0xbc952941d43eba0cc5b9f3f0e3b98e7984a10e085ab43d623e15224af13f4e67", replacementFingerprint]]);
  return original.actions.slice(19).map((source, index) => {
    const safe = source.safeTransaction ? freeze({ to: source.safeTransaction.to, value: source.safeTransaction.value.toString(), data: source.safeTransaction.data, operation: 0 as const, safeTxGas: "0" as const, baseGas: "0" as const, gasPrice: "0" as const, gasToken: source.safeTransaction.gasToken, refundReceiver: source.safeTransaction.refundReceiver, nonce: (source.safeTransaction.safeNonce + 1n).toString() }) : undefined;
    let queue: ExpiredHashlessContinuationAction["queue"];
    if (source.queue) {
      const key = `${source.queue.to.toLowerCase()}:${source.queue.value}:${source.queue.data.toLowerCase()}`;
      const queueNonce = source.queue.queueNonce + 1n;
      queue = queueMap.get(key);
      if (!queue || queue.queueNonce !== queueNonce.toString()) {
        const fingerprint = queueFingerprint({ safe: original.safe, delay: original.delay, to: source.queue.to, value: source.queue.value, data: source.queue.data, operation: 0, queueNonce });
        queue = freeze({ queueNonce: queueNonce.toString(), fingerprint, monitoringFingerprint: publicHash({ chainId: original.chainId, safe: original.safe, delay: original.delay, queueNonce: queueNonce.toString(), fingerprint }), to: source.queue.to, value: source.queue.value.toString(), data: source.queue.data, operation: 0 });
        queueMap.set(key, queue);
      }
      fingerprintMap.set(source.queue.fingerprint.toLowerCase(), queue.fingerprint);
    }
    const shift = (state: typeof source.before): ContinuationState => freeze({ safeNonce: (BigInt(state.safeNonce) + 1n).toString(), delayQueueNonce: (BigInt(state.delayQueueNonce) + 1n).toString(), delayTxNonce: (BigInt(state.delayTxNonce) + 1n).toString(), safeNativeBalance: "0", safeUsdcBalance: state.safeUsdcBalance, funderUsdcBalance: state.funderUsdcBalance, nativeBaseSpent: state.nativeBaseSpent, nativeInstantSpent: state.nativeInstantSpent, usdcBaseSpent: state.usdcBaseSpent, usdcInstantSpent: state.usdcInstantSpent, queueStatus: state.queueStatus, queueNonce: state.queueNonce === null ? null : (BigInt(state.queueNonce) + 1n).toString(), queueFingerprint: state.queueFingerprint === null ? null : fingerprintMap.get(state.queueFingerprint.toLowerCase()) ?? (() => { throw new Error(`${source.id} stale queue fingerprint cannot be rebased`); })() });
    const transaction = safe ? { to: safe.to, value: safe.value, data: safe.data, operation: 0 as const } : { to: source.publicTransaction!.to, value: source.publicTransaction!.value.toString(), data: source.publicTransaction!.data, operation: 0 as const };
    const dependsOn = source.id === "usdc-base-x" ? source.dependsOn.map(id => id === "native-queue-ready-execute" ? "native-queue-ready-replacement-execute" : id) : [...source.dependsOn];
    const gasLimitCap = source.kind === "controlled-recipient-recycled-funding" ? caps.fundingGasLimit : safe ? caps.safeExecutionGasLimit : caps.publicDelayGasLimit;
    return action({ id: source.id, kind: source.kind, asset: "USDC", expectedOutcome: source.expectedOutcome, signerRoles: [...source.signerRoles], dependsOn, transaction, safeTransaction: safe, safeTxHash: safe ? safeTxHash(original.chainId, original.safe, safe) : undefined, queue, before: shift(source.before), after: shift(source.after), gasLimitCap, maxFeePerGasCap: caps.maxFeePerGas, maxPriorityFeePerGasCap: caps.maxPriorityFeePerGas });
  });
}

export function createExpiredHashlessContinuationProposal(input: Readonly<{ original: OrdinaryScenarioProposal; journal: OrdinaryScenarioJournal; certificate: VerifiedHashlessStateCertificate; observer: ContinuationObserverBinding; caps: ContinuationActionCaps }>): ExpiredHashlessContinuationProposal {
  assertOriginal(input.original);
  if (!isVerifiedHashlessStateCertificate(input.certificate) || input.certificate.classification !== "EXPIRED_UNEXECUTED") throw new Error("continuation requires an opaque verified hashless certificate");
  if (!same(hashHistoricalPrefix(input.journal), APPROVED_HISTORICAL_PREFIX_HASH) || input.journal.actions.length !== 19 || input.journal.liveJournal.entries.length !== 10) throw new Error("continuation historical journal prefix mismatch");
  const observer = validateObserver(input.observer, input.certificate, input.original), caps = validateCaps(input.caps);
  const native = nativeActions(input.original, caps); const replacementFingerprint = native[1]!.queue!.fingerprint;
  const actions = freeze([...native, ...rebaseUsdc(input.original, caps, replacementFingerprint)]);
  if (actions.length !== 22) throw new Error("continuation must contain exactly 22 actions");
  const originalActualGasCost = BigInt(input.original.baselineActualCostWei) + input.journal.actions.reduce((sum, row) => sum + BigInt(row.ourReceiptGasCost ?? "0"), 0n);
  const originalPrincipal = 60_000_000_000_001n;
  const continuationReservation = actions.filter(item => item.expectedOutcome === "success").reduce((sum, item) => sum + BigInt(item.gasLimitCap) * BigInt(item.maxFeePerGasCap), 1n);
  const maximumRemainingReservation = PHASE_LIMIT - originalActualGasCost - originalPrincipal;
  const maximumCumulative = originalActualGasCost + originalPrincipal + continuationReservation;
  if (maximumRemainingReservation < 0n || continuationReservation > maximumRemainingReservation) throw new Error("continuation reservation exceeds the 0.05 ETH phase ceiling");
  const stopped = input.journal.actions[18]!;
  const source = freeze({ originalReviewPackageHash: input.original.reviewPackageHash, originalProposalHash: APPROVED_ORIGINAL_PROPOSAL_HASH, originalReviewArtifactBytesHash: input.original.reviewArtifactBytesHash, originalApprovalHash: input.journal.approvalHash, historicalActionCount: 19 as const, historicalLiveEntryCount: 10 as const, historicalPrefixHash: APPROVED_HISTORICAL_PREFIX_HASH, stoppedRow: freeze({ id: "native-queue-ready-execute" as const, commitment: stopped.commitment, materializationHash: stopped.materializationHash!, prestateHash: stopped.prestateHash!, requestHash: stopped.requestHash!, signatureBundleHash: null, signedCalldataHash: stopped.signedCalldataHash!, simulationEvidenceHash: stopped.simulationEvidenceHash!, outerDataHash: stopped.outerDataHash!, outerNonce: 809 as const }) });
  if (Object.values(source.stoppedRow).some(value => value === undefined)) throw new Error("continuation stopped source row is incomplete");
  const body = { schemaVersion: 1 as const, recoveryKind: "FIRST38_NATIVE_READY_HASHLESS_EXPIRED_V1" as const, authorization: "NONE" as const, chainId: 11155111 as const, source, originalProposalHash: APPROVED_ORIGINAL_PROPOSAL_HASH, historicalPrefixHash: APPROVED_HISTORICAL_PREFIX_HASH, certificateHash: input.certificate.certificateHash, sourceCurrentSnapshotHash: publicHash(input.certificate.currentSnapshot), observer, caps, derivations: freeze({ outerEoaNonce: "CURRENT_GREATER_THAN_809_ONLY" as const, fees: "FROZEN_AT_OR_BELOW_ACTION_CAPS_AND_CANONICAL_BASEFEE" as const, gas: "POSITIVE_ESTIMATE_AT_OR_BELOW_ACTION_CAP" as const, queueTiming: "CANONICAL_RECEIPT_CREATED_AT_ONLY" as const, safeNonce: "FIXED" as const, delayQueueNonce: "FIXED" as const, delayTxNonce: "FIXED" as const }), maxBroadcastAttempts: 1 as const, reservation: freeze({ phaseLimitWei: PHASE_LIMIT.toString(), originalActualGasCostWei: originalActualGasCost.toString(), originalPrincipalWei: originalPrincipal.toString(), continuationMaximumReservationWei: continuationReservation.toString(), maximumRemainingReservationWei: maximumRemainingReservation.toString(), maximumCumulativeOutlayWei: maximumCumulative.toString() }), actions };
  const proposal = freeze({ ...body, proposalHash: publicHash(body) }) as unknown as ExpiredHashlessContinuationProposal; proposals.add(proposal); return proposal;
}

export function parseExpiredHashlessContinuationProposal(serialized: string, original: OrdinaryScenarioProposal, journal: OrdinaryScenarioJournal, certificate: VerifiedHashlessStateCertificate): ExpiredHashlessContinuationProposal {
  if (Buffer.byteLength(serialized, "utf8") > 2_000_000) throw new Error("continuation proposal is too large");
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("continuation proposal must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("continuation proposal must be an object");
  const value = parsed as Record<string, unknown>;
  exactKeys(value, ["schemaVersion", "recoveryKind", "authorization", "chainId", "source", "originalProposalHash", "historicalPrefixHash", "certificateHash", "sourceCurrentSnapshotHash", "observer", "caps", "derivations", "maxBroadcastAttempts", "reservation", "actions", "proposalHash"], "continuation proposal");
  const expected = createExpiredHashlessContinuationProposal({ original, journal, certificate, observer: value.observer as ContinuationObserverBinding, caps: value.caps as ContinuationActionCaps });
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("continuation proposal shape, type, commitment, or hash drift");
  return expected;
}

export function loadExpiredHashlessContinuationApproval(proposal: ExpiredHashlessContinuationProposal, serializedApproval: string, expectedApprovalHash: Hex): ExpiredHashlessContinuationApproval {
  if (!proposals.has(proposal)) throw new Error("continuation proposal is not opaque");
  let parsed: unknown; try { parsed = JSON.parse(serializedApproval); } catch { throw new Error("continuation approval must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("continuation approval must be an object");
  const value = parsed as Record<string, unknown>; exactKeys(value, ["schemaVersion", "scope", "authorization", "proposalHash", "certificateHash", "observer", "caps", "reservation", "derivations", "maxBroadcastAttempts", "approvedActions"], "continuation approval");
  const approvalHash = publicHash(value);
  if (!HASH.test(expectedApprovalHash) || !same(approvalHash, expectedApprovalHash)) throw new Error("continuation approval hash mismatch");
  if (value.schemaVersion !== 1 || value.scope !== "first38-native-ready-hashless-expired-v1" || value.authorization !== "EXPLICIT_GROUP_APPROVAL" || value.maxBroadcastAttempts !== 1 || value.proposalHash !== proposal.proposalHash || value.certificateHash !== proposal.certificateHash || JSON.stringify(value.observer) !== JSON.stringify(proposal.observer) || JSON.stringify(value.caps) !== JSON.stringify(proposal.caps) || JSON.stringify(value.reservation) !== JSON.stringify(proposal.reservation) || JSON.stringify(value.derivations) !== JSON.stringify(proposal.derivations)) throw new Error("continuation approval exact binding mismatch");
  const approved = value.approvedActions;
  if (!Array.isArray(approved) || approved.length !== proposal.actions.length) throw new Error("continuation approval action count mismatch");
  for (let index = 0; index < approved.length; index++) { const item = approved[index]; if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("continuation approved action shape mismatch"); exactKeys(item as Record<string, unknown>, ["id", "commitment"], "continuation approved action"); if ((item as any).id !== proposal.actions[index]!.id || !same(hash((item as any).commitment, "approved commitment"), proposal.actions[index]!.commitment)) throw new Error("continuation approval action mismatch"); }
  const approval = freeze({ approvalHash }) as ExpiredHashlessContinuationApproval; approvals.set(approval, proposal); return approval;
}

export function assertExpiredHashlessContinuationAuthorization(proposal: ExpiredHashlessContinuationProposal, approval: ExpiredHashlessContinuationApproval): void {
  if (!proposals.has(proposal) || approvals.get(approval) !== proposal) throw new Error("expired hashless continuation authorization is not opaque and exactly bound");
}

export function attachExpiredHashlessContinuation(journal: OrdinaryScenarioJournal, proposal: ExpiredHashlessContinuationProposal, approval: ExpiredHashlessContinuationApproval): OrdinaryScenarioJournal & { hashlessContinuation: HashlessContinuationStorage } {
  assertExpiredHashlessContinuationAuthorization(proposal, approval);
  if (!same(hashHistoricalPrefix(journal), proposal.historicalPrefixHash) || journal.actions.length !== 19 || journal.liveJournal.entries.length !== 10) throw new Error("continuation journal historical prefix changed before attachment");
  const storage: HashlessContinuationStorage = freeze({ schemaVersion: 1, recoveryKind: proposal.recoveryKind, source: proposal.source, historicalActionCount: 19, historicalLiveEntryCount: 10, historicalPrefixHash: proposal.historicalPrefixHash, originalProposalHash: proposal.originalProposalHash, certificateHash: proposal.certificateHash, proposalHash: proposal.proposalHash, approvalHash: approval.approvalHash, actionCommitments: proposal.actions.map(({ id, commitment }) => freeze({ id, commitment })), cumulativeContinuationReservationWei: proposal.reservation.continuationMaximumReservationWei, actions: proposal.actions.map(({ id, commitment }) => ({ id, commitment, status: "approved" as const })) });
  (journal as OrdinaryScenarioJournal & { hashlessContinuation: HashlessContinuationStorage }).hashlessContinuation = storage;
  return journal as OrdinaryScenarioJournal & { hashlessContinuation: HashlessContinuationStorage };
}
