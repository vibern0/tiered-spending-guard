import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { sha256 } from "../plan-deployment";
import { assertExpiredHashlessContinuationAuthorization, assertExpiredHashlessContinuationLineage } from "./ordinary-scenario-hashless-continuation";
import { assertUsdcSuccessorReceiptInclusion, type OrdinaryScenarioActionRecord, type OrdinaryScenarioJournal } from "./ordinary-scenario-executor";
import {
  REPAIR_ACTION_IDS,
  assertRepairApproval,
  loadRepairCreationProposal,
  loadRepairGroupProposal,
  verifyRepairPredecessor,
  type RepairApproval,
  type RepairCreationProposal,
  type RepairGroupProposal,
  type RepairPrefixEvidence,
} from "./ordinary-scenario-repair";
import {
  hashUsdcSuccessorSource,
  isVerifiedUsdcSuccessorCertificate,
  type UsdcSuccessorSource,
  type VerifiedUsdcSuccessorCertificate,
} from "./ordinary-scenario-usdc-successor-certificate";
import {
  assertUsdcSuccessorAuthorization,
  type UsdcSuccessorApproval,
  type UsdcSuccessorProposal,
} from "./ordinary-scenario-usdc-successor-proposal";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const TERMINAL = new Set(["confirmed", "rejection-proved"]);
const PROGRESS = new Set(["approved", "materialized", "signed-simulated", "outer-pending", "reverted", "stopped"]);
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const hash = (value: unknown, label: string): Hex => { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is not a hash`); return value as Hex; };
const publicHash = (value: unknown): Hex => sha256(value) as Hex;
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const repairPublicHash = (value: unknown): Hex => `0x${createHash("sha256").update(JSON.stringify(publicValue(value))).digest("hex")}` as Hex;
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };

export type UsdcSuccessorReportContext = Readonly<{
  certificate: VerifiedUsdcSuccessorCertificate;
  proposal: UsdcSuccessorProposal;
  approval: UsdcSuccessorApproval;
}>;

export type UsdcSuccessorRepairReportEvidence = Readonly<{
  creation: RepairCreationProposal;
  creationApproval?: RepairApproval;
  group?: RepairGroupProposal;
  groupApproval?: RepairApproval;
}>;

function sameReceipt(left: OrdinaryScenarioActionRecord["receipt"], right: OrdinaryScenarioJournal["liveJournal"]["entries"][number]["receipt"]): boolean {
  return !!left && !!right && same(left.transactionHash, right.transactionHash) && left.status === "success" && right.status === "success" && BigInt(left.gasUsed) === BigInt(right.gasUsed) && BigInt(left.effectiveGasPrice) === BigInt(right.effectiveGasPrice) && BigInt(left.blockNumber) === BigInt(right.blockNumber) && same(left.blockHash, right.blockHash);
}

function assertSourceAndContext(source: UsdcSuccessorSource, context: UsdcSuccessorReportContext, journal: OrdinaryScenarioJournal): void {
  assertExpiredHashlessContinuationLineage(source.original, source.recovery);
  assertExpiredHashlessContinuationAuthorization(source.recovery, source.recoveryApproval);
  if (!isVerifiedUsdcSuccessorCertificate(context.certificate)) throw new Error("USDC successor report certificate is not opaque and verified");
  assertUsdcSuccessorAuthorization(context.proposal, context.approval);
  const proposal = context.proposal, certificate = context.certificate, attached = journal.usdcSuccessor, recovery = journal.hashlessContinuation;
  if (!same(certificate.sourceHash, proposal.sourceHash) || !same(certificate.certificateHash, proposal.certificateHash) || certificate.effectivePeriod.toString() !== proposal.effectivePeriod || !same(hashUsdcSuccessorSource(journal), proposal.sourceHash)) throw new Error("USDC successor report certificate, source, or effective-period binding mismatch");
  if (journal.schemaVersion !== 1 || journal.chainId !== source.original.chainId || journal.liveJournal.chainId !== source.original.chainId || !same(journal.reviewPackageHash, source.original.reviewPackageHash) || !same(journal.proposalHash, source.original.proposalHash) || !same(journal.funder, source.original.funder) || journal.actions.length !== 19 || journal.liveJournal.entries.length < 13) throw new Error("USDC successor report historical source identity mismatch");
  if (!recovery || recovery.actions.length !== 22 || recovery.actionCommitments.length !== 22 || !same(recovery.historicalPrefixHash, source.recovery.historicalPrefixHash) || !same(recovery.certificateHash, source.recovery.certificateHash) || !same(recovery.proposalHash, source.recovery.proposalHash) || !same(recovery.approvalHash, source.recoveryApproval.approvalHash) || publicHash(recovery.source) !== publicHash(source.recovery.source)) throw new Error("USDC successor report native recovery header or lineage mismatch");
  for (let index = 0; index < 22; index++) {
    const action = source.recovery.actions[index]!, commitment = recovery.actionCommitments[index]!, record = recovery.actions[index]!;
    if (commitment.id !== action.id || !same(commitment.commitment, action.commitment) || record.id !== action.id || !same(record.commitment, action.commitment)) throw new Error("USDC successor report native recovery catalog mismatch");
    if (index < 3) {
      if (record.status !== "confirmed" || !record.transactionHash || !record.receipt || record.receipt.status !== "success" || !same(record.transactionHash, record.receipt.transactionHash) || !record.evidenceHash || !HASH.test(record.evidenceHash)) throw new Error("USDC successor report native recovery 3-of-22 evidence mismatch");
    } else if (record.status !== "approved" || Object.keys(record).sort().join(",") !== "commitment,id,status") throw new Error("USDC successor report superseded old USDC tail changed");
  }
  if (!attached || attached.schemaVersion !== 1 || attached.scope !== "ordinary-usdc-period-successor-v1" || !same(attached.sourceHash, proposal.sourceHash) || !same(attached.certificateHash, certificate.certificateHash) || !same(attached.proposalHash, proposal.proposalHash) || !same(attached.approvalHash, context.approval.approvalHash) || attached.effectivePeriod !== proposal.effectivePeriod || attached.deadline !== proposal.deadline || attached.maximumReservationWei !== proposal.reservation.successorMaximumReservationWei || attached.maxBroadcastAttempts !== 1 || attached.actionCommitments.length !== 19 || attached.actions.length !== 19) throw new Error("USDC successor report attachment header or exact approval binding mismatch");
}

type SuccessorProgress = Readonly<{ complete: boolean; terminalCount: number; successfulCount: number; actions: readonly Readonly<Record<string, unknown>>[] }>;

function validateSuccessor(context: UsdcSuccessorReportContext, journal: OrdinaryScenarioJournal): SuccessorProgress {
  const proposal = context.proposal, attached = journal.usdcSuccessor!;
  const expectedLive: Array<{ record: OrdinaryScenarioActionRecord; status: "success" | "pending" | "reverted" }> = [];
  let complete = true, terminalCount = 0, successfulCount = 0;
  const actions = proposal.actions.map((action, index) => {
    const commitment = attached.actionCommitments[index]!, record = attached.actions[index] as OrdinaryScenarioActionRecord;
    if (commitment.id !== action.id || !same(commitment.commitment, action.commitment) || record.id !== action.id || !same(record.commitment, action.commitment)) throw new Error("USDC successor report action catalog or commitment mismatch");
    const expectedTerminal = action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed";
    if (TERMINAL.has(record.status)) {
      terminalCount++;
      if (record.status !== expectedTerminal || !record.evidenceHash || !HASH.test(record.evidenceHash)) throw new Error(`USDC successor report terminal evidence mismatch at action ${index + 1}`);
      if (record.status === "confirmed") {
        const receipt = record.receipt;
        if (!record.transactionHash || !receipt || receipt.status !== "success" || !same(record.transactionHash, receipt.transactionHash) || !HASH.test(receipt.blockHash) || BigInt(receipt.blockNumber) <= 0n || BigInt(receipt.gasUsed) <= 0n || BigInt(receipt.gasUsed) > BigInt(action.gasLimitCap) || BigInt(receipt.effectiveGasPrice) < 0n || BigInt(receipt.effectiveGasPrice) > BigInt(action.maxFeePerGasCap) || BigInt(record.ourReceiptGasCost ?? "-1") !== BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) || BigInt(record.ourPrincipalDelta ?? "-1") !== 0n || BigInt(record.outerValue ?? "-1") !== 0n) throw new Error(`USDC successor report canonical receipt, cost, or principal accounting mismatch at action ${index + 1}`);
        assertUsdcSuccessorReceiptInclusion(record, proposal.effectivePeriod, proposal.deadline);
        if (index === 0 ? record.establishedWindow !== proposal.effectivePeriod : record.establishedWindow !== undefined) throw new Error("USDC successor report receipt effective-period binding mismatch");
        expectedLive.push({ record, status: "success" }); successfulCount++;
      } else if (record.transactionHash !== undefined || record.receipt !== undefined) throw new Error(`USDC successor report rejection evidence unexpectedly carries a transaction at action ${index + 1}`);
    } else {
      complete = false;
      if (!PROGRESS.has(record.status)) throw new Error(`USDC successor report progress status mismatch at action ${index + 1}`);
      if (record.status === "approved") {
        if (Object.keys(record).sort().join(",") !== "commitment,id,status") throw new Error("USDC successor report approved action carries materialized evidence");
      } else if (record.status === "outer-pending") {
        if (!record.transactionHash || !HASH.test(record.transactionHash)) throw new Error("USDC successor report pending action lacks a durable transaction hash");
        expectedLive.push({ record, status: "pending" });
      } else if (record.status === "reverted") {
        if (!record.transactionHash || !record.receipt || record.receipt.status !== "reverted" || !same(record.transactionHash, record.receipt.transactionHash)) throw new Error("USDC successor report reverted action lacks its canonical receipt");
        expectedLive.push({ record, status: "reverted" });
      } else if (record.transactionHash !== undefined && record.intentHash !== undefined) {
        expectedLive.push({ record, status: record.receipt?.status === "reverted" ? "reverted" : record.receipt?.status === "success" ? "success" : "pending" });
      }
    }
    return freeze({ id: action.id, status: record.status, evidenceHash: TERMINAL.has(record.status) ? record.evidenceHash ?? null : null, transactionHash: record.transactionHash ?? null, failureCause: null });
  });
  const live = journal.liveJournal.entries.slice(13, 13 + expectedLive.length);
  if (live.length !== expectedLive.length) throw new Error("USDC successor report live evidence is missing");
  for (let index = 0; index < expectedLive.length; index++) {
    const expected = expectedLive[index]!, entry = live[index]!;
    if (entry.id !== expected.record.id || entry.status !== expected.status || !expected.record.transactionHash || !same(entry.transactionHash, expected.record.transactionHash)) throw new Error("USDC successor report live evidence catalog mismatch");
    if (expected.status === "success") {
      if (!sameReceipt(expected.record.receipt, entry.receipt) || entry.reserved !== BigInt(expected.record.ourReceiptGasCost ?? "-1")) throw new Error("USDC successor report live receipt accounting mismatch");
    } else if (expected.status === "reverted") {
      if (!expected.record.receipt || !entry.receipt || expected.record.receipt.status !== "reverted" || entry.receipt.status !== "reverted" || !same(expected.record.receipt.transactionHash, entry.receipt.transactionHash)) throw new Error("USDC successor report reverted live receipt mismatch");
    } else if (entry.receipt !== undefined) throw new Error("USDC successor report pending live entry unexpectedly has a receipt");
  }
  const suffix = journal.liveJournal.entries.slice(13 + expectedLive.length);
  if (!journal.repairContinuation && suffix.length !== 0) throw new Error("USDC successor report orphan live suffix has no attached repair");
  if (journal.repairContinuation && suffix.some(entry => !REPAIR_ACTION_IDS.includes(entry.id as typeof REPAIR_ACTION_IDS[number]))) throw new Error("USDC successor report live catalog has an unrelated repair suffix");
  if (complete && (terminalCount !== 19 || successfulCount !== 11 || journal.liveJournal.entries.slice(0, 24).length !== 24)) throw new Error("USDC successor report complete catalog lacks 19 terminal actions or 24 successful live entries");
  return freeze({ complete, terminalCount, successfulCount, actions });
}

function repairPrefixEvidence(source: UsdcSuccessorSource, journal: OrdinaryScenarioJournal): readonly RepairPrefixEvidence[] {
  return [
    ...journal.actions.map((record, index) => ({ actionId: record.id, evidenceHash: index === 18 ? repairPublicHash(source.recovery.source.stoppedRow) : hash(record.evidenceHash, `USDC successor report historical evidence ${index + 1}`), ...(record.transactionHash ? { transactionHash: record.transactionHash } : {}) })),
    ...journal.hashlessContinuation!.actions.slice(0, 3).map((record, index) => ({ actionId: record.id, evidenceHash: hash(record.evidenceHash, `USDC successor report native recovery evidence ${index + 1}`), ...(record.transactionHash ? { transactionHash: record.transactionHash } : {}) })),
    ...journal.usdcSuccessor!.actions.map((record, index) => ({ actionId: record.id, evidenceHash: hash((record as OrdinaryScenarioActionRecord).evidenceHash, `USDC successor report action evidence ${index + 1}`), ...((record as OrdinaryScenarioActionRecord).transactionHash ? { transactionHash: (record as OrdinaryScenarioActionRecord).transactionHash } : {}) })),
  ];
}

function assertRepairReceipt(entry: OrdinaryScenarioJournal["liveJournal"]["entries"][number], record: NonNullable<OrdinaryScenarioJournal["repairContinuation"]>["actions"][number], artifact: RepairCreationProposal["action"] | RepairGroupProposal["actions"][number]): void {
  const receipt = entry.receipt;
  if (entry.id !== record.id || entry.id !== artifact.id || entry.status !== "success" || !record.transactionHash || !same(entry.transactionHash, record.transactionHash) || !receipt || receipt.status !== "success" || !same(receipt.transactionHash, entry.transactionHash) || !HASH.test(receipt.blockHash) || BigInt(receipt.blockNumber) <= 0n || BigInt(receipt.gasUsed) <= 0n || BigInt(receipt.gasUsed) > BigInt(artifact.gasLimitCap) || BigInt(receipt.effectiveGasPrice) < 0n || BigInt(receipt.effectiveGasPrice) > BigInt(artifact.maxFeePerGasCap) || entry.reserved !== BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)) throw new Error("USDC successor report repair live receipt or accounting mismatch");
}

function renderRepair(source: UsdcSuccessorSource, context: UsdcSuccessorReportContext, journal: OrdinaryScenarioJournal, successorComplete: boolean, evidence?: UsdcSuccessorRepairReportEvidence): Readonly<Record<string, unknown>> {
  const repair = journal.repairContinuation;
  if (!repair) {
    if (evidence !== undefined) throw new Error("USDC successor report rejects unused repair evidence without an attached repair");
    return freeze({ status: "NOT_ATTACHED", predecessor: null, terminalCounters: { safeNonce: "19", delayQueueNonce: "9", delayTxNonce: "9" } });
  }
  if (!successorComplete) throw new Error("USDC successor report mixed repair lineage requires the complete 19-action successor");
  if (!evidence) throw new Error("USDC successor report attached repair requires exact public repair evidence context");
  const verified = verifyRepairPredecessor(source.original, journal, repairPrefixEvidence(source, journal), { kind: "usdc-period-successor-v1", source, certificate: context.certificate, successor: context.proposal, approval: context.approval });
  const creation = loadRepairCreationProposal(JSON.stringify(evidence.creation), evidence.creation.proposalHash);
  const predecessor = repair.predecessor;
  if (!predecessor || repair.schemaVersion !== 1 || predecessor.kind !== verified.kind || predecessor.actionCount !== verified.actionCount || repair.originalActionCount !== verified.actionCount) throw new Error("USDC successor report repair predecessor identity mismatch");
  if (!same(repair.prefixHash, verified.prefixHash) || !same(repair.prefixHash, creation.prefixHash)) throw new Error("USDC successor report repair prefix mismatch");
  if (!same(repair.creationProposalHash, creation.proposalHash)) throw new Error("USDC successor report repair creation proposal hash mismatch");
  if (publicHash(predecessor) !== publicHash(creation.predecessor) || !same(creation.originalProposalHash, source.original.proposalHash) || !same(creation.originalApprovalHash, journal.approvalHash)) throw new Error("USDC successor report repair creation lineage mismatch");
  const creationRecord = repair.actions[0];
  if (!creationRecord || creationRecord.id !== creation.action.id || !same(creationRecord.commitment, creation.action.commitment)) throw new Error("USDC successor report repair creation commitment mismatch");
  if (repair.creationApprovalHash) {
    if (!evidence.creationApproval) throw new Error("USDC successor report repair creation approval context is missing");
    assertRepairApproval(evidence.creation, evidence.creationApproval);
    if (!same(repair.creationApprovalHash, evidence.creationApproval.approvalHash) || creationRecord.status === "proposed") throw new Error("USDC successor report repair creation approval stage mismatch");
  } else if (evidence.creationApproval !== undefined || creationRecord.status !== "proposed") throw new Error("USDC successor report repair creation approval stage mismatch");
  const hasGroup = repair.groupProposalHash !== undefined || repair.groupApprovalHash !== undefined || repair.actions.length > 1;
  let group: RepairGroupProposal | undefined;
  if (hasGroup) {
    if (!repair.groupProposalHash || !repair.groupApprovalHash || !evidence.group || !evidence.groupApproval || creationRecord.status !== "confirmed") throw new Error("USDC successor report repair group evidence context or creation stage is incomplete");
    group = loadRepairGroupProposal(JSON.stringify(evidence.group), evidence.group.proposalHash);
    assertRepairApproval(evidence.group, evidence.groupApproval);
    if (!same(repair.groupProposalHash, group.proposalHash) || !same(repair.groupApprovalHash, evidence.groupApproval.approvalHash) || !same(group.creationProposalHash, creation.proposalHash) || !same(group.originalProposalHash, source.original.proposalHash) || !same(group.originalApprovalHash, journal.approvalHash) || !same(group.prefixHash, verified.prefixHash) || publicHash(group.predecessor) !== publicHash(creation.predecessor)) throw new Error("USDC successor report repair group header or approval mismatch");
  } else if (evidence.group !== undefined || evidence.groupApproval !== undefined) throw new Error("USDC successor report rejects unused repair group evidence");
  if (repair.cumulativeActualCostWei !== (group?.cumulativeActualCostWei ?? creation.cumulativeActualCostWei)) throw new Error("USDC successor report repair cumulative cost mismatch");
  let complete = repair.actions.length === REPAIR_ACTION_IDS.length;
  const expectedLive: Array<{ record: typeof creationRecord; artifact: RepairCreationProposal["action"] | RepairGroupProposal["actions"][number] }> = [];
  for (let index = 0; index < repair.actions.length; index++) {
    const record = repair.actions[index]!, expectedId = REPAIR_ACTION_IDS[index], artifact = index === 0 ? creation.action : group?.actions[index - 1];
    if (!expectedId || record.id !== expectedId || !artifact || artifact.id !== record.id || !same(artifact.commitment, record.commitment)) throw new Error("USDC successor report repair action catalog or commitment mismatch");
    const expectedTerminal = record.id === "post-rotation-old-secondary-rejection" ? "rejection-proved" : "confirmed";
    if (record.status === "confirmed" || record.status === "rejection-proved") {
      const noWriteCreation = index === 0 && creation.alreadyDeployed;
      if (record.status !== expectedTerminal || !record.evidenceHash || !HASH.test(record.evidenceHash) || (record.status === "confirmed" && !noWriteCreation && (!record.transactionHash || !HASH.test(record.transactionHash))) || (noWriteCreation && record.transactionHash !== undefined) || (record.status === "rejection-proved" && record.transactionHash !== undefined)) throw new Error("USDC successor report repair terminal evidence mismatch");
      if (record.status === "confirmed" && !noWriteCreation) expectedLive.push({ record, artifact });
    } else {
      complete = false;
      if (!["proposed", "approved", "pending", "stopped"].includes(record.status)) throw new Error("USDC successor report repair progress status mismatch");
      if (record.status === "pending") {
        if (!record.transactionHash || !HASH.test(record.transactionHash)) throw new Error("USDC successor report repair pending hash is missing");
        expectedLive.push({ record, artifact });
      } else if (record.transactionHash !== undefined || record.evidenceHash !== undefined) throw new Error("USDC successor report repair nonterminal evidence stage mismatch");
    }
  }
  const repairLive = journal.liveJournal.entries.slice(24);
  if (repairLive.length !== expectedLive.length) throw new Error("USDC successor report repair live suffix is missing or has extras");
  for (let index = 0; index < expectedLive.length; index++) {
    const expected = expectedLive[index]!, entry = repairLive[index]!;
    if (expected.record.status === "pending") {
      if (entry.id !== expected.record.id || entry.status !== "pending" || !expected.record.transactionHash || !same(entry.transactionHash, expected.record.transactionHash) || entry.receipt !== undefined) throw new Error("USDC successor report repair pending live catalog mismatch");
    } else assertRepairReceipt(entry, expected.record, expected.artifact);
  }
  return freeze({ status: complete ? "REPAIR_TERMINAL_EVIDENCE_RECORDED" : "REPAIR_INCOMPLETE", predecessor: predecessor.kind, actionCount: repair.actions.length, terminalCounters: { safeNonce: "19", delayQueueNonce: "9", delayTxNonce: "9" } });
}

/** Project already-persisted public evidence. Performs no filesystem, RPC, signing, simulation, approval construction, or broadcast work. */
export function renderUsdcSuccessorReport(source: UsdcSuccessorSource, context: UsdcSuccessorReportContext, journal: OrdinaryScenarioJournal, repairEvidence?: UsdcSuccessorRepairReportEvidence): Readonly<Record<string, unknown>> {
  assertSourceAndContext(source, context, journal);
  const progress = validateSuccessor(context, journal);
  const repair = renderRepair(source, context, journal, progress.complete, repairEvidence);
  return freeze({
    schemaVersion: 1,
    scope: "ORDINARY_USDC_PERIOD_SUCCESSOR_EVIDENCE_REPORT_V1",
    provenance: { source: "VERIFIED_PERSISTED_PUBLIC_EVIDENCE", rpcReadsPerformedByRenderer: false, filesystemReadsPerformedByRenderer: false, signing: false, simulation: false, approvalConstruction: false, broadcast: false },
    original: { status: "INTERRUPTED_HASHLESS_AT_19_OF_38", terminalRowCount: 18, immutableRow19: { row: 19, id: source.recovery.source.stoppedRow.id, status: "signed-simulated", outerNonce: 809, transactionHash: null, failureCause: "UNKNOWN", executionEvidence: null } },
    nativeRecovery: { status: "NATIVE_RECOVERY_3_OF_22", confirmedActionCount: 3, approvedActionCount: 19, proposalHash: source.recovery.proposalHash, certificateHash: source.recovery.certificateHash, approvalHash: source.recoveryApproval.approvalHash },
    supersededOriginalUsdc: { status: "SUPERSEDED_UNEXECUTED_COMMITMENTS", actionCount: 19, actionIds: source.recovery.actions.slice(3).map(action => action.id), actions: source.recovery.actions.slice(3).map(action => ({ id: action.id, commitment: action.commitment })) },
    successor: { status: progress.complete ? "USDC_SUCCESSOR_19_OF_19_TERMINAL" : "USDC_SUCCESSOR_INCOMPLETE", terminalActionCount: progress.terminalCount, successfulLiveEntryCount: progress.successfulCount, actionCount: 19, actionIds: context.proposal.actions.map(action => action.id), effectivePeriod: context.proposal.effectivePeriod, terminalCounters: { safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7" }, observer: { probeEvidenceHash: context.proposal.observer.probeEvidenceHash, requiredThrough: context.proposal.observer.requiredThrough, expiresAt: context.proposal.observer.expiresAt }, actions: progress.actions },
    laterRepair: repair,
    task0: { status: "OPEN", nativeTasks1Through13: "GATED", requiredEvidence: ["successor-live-receipts-and-effects", "observer-delivery-and-acknowledgement", "repair-and-rotation", "freeze", "root-security-check", "whole-change-independent-review"] },
    claims: { hardwarePasskeyUxVerified: false, browserPasskeyUxVerified: false, nativeSafe4337Complete: false, audited: false, pullRequestGreen: false, mainnetReady: false, productionReady: false },
  });
}
