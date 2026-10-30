import { hashTypedData, type Hex } from "viem";
import { queueFingerprint, queueMonitoringFingerprint } from "../../src/queue/delay";
import { SAFE_TX_TYPES } from "../../src/signers/types";
import { sha256 } from "../plan-deployment";
import type { OrdinaryScenarioActionRecord, OrdinaryScenarioJournal } from "./ordinary-scenario-executor";
import {
  hashUsdcRecycleContinuationSource,
  isVerifiedUsdcRecycleContinuationCertificate,
  type UsdcRecycleContinuationSource,
  type VerifiedUsdcRecycleContinuationCertificate,
} from "./ordinary-scenario-usdc-recycle-continuation-certificate";
import {
  type ContinuationActionCaps,
  type ContinuationObserverBinding,
  type ExpiredHashlessContinuationAction,
} from "./ordinary-scenario-hashless-continuation";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SCOPE = "ordinary-usdc-recycle-continuation-v1" as const;
const AUTHORITY_EVIDENCE_HASH = "0xc7dca18faa9a9bf1cb2028c8bb77a5ccf8b0577145a408dd301d043be09bad3b" as Hex;
const PERIOD = 1_793_232_000n;
const DEADLINE = 1_793_318_400n;
const PHASE_LIMIT = 50_000_000_000_000_000n;
const PRIOR_GROSS_NATIVE_PRINCIPAL = 60_000_000_000_002n;
const ORIGINAL_AGGREGATE_GAS_ALLOWANCE = 16_080_584_000_000n;
const CONTINUATION_MAXIMUM_RESERVATION = 12_080_584_000_000n;
const PRIOR_ACTUAL_GAS_COST = 168_855_544n;
const INVALIDATION_GAS_COST = 124_785_100_000n;
const AGGREGATE_KNOWN_CHARGE = 124_953_955_544n;
const REMAINING_AGGREGATE_ALLOWANCE = 15_955_630_044_456n;
const UNUSED_AGGREGATE_ALLOWANCE = 3_875_046_044_456n;
const MAXIMUM_PHASE_OUTLAY = 143_241_710_272_986n;

export const USDC_RECYCLE_CONTINUATION_SCHEDULE = Object.freeze({ review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300", reviewAdmission: "11640", initialExecutionAdmission: "8040", reconciliationMargin: "840" } as const);
export const USDC_RECYCLE_CONTINUATION_GROUPS = Object.freeze([
  Object.freeze({ start: 1 as const, end: 5 as const, budgetSeconds: "2400" as const }),
  Object.freeze({ start: 6 as const, end: 10 as const, budgetSeconds: "1500" as const }),
  Object.freeze({ start: 11 as const, end: 14 as const, budgetSeconds: "1800" as const }),
  Object.freeze({ start: 15 as const, end: 17 as const, budgetSeconds: "1500" as const }),
]);

const CATALOG = Object.freeze([
  Object.freeze({ oldId: "usdc-successor-recycle-topup-step-up", newId: "usdc-recycle-continuation-recycle-topup-step-up", dependencies: Object.freeze(["usdc-successor-step-up-contract"]) }),
  Object.freeze({ oldId: "usdc-successor-step-up-ecdsa", newId: "usdc-recycle-continuation-step-up-ecdsa", dependencies: Object.freeze(["usdc-recycle-continuation-recycle-topup-step-up"]) }),
  Object.freeze({ oldId: "usdc-successor-direct-overspend-rejection", newId: "usdc-recycle-continuation-direct-overspend-rejection", dependencies: Object.freeze(["usdc-recycle-continuation-step-up-ecdsa"]) }),
  Object.freeze({ oldId: "usdc-successor-replay-rejection", newId: "usdc-recycle-continuation-replay-rejection", dependencies: Object.freeze(["usdc-successor-base-x"]) }),
  Object.freeze({ oldId: "usdc-successor-unsupported-path-rejection", newId: "usdc-recycle-continuation-unsupported-path-rejection", dependencies: Object.freeze(["usdc-recycle-continuation-step-up-ecdsa"]) }),
  Object.freeze({ oldId: "usdc-successor-recycle-topup-delayed", newId: "usdc-recycle-continuation-recycle-topup-delayed", dependencies: Object.freeze(["usdc-recycle-continuation-step-up-ecdsa"]) }),
  Object.freeze({ oldId: "usdc-successor-queue-cancel", newId: "usdc-recycle-continuation-queue-cancel", dependencies: Object.freeze(["usdc-recycle-continuation-recycle-topup-delayed"]) }),
  Object.freeze({ oldId: "usdc-successor-queue-cancel-early-rejection", newId: "usdc-recycle-continuation-queue-cancel-early-rejection", dependencies: Object.freeze(["usdc-recycle-continuation-queue-cancel"]) }),
  Object.freeze({ oldId: "usdc-successor-queue-cancel-action", newId: "usdc-recycle-continuation-queue-cancel-action", dependencies: Object.freeze(["usdc-recycle-continuation-queue-cancel"]) }),
  Object.freeze({ oldId: "usdc-successor-queue-cancelled-execution-rejection", newId: "usdc-recycle-continuation-queue-cancelled-execution-rejection", dependencies: Object.freeze(["usdc-recycle-continuation-queue-cancel-action"]) }),
  Object.freeze({ oldId: "usdc-successor-queue-expiry", newId: "usdc-recycle-continuation-queue-expiry", dependencies: Object.freeze(["usdc-recycle-continuation-queue-cancel-action"]) }),
  Object.freeze({ oldId: "usdc-successor-queue-expiry-early-rejection", newId: "usdc-recycle-continuation-queue-expiry-early-rejection", dependencies: Object.freeze(["usdc-recycle-continuation-queue-expiry"]) }),
  Object.freeze({ oldId: "usdc-successor-queue-expiry-skip", newId: "usdc-recycle-continuation-queue-expiry-skip", dependencies: Object.freeze(["usdc-recycle-continuation-queue-expiry"]) }),
  Object.freeze({ oldId: "usdc-successor-queue-expired-execution-rejection", newId: "usdc-recycle-continuation-queue-expired-execution-rejection", dependencies: Object.freeze(["usdc-recycle-continuation-queue-expiry-skip"]) }),
  Object.freeze({ oldId: "usdc-successor-queue-execute", newId: "usdc-recycle-continuation-queue-execute", dependencies: Object.freeze(["usdc-recycle-continuation-queue-expiry-skip"]) }),
  Object.freeze({ oldId: "usdc-successor-queue-execute-early-rejection", newId: "usdc-recycle-continuation-queue-execute-early-rejection", dependencies: Object.freeze(["usdc-recycle-continuation-queue-execute"]) }),
  Object.freeze({ oldId: "usdc-successor-queue-ready-execute", newId: "usdc-recycle-continuation-queue-ready-execute", dependencies: Object.freeze(["usdc-recycle-continuation-queue-execute-early-rejection"]) }),
] as const);

type CurrentCheckpoint = VerifiedUsdcRecycleContinuationCertificate["currentCheckpoint"];
type Schedule = typeof USDC_RECYCLE_CONTINUATION_SCHEDULE;
type Group = typeof USDC_RECYCLE_CONTINUATION_GROUPS[number];
type SharedBudgetCharges = Readonly<{ priorActualGasCostWei: string; invalidationGasCostWei: string; aggregateKnownChargeWei: string }>;
type Reservation = Readonly<{
  phaseLimitWei: string;
  canonicalPriorGasCostWei: string;
  priorGrossNativePrincipalWei: string;
  continuationNativePrincipalWei: "0";
  originalAggregateGasAllowanceWei: string;
  priorActualGasCostWei: string;
  invalidationGasCostWei: string;
  aggregateKnownChargeWei: string;
  remainingAggregateAllowanceWei: string;
  continuationMaximumReservationWei: string;
  unusedAggregateAllowanceWei: string;
  maximumPhaseOutlayWei: string;
  grossUsdcOutflow: "11000000";
  grossUsdcInwardRecycling: "11000000";
}>;

declare const proposalBrand: unique symbol;
export type UsdcRecycleContinuationProposal = Readonly<{
  schemaVersion: 1;
  scope: typeof SCOPE;
  authorization: "NONE";
  chainId: 11155111;
  authorityEvidenceHash: Hex;
  sourceHash: Hex;
  certificateHash: Hex;
  snapshot: VerifiedUsdcRecycleContinuationCertificate["snapshot"];
  currentCheckpoint: CurrentCheckpoint;
  minimumOuterNonce: number;
  effectivePeriod: string;
  deadline: string;
  observer: ContinuationObserverBinding;
  schedule: Schedule;
  groups: readonly Group[];
  caps: ContinuationActionCaps;
  reservation: Reservation;
  sharedBudgetCharges: SharedBudgetCharges;
  maxBroadcastAttempts: 1;
  actions: readonly ExpiredHashlessContinuationAction[];
  proposalHash: Hex;
  readonly [proposalBrand]: true;
}>;

declare const approvalBrand: unique symbol;
export type UsdcRecycleContinuationApproval = Readonly<{ approvalHash: Hex; readonly [approvalBrand]: true }>;
declare const storageBrand: unique symbol;
export type UsdcRecycleContinuationStorage = Readonly<{
  schemaVersion: 1;
  scope: typeof SCOPE;
  sourceHash: Hex;
  certificateHash: Hex;
  proposalHash: Hex;
  approvalHash: Hex;
  currentCheckpoint: CurrentCheckpoint;
  minimumOuterNonce: number;
  effectivePeriod: string;
  deadline: string;
  actionCommitments: readonly Readonly<{ id: string; commitment: Hex }>[];
  maximumReservationWei: string;
  aggregateKnownChargeWei: string;
  maxBroadcastAttempts: 1;
  actions: readonly (Readonly<{ id: string; commitment: Hex; status: "approved" }> | Readonly<OrdinaryScenarioActionRecord>)[];
  readonly [storageBrand]: true;
}>;

type ProposalInput = Readonly<{ source: UsdcRecycleContinuationSource; certificate: VerifiedUsdcRecycleContinuationCertificate; observer: ContinuationObserverBinding; caps: ContinuationActionCaps }>;
type ProposalContext = Readonly<{
  source: UsdcRecycleContinuationSource;
  certificate: VerifiedUsdcRecycleContinuationCertificate;
  historicalSourceHash: Hex;
  observer: ContinuationObserverBinding;
  caps: ContinuationActionCaps;
  commitments: readonly Hex[];
  aggregateKnownChargeWei: bigint;
  remainingAggregateAllowanceWei: bigint;
  continuationMaximumReservationWei: bigint;
  maxBroadcastAttempts: 1;
}>;

const proposalContexts = new WeakMap<object, ProposalContext>();
const approvals = new WeakMap<object, UsdcRecycleContinuationProposal>();
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const publicHash = (value: unknown): Hex => sha256(value) as Hex;
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
};
const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} shape mismatch`);
};
const hash = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a hash`);
  return value as Hex;
};
const decimal = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`);
  return BigInt(value);
};

function historicalJournalProjection(journal: OrdinaryScenarioJournal): Readonly<Record<string, unknown>> {
  const { usdcRecycleContinuation: _recycle, repairContinuation: _repair, liveJournal, ...historical } = journal;
  return { ...historical, liveJournal: { ...liveJournal, entries: liveJournal.entries.slice(0, 15) } };
}

function historicalSourceHash(source: UsdcRecycleContinuationSource, journal: OrdinaryScenarioJournal): Hex {
  return publicHash(publicValue({
    prior: {
      original: source.prior.original,
      recovery: source.prior.recovery,
      recoveryApproval: source.prior.recoveryApproval,
      journal: historicalJournalProjection(journal),
    },
    priorCertificate: source.priorCertificate,
    priorProposal: source.priorProposal,
    priorApproval: source.priorApproval,
  }));
}

function validateCaps(caps: ContinuationActionCaps): ContinuationActionCaps {
  exactKeys(caps as unknown as Record<string, unknown>, ["fundingGasLimit", "safeExecutionGasLimit", "publicDelayGasLimit", "maxFeePerGas", "maxPriorityFeePerGas"], "USDC recycle continuation caps");
  const expected: ContinuationActionCaps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" };
  if (JSON.stringify(caps) !== JSON.stringify(expected)) throw new Error("USDC recycle continuation caps must equal the reviewed literal caps");
  return freeze({ ...caps });
}

function validateObserver(observer: ContinuationObserverBinding, source: UsdcRecycleContinuationSource): ContinuationObserverBinding {
  exactKeys(observer as unknown as Record<string, unknown>, ["kind", "publicId", "endpointHash", "startupEvidenceHash", "probeEvidenceHash", "independentFromProposer", "readyAt", "workflowScheduleSeconds", "requiredThrough", "expiresAt"], "USDC recycle continuation observer");
  exactKeys(observer.workflowScheduleSeconds as unknown as Record<string, unknown>, ["review", "execution", "confirmations", "delivery", "acknowledgement", "keylessConfirmation"], "USDC recycle continuation observer schedule");
  if (JSON.stringify(observer) !== JSON.stringify(source.priorProposal.observer)) throw new Error("USDC recycle continuation observer must be the byte-exact inherited prior observer with the existing probe");
  return freeze(structuredClone(observer));
}

function assertSourceAndCertificate(source: UsdcRecycleContinuationSource, certificate: VerifiedUsdcRecycleContinuationCertificate, mode: "create" | "parse"): void {
  if (!isVerifiedUsdcRecycleContinuationCertificate(certificate)) throw new Error("USDC recycle continuation requires an opaque verified certificate");
  const sourceHash = hashUsdcRecycleContinuationSource(source);
  if (!same(sourceHash, certificate.sourceHash)) throw new Error("USDC recycle continuation source and certificate are not content-bound");
  if (certificate.effectivePeriod !== PERIOD || certificate.priorActualGasCostWei !== PRIOR_ACTUAL_GAS_COST || certificate.invalidation.gasCost !== INVALIDATION_GAS_COST || certificate.aggregateKnownChargeWei !== AGGREGATE_KNOWN_CHARGE) throw new Error("USDC recycle continuation certificate budget or invalidation charge mismatch");
  const checkpoint = certificate.currentCheckpoint;
  if (checkpoint.blockNumber !== certificate.snapshot.blockNumber || !same(checkpoint.blockHash, certificate.snapshot.blockHash) || !same(checkpoint.stateHash, certificate.snapshot.stateHash) || checkpoint.snapshotNonce < 870 || checkpoint.snapshotNonce !== checkpoint.latestNonce || checkpoint.snapshotNonce !== checkpoint.pendingNonce) throw new Error("USDC recycle continuation current checkpoint or minimum outer nonce is invalid");
  const journal = source.prior.journal;
  if (journal.actions.length !== 19 || journal.liveJournal.entries.length < 15 || !journal.usdcSuccessor || journal.usdcSuccessor.actions.length !== 19 || source.priorProposal.actions.length !== 19) throw new Error("USDC recycle continuation source lineage is incomplete");
  if (mode === "create" && (journal.liveJournal.entries.length !== 15 || "usdcRecycleContinuation" in journal || "repairContinuation" in journal)) throw new Error("USDC recycle continuation creation requires the exact clean 15-entry source with no existing sibling or repair");
}

function safeHash(source: UsdcRecycleContinuationSource, action: ExpiredHashlessContinuationAction): Hex | undefined {
  if (!action.safeTransaction) return undefined;
  const tx = action.safeTransaction;
  return hashTypedData({ domain: { chainId: 11_155_111, verifyingContract: source.prior.original.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { to: tx.to, value: BigInt(tx.value), data: tx.data, operation: tx.operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: BigInt(tx.nonce) } });
}

function rebuildActions(source: UsdcRecycleContinuationSource, checkpoint: CurrentCheckpoint, minimumOuterNonce: number): readonly ExpiredHashlessContinuationAction[] {
  const old = source.priorProposal.actions.slice(2);
  if (old.length !== CATALOG.length || old.some((action, index) => action.id !== CATALOG[index]!.oldId)) throw new Error("USDC recycle continuation literal old-row-3-through-19 descriptor source mismatch");
  const actions = old.map((sourceAction, index) => {
    const catalog = CATALOG[index]!;
    const recomputedSafeHash = safeHash(source, sourceAction);
    if (sourceAction.safeTransaction && (!sourceAction.safeTxHash || recomputedSafeHash !== sourceAction.safeTxHash)) throw new Error("USDC recycle continuation Safe transaction hash mismatch");
    if (sourceAction.queue) {
      const item = { safe: source.prior.original.safe, delay: source.prior.original.delay, to: sourceAction.queue.to, value: BigInt(sourceAction.queue.value), data: sourceAction.queue.data, operation: sourceAction.queue.operation, queueNonce: BigInt(sourceAction.queue.queueNonce) };
      if (queueFingerprint(item) !== sourceAction.queue.fingerprint || queueMonitoringFingerprint(item) !== sourceAction.queue.monitoringFingerprint) throw new Error("USDC recycle continuation queue fingerprint mismatch");
    }
    const cloned = structuredClone(sourceAction) as ExpiredHashlessContinuationAction;
    const { commitment: _oldCommitment, ...oldDescriptor } = cloned;
    const descriptor = { ...oldDescriptor, id: catalog.newId, dependsOn: [...catalog.dependencies] };
    return freeze({ ...descriptor, commitment: publicHash({ ...descriptor, currentCheckpoint: checkpoint, minimumOuterNonce }) }) as ExpiredHashlessContinuationAction;
  });
  if (actions.some((action, index) => action.commitment === old[index]!.commitment || action.id === old[index]!.id)) throw new Error("USDC recycle continuation action identity was not freshly bound");
  return freeze(actions);
}

function reservation(source: UsdcRecycleContinuationSource, certificate: VerifiedUsdcRecycleContinuationCertificate): Reservation {
  const canonicalPriorGasCost = BigInt(source.priorProposal.reservation.priorActualGasCostWei);
  const priorPrincipal = BigInt(source.priorProposal.reservation.priorPrincipalWei);
  if (priorPrincipal !== PRIOR_GROSS_NATIVE_PRINCIPAL || canonicalPriorGasCost + priorPrincipal + certificate.aggregateKnownChargeWei + CONTINUATION_MAXIMUM_RESERVATION !== MAXIMUM_PHASE_OUTLAY || certificate.aggregateKnownChargeWei > ORIGINAL_AGGREGATE_GAS_ALLOWANCE || ORIGINAL_AGGREGATE_GAS_ALLOWANCE - certificate.aggregateKnownChargeWei !== REMAINING_AGGREGATE_ALLOWANCE || CONTINUATION_MAXIMUM_RESERVATION > REMAINING_AGGREGATE_ALLOWANCE || REMAINING_AGGREGATE_ALLOWANCE - CONTINUATION_MAXIMUM_RESERVATION !== UNUSED_AGGREGATE_ALLOWANCE || MAXIMUM_PHASE_OUTLAY > PHASE_LIMIT) throw new Error("USDC recycle continuation shared budget overflow, reset, or canonical prior outlay mismatch");
  return freeze({ phaseLimitWei: PHASE_LIMIT.toString(), canonicalPriorGasCostWei: canonicalPriorGasCost.toString(), priorGrossNativePrincipalWei: priorPrincipal.toString(), continuationNativePrincipalWei: "0", originalAggregateGasAllowanceWei: ORIGINAL_AGGREGATE_GAS_ALLOWANCE.toString(), priorActualGasCostWei: certificate.priorActualGasCostWei.toString(), invalidationGasCostWei: certificate.invalidation.gasCost.toString(), aggregateKnownChargeWei: certificate.aggregateKnownChargeWei.toString(), remainingAggregateAllowanceWei: REMAINING_AGGREGATE_ALLOWANCE.toString(), continuationMaximumReservationWei: CONTINUATION_MAXIMUM_RESERVATION.toString(), unusedAggregateAllowanceWei: UNUSED_AGGREGATE_ALLOWANCE.toString(), maximumPhaseOutlayWei: MAXIMUM_PHASE_OUTLAY.toString(), grossUsdcOutflow: "11000000", grossUsdcInwardRecycling: "11000000" });
}

function buildProposal(input: ProposalInput, mode: "create" | "parse"): UsdcRecycleContinuationProposal {
  assertSourceAndCertificate(input.source, input.certificate, mode);
  const caps = validateCaps(input.caps), observer = validateObserver(input.observer, input.source);
  const currentCheckpoint = freeze(structuredClone(input.certificate.currentCheckpoint));
  const minimumOuterNonce = currentCheckpoint.snapshotNonce;
  const actions = rebuildActions(input.source, currentCheckpoint, minimumOuterNonce);
  const budget = reservation(input.source, input.certificate);
  const sharedBudgetCharges = freeze({ priorActualGasCostWei: budget.priorActualGasCostWei, invalidationGasCostWei: budget.invalidationGasCostWei, aggregateKnownChargeWei: budget.aggregateKnownChargeWei });
  const body = { schemaVersion: 1 as const, scope: SCOPE, authorization: "NONE" as const, chainId: 11_155_111 as const, authorityEvidenceHash: AUTHORITY_EVIDENCE_HASH, sourceHash: input.certificate.sourceHash, certificateHash: input.certificate.certificateHash, snapshot: freeze(structuredClone(input.certificate.snapshot)), currentCheckpoint, minimumOuterNonce, effectivePeriod: PERIOD.toString(), deadline: DEADLINE.toString(), observer, schedule: USDC_RECYCLE_CONTINUATION_SCHEDULE, groups: USDC_RECYCLE_CONTINUATION_GROUPS, caps, reservation: budget, sharedBudgetCharges, maxBroadcastAttempts: 1 as const, actions };
  const proposal = freeze({ ...body, proposalHash: publicHash(body) }) as unknown as UsdcRecycleContinuationProposal;
  proposalContexts.set(proposal, freeze({ source: input.source, certificate: input.certificate, historicalSourceHash: historicalSourceHash(input.source, input.source.prior.journal), observer, caps, commitments: actions.map(action => action.commitment), aggregateKnownChargeWei: input.certificate.aggregateKnownChargeWei, remainingAggregateAllowanceWei: REMAINING_AGGREGATE_ALLOWANCE, continuationMaximumReservationWei: CONTINUATION_MAXIMUM_RESERVATION, maxBroadcastAttempts: 1 as const }));
  return proposal;
}

export function createUsdcRecycleContinuationProposal(input: ProposalInput): UsdcRecycleContinuationProposal {
  return buildProposal(input, "create");
}

export function assertAttachedUsdcRecycleContinuation(value: unknown, proposal: UsdcRecycleContinuationProposal): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("attached USDC recycle continuation storage is malformed");
  const storage = value as Partial<UsdcRecycleContinuationStorage>;
  if (storage.schemaVersion !== 1 || storage.scope !== SCOPE || storage.sourceHash !== proposal.sourceHash || storage.certificateHash !== proposal.certificateHash || storage.proposalHash !== proposal.proposalHash || storage.minimumOuterNonce !== proposal.minimumOuterNonce || JSON.stringify(storage.currentCheckpoint) !== JSON.stringify(proposal.currentCheckpoint) || storage.effectivePeriod !== proposal.effectivePeriod || storage.deadline !== proposal.deadline || storage.maximumReservationWei !== proposal.reservation.continuationMaximumReservationWei || storage.aggregateKnownChargeWei !== proposal.reservation.aggregateKnownChargeWei || storage.maxBroadcastAttempts !== 1 || !Array.isArray(storage.actionCommitments) || !Array.isArray(storage.actions) || storage.actions.length !== 17 || storage.actionCommitments.length !== 17) throw new Error("attached USDC recycle continuation header or action lineage mismatch");
  for (let index = 0; index < 17; index++) if (storage.actionCommitments[index]?.id !== proposal.actions[index]!.id || storage.actionCommitments[index]?.commitment !== proposal.actions[index]!.commitment || storage.actions[index]?.id !== proposal.actions[index]!.id || storage.actions[index]?.commitment !== proposal.actions[index]!.commitment) throw new Error("attached USDC recycle continuation catalog drifted");
}

export function hashAttachedUsdcRecycleContinuationHeader(storage: UsdcRecycleContinuationStorage): Hex {
  return publicHash({ schemaVersion: storage.schemaVersion, scope: storage.scope, sourceHash: storage.sourceHash, certificateHash: storage.certificateHash, proposalHash: storage.proposalHash, approvalHash: storage.approvalHash, currentCheckpoint: storage.currentCheckpoint, minimumOuterNonce: storage.minimumOuterNonce, effectivePeriod: storage.effectivePeriod, deadline: storage.deadline, actionCommitments: storage.actionCommitments, maximumReservationWei: storage.maximumReservationWei, aggregateKnownChargeWei: storage.aggregateKnownChargeWei, maxBroadcastAttempts: storage.maxBroadcastAttempts });
}

export function hashApprovedUsdcRecycleContinuationHeader(proposal: UsdcRecycleContinuationProposal, approval: UsdcRecycleContinuationApproval): Hex {
  return publicHash({ schemaVersion: 1, scope: SCOPE, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, proposalHash: proposal.proposalHash, approvalHash: approval.approvalHash, currentCheckpoint: proposal.currentCheckpoint, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, actionCommitments: proposal.actions.map(({ id, commitment }) => ({ id, commitment })), maximumReservationWei: proposal.reservation.continuationMaximumReservationWei, aggregateKnownChargeWei: proposal.reservation.aggregateKnownChargeWei, maxBroadcastAttempts: 1 });
}

export function parseUsdcRecycleContinuationProposal(serialized: string, source: UsdcRecycleContinuationSource, certificate: VerifiedUsdcRecycleContinuationCertificate): UsdcRecycleContinuationProposal {
  if (Buffer.byteLength(serialized, "utf8") > 2_000_000) throw new Error("USDC recycle continuation proposal is too large");
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new Error("USDC recycle continuation proposal must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("USDC recycle continuation proposal must be an object");
  exactKeys(parsed as Record<string, unknown>, ["schemaVersion", "scope", "authorization", "chainId", "authorityEvidenceHash", "sourceHash", "certificateHash", "snapshot", "currentCheckpoint", "minimumOuterNonce", "effectivePeriod", "deadline", "observer", "schedule", "groups", "caps", "reservation", "sharedBudgetCharges", "maxBroadcastAttempts", "actions", "proposalHash"], "USDC recycle continuation proposal");
  const expected = buildProposal({ source, certificate, observer: (parsed as any).observer, caps: (parsed as any).caps }, "parse");
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("USDC recycle continuation proposal shape, catalog, commitment, checkpoint, budget, or hash drift");
  const attached = (source.prior.journal as OrdinaryScenarioJournal & { usdcRecycleContinuation?: unknown }).usdcRecycleContinuation;
  if (attached !== undefined) assertAttachedUsdcRecycleContinuation(attached, expected);
  return expected;
}

export function loadUsdcRecycleContinuationApproval(proposal: UsdcRecycleContinuationProposal, serialized: string, expectedApprovalHash: Hex): UsdcRecycleContinuationApproval {
  if (!proposalContexts.has(proposal)) throw new Error("USDC recycle continuation proposal is not opaque");
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new Error("USDC recycle continuation approval must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("USDC recycle continuation approval must be an object");
  const value = parsed as Record<string, unknown>;
  exactKeys(value, ["schemaVersion", "scope", "authorization", "authorityEvidenceHash", "proposalHash", "sourceHash", "certificateHash", "snapshot", "currentCheckpoint", "minimumOuterNonce", "effectivePeriod", "deadline", "observer", "schedule", "groups", "caps", "reservation", "repairAuthority", "sharedBudgetCharges", "maxBroadcastAttempts", "approvedActions"], "USDC recycle continuation approval");
  const approvalHash = publicHash(value);
  if (!HASH.test(expectedApprovalHash) || !same(approvalHash, expectedApprovalHash)) throw new Error("USDC recycle continuation approval hash mismatch");
  if (value.schemaVersion !== 1 || value.scope !== SCOPE || value.authorization !== "STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION" || value.authorityEvidenceHash !== AUTHORITY_EVIDENCE_HASH || value.proposalHash !== proposal.proposalHash || value.sourceHash !== proposal.sourceHash || value.certificateHash !== proposal.certificateHash || value.minimumOuterNonce !== proposal.minimumOuterNonce || value.effectivePeriod !== proposal.effectivePeriod || value.deadline !== proposal.deadline || value.repairAuthority !== "NONE" || value.maxBroadcastAttempts !== 1 || JSON.stringify(value.snapshot) !== JSON.stringify(proposal.snapshot) || JSON.stringify(value.currentCheckpoint) !== JSON.stringify(proposal.currentCheckpoint) || JSON.stringify(value.observer) !== JSON.stringify(proposal.observer) || JSON.stringify(value.schedule) !== JSON.stringify(proposal.schedule) || JSON.stringify(value.groups) !== JSON.stringify(proposal.groups) || JSON.stringify(value.caps) !== JSON.stringify(proposal.caps) || JSON.stringify(value.reservation) !== JSON.stringify(proposal.reservation) || JSON.stringify(value.sharedBudgetCharges) !== JSON.stringify(proposal.sharedBudgetCharges)) throw new Error("USDC recycle continuation standing authority, repair exclusion, checkpoint, or shared budget binding mismatch");
  if (!Array.isArray(value.approvedActions) || value.approvedActions.length !== 17) throw new Error("USDC recycle continuation approved action count mismatch");
  value.approvedActions.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("USDC recycle continuation approved action shape mismatch");
    exactKeys(raw as Record<string, unknown>, ["id", "commitment"], "USDC recycle continuation approved action");
    const action = proposal.actions[index]!;
    if ((raw as any).id !== action.id || !same(hash((raw as any).commitment, "USDC recycle continuation approved commitment"), action.commitment)) throw new Error("USDC recycle continuation approved action mismatch");
  });
  const approval = freeze({ approvalHash }) as UsdcRecycleContinuationApproval;
  approvals.set(approval, proposal);
  return approval;
}

export function assertUsdcRecycleContinuationAuthorization(proposal: UsdcRecycleContinuationProposal, approval: UsdcRecycleContinuationApproval): void {
  if (!proposalContexts.has(proposal) || approvals.get(approval) !== proposal) throw new Error("USDC recycle continuation authorization is not opaque and exactly bound");
}

export function assertUsdcRecycleContinuationHistoricalBinding(source: UsdcRecycleContinuationSource, certificate: VerifiedUsdcRecycleContinuationCertificate, proposal: UsdcRecycleContinuationProposal, journal: OrdinaryScenarioJournal): void {
  const context = proposalContexts.get(proposal);
  if (!context || context.source !== source || context.certificate !== certificate) throw new Error("USDC recycle continuation historical source is not the authenticated proposal context");
  if (!same(historicalSourceHash(source, source.prior.journal), context.historicalSourceHash) || !same(historicalSourceHash(source, journal), context.historicalSourceHash)) throw new Error("USDC recycle continuation historical source or journal binding mismatch");
}

export function attachUsdcRecycleContinuation(journal: OrdinaryScenarioJournal, proposal: UsdcRecycleContinuationProposal, approval: UsdcRecycleContinuationApproval): OrdinaryScenarioJournal & { usdcRecycleContinuation: UsdcRecycleContinuationStorage } {
  assertUsdcRecycleContinuationAuthorization(proposal, approval);
  const context = proposalContexts.get(proposal)!;
  if ("usdcRecycleContinuation" in journal) throw new Error("journal already has a USDC recycle continuation attachment");
  if (journal !== context.source.prior.journal || !same(hashUsdcRecycleContinuationSource(context.source), proposal.sourceHash)) throw new Error("USDC recycle continuation journal source changed before attachment");
  if (!journal.usdcSuccessor || journal.liveJournal.entries.length !== 15) throw new Error("USDC recycle continuation attachment requires the exact stopped predecessor checkpoint");
  const storage = freeze({ schemaVersion: 1, scope: SCOPE, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, proposalHash: proposal.proposalHash, approvalHash: approval.approvalHash, currentCheckpoint: proposal.currentCheckpoint, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, actionCommitments: proposal.actions.map(({ id, commitment }) => freeze({ id, commitment })), maximumReservationWei: proposal.reservation.continuationMaximumReservationWei, aggregateKnownChargeWei: proposal.reservation.aggregateKnownChargeWei, maxBroadcastAttempts: 1, actions: proposal.actions.map(({ id, commitment }) => freeze({ id, commitment, status: "approved" as const })) }) as UsdcRecycleContinuationStorage;
  (journal as OrdinaryScenarioJournal & { usdcRecycleContinuation: UsdcRecycleContinuationStorage }).usdcRecycleContinuation = storage;
  return journal as OrdinaryScenarioJournal & { usdcRecycleContinuation: UsdcRecycleContinuationStorage };
}

export function assertUsdcRecycleContinuationAdmission(proposal: UsdcRecycleContinuationProposal, actionId: string, chainTimestamp: bigint, now: Date, phase: "review" | "scenario" | "private" | "broadcast"): void {
  if (!proposalContexts.has(proposal)) throw new Error("USDC recycle continuation admission requires an opaque proposal");
  const index = proposal.actions.findIndex(action => action.id === actionId);
  if (index < 0) throw new Error("USDC recycle continuation action is outside the closed catalog");
  if (typeof chainTimestamp !== "bigint") throw new Error("USDC recycle continuation chain timestamp must be a bigint");
  if (!["review", "scenario", "private", "broadcast"].includes(phase)) throw new Error("USDC recycle continuation admission phase is invalid");
  const milliseconds = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds)) throw new Error("USDC recycle continuation root UTC date must be finite");
  const nowSeconds = BigInt(Math.floor(milliseconds / 1_000));
  const period = decimal(proposal.effectivePeriod, "USDC recycle continuation period"), deadline = decimal(proposal.deadline, "USDC recycle continuation deadline"), receiverExpiry = decimal(proposal.observer.expiresAt, "USDC recycle continuation receiver expiry"), readyAt = decimal(proposal.observer.readyAt, "USDC recycle continuation observer readyAt");
  if (chainTimestamp < period) throw new Error("USDC recycle continuation canonical chain timestamp precedes the approved period");
  if (nowSeconds < readyAt) throw new Error("USDC recycle continuation root UTC precedes inherited observer readiness");
  if (chainTimestamp >= deadline || nowSeconds >= deadline) throw new Error("USDC recycle continuation approved period deadline has elapsed");
  if (chainTimestamp >= receiverExpiry || nowSeconds >= receiverExpiry) throw new Error("USDC recycle continuation receiver expiry has elapsed");
  const remaining = [deadline - chainTimestamp, deadline - nowSeconds, receiverExpiry - chainTimestamp, receiverExpiry - nowSeconds].reduce((minimum, value) => value < minimum ? value : minimum);
  let required = 1n, strict = false;
  if (phase === "review") required = BigInt(USDC_RECYCLE_CONTINUATION_SCHEDULE.reviewAdmission);
  if (phase === "scenario") {
    const groupIndex = USDC_RECYCLE_CONTINUATION_GROUPS.findIndex(group => index + 1 >= group.start && index + 1 <= group.end);
    required = USDC_RECYCLE_CONTINUATION_GROUPS.slice(groupIndex).reduce((sum, group) => sum + BigInt(group.budgetSeconds), BigInt(USDC_RECYCLE_CONTINUATION_SCHEDULE.reconciliationMargin));
  }
  if ((phase === "private" || phase === "broadcast") && proposal.actions[index]!.kind === "queue-proposal") {
    const group = USDC_RECYCLE_CONTINUATION_GROUPS.find(candidate => index + 1 >= candidate.start && index + 1 <= candidate.end)!;
    required = BigInt(group.budgetSeconds) + BigInt(USDC_RECYCLE_CONTINUATION_SCHEDULE.reconciliationMargin);
    strict = true;
  }
  if (strict ? remaining <= required : remaining < required) throw new Error(`USDC recycle continuation ${phase} admission has insufficient remaining time for ${required} seconds${strict ? " plus queue margin" : ""}`);
}
