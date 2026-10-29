import type { Hex } from "viem";
import { sha256 } from "../plan-deployment";
import { hashUsdcSuccessorSource, isVerifiedUsdcSuccessorCertificate, type UsdcSuccessorSource, type VerifiedUsdcSuccessorCertificate } from "./ordinary-scenario-usdc-successor-certificate";
import { assertHashlessSourceJournalReadOnlySnapshot } from "./ordinary-scenario-hashless-certificate";
import { assertExpiredHashlessContinuationAuthorization, assertExpiredHashlessContinuationLineage, buildClosedUsdcSuccessorActions, type ContinuationActionCaps, type ContinuationObserverBinding, type ExpiredHashlessContinuationAction } from "./ordinary-scenario-hashless-continuation";
import type { OrdinaryScenarioActionRecord, OrdinaryScenarioJournal } from "./ordinary-scenario-executor";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SCOPE = "ordinary-usdc-period-successor-v1" as const;
const AUTHORITY_EVIDENCE_HASH = "0xc7dca18faa9a9bf1cb2028c8bb77a5ccf8b0577145a408dd301d043be09bad3b" as Hex;
const PHASE_LIMIT = 50_000_000_000_000_000n;
const PRIOR_PRINCIPAL = 60_000_000_000_002n;
const SUCCESSOR_RESERVATION = 16_080_584_000_000n;
const GROSS_USDC = 31_000_000n;
const RECYCLED_USDC = 11_000_000n;

export const USDC_SUCCESSOR_SCHEDULE = Object.freeze({ review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300", reviewAdmission: "11640", initialExecutionAdmission: "8040", reconciliationMargin: "840" } as const);
export const USDC_SUCCESSOR_GROUPS = Object.freeze([
  Object.freeze({ start: 1 as const, end: 7 as const, budgetSeconds: "2400" as const }),
  Object.freeze({ start: 8 as const, end: 12 as const, budgetSeconds: "1500" as const }),
  Object.freeze({ start: 13 as const, end: 16 as const, budgetSeconds: "1800" as const }),
  Object.freeze({ start: 17 as const, end: 19 as const, budgetSeconds: "1500" as const }),
]);

type UsdcSuccessorSchedule = typeof USDC_SUCCESSOR_SCHEDULE;
type UsdcSuccessorGroup = typeof USDC_SUCCESSOR_GROUPS[number];
type UsdcSuccessorReservation = Readonly<{ phaseLimitWei: string; priorActualGasCostWei: string; priorPrincipalWei: string; successorMaximumReservationWei: string; aggregateSuccessorAllowanceWei: string; maximumCumulativeOutlayWei: string; grossUsdcAllowance: string; recycledUsdcAllowance: string }>;
declare const proposalBrand: unique symbol;
export type UsdcSuccessorProposal = Readonly<{ schemaVersion: 1; scope: typeof SCOPE; authorization: "NONE"; chainId: 11155111; authorityEvidenceHash: Hex; sourceHash: Hex; certificateHash: Hex; snapshot: Readonly<{ blockNumber: string; blockHash: Hex; timestamp: string }>; effectivePeriod: string; deadline: string; observer: ContinuationObserverBinding; schedule: UsdcSuccessorSchedule; groups: readonly UsdcSuccessorGroup[]; caps: ContinuationActionCaps; reservation: UsdcSuccessorReservation; maxBroadcastAttempts: 1; actions: readonly ExpiredHashlessContinuationAction[]; proposalHash: Hex; readonly [proposalBrand]: true }>;
declare const approvalBrand: unique symbol;
export type UsdcSuccessorApproval = Readonly<{ approvalHash: Hex; readonly [approvalBrand]: true }>;
export type UsdcSuccessorStorage = Readonly<{ schemaVersion: 1; scope: typeof SCOPE; sourceHash: Hex; certificateHash: Hex; proposalHash: Hex; approvalHash: Hex; effectivePeriod: string; deadline: string; actionCommitments: readonly Readonly<{ id: string; commitment: Hex }>[]; maximumReservationWei: string; maxBroadcastAttempts: 1; actions: Array<Readonly<{ id: string; commitment: Hex; status: "approved" }> | OrdinaryScenarioActionRecord> }>;

const proposals = new WeakSet<object>();
const approvals = new WeakMap<object, UsdcSuccessorProposal>();
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };
const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} shape mismatch`); };
const decimal = (value: unknown, label: string): bigint => { if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`); return BigInt(value); };
const hash = (value: unknown, label: string): Hex => { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a hash`); return value as Hex; };
const publicHash = (value: unknown): Hex => sha256(value) as Hex;

function assertSourceAndCertificate(source: UsdcSuccessorSource, certificate: VerifiedUsdcSuccessorCertificate): void {
  assertHashlessSourceJournalReadOnlySnapshot(source.journal);
  assertExpiredHashlessContinuationLineage(source.original, source.recovery);
  assertExpiredHashlessContinuationAuthorization(source.recovery, source.recoveryApproval);
  if (!isVerifiedUsdcSuccessorCertificate(certificate)) throw new Error("USDC successor requires an opaque verified certificate");
  const sourceHash = hashUsdcSuccessorSource(source.journal);
  if (!same(sourceHash, certificate.sourceHash)) throw new Error("USDC successor source and certificate are not content-bound");
  if (source.journal.actions.length !== 19 || source.journal.liveJournal.entries.length < 13 || !source.journal.hashlessContinuation || source.journal.hashlessContinuation.actions.length !== 22) throw new Error("USDC successor source lineage is incomplete");
  for (let index = 0; index < 3; index++) if (source.journal.hashlessContinuation.actions[index]?.status !== "confirmed") throw new Error("USDC successor source native recovery is incomplete");
  for (let index = 3; index < 22; index++) if (source.journal.hashlessContinuation.actions[index]?.status !== "approved") throw new Error("USDC successor source USDC tail is not untouched");
}

function validateCaps(caps: ContinuationActionCaps): ContinuationActionCaps {
  exactKeys(caps as unknown as Record<string, unknown>, ["fundingGasLimit", "safeExecutionGasLimit", "publicDelayGasLimit", "maxFeePerGas", "maxPriorityFeePerGas"], "USDC successor caps");
  const expected: ContinuationActionCaps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" };
  if (JSON.stringify(caps) !== JSON.stringify(expected)) throw new Error("USDC successor caps must equal the reviewed literal caps");
  return freeze({ ...caps });
}

function validateObserver(observer: ContinuationObserverBinding, certificate: VerifiedUsdcSuccessorCertificate, deadline: bigint): ContinuationObserverBinding {
  exactKeys(observer as unknown as Record<string, unknown>, ["kind", "publicId", "endpointHash", "startupEvidenceHash", "probeEvidenceHash", "independentFromProposer", "readyAt", "workflowScheduleSeconds", "requiredThrough", "expiresAt"], "USDC successor observer");
  exactKeys(observer.workflowScheduleSeconds as unknown as Record<string, unknown>, ["review", "execution", "confirmations", "delivery", "acknowledgement", "keylessConfirmation"], "USDC successor observer schedule");
  const expectedWorkflow = { review: USDC_SUCCESSOR_SCHEDULE.review, execution: USDC_SUCCESSOR_SCHEDULE.execution, confirmations: USDC_SUCCESSOR_SCHEDULE.confirmations, delivery: USDC_SUCCESSOR_SCHEDULE.delivery, acknowledgement: USDC_SUCCESSOR_SCHEDULE.acknowledgement, keylessConfirmation: USDC_SUCCESSOR_SCHEDULE.keylessConfirmation };
  if (observer.kind !== "https-webhook" || observer.independentFromProposer !== true || JSON.stringify(observer.workflowScheduleSeconds) !== JSON.stringify(expectedWorkflow) || !observer.publicId.startsWith("temporary-test-receiver:") || !observer.publicId.endsWith(observer.endpointHash) || !HASH.test(observer.endpointHash) || !HASH.test(observer.startupEvidenceHash) || !HASH.test(observer.probeEvidenceHash) || same(observer.endpointHash, observer.startupEvidenceHash) || same(observer.endpointHash, observer.probeEvidenceHash) || same(observer.startupEvidenceHash, observer.probeEvidenceHash)) throw new Error("USDC successor observer or exact 7200-second execution schedule is invalid");
  const ready = decimal(observer.readyAt, "observer readyAt"), requiredThrough = decimal(observer.requiredThrough, "observer requiredThrough"), expires = decimal(observer.expiresAt, "observer expiresAt");
  if (ready < certificate.snapshot.block.timestamp || requiredThrough !== ready + 11_640n || deadline - ready < 11_640n || expires - ready < 11_640n || expires < requiredThrough) throw new Error("USDC successor observer schedule, receiver lifetime, or 11640-second review admission is invalid");
  return freeze({ ...observer, workflowScheduleSeconds: { ...observer.workflowScheduleSeconds } });
}

type ProposalInput = Readonly<{ source: UsdcSuccessorSource; certificate: VerifiedUsdcSuccessorCertificate; observer: ContinuationObserverBinding; caps: ContinuationActionCaps }>;
function buildProposal(input: ProposalInput, mode: "create" | "parse"): UsdcSuccessorProposal {
  assertSourceAndCertificate(input.source, input.certificate);
  if (mode === "create" && "usdcSuccessor" in input.source.journal) throw new Error("journal already has a USDC successor attachment");
  const effectivePeriod = input.certificate.effectivePeriod;
  const deadline = effectivePeriod + 86_400n;
  const caps = validateCaps(input.caps);
  const observer = validateObserver(input.observer, input.certificate, deadline);
  const actions = buildClosedUsdcSuccessorActions(input.source.original, input.source.recovery, caps);
  if (actions.length !== 19 || actions.some((action, index) => action.id !== `usdc-successor-${input.source.recovery.actions[index + 3]!.id.slice(5)}`)) throw new Error("USDC successor literal 19-action catalog mismatch");
  const priorActualGasCost = BigInt(input.source.original.baselineActualCostWei) + input.source.journal.actions.reduce((sum, action) => sum + BigInt(action.ourReceiptGasCost ?? "0"), 0n) + input.certificate.recoveryGasCostWei;
  const maximumCumulativeOutlay = priorActualGasCost + PRIOR_PRINCIPAL + SUCCESSOR_RESERVATION;
  if (maximumCumulativeOutlay > PHASE_LIMIT) throw new Error("USDC successor aggregate reservation exceeds the whole-phase ceiling");
  const reservation = freeze({ phaseLimitWei: PHASE_LIMIT.toString(), priorActualGasCostWei: priorActualGasCost.toString(), priorPrincipalWei: PRIOR_PRINCIPAL.toString(), successorMaximumReservationWei: SUCCESSOR_RESERVATION.toString(), aggregateSuccessorAllowanceWei: SUCCESSOR_RESERVATION.toString(), maximumCumulativeOutlayWei: maximumCumulativeOutlay.toString(), grossUsdcAllowance: GROSS_USDC.toString(), recycledUsdcAllowance: RECYCLED_USDC.toString() });
  const sourceHash = hashUsdcSuccessorSource(input.source.journal);
  const body = { schemaVersion: 1 as const, scope: SCOPE, authorization: "NONE" as const, chainId: 11_155_111 as const, authorityEvidenceHash: AUTHORITY_EVIDENCE_HASH, sourceHash, certificateHash: input.certificate.certificateHash, snapshot: freeze({ blockNumber: input.certificate.snapshot.block.number.toString(), blockHash: input.certificate.snapshot.block.hash, timestamp: input.certificate.snapshot.block.timestamp.toString() }), effectivePeriod: effectivePeriod.toString(), deadline: deadline.toString(), observer, schedule: USDC_SUCCESSOR_SCHEDULE, groups: USDC_SUCCESSOR_GROUPS, caps, reservation, maxBroadcastAttempts: 1 as const, actions };
  const proposal = freeze({ ...body, proposalHash: publicHash(body) }) as unknown as UsdcSuccessorProposal;
  proposals.add(proposal);
  return proposal;
}

export function createUsdcSuccessorProposal(input: ProposalInput): UsdcSuccessorProposal { return buildProposal(input, "create"); }

function assertAttached(value: unknown, proposal: UsdcSuccessorProposal): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("attached USDC successor storage is malformed");
  const storage = value as Partial<UsdcSuccessorStorage>;
  if (storage.schemaVersion !== 1 || storage.scope !== SCOPE || storage.sourceHash !== proposal.sourceHash || storage.certificateHash !== proposal.certificateHash || storage.proposalHash !== proposal.proposalHash || storage.effectivePeriod !== proposal.effectivePeriod || storage.deadline !== proposal.deadline || storage.maxBroadcastAttempts !== 1 || storage.maximumReservationWei !== proposal.reservation.successorMaximumReservationWei || !Array.isArray(storage.actionCommitments) || !Array.isArray(storage.actions) || storage.actionCommitments.length !== 19 || storage.actions.length !== 19) throw new Error("attached USDC successor header or action lineage mismatch");
  for (let index = 0; index < 19; index++) if (storage.actionCommitments[index]?.id !== proposal.actions[index]!.id || storage.actionCommitments[index]?.commitment !== proposal.actions[index]!.commitment || storage.actions[index]?.id !== proposal.actions[index]!.id || storage.actions[index]?.commitment !== proposal.actions[index]!.commitment) throw new Error("attached USDC successor catalog drifted");
}

export function parseUsdcSuccessorProposal(serialized: string, source: UsdcSuccessorSource, certificate: VerifiedUsdcSuccessorCertificate): UsdcSuccessorProposal {
  if (Buffer.byteLength(serialized, "utf8") > 2_000_000) throw new Error("USDC successor proposal is too large");
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("USDC successor proposal must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("USDC successor proposal must be an object");
  exactKeys(parsed as Record<string, unknown>, ["schemaVersion", "scope", "authorization", "chainId", "authorityEvidenceHash", "sourceHash", "certificateHash", "snapshot", "effectivePeriod", "deadline", "observer", "schedule", "groups", "caps", "reservation", "maxBroadcastAttempts", "actions", "proposalHash"], "USDC successor proposal");
  const expected = buildProposal({ source, certificate, observer: (parsed as any).observer, caps: (parsed as any).caps }, "parse");
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("USDC successor proposal shape, catalog, commitment, or hash drift");
  const attached = (source.journal as OrdinaryScenarioJournal & { usdcSuccessor?: unknown }).usdcSuccessor;
  if (attached !== undefined) assertAttached(attached, expected);
  return expected;
}

export function loadUsdcSuccessorApproval(proposal: UsdcSuccessorProposal, serialized: string, expectedApprovalHash: Hex): UsdcSuccessorApproval {
  if (!proposals.has(proposal)) throw new Error("USDC successor proposal is not opaque");
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("USDC successor approval must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("USDC successor approval must be an object");
  const value = parsed as Record<string, unknown>;
  exactKeys(value, ["schemaVersion", "scope", "authorization", "authorityEvidenceHash", "proposalHash", "sourceHash", "certificateHash", "snapshot", "effectivePeriod", "deadline", "observer", "schedule", "groups", "caps", "reservation", "maxBroadcastAttempts", "approvedActions"], "USDC successor approval");
  const approvalHash = publicHash(value);
  if (!HASH.test(expectedApprovalHash) || !same(approvalHash, expectedApprovalHash)) throw new Error("USDC successor approval hash mismatch");
  if (value.schemaVersion !== 1 || value.scope !== SCOPE || value.authorization !== "STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION" || value.authorityEvidenceHash !== AUTHORITY_EVIDENCE_HASH || value.proposalHash !== proposal.proposalHash || value.sourceHash !== proposal.sourceHash || value.certificateHash !== proposal.certificateHash || value.effectivePeriod !== proposal.effectivePeriod || value.deadline !== proposal.deadline || value.maxBroadcastAttempts !== 1 || JSON.stringify(value.snapshot) !== JSON.stringify(proposal.snapshot) || JSON.stringify(value.observer) !== JSON.stringify(proposal.observer) || JSON.stringify(value.schedule) !== JSON.stringify(proposal.schedule) || JSON.stringify(value.groups) !== JSON.stringify(proposal.groups) || JSON.stringify(value.caps) !== JSON.stringify(proposal.caps) || JSON.stringify(value.reservation) !== JSON.stringify(proposal.reservation)) throw new Error("USDC successor standing authority exact binding mismatch");
  if (!Array.isArray(value.approvedActions) || value.approvedActions.length !== 19) throw new Error("USDC successor approved action count mismatch");
  value.approvedActions.forEach((raw, index) => { if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("USDC successor approved action shape mismatch"); exactKeys(raw as Record<string, unknown>, ["id", "commitment"], "USDC successor approved action"); const action = proposal.actions[index]!; if ((raw as any).id !== action.id || !same(hash((raw as any).commitment, "approved action commitment"), action.commitment)) throw new Error("USDC successor approved action mismatch"); });
  const approval = freeze({ approvalHash }) as UsdcSuccessorApproval;
  approvals.set(approval, proposal);
  return approval;
}

export function assertUsdcSuccessorAuthorization(proposal: UsdcSuccessorProposal, approval: UsdcSuccessorApproval): void { if (!proposals.has(proposal) || approvals.get(approval) !== proposal) throw new Error("USDC successor authorization is not opaque and exactly bound"); }

export function attachUsdcSuccessor(journal: OrdinaryScenarioJournal, proposal: UsdcSuccessorProposal, approval: UsdcSuccessorApproval): OrdinaryScenarioJournal & { usdcSuccessor: UsdcSuccessorStorage } {
  assertUsdcSuccessorAuthorization(proposal, approval);
  assertHashlessSourceJournalReadOnlySnapshot(journal);
  if ("usdcSuccessor" in journal) throw new Error("journal already has a USDC successor attachment");
  if (!same(hashUsdcSuccessorSource(journal), proposal.sourceHash) || journal.liveJournal.entries.length !== 13 || !journal.hashlessContinuation) throw new Error("USDC successor journal source changed before attachment");
  const storage: UsdcSuccessorStorage = freeze({ schemaVersion: 1, scope: SCOPE, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, proposalHash: proposal.proposalHash, approvalHash: approval.approvalHash, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, actionCommitments: proposal.actions.map(({ id, commitment }) => freeze({ id, commitment })), maximumReservationWei: proposal.reservation.successorMaximumReservationWei, maxBroadcastAttempts: 1, actions: proposal.actions.map(({ id, commitment }) => ({ id, commitment, status: "approved" as const })) });
  (journal as OrdinaryScenarioJournal & { usdcSuccessor: UsdcSuccessorStorage }).usdcSuccessor = storage;
  return journal as OrdinaryScenarioJournal & { usdcSuccessor: UsdcSuccessorStorage };
}

export function assertUsdcSuccessorAdmission(proposal: UsdcSuccessorProposal, actionId: string, chainTimestamp: bigint, now: Date, phase: "review" | "scenario" | "private" | "broadcast"): void {
  if (!proposals.has(proposal)) throw new Error("USDC successor admission requires an opaque proposal");
  const index = proposal.actions.findIndex(action => action.id === actionId);
  if (index < 0) throw new Error("USDC successor action is outside the closed catalog");
  if (typeof chainTimestamp !== "bigint") throw new Error("USDC successor chain timestamp must be a bigint");
  const nowMilliseconds = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMilliseconds)) throw new Error("USDC successor root UTC date must be finite");
  const nowSeconds = BigInt(Math.floor(nowMilliseconds / 1000));
  const period = BigInt(proposal.effectivePeriod), deadline = BigInt(proposal.deadline), receiverExpiry = BigInt(proposal.observer.expiresAt), readyAt = BigInt(proposal.observer.readyAt);
  if (chainTimestamp < period) throw new Error("USDC successor canonical chain timestamp precedes the approved period");
  if (nowSeconds < readyAt) throw new Error("USDC successor root UTC precedes fresh observer readiness");
  if (chainTimestamp >= deadline || nowSeconds >= deadline) throw new Error("USDC successor approved period deadline has elapsed");
  if (chainTimestamp >= receiverExpiry || nowSeconds >= receiverExpiry) throw new Error("USDC successor receiver expiry has elapsed");
  const remaining = [deadline - chainTimestamp, deadline - nowSeconds, receiverExpiry - chainTimestamp, receiverExpiry - nowSeconds].reduce((minimum, value) => value < minimum ? value : minimum);
  let required = 1n;
  let strict = false;
  if (phase === "review") required = BigInt(USDC_SUCCESSOR_SCHEDULE.reviewAdmission);
  if (phase === "scenario") { const groupIndex = USDC_SUCCESSOR_GROUPS.findIndex(group => index + 1 >= group.start && index + 1 <= group.end); required = USDC_SUCCESSOR_GROUPS.slice(groupIndex).reduce((sum, group) => sum + BigInt(group.budgetSeconds), BigInt(USDC_SUCCESSOR_SCHEDULE.reconciliationMargin)); }
  if ((phase === "private" || phase === "broadcast") && proposal.actions[index]!.kind === "queue-proposal") { const group = USDC_SUCCESSOR_GROUPS.find(candidate => index + 1 >= candidate.start && index + 1 <= candidate.end)!; required = BigInt(group.budgetSeconds) + BigInt(USDC_SUCCESSOR_SCHEDULE.reconciliationMargin); strict = true; }
  if (strict ? remaining <= required : remaining < required) throw new Error(`USDC successor ${phase} admission has insufficient remaining time for ${required} seconds${strict ? " plus queue margin" : ""}`);
}
