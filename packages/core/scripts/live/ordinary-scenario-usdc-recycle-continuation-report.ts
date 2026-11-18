import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { sha256 } from "../plan-deployment";
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
  assertUsdcSuccessorReceiptInclusion,
  type OrdinaryScenarioActionRecord,
  type OrdinaryScenarioJournal,
} from "./ordinary-scenario-executor";
import {
  isVerifiedUsdcRecycleContinuationCertificate,
  type UsdcRecycleContinuationSource,
  type VerifiedUsdcRecycleContinuationCertificate,
} from "./ordinary-scenario-usdc-recycle-continuation-certificate";
import {
  assertAttachedUsdcRecycleContinuation,
  assertUsdcRecycleContinuationAuthorization,
  assertUsdcRecycleContinuationHistoricalBinding,
  hashApprovedUsdcRecycleContinuationHeader,
  hashAttachedUsdcRecycleContinuationHeader,
  type UsdcRecycleContinuationApproval,
  type UsdcRecycleContinuationProposal,
} from "./ordinary-scenario-usdc-recycle-continuation-proposal";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const TERMINAL = new Set(["confirmed", "rejection-proved"]);
const PROGRESS = new Set(["approved", "materialized", "signed-simulated", "outer-pending", "reverted", "stopped"]);
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const publicHash = (value: unknown): Hex => sha256(value) as Hex;
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const repairPublicHash = (value: unknown): Hex => `0x${createHash("sha256").update(JSON.stringify(publicValue(value))).digest("hex")}` as Hex;
const hash = (value: unknown, label: string): Hex => { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is not a hash`); return value as Hex; };
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };

export type UsdcRecycleContinuationReportContext = Readonly<{
  certificate: VerifiedUsdcRecycleContinuationCertificate;
  proposal: UsdcRecycleContinuationProposal;
  approval: UsdcRecycleContinuationApproval;
}>;

export type UsdcRecycleContinuationRepairReportEvidence = Readonly<{
  creation: RepairCreationProposal;
  creationApproval?: RepairApproval;
  group?: RepairGroupProposal;
  groupApproval?: RepairApproval;
}>;

function sameReceipt(left: OrdinaryScenarioActionRecord["receipt"], right: OrdinaryScenarioJournal["liveJournal"]["entries"][number]["receipt"]): boolean {
  return !!left && !!right && same(left.transactionHash, right.transactionHash) && left.status === "success" && right.status === "success" && BigInt(left.gasUsed) === BigInt(right.gasUsed) && BigInt(left.effectiveGasPrice) === BigInt(right.effectiveGasPrice) && BigInt(left.blockNumber) === BigInt(right.blockNumber) && same(left.blockHash, right.blockHash);
}

function assertHistoricalSource(source: UsdcRecycleContinuationSource, context: UsdcRecycleContinuationReportContext, journal: OrdinaryScenarioJournal): void {
  if (!isVerifiedUsdcRecycleContinuationCertificate(context.certificate)) throw new Error("USDC recycle report certificate is not opaque and verified");
  assertUsdcRecycleContinuationAuthorization(context.proposal, context.approval);
  assertUsdcRecycleContinuationHistoricalBinding(source, context.certificate, context.proposal, journal);
  const proposal = context.proposal, certificate = context.certificate, attached = journal.usdcRecycleContinuation;
  if (!same(certificate.sourceHash, proposal.sourceHash) || !same(certificate.certificateHash, proposal.certificateHash) || certificate.effectivePeriod.toString() !== proposal.effectivePeriod) throw new Error("USDC recycle report certificate, source, or period binding mismatch");
  if (!attached) throw new Error("USDC recycle report attachment is missing");
  assertAttachedUsdcRecycleContinuation(attached, proposal);
  if (!same(attached.approvalHash, context.approval.approvalHash) || !same(hashAttachedUsdcRecycleContinuationHeader(attached), hashApprovedUsdcRecycleContinuationHeader(proposal, context.approval))) throw new Error("USDC recycle report attachment approval or immutable header mismatch");
  if (certificate.invalidation.transactionHash !== "0xa81d6df9e9720da44c096b713fdf389fa28ae41aee2224d7f492560ee864781e" || certificate.invalidation.nonce !== 869 || certificate.invalidation.cause !== "UNKNOWN" || certificate.invalidation.gasCost !== 124_785_100_000n || certificate.priorActualGasCostWei !== 168_855_544n || certificate.aggregateKnownChargeWei !== 124_953_955_544n || proposal.reservation.invalidationGasCostWei !== "124785100000" || proposal.reservation.aggregateKnownChargeWei !== "124953955544" || proposal.reservation.grossUsdcOutflow !== "11000000" || proposal.reservation.grossUsdcInwardRecycling !== "11000000" || proposal.reservation.continuationNativePrincipalWei !== "0") throw new Error("USDC recycle report invalidation charge, gas, principal, or non-netting budget mismatch");
  if (journal.schemaVersion !== 1 || journal.chainId !== source.prior.original.chainId || journal.liveJournal.chainId !== source.prior.original.chainId || journal.actions.length !== 19 || journal.liveJournal.entries.length < 15 || !journal.hashlessContinuation || !journal.usdcSuccessor) throw new Error("USDC recycle report historical source identity mismatch");
  for (let index = 0; index < 19; index++) {
    const action = source.prior.original.actions[index]!, record = journal.actions[index]!;
    const expected = index === 18 ? "signed-simulated" : action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed";
    if (record.id !== action.id || !same(record.commitment, action.commitment) || record.status !== expected || (index === 18 && (record.transactionHash !== undefined || record.receipt !== undefined))) throw new Error("USDC recycle report original stopped lineage changed");
  }
  const recovery = journal.hashlessContinuation;
  if (recovery.actions.length !== 22 || recovery.actionCommitments.length !== 22) throw new Error("USDC recycle report native recovery catalog mismatch");
  for (let index = 0; index < 22; index++) {
    const action = source.prior.recovery.actions[index]!, commitment = recovery.actionCommitments[index]!, record = recovery.actions[index]!;
    if (commitment.id !== action.id || !same(commitment.commitment, action.commitment) || record.id !== action.id || !same(record.commitment, action.commitment)) throw new Error("USDC recycle report native recovery lineage mismatch");
    if (index < 3 ? record.status !== "confirmed" || !record.transactionHash || !record.receipt || !record.evidenceHash : record.status !== "approved" || Object.keys(record).sort().join(",") !== "commitment,id,status") throw new Error("USDC recycle report native 3-of-22 evidence or untouched tail mismatch");
  }
  const old = journal.usdcSuccessor;
  if (old.actions.length !== 19 || old.actionCommitments.length !== 19) throw new Error("USDC recycle report old USDC catalog mismatch");
  for (let index = 0; index < 19; index++) {
    const action = source.priorProposal.actions[index]!, commitment = old.actionCommitments[index]!, record = old.actions[index] as OrdinaryScenarioActionRecord;
    const expected = index < 2 ? "confirmed" : index === 2 ? "signed-simulated" : "approved";
    if (commitment.id !== action.id || !same(commitment.commitment, action.commitment) || record.id !== action.id || !same(record.commitment, action.commitment) || record.status !== expected || (index === 2 && (record.transactionHash !== undefined || record.receipt !== undefined))) throw new Error("USDC recycle report old stopped successor lineage changed");
  }
  const expectedPrefixIds = [
    ...journal.actions.slice(0, 18).filter(record => record.status === "confirmed").map(record => record.id),
    ...recovery.actions.slice(0, 3).map(record => record.id),
    ...old.actions.slice(0, 2).map(record => record.id),
  ];
  const prefix = journal.liveJournal.entries.slice(0, 15);
  if (expectedPrefixIds.length !== 15 || prefix.length !== 15 || prefix.some((entry, index) => entry.id !== expectedPrefixIds[index] || entry.status !== "success" || !entry.receipt)) throw new Error("USDC recycle report historical 15-live prefix mismatch");
}

function repairPrefixEvidence(source: UsdcRecycleContinuationSource, journal: OrdinaryScenarioJournal): readonly RepairPrefixEvidence[] {
  return [
    ...journal.actions.map((record, index) => ({ actionId: record.id, evidenceHash: index === 18 ? repairPublicHash(source.prior.recovery.source.stoppedRow) : hash(record.evidenceHash, `USDC recycle report original evidence ${index + 1}`), ...(record.transactionHash ? { transactionHash: record.transactionHash } : {}) })),
    ...journal.hashlessContinuation!.actions.slice(0, 3).map((record, index) => ({ actionId: record.id, evidenceHash: hash((record as OrdinaryScenarioActionRecord).evidenceHash, `USDC recycle report native evidence ${index + 1}`), ...((record as OrdinaryScenarioActionRecord).transactionHash ? { transactionHash: (record as OrdinaryScenarioActionRecord).transactionHash } : {}) })),
    ...journal.usdcSuccessor!.actions.slice(0, 2).map((record, index) => ({ actionId: record.id, evidenceHash: hash((record as OrdinaryScenarioActionRecord).evidenceHash, `USDC recycle report old USDC evidence ${index + 1}`), ...((record as OrdinaryScenarioActionRecord).transactionHash ? { transactionHash: (record as OrdinaryScenarioActionRecord).transactionHash } : {}) })),
    ...journal.usdcRecycleContinuation!.actions.map((record, index) => ({ actionId: record.id, evidenceHash: hash((record as OrdinaryScenarioActionRecord).evidenceHash, `USDC recycle report continuation evidence ${index + 1}`), ...((record as OrdinaryScenarioActionRecord).transactionHash ? { transactionHash: (record as OrdinaryScenarioActionRecord).transactionHash } : {}) })),
  ];
}

type ContinuationProgress = Readonly<{ complete: boolean; terminalCount: number; successfulCount: number; actions: readonly Readonly<Record<string, unknown>>[] }>;

function validateContinuation(source: UsdcRecycleContinuationSource, context: UsdcRecycleContinuationReportContext, journal: OrdinaryScenarioJournal): ContinuationProgress {
  const proposal = context.proposal, attached = journal.usdcRecycleContinuation!;
  const expectedLive: Array<{ record: OrdinaryScenarioActionRecord; status: "success" | "pending" | "reverted" }> = [];
  let complete = true, terminalCount = 0, successfulCount = 0;
  const actions = proposal.actions.map((action, index) => {
    const commitment = attached.actionCommitments[index]!, record = attached.actions[index] as OrdinaryScenarioActionRecord;
    if (commitment.id !== action.id || !same(commitment.commitment, action.commitment) || record.id !== action.id || !same(record.commitment, action.commitment)) throw new Error("USDC recycle report action catalog or commitment mismatch");
    const expectedTerminal = action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed";
    if (TERMINAL.has(record.status)) {
      terminalCount++;
      if (record.status !== expectedTerminal || !record.evidenceHash || !HASH.test(record.evidenceHash)) throw new Error(`USDC recycle report terminal evidence mismatch at action ${index + 1}`);
      if (record.status === "confirmed") {
        const receipt = record.receipt;
        if (!record.transactionHash || !receipt || receipt.status !== "success" || !same(record.transactionHash, receipt.transactionHash) || !HASH.test(receipt.blockHash) || BigInt(receipt.blockNumber) <= 0n || BigInt(receipt.gasUsed) <= 0n || BigInt(receipt.gasUsed) > BigInt(action.gasLimitCap) || BigInt(receipt.effectiveGasPrice) < 0n || BigInt(receipt.effectiveGasPrice) > BigInt(action.maxFeePerGasCap) || BigInt(record.ourReceiptGasCost ?? "-1") !== BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) || BigInt(record.ourPrincipalDelta ?? "-1") !== 0n || BigInt(record.outerValue ?? "-1") !== 0n) throw new Error(`USDC recycle report canonical receipt, gas accounting, or principal mismatch at action ${index + 1}`);
        assertUsdcSuccessorReceiptInclusion(record, proposal.effectivePeriod, proposal.deadline);
        expectedLive.push({ record, status: "success" }); successfulCount++;
      } else if (record.transactionHash !== undefined || record.receipt !== undefined) throw new Error("USDC recycle report rejection evidence unexpectedly carries a transaction");
    } else {
      complete = false;
      if (!PROGRESS.has(record.status)) throw new Error(`USDC recycle report progress status mismatch at action ${index + 1}`);
      if (record.status === "approved") {
        if (Object.keys(record).sort().join(",") !== "commitment,id,status") throw new Error("USDC recycle report approved action carries materialized evidence");
      } else if (record.status === "outer-pending") {
        if (!record.transactionHash || !HASH.test(record.transactionHash)) throw new Error("USDC recycle report pending action lacks a durable transaction hash");
        expectedLive.push({ record, status: "pending" });
      } else if (record.status === "reverted") {
        if (!record.transactionHash || !record.receipt || record.receipt.status !== "reverted" || !same(record.transactionHash, record.receipt.transactionHash)) throw new Error("USDC recycle report reverted action lacks its canonical receipt");
        expectedLive.push({ record, status: "reverted" });
      } else if (record.transactionHash !== undefined && record.intentHash !== undefined) {
        expectedLive.push({ record, status: record.receipt?.status === "reverted" ? "reverted" : record.receipt?.status === "success" ? "success" : "pending" });
      }
    }
    return freeze({ id: action.id, status: record.status, evidenceHash: TERMINAL.has(record.status) ? record.evidenceHash ?? null : null, transactionHash: record.transactionHash ?? null, failureCause: null });
  });
  const live = journal.liveJournal.entries.slice(15, 15 + expectedLive.length);
  if (live.length !== expectedLive.length) throw new Error("USDC recycle report live evidence is missing");
  for (let index = 0; index < expectedLive.length; index++) {
    const expected = expectedLive[index]!, entry = live[index]!;
    if (entry.id !== expected.record.id || entry.status !== expected.status || !expected.record.transactionHash || !same(entry.transactionHash, expected.record.transactionHash)) throw new Error("USDC recycle report live evidence catalog mismatch");
    if (expected.status === "success") {
      if (!sameReceipt(expected.record.receipt, entry.receipt) || entry.reserved !== BigInt(expected.record.ourReceiptGasCost ?? "-1")) throw new Error("USDC recycle report live receipt accounting mismatch");
    } else if (expected.status === "reverted") {
      if (!expected.record.receipt || !entry.receipt || expected.record.receipt.status !== "reverted" || entry.receipt.status !== "reverted" || !same(expected.record.receipt.transactionHash, entry.receipt.transactionHash)) throw new Error("USDC recycle report reverted live receipt mismatch");
    } else if (entry.receipt !== undefined) throw new Error("USDC recycle report pending live entry unexpectedly has a receipt");
  }
  const suffix = journal.liveJournal.entries.slice(15 + expectedLive.length);
  if (!journal.repairContinuation && suffix.length !== 0) throw new Error("USDC recycle report orphan live suffix has no attached repair");
  if (journal.repairContinuation && suffix.some(entry => !REPAIR_ACTION_IDS.includes(entry.id as typeof REPAIR_ACTION_IDS[number]))) throw new Error("USDC recycle report live catalog has an unrelated repair suffix");
  if (complete) {
    if (terminalCount !== 17 || successfulCount !== 9 || journal.liveJournal.entries.slice(0, 24).length !== 24) throw new Error("USDC recycle report complete catalog lacks 17 terminal actions or 24 successful live entries");
    verifyRepairPredecessor(source.prior.original, journal, repairPrefixEvidence(source, journal), { kind: "usdc-recycle-continuation-v1", source, certificate: context.certificate, continuation: context.proposal, approval: context.approval });
  }
  return freeze({ complete, terminalCount, successfulCount, actions });
}

function assertRepairReceipt(entry: OrdinaryScenarioJournal["liveJournal"]["entries"][number], record: NonNullable<OrdinaryScenarioJournal["repairContinuation"]>["actions"][number], artifact: RepairCreationProposal["action"] | RepairGroupProposal["actions"][number]): void {
  const receipt = entry.receipt;
  if (entry.id !== record.id || entry.id !== artifact.id || entry.status !== "success" || !record.transactionHash || !same(entry.transactionHash, record.transactionHash) || !receipt || receipt.status !== "success" || !same(receipt.transactionHash, entry.transactionHash) || !HASH.test(receipt.blockHash) || BigInt(receipt.blockNumber) <= 0n || BigInt(receipt.gasUsed) <= 0n || BigInt(receipt.gasUsed) > BigInt(artifact.gasLimitCap) || BigInt(receipt.effectiveGasPrice) < 0n || BigInt(receipt.effectiveGasPrice) > BigInt(artifact.maxFeePerGasCap) || entry.reserved !== BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)) throw new Error("USDC recycle report repair live receipt or accounting mismatch");
}

function renderRepair(source: UsdcRecycleContinuationSource, context: UsdcRecycleContinuationReportContext, journal: OrdinaryScenarioJournal, continuationComplete: boolean, evidence?: UsdcRecycleContinuationRepairReportEvidence): Readonly<Record<string, unknown>> {
  const repair = journal.repairContinuation;
  if (!repair) {
    if (evidence !== undefined) throw new Error("USDC recycle report rejects unused repair evidence without an attached repair");
    return freeze({ status: "NOT_ATTACHED", predecessor: null, expectedTerminalCounters: { safeNonce: "19", delayQueueNonce: "9", delayTxNonce: "9" } });
  }
  if (!continuationComplete) throw new Error("USDC recycle report mixed repair lineage requires the complete continuation");
  if (!evidence) throw new Error("USDC recycle report attached repair requires exact public repair evidence context");
  const verified = verifyRepairPredecessor(source.prior.original, journal, repairPrefixEvidence(source, journal), { kind: "usdc-recycle-continuation-v1", source, certificate: context.certificate, continuation: context.proposal, approval: context.approval });
  const creation = loadRepairCreationProposal(JSON.stringify(evidence.creation), evidence.creation.proposalHash), predecessor = repair.predecessor;
  if (!predecessor || repair.schemaVersion !== 1 || predecessor.kind !== verified.kind || predecessor.actionCount !== verified.actionCount || repair.originalActionCount !== verified.actionCount || !same(repair.prefixHash, verified.prefixHash) || !same(repair.prefixHash, creation.prefixHash) || !same(repair.creationProposalHash, creation.proposalHash) || publicHash(predecessor) !== publicHash(creation.predecessor) || !same(creation.originalProposalHash, source.prior.original.proposalHash) || !same(creation.originalApprovalHash, journal.approvalHash)) throw new Error("USDC recycle report repair predecessor, prefix, or creation lineage mismatch");
  const creationRecord = repair.actions[0];
  if (!creationRecord || creationRecord.id !== creation.action.id || !same(creationRecord.commitment, creation.action.commitment)) throw new Error("USDC recycle report repair creation commitment mismatch");
  if (repair.creationApprovalHash) {
    if (!evidence.creationApproval) throw new Error("USDC recycle report repair creation approval context is missing");
    assertRepairApproval(evidence.creation, evidence.creationApproval);
    if (!same(repair.creationApprovalHash, evidence.creationApproval.approvalHash) || creationRecord.status === "proposed") throw new Error("USDC recycle report repair creation approval stage mismatch");
  } else if (evidence.creationApproval !== undefined || creationRecord.status !== "proposed") throw new Error("USDC recycle report repair creation approval stage mismatch");
  const hasGroup = repair.groupProposalHash !== undefined || repair.groupApprovalHash !== undefined || repair.actions.length > 1;
  let group: RepairGroupProposal | undefined;
  if (hasGroup) {
    if (!repair.groupProposalHash || !repair.groupApprovalHash || !evidence.group || !evidence.groupApproval || creationRecord.status !== "confirmed") throw new Error("USDC recycle report repair group evidence context is incomplete");
    group = loadRepairGroupProposal(JSON.stringify(evidence.group), evidence.group.proposalHash); assertRepairApproval(evidence.group, evidence.groupApproval);
    if (!same(repair.groupProposalHash, group.proposalHash) || !same(repair.groupApprovalHash, evidence.groupApproval.approvalHash) || !same(group.creationProposalHash, creation.proposalHash) || !same(group.originalProposalHash, source.prior.original.proposalHash) || !same(group.originalApprovalHash, journal.approvalHash) || !same(group.prefixHash, verified.prefixHash) || publicHash(group.predecessor) !== publicHash(creation.predecessor)) throw new Error("USDC recycle report repair group header or approval mismatch");
  } else if (evidence.group !== undefined || evidence.groupApproval !== undefined) throw new Error("USDC recycle report rejects unused repair group evidence");
  if (repair.cumulativeActualCostWei !== (group?.cumulativeActualCostWei ?? creation.cumulativeActualCostWei)) throw new Error("USDC recycle report repair cumulative cost mismatch");
  let complete = repair.actions.length === REPAIR_ACTION_IDS.length;
  const expectedLive: Array<{ record: typeof creationRecord; artifact: RepairCreationProposal["action"] | RepairGroupProposal["actions"][number] }> = [];
  for (let index = 0; index < repair.actions.length; index++) {
    const record = repair.actions[index]!, expectedId = REPAIR_ACTION_IDS[index], artifact = index === 0 ? creation.action : group?.actions[index - 1];
    if (!expectedId || record.id !== expectedId || !artifact || artifact.id !== record.id || !same(artifact.commitment, record.commitment)) throw new Error("USDC recycle report repair action catalog or commitment mismatch");
    const expectedTerminal = record.id === "post-rotation-old-secondary-rejection" ? "rejection-proved" : "confirmed";
    if (record.status === "confirmed" || record.status === "rejection-proved") {
      const noWriteCreation = index === 0 && creation.alreadyDeployed;
      if (record.status !== expectedTerminal || !record.evidenceHash || !HASH.test(record.evidenceHash) || (record.status === "confirmed" && !noWriteCreation && (!record.transactionHash || !HASH.test(record.transactionHash))) || (noWriteCreation && record.transactionHash !== undefined) || (record.status === "rejection-proved" && record.transactionHash !== undefined)) throw new Error("USDC recycle report repair terminal evidence mismatch");
      if (record.status === "confirmed" && !noWriteCreation) expectedLive.push({ record, artifact });
    } else {
      complete = false;
      if (!["proposed", "approved", "pending", "stopped"].includes(record.status)) throw new Error("USDC recycle report repair progress status mismatch");
      if (record.status === "pending") {
        if (!record.transactionHash || !HASH.test(record.transactionHash)) throw new Error("USDC recycle report repair pending hash is missing");
        expectedLive.push({ record, artifact });
      } else if (record.transactionHash !== undefined || record.evidenceHash !== undefined) throw new Error("USDC recycle report repair nonterminal evidence stage mismatch");
    }
  }
  const repairLive = journal.liveJournal.entries.slice(24);
  if (repairLive.length !== expectedLive.length) throw new Error("USDC recycle report repair live suffix is missing or has extras");
  for (let index = 0; index < expectedLive.length; index++) {
    const expected = expectedLive[index]!, entry = repairLive[index]!;
    if (expected.record.status === "pending") {
      if (entry.id !== expected.record.id || entry.status !== "pending" || !expected.record.transactionHash || !same(entry.transactionHash, expected.record.transactionHash) || entry.receipt !== undefined) throw new Error("USDC recycle report repair pending live catalog mismatch");
    } else assertRepairReceipt(entry, expected.record, expected.artifact);
  }
  return freeze({ status: complete ? "REPAIR_TERMINAL_EVIDENCE_RECORDED" : "REPAIR_INCOMPLETE", predecessor: predecessor.kind, actionCount: repair.actions.length, expectedTerminalCounters: { safeNonce: "19", delayQueueNonce: "9", delayTxNonce: "9" } });
}

/** Projects only supplied, already-persisted public evidence. Performs no filesystem, RPC, signing, simulation, approval construction, or broadcast work. */
export function renderUsdcRecycleContinuationReport(source: UsdcRecycleContinuationSource, context: UsdcRecycleContinuationReportContext, journal: OrdinaryScenarioJournal, repairEvidence?: UsdcRecycleContinuationRepairReportEvidence): Readonly<Record<string, unknown>> {
  assertHistoricalSource(source, context, journal);
  const progress = validateContinuation(source, context, journal);
  const repair = renderRepair(source, context, journal, progress.complete, repairEvidence);
  const oldRow = journal.usdcSuccessor!.actions[2] as OrdinaryScenarioActionRecord;
  return freeze({
    schemaVersion: 1,
    scope: "ORDINARY_USDC_RECYCLE_CONTINUATION_EVIDENCE_REPORT_V1",
    provenance: { source: "VERIFIED_PERSISTED_PUBLIC_EVIDENCE", rpcReadsPerformedByRenderer: false, filesystemReadsPerformedByRenderer: false, signing: false, simulation: false, approvalConstruction: false, broadcast: false },
    original: { status: "INTERRUPTED_HASHLESS_AT_19_OF_38", terminalRowCount: 18, immutableRow19: { row: 19, id: source.prior.recovery.source.stoppedRow.id, status: "signed-simulated", outerNonce: 809, transactionHash: null, failureCause: "UNKNOWN", executionEvidence: null } },
    nativeRecovery: { status: "NATIVE_RECOVERY_3_OF_22", confirmedActionCount: 3, approvedActionCount: 19, proposalHash: source.prior.recovery.proposalHash, certificateHash: source.prior.recovery.certificateHash, approvalHash: source.prior.recoveryApproval.approvalHash },
    oldUsdcSuccessor: { status: "OLD_USDC_SUCCESSOR_STOPPED_AT_2_OF_19", terminalActionCount: 2, actionCount: 19, immutableRow3: { row: 3, id: oldRow.id, status: "signed-simulated", outerNonce: oldRow.outerNonce ?? 869, transactionHash: null, failureCause: null }, supersededRemainderActionCount: 16 },
    invalidation: { transactionHash: context.certificate.invalidation.transactionHash, nonce: context.certificate.invalidation.nonce, cause: context.certificate.invalidation.cause, gasCostWei: context.certificate.invalidation.gasCost.toString(), confirmations: context.certificate.invalidation.confirmations.toString() },
    recycleContinuation: { status: progress.complete ? "USDC_RECYCLE_CONTINUATION_17_OF_17_TERMINAL" : "USDC_RECYCLE_CONTINUATION_INCOMPLETE", terminalActionCount: progress.terminalCount, successfulLiveEntryCount: progress.successfulCount, semanticUsdcCompletionCount: progress.complete ? 19 : 2 + progress.terminalCount, actionCount: 17, actionIds: context.proposal.actions.map(action => action.id), effectivePeriod: context.proposal.effectivePeriod, deadline: context.proposal.deadline, minimumOuterNonce: context.proposal.minimumOuterNonce, maxBroadcastAttempts: context.proposal.maxBroadcastAttempts, expectedTerminalCounters: { safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7" }, observer: { probeEvidenceHash: context.proposal.observer.probeEvidenceHash, requiredThrough: context.proposal.observer.requiredThrough, expiresAt: context.proposal.observer.expiresAt }, actions: progress.actions },
    combinedEvidence: { successfulLiveEntryCount: 15 + progress.successfulCount, semanticUsdcTerminalActionCount: 2 + progress.terminalCount, expectedSafeNonce: "15", expectedDelayQueueNonce: "7", expectedDelayTxNonce: "7" },
    accounting: { ...context.proposal.reservation, nettingApplied: false },
    laterRepair: repair,
    task0: { status: "OPEN", nativeTasks1Through13: "GATED", requiredEvidence: ["recycle-live-receipts-and-effects", "observer-delivery-and-acknowledgement", "repair-and-rotation", "freeze", "browser-and-hardware", "root-security-check", "whole-change-independent-review"] },
    claims: { hardwarePasskeyUxVerified: false, browserPasskeyUxVerified: false, nativeSafe4337Complete: false, audited: false, pullRequestGreen: false, mainnetReady: false, productionReady: false },
  });
}
