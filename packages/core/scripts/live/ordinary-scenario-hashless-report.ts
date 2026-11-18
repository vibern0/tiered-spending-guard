import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { sha256 } from "../plan-deployment";
import { hashHistoricalPrefix } from "./ordinary-scenario-hashless-certificate";
import { assertExpiredHashlessContinuationLineage, type ExpiredHashlessContinuationApproval, type ExpiredHashlessContinuationProposal } from "./ordinary-scenario-hashless-continuation";
import type { OrdinaryScenarioActionRecord, OrdinaryScenarioJournal, OrdinaryScenarioProposal } from "./ordinary-scenario-executor";
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

const HASH = /^0x[0-9a-fA-F]{64}$/;
const TERMINAL = new Set(["confirmed", "rejection-proved"]);
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const hash = (value: unknown, label: string): Hex => { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is not a hash`); return value as Hex; };
const publicHash = (value: unknown): Hex => sha256(value) as Hex;
const repairPublicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(repairPublicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, repairPublicValue(child)])) : value;
const repairPublicHash = (value: unknown): Hex => `0x${createHash("sha256").update(JSON.stringify(repairPublicValue(value))).digest("hex")}` as Hex;
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };

export type ExpiredHashlessRepairReportEvidence = Readonly<{
  continuationApproval: ExpiredHashlessContinuationApproval;
  creation: RepairCreationProposal;
  creationApproval?: RepairApproval;
  group?: RepairGroupProposal;
  groupApproval?: RepairApproval;
}>;

function sameReceipt(left: OrdinaryScenarioActionRecord["receipt"], right: OrdinaryScenarioJournal["liveJournal"]["entries"][number]["receipt"]): boolean {
  return !!left && !!right && same(left.transactionHash, right.transactionHash) && left.status === "success" && right.status === "success" && BigInt(left.gasUsed) === BigInt(right.gasUsed) && BigInt(left.effectiveGasPrice) === BigInt(right.effectiveGasPrice) && BigInt(left.blockNumber) === BigInt(right.blockNumber) && same(left.blockHash, right.blockHash);
}

function assertHistoricalSource(original: OrdinaryScenarioProposal, continuation: ExpiredHashlessContinuationProposal, journal: OrdinaryScenarioJournal): void {
  if (journal.schemaVersion !== 1 || journal.chainId !== original.chainId || journal.liveJournal.chainId !== original.chainId || !same(journal.reviewPackageHash, original.reviewPackageHash) || !same(journal.proposalHash, original.proposalHash) || !same(journal.funder, original.funder) || journal.actions.length !== 19 || journal.liveJournal.entries.length < 10) throw new Error("hashless report historical journal identity or length mismatch");
  if (!same(hashHistoricalPrefix(journal), continuation.historicalPrefixHash)) throw new Error("hashless report immutable historical prefix mismatch");
  for (let index = 0; index < 18; index++) {
    const action = original.actions[index]!, record = journal.actions[index]!;
    const expected = action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed";
    if (record.id !== action.id || !same(record.commitment, action.commitment) || record.status !== expected || !record.evidenceHash || !HASH.test(record.evidenceHash)) throw new Error(`hashless report original terminal evidence mismatch at row ${index + 1}`);
    if (expected === "confirmed" && (!record.transactionHash || !record.receipt || !same(record.transactionHash, record.receipt.transactionHash))) throw new Error(`hashless report original canonical receipt evidence mismatch at row ${index + 1}`);
  }
  const row19 = journal.actions[18]!, stopped = continuation.source.stoppedRow;
  if (row19.id !== stopped.id || !same(row19.commitment, stopped.commitment) || row19.status !== "signed-simulated" || row19.outerNonce !== 809 || row19.transactionHash !== undefined || row19.receipt !== undefined || row19.evidenceHash !== undefined) throw new Error("hashless report immutable row 19 status mismatch");
  for (const key of ["materializationHash", "prestateHash", "requestHash", "signedCalldataHash", "simulationEvidenceHash", "outerDataHash"] as const) if (!row19[key] || !same(row19[key]!, stopped[key])) throw new Error(`hashless report immutable row 19 ${key} mismatch`);
  if (row19.signatureBundleHash !== null || stopped.signatureBundleHash !== null) throw new Error("hashless report immutable row 19 signature binding mismatch");
  const successes = journal.actions.slice(0, 18).filter(record => record.status === "confirmed");
  if (successes.length !== 10) throw new Error("hashless report original live evidence count mismatch");
  for (let index = 0; index < successes.length; index++) {
    const record = successes[index]!, live = journal.liveJournal.entries[index];
    if (!live || live.id !== record.id || live.status !== "success" || !record.transactionHash || !same(live.transactionHash, record.transactionHash) || !sameReceipt(record.receipt, live.receipt)) throw new Error("hashless report original live evidence catalog mismatch");
  }
}

function validateContinuation(continuation: ExpiredHashlessContinuationProposal, journal: OrdinaryScenarioJournal): { complete: boolean; actions: readonly Readonly<Record<string, unknown>>[] } {
  const attached = journal.hashlessContinuation;
  if (!attached || attached.schemaVersion !== 1 || attached.recoveryKind !== continuation.recoveryKind || attached.historicalActionCount !== 19 || attached.historicalLiveEntryCount !== 10 || !same(attached.historicalPrefixHash, continuation.historicalPrefixHash) || !same(attached.originalProposalHash, continuation.originalProposalHash) || !same(attached.certificateHash, continuation.certificateHash) || !same(attached.proposalHash, continuation.proposalHash) || !HASH.test(attached.approvalHash) || publicHash(attached.source) !== publicHash(continuation.source) || attached.actionCommitments.length !== 22 || attached.actions.length !== 22) throw new Error("hashless report continuation header or lineage mismatch");
  const successfulRecords: OrdinaryScenarioActionRecord[] = [];
  let complete = true;
  const actions = continuation.actions.map((action, index) => {
    const commitment = attached.actionCommitments[index], record = attached.actions[index] as OrdinaryScenarioActionRecord;
    if (!commitment || commitment.id !== action.id || !same(commitment.commitment, action.commitment) || record.id !== action.id || !same(record.commitment, action.commitment)) throw new Error("hashless report continuation catalog or order mismatch");
    const expectedTerminal = action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed";
    if (TERMINAL.has(record.status)) {
      if (record.status !== expectedTerminal || !record.evidenceHash || !HASH.test(record.evidenceHash)) throw new Error(`hashless report continuation terminal evidence mismatch at action ${index + 1}`);
      if (record.status === "confirmed") {
        if (!record.transactionHash || !record.receipt || !same(record.transactionHash, record.receipt.transactionHash) || record.receipt.status !== "success") throw new Error(`hashless report continuation canonical receipt evidence mismatch at action ${index + 1}`);
        successfulRecords.push(record);
      } else if (record.transactionHash !== undefined || record.receipt !== undefined) throw new Error(`hashless report rejection evidence unexpectedly carries a canonical transaction at action ${index + 1}`);
    } else {
      complete = false;
      if (!["approved", "materialized", "signed-simulated", "outer-pending", "reverted", "stopped"].includes(record.status)) throw new Error(`hashless report continuation status mismatch at action ${index + 1}`);
    }
    return freeze({ id: action.id, status: record.status, evidenceHash: TERMINAL.has(record.status) ? record.evidenceHash ?? null : null, transactionHash: record.status === "confirmed" ? record.transactionHash ?? null : null, failureCause: null });
  });
  const live = journal.liveJournal.entries.slice(10, 10 + successfulRecords.length);
  if (live.length !== successfulRecords.length) throw new Error("hashless report continuation live evidence is missing");
  for (let index = 0; index < successfulRecords.length; index++) {
    const record = successfulRecords[index]!, entry = live[index];
    if (!entry || entry.id !== record.id || entry.status !== "success" || !record.transactionHash || !same(entry.transactionHash, record.transactionHash) || !sameReceipt(record.receipt, entry.receipt)) throw new Error("hashless report continuation live evidence catalog mismatch");
  }
  const suffix = journal.liveJournal.entries.slice(10 + successfulRecords.length);
  if (!journal.repairContinuation && suffix.length !== 0) throw new Error("hashless report orphan repair live suffix has no attached repair");
  if (journal.repairContinuation && suffix.some(entry => !REPAIR_ACTION_IDS.includes(entry.id as typeof REPAIR_ACTION_IDS[number]))) throw new Error("hashless report continuation live catalog has an unrelated suffix");
  if (complete && successfulRecords.length !== continuation.actions.filter(action => action.expectedOutcome === "success").length) throw new Error("hashless report complete continuation lacks all live receipts");
  const terminal = continuation.actions.at(-1)?.after;
  if (!terminal || terminal.safeNonce !== "15" || terminal.delayQueueNonce !== "7" || terminal.delayTxNonce !== "7") throw new Error("hashless report continuation terminal counter drift");
  return { complete, actions };
}

function repairPrefixEvidence(continuation: ExpiredHashlessContinuationProposal, journal: OrdinaryScenarioJournal): readonly RepairPrefixEvidence[] {
  return [
    ...journal.actions.map((record, index) => ({ actionId: record.id, evidenceHash: index === 18 ? repairPublicHash(continuation.source.stoppedRow) : hash(record.evidenceHash, `hashless report historical evidence ${index + 1}`), ...(record.transactionHash ? { transactionHash: record.transactionHash } : {}) })),
    ...journal.hashlessContinuation!.actions.map((record, index) => ({ actionId: record.id, evidenceHash: hash(record.evidenceHash, `hashless report continuation evidence ${index + 1}`), ...(record.transactionHash ? { transactionHash: record.transactionHash } : {}) })),
  ];
}

function assertRepairReceipt(entry: OrdinaryScenarioJournal["liveJournal"]["entries"][number], record: NonNullable<OrdinaryScenarioJournal["repairContinuation"]>["actions"][number], artifact: RepairCreationProposal["action"] | RepairGroupProposal["actions"][number]): void {
  const receipt = entry.receipt;
  if (entry.id !== record.id || entry.id !== artifact.id || entry.status !== "success" || !record.transactionHash || !same(entry.transactionHash, record.transactionHash) || !receipt || receipt.status !== "success" || !same(receipt.transactionHash, entry.transactionHash) || !HASH.test(receipt.blockHash) || BigInt(receipt.blockNumber) <= 0n || BigInt(receipt.gasUsed) <= 0n || BigInt(receipt.gasUsed) > BigInt(artifact.gasLimitCap) || BigInt(receipt.effectiveGasPrice) < 0n || BigInt(receipt.effectiveGasPrice) > BigInt(artifact.maxFeePerGasCap) || entry.reserved !== BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)) throw new Error("hashless report repair live receipt or accounting mismatch");
}

function renderRepair(original: OrdinaryScenarioProposal, continuation: ExpiredHashlessContinuationProposal, journal: OrdinaryScenarioJournal, continuationComplete: boolean, evidence?: ExpiredHashlessRepairReportEvidence): Readonly<Record<string, unknown>> {
  const repair = journal.repairContinuation;
  if (!repair) {
    if (evidence !== undefined) throw new Error("hashless report rejects unused repair evidence without an attached repair");
    return freeze({ status: "NOT_ATTACHED", predecessor: null, terminalCounters: { safeNonce: "19", delayQueueNonce: "9", delayTxNonce: "9" } });
  }
  if (!continuationComplete) throw new Error("hashless report mixed repair lineage requires the complete 22-action continuation");
  if (!evidence) throw new Error("hashless report attached repair requires exact public repair evidence context");
  const verified = verifyRepairPredecessor(original, journal, repairPrefixEvidence(continuation, journal), { kind: "expired-hashless-continuation-v1", continuation, approval: evidence.continuationApproval });
  const creation = loadRepairCreationProposal(JSON.stringify(evidence.creation), evidence.creation.proposalHash);
  const predecessor = repair.predecessor;
  if (!predecessor || repair.schemaVersion !== 1 || predecessor.kind !== verified.kind || predecessor.actionCount !== verified.actionCount || repair.originalActionCount !== verified.actionCount || !same(repair.prefixHash, verified.prefixHash) || !same(repair.prefixHash, creation.prefixHash) || !same(repair.creationProposalHash, creation.proposalHash) || repair.cumulativeActualCostWei !== creation.cumulativeActualCostWei || publicHash(predecessor) !== publicHash(creation.predecessor) || !same(creation.originalProposalHash, original.proposalHash) || !same(creation.originalApprovalHash, journal.approvalHash)) throw new Error("hashless report repair predecessor or creation header mismatch");
  const creationRecord = repair.actions[0];
  if (!creationRecord || creationRecord.id !== creation.action.id || !same(creationRecord.commitment, creation.action.commitment)) throw new Error("hashless report repair creation commitment mismatch");
  if (repair.creationApprovalHash) {
    if (!evidence.creationApproval) throw new Error("hashless report repair creation approval context is missing");
    assertRepairApproval(evidence.creation, evidence.creationApproval);
    if (!same(repair.creationApprovalHash, evidence.creationApproval.approvalHash)) throw new Error("hashless report repair creation approval hash mismatch");
    if (creationRecord.status === "proposed") throw new Error("hashless report repair creation approval stage mismatch");
  } else if (evidence.creationApproval !== undefined || creationRecord.status !== "proposed") throw new Error("hashless report repair creation approval stage mismatch");

  const hasGroup = repair.groupProposalHash !== undefined || repair.groupApprovalHash !== undefined || repair.actions.length > 1;
  let group: RepairGroupProposal | undefined;
  if (hasGroup) {
    if (!repair.groupProposalHash || !repair.groupApprovalHash || !evidence.group || !evidence.groupApproval) throw new Error("hashless report repair group evidence context is incomplete");
    if (creationRecord.status !== "confirmed") throw new Error("hashless report repair group requires confirmed creation");
    group = loadRepairGroupProposal(JSON.stringify(evidence.group), evidence.group.proposalHash);
    assertRepairApproval(evidence.group, evidence.groupApproval);
    if (!same(repair.groupProposalHash, group.proposalHash) || !same(repair.groupApprovalHash, evidence.groupApproval.approvalHash) || !same(group.creationProposalHash, creation.proposalHash) || !same(group.originalProposalHash, original.proposalHash) || !same(group.originalApprovalHash, journal.approvalHash) || !same(group.prefixHash, verified.prefixHash) || publicHash(group.predecessor) !== publicHash(creation.predecessor)) throw new Error("hashless report repair group header or approval mismatch");
  } else if (evidence.group !== undefined || evidence.groupApproval !== undefined) throw new Error("hashless report rejects unused repair group evidence");

  let complete = repair.actions.length === REPAIR_ACTION_IDS.length;
  const expectedLive: Array<{ record: typeof creationRecord; artifact: RepairCreationProposal["action"] | RepairGroupProposal["actions"][number] }> = [];
  for (let index = 0; index < repair.actions.length; index++) {
    const action = repair.actions[index]!, expectedId = REPAIR_ACTION_IDS[index];
    if (expectedId === undefined || action.id !== expectedId) throw new Error("hashless report repair action catalog or order mismatch");
    if (index > 0 && group && action.status === "proposed") throw new Error("hashless report repair group approval stage mismatch");
    const artifact = index === 0 ? creation.action : group?.actions[index - 1];
    if (!artifact || artifact.id !== action.id || !same(artifact.commitment, action.commitment)) throw new Error("hashless report repair action commitment mismatch");
    const expectedTerminal = action.id === "post-rotation-old-secondary-rejection" ? "rejection-proved" : "confirmed";
    if (action.status === "confirmed" || action.status === "rejection-proved") {
      const noWriteCreation = index === 0 && creation.alreadyDeployed;
      if (action.status !== expectedTerminal || !action.evidenceHash || !HASH.test(action.evidenceHash) || (action.status === "confirmed" && !noWriteCreation && (!action.transactionHash || !HASH.test(action.transactionHash))) || (noWriteCreation && action.transactionHash !== undefined) || (action.status === "rejection-proved" && action.transactionHash !== undefined)) throw new Error("hashless report repair terminal evidence mismatch");
      if (action.status === "confirmed" && !noWriteCreation) expectedLive.push({ record: action, artifact });
    } else {
      complete = false;
      if (!["proposed", "approved", "pending", "stopped"].includes(action.status)) throw new Error("hashless report repair action status mismatch");
      if (action.status === "pending") {
        if (!action.transactionHash || !HASH.test(action.transactionHash)) throw new Error("hashless report repair pending transaction hash is missing");
        expectedLive.push({ record: action, artifact });
      } else if (action.transactionHash !== undefined || action.evidenceHash !== undefined) throw new Error("hashless report repair nonterminal evidence stage mismatch");
    }
  }
  const repairLive = journal.liveJournal.entries.slice(24);
  if (repairLive.length !== expectedLive.length) throw new Error("hashless report repair live suffix is missing or has extras");
  for (let index = 0; index < expectedLive.length; index++) {
    const expected = expectedLive[index]!, entry = repairLive[index]!;
    if (expected.record.status === "pending") {
      if (entry.id !== expected.record.id || entry.status !== "pending" || !expected.record.transactionHash || !same(entry.transactionHash, expected.record.transactionHash) || entry.receipt !== undefined) throw new Error("hashless report repair pending live catalog mismatch");
    } else assertRepairReceipt(entry, expected.record, expected.artifact);
  }
  return freeze({ status: complete ? "REPAIR_TERMINAL_EVIDENCE_RECORDED" : "REPAIR_INCOMPLETE", predecessor: predecessor.kind, actionCount: repair.actions.length, terminalCounters: { safeNonce: "19", delayQueueNonce: "9", delayTxNonce: "9" } });
}

/** Render persisted public evidence only. This function performs no RPC read, signing, simulation, or broadcast. */
export function renderExpiredHashlessContinuationReport(original: OrdinaryScenarioProposal, continuation: ExpiredHashlessContinuationProposal, journal: OrdinaryScenarioJournal, repairEvidence?: ExpiredHashlessRepairReportEvidence): Readonly<Record<string, unknown>> {
  assertExpiredHashlessContinuationLineage(original, continuation);
  assertHistoricalSource(original, continuation, journal);
  const progress = validateContinuation(continuation, journal);
  const repair = renderRepair(original, continuation, journal, progress.complete, repairEvidence);
  return freeze({
    schemaVersion: 1,
    scope: "FIRST38_HASHLESS_CONTINUATION_EVIDENCE_REPORT_V1",
    provenance: { source: "VERIFIED_PERSISTED_PUBLIC_EVIDENCE", rpcReadsPerformedByRenderer: false, signing: false, simulation: false, broadcast: false },
    original: {
      status: "INTERRUPTED_HASHLESS_AT_19_OF_38",
      terminalRowCount: 18,
      immutableRow19: { row: 19, id: continuation.source.stoppedRow.id, status: "signed-simulated", outerNonce: 809, transactionHash: null, failureCause: null, executionEvidence: null },
    },
    sourceCertificate: { certificateHash: continuation.certificateHash, status: "VERIFIED_PERSISTED_CERTIFICATE", nonce809Consumption: { classification: "DIFFERENT_CANONICAL_ENVELOPE", transactionType: "EIP155_PROTECTED_LEGACY", minimumConfirmations: 6, transactionHash: null } },
    supersededOriginalUsdc: { status: "SUPERSEDED_UNEXECUTED_COMMITMENTS", actionCount: 19, actionIds: original.actions.slice(19).map(action => action.id), actions: original.actions.slice(19).map(action => ({ id: action.id, commitment: action.commitment })) },
    continuation: { status: progress.complete ? "EXPIRED_SOURCE_REBASED_CONTINUATION_COMPLETE" : "CONTINUATION_INCOMPLETE", terminalActionCount: progress.complete ? 22 : progress.actions.filter(action => TERMINAL.has(String(action.status))).length, actionCount: 22, actionIds: continuation.actions.map(action => action.id), terminalCounters: { safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7" }, actions: progress.actions },
    laterRepair: repair,
    task0: { status: "OPEN", nativeTasks1Through13: "GATED", requiredEvidence: ["native-and-USDC-X/Y", "cancellation", "expiry", "ready-execution", "observer-delivery-and-acknowledgement", "repair-and-rotation", "freeze", "balances", "topology", "regressions", "independent-review"] },
  });
}
