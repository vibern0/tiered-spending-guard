import { encodeFunctionData, hashTypedData, type Hex } from "viem";
import { SAFE_TX_TYPES } from "../../src/signers/types";
import { sha256 } from "../plan-deployment";
import {
  FRESH_SUCCESSOR_SCOPE,
  hashUsdcFreshSuccessorSource,
  isVerifiedUsdcFreshSuccessorCertificate,
  type VerifiedUsdcFreshSuccessorCertificate,
} from "./ordinary-scenario-usdc-fresh-successor-certificate";
import type { UsdcRecycleContinuationSource } from "./ordinary-scenario-usdc-recycle-continuation-certificate";
import {
  assertExpiredHashlessContinuationAuthorization,
  assertExpiredHashlessContinuationLineage,
  buildClosedUsdcSuccessorActions,
  type ContinuationActionCaps,
  type ContinuationObserverBinding,
  type ExpiredHashlessContinuationAction,
} from "./ordinary-scenario-hashless-continuation";
import {
  assertUsdcSuccessorAuthorization,
} from "./ordinary-scenario-usdc-successor-proposal";
import type { OrdinaryScenarioActionRecord, OrdinaryScenarioJournal } from "./ordinary-scenario-executor";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const PHASE_LIMIT = 50_000_000_000_000_000n;
const PRIOR_PRINCIPAL = 60_000_000_000_002n;
const PRIOR_ACTUAL_GAS_COST = 71_161_126_272_984n;
const KNOWN_OLD_SUCCESSOR_CHARGE = 124_953_955_544n;
const REMAINING_OLD_SUCCESSOR_ALLOWANCE = 15_955_630_044_456n;
const SUCCESSOR_RESERVATION = 15_340_292_000_000n;
const NEW_GROSS_USDC = 31_000_000n;
const AGGREGATE_GROSS_USDC = 51_000_000n;
const INWARD_USDC = 31_000_000n;
const TOKEN_ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool" }] }] as const;

export const FRESH_SUCCESSOR_AUTHORITY_EVIDENCE_HASH = sha256({
  scope: FRESH_SUCCESSOR_SCOPE,
  userAuthority: "focused-successor-and-required-testing-cap-approved-2026-10-30",
  newGrossUsdc: NEW_GROSS_USDC.toString(),
  aggregateGrossUsdc: AGGREGATE_GROSS_USDC.toString(),
  repairAuthority: "NONE",
}) as Hex;
export const FRESH_SUCCESSOR_SCHEDULE = Object.freeze({ review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300", reviewAdmission: "11640", initialExecutionAdmission: "8040", reconciliationMargin: "840" } as const);
export const FRESH_SUCCESSOR_GROUPS = Object.freeze([
  Object.freeze({ start: 1 as const, end: 7 as const, budgetSeconds: "2400" as const }),
  Object.freeze({ start: 8 as const, end: 11 as const, budgetSeconds: "1500" as const }),
  Object.freeze({ start: 12 as const, end: 15 as const, budgetSeconds: "1800" as const }),
  Object.freeze({ start: 16 as const, end: 18 as const, budgetSeconds: "1500" as const }),
]);

const IDS = Object.freeze(["prefund-all", "base-x", "step-up-contract", "step-up-ecdsa", "direct-overspend-rejection", "replay-rejection", "unsupported-path-rejection", "queue-cancel", "queue-cancel-early-rejection", "queue-cancel-action", "queue-cancelled-execution-rejection", "queue-expiry", "queue-expiry-early-rejection", "queue-expiry-skip", "queue-expired-execution-rejection", "queue-execute", "queue-execute-early-rejection", "queue-ready-execute"].map(id => `usdc-fresh-successor-${id}`));
const TEMPLATE_INDEXES = Object.freeze([0, 1, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
const DEPENDENCIES = Object.freeze([
  Object.freeze(["usdc-successor-step-up-contract"]), Object.freeze([IDS[0]!]), Object.freeze([IDS[1]!]), Object.freeze([IDS[2]!]), Object.freeze([IDS[3]!]), Object.freeze([IDS[1]!]), Object.freeze([IDS[3]!]), Object.freeze([IDS[3]!]), Object.freeze([IDS[7]!]), Object.freeze([IDS[7]!]), Object.freeze([IDS[9]!]), Object.freeze([IDS[9]!]), Object.freeze([IDS[11]!]), Object.freeze([IDS[11]!]), Object.freeze([IDS[13]!]), Object.freeze([IDS[13]!]), Object.freeze([IDS[15]!]), Object.freeze([IDS[16]!]),
]);

type FreshSchedule = typeof FRESH_SUCCESSOR_SCHEDULE;
type FreshGroup = typeof FRESH_SUCCESSOR_GROUPS[number];
type FreshReservation = Readonly<{ phaseLimitWei: string; priorActualGasCostWei: string; priorPrincipalWei: string; knownOldSuccessorChargeWei: string; remainingOldSuccessorAllowanceWei: string; successorMaximumReservationWei: string; spareOldSuccessorAllowanceWei: string; maximumCumulativeOutlayWei: string; newGrossUsdcAllowance: string; aggregateGrossUsdcAllowance: string; inwardUsdcFunding: string }>;
declare const proposalBrand: unique symbol;
export type UsdcFreshSuccessorProposal = Readonly<{ schemaVersion: 1; scope: typeof FRESH_SUCCESSOR_SCOPE; authorization: "NONE"; chainId: 11155111; authorityEvidenceHash: Hex; sourceHash: Hex; certificateHash: Hex; snapshot: Readonly<{ blockNumber: string; blockHash: Hex; timestamp: string }>; minimumOuterNonce: number; effectivePeriod: string; deadline: string; observer: ContinuationObserverBinding; schedule: FreshSchedule; groups: readonly FreshGroup[]; caps: ContinuationActionCaps; reservation: FreshReservation; maxBroadcastAttempts: 1; repairAuthority: "NONE"; actions: readonly ExpiredHashlessContinuationAction[]; proposalHash: Hex; readonly [proposalBrand]: true }>;
declare const approvalBrand: unique symbol;
export type UsdcFreshSuccessorApproval = Readonly<{ approvalHash: Hex; readonly [approvalBrand]: true }>;
export type UsdcFreshSuccessorStorage = Readonly<{ schemaVersion: 1; scope: typeof FRESH_SUCCESSOR_SCOPE; sourceHash: Hex; certificateHash: Hex; proposalHash: Hex; approvalHash: Hex; minimumOuterNonce: number; effectivePeriod: string; deadline: string; actionCommitments: readonly Readonly<{ id: string; commitment: Hex }>[]; maximumReservationWei: string; maxBroadcastAttempts: 1; repairAuthority: "NONE"; actions: Array<Readonly<{ id: string; commitment: Hex; status: "approved" }> | OrdinaryScenarioActionRecord> }>;

const proposals = new WeakSet<object>();
const approvals = new WeakMap<object, UsdcFreshSuccessorProposal>();
const approvalPublicValues = new WeakMap<object, Readonly<Record<string, unknown>>>();
const proposalJournals = new WeakMap<object, OrdinaryScenarioJournal>();
const proposalJournalHashes = new WeakMap<object, Hex>();
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };
const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} shape mismatch`); };
const decimal = (value: unknown, label: string): bigint => { if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`); return BigInt(value); };
const hash = (value: unknown, label: string): Hex => { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a hash`); return value as Hex; };
const publicHash = (value: unknown): Hex => sha256(value) as Hex;

function assertSourceAndCertificate(source: UsdcRecycleContinuationSource, certificate: VerifiedUsdcFreshSuccessorCertificate, mode: "create" | "parse"): void {
  assertExpiredHashlessContinuationLineage(source.prior.original, source.prior.recovery);
  assertExpiredHashlessContinuationAuthorization(source.prior.recovery, source.prior.recoveryApproval);
  assertUsdcSuccessorAuthorization(source.priorProposal, source.priorApproval);
  if (!isVerifiedUsdcFreshSuccessorCertificate(certificate)) throw new Error("fresh USDC successor requires an opaque verified certificate");
  if (!same(hashUsdcFreshSuccessorSource(source), certificate.sourceHash)) throw new Error("fresh USDC successor source and certificate are not content-bound");
  const journal = source.prior.journal as OrdinaryScenarioJournal & { usdcFreshSuccessor?: unknown; usdcRecycleContinuation?: unknown; repairContinuation?: unknown };
  if (journal.actions.length !== 19 || journal.liveJournal.entries.length < 15 || !journal.hashlessContinuation || !journal.usdcSuccessor || journal.hashlessContinuation.actions.length !== 22 || journal.usdcSuccessor.actions.length !== 19) throw new Error("fresh USDC successor source lineage is incomplete");
  if (mode === "create") {
    exactKeys(journal as unknown as Record<string, unknown>, ["schemaVersion", "chainId", "reviewPackageHash", "proposalHash", "approvalHash", "funder", "actions", "liveJournal", "hashlessContinuation", "usdcSuccessor"], "clean fresh USDC successor source journal");
    if (journal.liveJournal.entries.length !== 15 || journal.usdcFreshSuccessor !== undefined || journal.usdcRecycleContinuation !== undefined || journal.repairContinuation !== undefined) throw new Error("fresh USDC successor creation requires the exact clean 15-entry source without sibling or repair");
  }
}

function validateCaps(caps: ContinuationActionCaps): ContinuationActionCaps {
  exactKeys(caps as unknown as Record<string, unknown>, ["fundingGasLimit", "safeExecutionGasLimit", "publicDelayGasLimit", "maxFeePerGas", "maxPriorityFeePerGas"], "fresh USDC successor caps");
  const expected: ContinuationActionCaps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" };
  if (JSON.stringify(caps) !== JSON.stringify(expected)) throw new Error("fresh USDC successor caps must equal the reviewed literal caps");
  return freeze({ ...caps });
}

function validateObserver(observer: ContinuationObserverBinding, certificate: VerifiedUsdcFreshSuccessorCertificate, deadline: bigint, source: UsdcRecycleContinuationSource): ContinuationObserverBinding {
  exactKeys(observer as unknown as Record<string, unknown>, ["kind", "publicId", "endpointHash", "startupEvidenceHash", "probeEvidenceHash", "independentFromProposer", "readyAt", "workflowScheduleSeconds", "requiredThrough", "expiresAt"], "fresh USDC successor observer");
  exactKeys(observer.workflowScheduleSeconds as unknown as Record<string, unknown>, ["review", "execution", "confirmations", "delivery", "acknowledgement", "keylessConfirmation"], "fresh USDC successor observer schedule");
  const workflow = { review: FRESH_SUCCESSOR_SCHEDULE.review, execution: FRESH_SUCCESSOR_SCHEDULE.execution, confirmations: FRESH_SUCCESSOR_SCHEDULE.confirmations, delivery: FRESH_SUCCESSOR_SCHEDULE.delivery, acknowledgement: FRESH_SUCCESSOR_SCHEDULE.acknowledgement, keylessConfirmation: FRESH_SUCCESSOR_SCHEDULE.keylessConfirmation };
  if (observer.kind !== "https-webhook" || observer.independentFromProposer !== true || JSON.stringify(observer.workflowScheduleSeconds) !== JSON.stringify(workflow) || !observer.publicId.startsWith("temporary-test-receiver:") || !observer.publicId.endsWith(observer.endpointHash) || !HASH.test(observer.endpointHash) || !HASH.test(observer.startupEvidenceHash) || !HASH.test(observer.probeEvidenceHash) || same(observer.endpointHash, observer.startupEvidenceHash) || same(observer.endpointHash, observer.probeEvidenceHash) || same(observer.startupEvidenceHash, observer.probeEvidenceHash)) throw new Error("fresh USDC successor observer or workflow schedule is invalid");
  const priorIdentities = [source.priorProposal.observer.endpointHash, source.priorProposal.observer.startupEvidenceHash, source.priorProposal.observer.probeEvidenceHash];
  if ([observer.endpointHash, observer.startupEvidenceHash, observer.probeEvidenceHash].some(identity => priorIdentities.some(prior => same(identity, prior)))) throw new Error("fresh USDC successor observer identity reuses prior endpoint or probe evidence");
  const ready = decimal(observer.readyAt, "observer readyAt"), required = decimal(observer.requiredThrough, "observer requiredThrough"), expires = decimal(observer.expiresAt, "observer expiresAt");
  if (ready < BigInt(certificate.snapshot.timestamp) || required !== ready + 11_640n || deadline - ready < 11_640n || expires - ready < 11_640n || expires < required) throw new Error("fresh USDC successor observer lifetime or 11640-second review admission is invalid");
  return freeze({ ...observer, workflowScheduleSeconds: { ...observer.workflowScheduleSeconds } });
}

function safeTxHash(source: UsdcRecycleContinuationSource, tx: NonNullable<ExpiredHashlessContinuationAction["safeTransaction"]>): Hex {
  return hashTypedData({ domain: { chainId: 11_155_111, verifyingContract: source.prior.original.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { ...tx, value: BigInt(tx.value), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: BigInt(tx.nonce) } });
}

type State = ExpiredHashlessContinuationAction["before"];
type CoreState = Readonly<{ safeNonce: string; delayQueueNonce: string; delayTxNonce: string; safeUsdcBalance: string; funderUsdcBalance: string; usdcBaseSpent: string; usdcInstantSpent: string }>;
const core = (safeNonce: number, delayQueueNonce: number, delayTxNonce: number, safeUsdc: number, funderUsdc: number, base: number, instant: number): CoreState => ({ safeNonce: String(safeNonce), delayQueueNonce: String(delayQueueNonce), delayTxNonce: String(delayTxNonce), safeUsdcBalance: String(safeUsdc), funderUsdcBalance: String(funderUsdc), usdcBaseSpent: String(base), usdcInstantSpent: String(instant) });
const CORES = Object.freeze([
  core(10, 4, 4, 0, 40_000_000, 10_000_000, 20_000_000), core(10, 4, 4, 31_000_000, 9_000_000, 10_000_000, 20_000_000),
  core(11, 4, 4, 21_000_000, 19_000_000, 10_000_000, 10_000_000), core(12, 4, 4, 11_000_000, 29_000_000, 10_000_000, 20_000_000), core(13, 4, 4, 1_000_000, 39_000_000, 10_000_000, 30_000_000),
  core(13, 4, 4, 1_000_000, 39_000_000, 10_000_000, 30_000_000), core(13, 4, 4, 1_000_000, 39_000_000, 10_000_000, 30_000_000), core(13, 4, 4, 1_000_000, 39_000_000, 10_000_000, 30_000_000),
  core(14, 5, 4, 1_000_000, 39_000_000, 10_000_000, 30_000_000), core(14, 5, 4, 1_000_000, 39_000_000, 10_000_000, 30_000_000), core(15, 5, 5, 1_000_000, 39_000_000, 10_000_000, 30_000_000), core(15, 5, 5, 1_000_000, 39_000_000, 10_000_000, 30_000_000),
  core(16, 6, 5, 1_000_000, 39_000_000, 10_000_000, 30_000_000), core(16, 6, 5, 1_000_000, 39_000_000, 10_000_000, 30_000_000), core(16, 6, 6, 1_000_000, 39_000_000, 10_000_000, 30_000_000), core(16, 6, 6, 1_000_000, 39_000_000, 10_000_000, 30_000_000),
  core(17, 7, 6, 1_000_000, 39_000_000, 10_000_000, 30_000_000), core(17, 7, 6, 1_000_000, 39_000_000, 10_000_000, 30_000_000), core(17, 7, 7, 0, 40_000_000, 10_000_000, 30_000_000),
]);

const state = (template: State, values: CoreState): State => freeze({ ...template, ...values, safeNativeBalance: "0" });
const action = (input: Omit<ExpiredHashlessContinuationAction, "commitment">): ExpiredHashlessContinuationAction => freeze({ ...input, commitment: publicHash(input) });

function buildActions(source: UsdcRecycleContinuationSource, caps: ContinuationActionCaps): readonly ExpiredHashlessContinuationAction[] {
  const old = buildClosedUsdcSuccessorActions(source.prior.original, source.prior.recovery, caps);
  const fundingTemplate = old[2]!;
  const fundingData = encodeFunctionData({ abi: TOKEN_ABI, functionName: "transfer", args: [source.prior.original.safe, NEW_GROSS_USDC] });
  const first = action({ id: IDS[0]!, kind: "controlled-recipient-funding", asset: "USDC", expectedOutcome: "success", signerRoles: ["funder"], dependsOn: DEPENDENCIES[0]!, transaction: freeze({ ...fundingTemplate.transaction, data: fundingData }), before: state(old[0]!.before, CORES[0]!), after: state(old[0]!.before, CORES[1]!), gasLimitCap: caps.fundingGasLimit, maxFeePerGasCap: caps.maxFeePerGas, maxPriorityFeePerGasCap: caps.maxPriorityFeePerGas });
  const rest = TEMPLATE_INDEXES.map((templateIndex, index) => {
    const template = old[templateIndex]!, idIndex = index + 1;
    const safeTransaction = template.safeTransaction ? freeze({ ...template.safeTransaction, nonce: (BigInt(template.safeTransaction.nonce) + 2n).toString() }) : undefined;
    const input: Omit<ExpiredHashlessContinuationAction, "commitment"> = {
      id: IDS[idIndex]!, kind: template.kind, asset: "USDC", expectedOutcome: template.expectedOutcome, signerRoles: freeze([...template.signerRoles]), dependsOn: DEPENDENCIES[idIndex]!, transaction: freeze({ ...template.transaction }),
      safeTransaction, safeTxHash: safeTransaction ? safeTxHash(source, safeTransaction) : undefined,
      queue: template.queue ? freeze({ ...template.queue }) : undefined,
      before: state(template.before, CORES[idIndex]!), after: state(template.after, CORES[idIndex + 1]!),
      gasLimitCap: template.kind === "controlled-recipient-recycled-funding" ? caps.fundingGasLimit : template.gasLimitCap,
      maxFeePerGasCap: caps.maxFeePerGas, maxPriorityFeePerGasCap: caps.maxPriorityFeePerGas,
    };
    return action(input);
  });
  const actions = freeze([first, ...rest]);
  if (actions.length !== 18 || actions.some((item, index) => item.id !== IDS[index])) throw new Error("fresh USDC successor literal 18-action catalog mismatch");
  return actions;
}

type ProposalInput = Readonly<{ source: UsdcRecycleContinuationSource; certificate: VerifiedUsdcFreshSuccessorCertificate; observer: ContinuationObserverBinding; caps: ContinuationActionCaps }>;
function buildProposal(input: ProposalInput, mode: "create" | "parse"): UsdcFreshSuccessorProposal {
  assertSourceAndCertificate(input.source, input.certificate, mode);
  const effectivePeriod = input.certificate.effectivePeriod, deadline = effectivePeriod + 86_400n;
  if (effectivePeriod <= 1_793_232_000n) throw new Error("fresh USDC successor requires a later effective period");
  const caps = validateCaps(input.caps), observer = validateObserver(input.observer, input.certificate, deadline, input.source), actions = buildActions(input.source, caps);
  const actualReservation = actions.filter(item => item.expectedOutcome === "success").reduce((sum, item) => sum + BigInt(item.gasLimitCap) * BigInt(item.maxFeePerGasCap), 0n);
  if (actualReservation !== SUCCESSOR_RESERVATION) throw new Error("fresh USDC successor reservation does not match the exact ten-broadcast catalog");
  const spare = REMAINING_OLD_SUCCESSOR_ALLOWANCE - actualReservation, maximum = PRIOR_ACTUAL_GAS_COST + PRIOR_PRINCIPAL + actualReservation;
  if (spare !== 615_338_044_456n || maximum !== 146_501_418_272_986n || maximum > PHASE_LIMIT) throw new Error("fresh USDC successor aggregate gas reservation exceeds its approved ceiling");
  const reservation = freeze({ phaseLimitWei: PHASE_LIMIT.toString(), priorActualGasCostWei: PRIOR_ACTUAL_GAS_COST.toString(), priorPrincipalWei: PRIOR_PRINCIPAL.toString(), knownOldSuccessorChargeWei: KNOWN_OLD_SUCCESSOR_CHARGE.toString(), remainingOldSuccessorAllowanceWei: REMAINING_OLD_SUCCESSOR_ALLOWANCE.toString(), successorMaximumReservationWei: actualReservation.toString(), spareOldSuccessorAllowanceWei: spare.toString(), maximumCumulativeOutlayWei: maximum.toString(), newGrossUsdcAllowance: NEW_GROSS_USDC.toString(), aggregateGrossUsdcAllowance: AGGREGATE_GROSS_USDC.toString(), inwardUsdcFunding: INWARD_USDC.toString() });
  const body = { schemaVersion: 1 as const, scope: FRESH_SUCCESSOR_SCOPE, authorization: "NONE" as const, chainId: 11_155_111 as const, authorityEvidenceHash: FRESH_SUCCESSOR_AUTHORITY_EVIDENCE_HASH, sourceHash: input.certificate.sourceHash, certificateHash: input.certificate.certificateHash, snapshot: freeze({ blockNumber: input.certificate.snapshot.blockNumber, blockHash: input.certificate.snapshot.blockHash, timestamp: input.certificate.snapshot.timestamp }), minimumOuterNonce: input.certificate.currentCheckpoint.snapshotNonce, effectivePeriod: effectivePeriod.toString(), deadline: deadline.toString(), observer, schedule: FRESH_SUCCESSOR_SCHEDULE, groups: FRESH_SUCCESSOR_GROUPS, caps, reservation, maxBroadcastAttempts: 1 as const, repairAuthority: "NONE" as const, actions };
  const proposal = freeze({ ...body, proposalHash: publicHash(body) }) as unknown as UsdcFreshSuccessorProposal;
  proposals.add(proposal);
  proposalJournals.set(proposal, input.source.prior.journal);
  proposalJournalHashes.set(proposal, publicHash(input.source.prior.journal));
  return proposal;
}

export function createUsdcFreshSuccessorProposal(input: ProposalInput): UsdcFreshSuccessorProposal { return buildProposal(input, "create"); }

function assertAttached(value: unknown, proposal: UsdcFreshSuccessorProposal): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("attached fresh USDC successor storage is malformed");
  const storage = value as Partial<UsdcFreshSuccessorStorage>;
  if (storage.schemaVersion !== 1 || storage.scope !== FRESH_SUCCESSOR_SCOPE || storage.sourceHash !== proposal.sourceHash || storage.certificateHash !== proposal.certificateHash || storage.proposalHash !== proposal.proposalHash || storage.minimumOuterNonce !== proposal.minimumOuterNonce || storage.effectivePeriod !== proposal.effectivePeriod || storage.deadline !== proposal.deadline || storage.maxBroadcastAttempts !== 1 || storage.repairAuthority !== "NONE" || storage.maximumReservationWei !== proposal.reservation.successorMaximumReservationWei || !Array.isArray(storage.actionCommitments) || !Array.isArray(storage.actions) || storage.actionCommitments.length !== 18 || storage.actions.length !== 18) throw new Error("attached fresh USDC successor header or action lineage mismatch");
  for (let index = 0; index < 18; index++) if (storage.actionCommitments[index]?.id !== proposal.actions[index]!.id || storage.actionCommitments[index]?.commitment !== proposal.actions[index]!.commitment || storage.actions[index]?.id !== proposal.actions[index]!.id || storage.actions[index]?.commitment !== proposal.actions[index]!.commitment) throw new Error("attached fresh USDC successor catalog drifted");
}

export function parseUsdcFreshSuccessorProposal(serialized: string, source: UsdcRecycleContinuationSource, certificate: VerifiedUsdcFreshSuccessorCertificate): UsdcFreshSuccessorProposal {
  if (Buffer.byteLength(serialized, "utf8") > 2_000_000) throw new Error("fresh USDC successor proposal is too large");
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("fresh USDC successor proposal must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fresh USDC successor proposal must be an object");
  exactKeys(parsed as Record<string, unknown>, ["schemaVersion", "scope", "authorization", "chainId", "authorityEvidenceHash", "sourceHash", "certificateHash", "snapshot", "minimumOuterNonce", "effectivePeriod", "deadline", "observer", "schedule", "groups", "caps", "reservation", "maxBroadcastAttempts", "repairAuthority", "actions", "proposalHash"], "fresh USDC successor proposal");
  const expected = buildProposal({ source, certificate, observer: (parsed as any).observer, caps: (parsed as any).caps }, "parse");
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("fresh USDC successor proposal shape, catalog, commitment, reservation, period, or hash drift");
  const attached = (source.prior.journal as OrdinaryScenarioJournal & { usdcFreshSuccessor?: unknown }).usdcFreshSuccessor;
  if (attached !== undefined) assertAttached(attached, expected);
  return expected;
}

export function loadUsdcFreshSuccessorApproval(proposal: UsdcFreshSuccessorProposal, serialized: string, expectedApprovalHash: Hex): UsdcFreshSuccessorApproval {
  if (!proposals.has(proposal)) throw new Error("fresh USDC successor proposal is not opaque");
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("fresh USDC successor approval must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fresh USDC successor approval must be an object");
  const value = parsed as Record<string, unknown>;
  exactKeys(value, ["schemaVersion", "scope", "authorization", "authorityEvidenceHash", "proposalHash", "sourceHash", "certificateHash", "snapshot", "minimumOuterNonce", "effectivePeriod", "deadline", "observer", "schedule", "groups", "caps", "reservation", "maxBroadcastAttempts", "repairAuthority", "approvedActions"], "fresh USDC successor approval");
  const approvalHash = publicHash(value);
  if (!HASH.test(expectedApprovalHash) || !same(approvalHash, expectedApprovalHash)) throw new Error("fresh USDC successor approval hash mismatch");
  if (value.schemaVersion !== 1 || value.scope !== FRESH_SUCCESSOR_SCOPE || value.authorization !== "FOCUSED_BOUNDED_SUCCESSOR_AUTHORIZATION" || value.authorityEvidenceHash !== FRESH_SUCCESSOR_AUTHORITY_EVIDENCE_HASH || value.proposalHash !== proposal.proposalHash || value.sourceHash !== proposal.sourceHash || value.certificateHash !== proposal.certificateHash || value.minimumOuterNonce !== proposal.minimumOuterNonce || value.effectivePeriod !== proposal.effectivePeriod || value.deadline !== proposal.deadline || value.maxBroadcastAttempts !== 1 || value.repairAuthority !== "NONE" || JSON.stringify(value.snapshot) !== JSON.stringify(proposal.snapshot) || JSON.stringify(value.observer) !== JSON.stringify(proposal.observer) || JSON.stringify(value.schedule) !== JSON.stringify(proposal.schedule) || JSON.stringify(value.groups) !== JSON.stringify(proposal.groups) || JSON.stringify(value.caps) !== JSON.stringify(proposal.caps) || JSON.stringify(value.reservation) !== JSON.stringify(proposal.reservation)) throw new Error("fresh USDC successor focused authority, repair authority, or exact binding mismatch");
  if (!Array.isArray(value.approvedActions) || value.approvedActions.length !== 18) throw new Error("fresh USDC successor approved action count mismatch");
  value.approvedActions.forEach((raw, index) => { if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("fresh USDC successor approved action shape mismatch"); exactKeys(raw as Record<string, unknown>, ["id", "commitment"], "fresh USDC successor approved action"); const action = proposal.actions[index]!; if ((raw as any).id !== action.id || !same(hash((raw as any).commitment, "approved action commitment"), action.commitment)) throw new Error("fresh USDC successor approved action mismatch"); });
  const approval = freeze({ approvalHash }) as UsdcFreshSuccessorApproval;
  approvals.set(approval, proposal); approvalPublicValues.set(approval, freeze(structuredClone(value)));
  return approval;
}

export function assertUsdcFreshSuccessorAuthorization(proposal: UsdcFreshSuccessorProposal, approval: UsdcFreshSuccessorApproval): void { if (!proposals.has(proposal) || approvals.get(approval) !== proposal) throw new Error("fresh USDC successor authorization is not opaque and exactly bound"); }

export function getUsdcFreshSuccessorApprovalPublicValue(approval: UsdcFreshSuccessorApproval): Readonly<Record<string, unknown>> {
  const proposal = approvals.get(approval), value = approvalPublicValues.get(approval);
  if (!proposal || !proposals.has(proposal) || !value || value.proposalHash !== proposal.proposalHash || value.certificateHash !== proposal.certificateHash || value.sourceHash !== proposal.sourceHash || value.approvalHash !== undefined || !same(publicHash(value), approval.approvalHash)) throw new Error("fresh USDC successor approval is not a genuine opaque verified approval");
  return freeze(structuredClone(value));
}

export function attachUsdcFreshSuccessor(journal: OrdinaryScenarioJournal, proposal: UsdcFreshSuccessorProposal, approval: UsdcFreshSuccessorApproval): OrdinaryScenarioJournal & { usdcFreshSuccessor: UsdcFreshSuccessorStorage } {
  assertUsdcFreshSuccessorAuthorization(proposal, approval);
  if ("usdcFreshSuccessor" in journal) throw new Error("journal already has a fresh USDC successor attachment");
  const expectedJournal = proposalJournals.get(proposal), expectedJournalHash = proposalJournalHashes.get(proposal);
  if (!expectedJournal || journal !== expectedJournal || !expectedJournalHash || !same(publicHash(journal), expectedJournalHash)) throw new Error("fresh USDC successor attachment journal is detached or changed from the reviewed source");
  exactKeys(journal as unknown as Record<string, unknown>, ["schemaVersion", "chainId", "reviewPackageHash", "proposalHash", "approvalHash", "funder", "actions", "liveJournal", "hashlessContinuation", "usdcSuccessor"], "fresh USDC successor attachment source journal");
  const storage: UsdcFreshSuccessorStorage = freeze({ schemaVersion: 1, scope: FRESH_SUCCESSOR_SCOPE, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, proposalHash: proposal.proposalHash, approvalHash: approval.approvalHash, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, actionCommitments: proposal.actions.map(({ id, commitment }) => freeze({ id, commitment })), maximumReservationWei: proposal.reservation.successorMaximumReservationWei, maxBroadcastAttempts: 1, repairAuthority: "NONE", actions: proposal.actions.map(({ id, commitment }) => ({ id, commitment, status: "approved" as const })) });
  (journal as OrdinaryScenarioJournal & { usdcFreshSuccessor: UsdcFreshSuccessorStorage }).usdcFreshSuccessor = storage;
  return journal as OrdinaryScenarioJournal & { usdcFreshSuccessor: UsdcFreshSuccessorStorage };
}

export function assertUsdcFreshSuccessorAdmission(proposal: UsdcFreshSuccessorProposal, actionId: string, chainTimestamp: bigint, now: Date, phase: "review" | "scenario" | "private" | "broadcast"): void {
  if (!proposals.has(proposal)) throw new Error("fresh USDC successor admission requires an opaque proposal");
  const index = proposal.actions.findIndex(item => item.id === actionId); if (index < 0) throw new Error("fresh USDC successor action is outside the closed catalog");
  if (typeof chainTimestamp !== "bigint") throw new Error("fresh USDC successor chain timestamp must be a bigint");
  const milliseconds = now instanceof Date ? now.getTime() : Number.NaN; if (!Number.isFinite(milliseconds)) throw new Error("fresh USDC successor root UTC date must be finite");
  const nowSeconds = BigInt(Math.floor(milliseconds / 1000)), period = BigInt(proposal.effectivePeriod), deadline = BigInt(proposal.deadline), expiry = BigInt(proposal.observer.expiresAt), ready = BigInt(proposal.observer.readyAt);
  if (chainTimestamp < period) throw new Error("fresh USDC successor canonical chain timestamp precedes the approved period");
  if (nowSeconds < ready) throw new Error("fresh USDC successor root UTC precedes observer readiness");
  if (chainTimestamp >= deadline || nowSeconds >= deadline) throw new Error("fresh USDC successor approved period deadline has elapsed");
  if (chainTimestamp >= expiry || nowSeconds >= expiry) throw new Error("fresh USDC successor receiver expiry has elapsed");
  const remaining = [deadline - chainTimestamp, deadline - nowSeconds, expiry - chainTimestamp, expiry - nowSeconds].reduce((minimum, value) => value < minimum ? value : minimum);
  let required = 1n, strict = false;
  if (phase === "review") required = BigInt(FRESH_SUCCESSOR_SCHEDULE.reviewAdmission);
  if (phase === "scenario") { const groupIndex = FRESH_SUCCESSOR_GROUPS.findIndex(group => index + 1 >= group.start && index + 1 <= group.end); required = FRESH_SUCCESSOR_GROUPS.slice(groupIndex).reduce((sum, group) => sum + BigInt(group.budgetSeconds), BigInt(FRESH_SUCCESSOR_SCHEDULE.reconciliationMargin)); }
  if ((phase === "private" || phase === "broadcast") && proposal.actions[index]!.kind === "queue-proposal") { const group = FRESH_SUCCESSOR_GROUPS.find(item => index + 1 >= item.start && index + 1 <= item.end)!; required = BigInt(group.budgetSeconds) + BigInt(FRESH_SUCCESSOR_SCHEDULE.reconciliationMargin); strict = true; }
  if (strict ? remaining <= required : remaining < required) throw new Error(`fresh USDC successor ${phase} admission has insufficient remaining time for ${required} seconds${strict ? " plus queue margin" : ""}`);
}
