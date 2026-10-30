import type { Hex } from "viem";
import { sha256 } from "../plan-deployment";
import { assertUsdcDelayedCompletionJournal, assertUsdcSuccessorReceiptInclusion, type OrdinaryScenarioActionRecord, type OrdinaryScenarioJournal } from "./ordinary-scenario-executor";
import { isVerifiedUsdcDelayedCompletionCertificate, type UsdcDelayedCompletionSource, type VerifiedUsdcDelayedCompletionCertificate } from "./ordinary-scenario-usdc-delayed-completion-certificate";
import { assertUsdcDelayedCompletionAuthorization, type UsdcDelayedCompletionApproval, type UsdcDelayedCompletionProposal } from "./ordinary-scenario-usdc-delayed-completion-proposal";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const TERMINAL = new Set(["confirmed", "rejection-proved"]), PROGRESS = new Set(["approved", "materialized", "signed-simulated", "outer-pending", "reverted", "stopped"]), ALERT_KINDS = new Set(["queue-proposal", "queue-cancellation", "queue-expiry", "ready-delay-execution"]);
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };
export type UsdcDelayedCompletionReportContext = Readonly<{ certificate: VerifiedUsdcDelayedCompletionCertificate; proposal: UsdcDelayedCompletionProposal; approval: UsdcDelayedCompletionApproval }>;

function validateContext(source: UsdcDelayedCompletionSource, context: UsdcDelayedCompletionReportContext, journal: OrdinaryScenarioJournal): void {
  if (!isVerifiedUsdcDelayedCompletionCertificate(context.certificate)) throw new Error("delayed completion report certificate is not opaque");
  assertUsdcDelayedCompletionAuthorization(context.proposal, context.approval); assertUsdcDelayedCompletionJournal(journal, source, context.proposal, context.approval);
  const certificate = context.certificate, proposal = context.proposal, attached = journal.usdcDelayedCompletion!;
  if (!same(certificate.sourceJournalHash, proposal.sourceJournalHash) || !same(certificate.certificateHash, proposal.certificateHash) || certificate.effectivePeriod.toString() !== proposal.effectivePeriod || !same(attached.certificateHash, proposal.certificateHash) || !same(attached.proposalHash, proposal.proposalHash) || !same(attached.approvalHash, context.approval.approvalHash)) throw new Error("delayed completion report source, certificate, proposal, approval, or header mismatch");
  if (proposal.reservation.newGrossUsdcAllowance !== "31000000" || proposal.reservation.aggregateGrossUsdcAllowance !== "51000000" || proposal.reservation.inwardUsdcFunding !== "31000000" || proposal.reservation.successorMaximumReservationWei !== "9340292000000" || proposal.reservation.maximumCumulativeOutlayWei !== "140501418272986") throw new Error("delayed completion report accounting or reservation header mismatch");
}

function finalMaterializationMatches(record: OrdinaryScenarioActionRecord, proposal: UsdcDelayedCompletionProposal, action: UsdcDelayedCompletionProposal["actions"][number]): boolean {
  const final = record.finalOuterMaterialization; if (!final) return false;
  const facts = { proposalHash: final.proposalHash, actionCommitment: final.actionCommitment, outerNonce: final.outerNonce, gas: final.gas, gasEstimate: final.gasEstimate, maxFeePerGas: final.maxFeePerGas, maxPriorityFeePerGas: final.maxPriorityFeePerGas, pinnedBlockNumber: final.pinnedBlockNumber, pinnedBlockHash: final.pinnedBlockHash, approvedContinuationReservationWei: final.approvedContinuationReservationWei, remainingReservationWei: final.remainingReservationWei };
  return same(final.proposalHash, proposal.proposalHash) && same(final.actionCommitment, action.commitment) && final.outerNonce >= proposal.minimumOuterNonce && BigInt(final.gas) <= BigInt(action.gasLimitCap) && BigInt(final.maxFeePerGas) <= BigInt(action.maxFeePerGasCap) && BigInt(final.maxPriorityFeePerGas) <= BigInt(action.maxPriorityFeePerGasCap) && final.approvedContinuationReservationWei === proposal.reservation.successorMaximumReservationWei && same(final.hash, sha256(facts) as Hex);
}

/** Pure persisted-evidence projection: no RPC, filesystem, signing, simulation, approval construction, or broadcast. */
export function renderUsdcDelayedCompletionReport(source: UsdcDelayedCompletionSource, context: UsdcDelayedCompletionReportContext, journal: OrdinaryScenarioJournal): Readonly<Record<string, any>> {
  validateContext(source, context, journal);
  const attached = journal.usdcDelayedCompletion!, proposal = context.proposal, expectedLive: OrdinaryScenarioActionRecord[] = [];
  let terminal = 0, successful = 0, gas = 0n, outflow = 0n, inward = 0n, approvedTail = false, complete = true;
  const actions = proposal.actions.map((action, index) => {
    const value = attached.actions[index]!, record = value as OrdinaryScenarioActionRecord;
    if (value.status === "approved") approvedTail = true; else if (approvedTail) throw new Error("delayed completion report progress is not a contiguous prefix");
    const expectedTerminal = action.expectedOutcome === "success" ? "confirmed" : "rejection-proved";
    if (TERMINAL.has(record.status)) {
      terminal++;
      if (record.status !== expectedTerminal || !record.evidenceHash || !HASH.test(record.evidenceHash) || !record.materializationHash || !HASH.test(record.materializationHash) || !record.prestateHash || !HASH.test(record.prestateHash)) throw new Error(`delayed completion terminal outcome, materialization, or evidence mismatch at ${index + 1}`);
      if (record.status === "confirmed") {
        const receipt = record.receipt;
        if (!record.intentHash || !record.transactionHash || !receipt || receipt.status !== "success" || !same(record.transactionHash, receipt.transactionHash) || BigInt(receipt.gasUsed) <= 0n || BigInt(receipt.gasUsed) > BigInt(action.gasLimitCap) || BigInt(receipt.effectiveGasPrice) < 0n || BigInt(receipt.effectiveGasPrice) > BigInt(action.maxFeePerGasCap) || BigInt(record.ourReceiptGasCost ?? "-1") !== BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) || BigInt(record.ourPrincipalDelta ?? "-1") !== 0n || BigInt(record.outerValue ?? "-1") !== 0n || !record.requestHash || !record.signedCalldataHash || !record.simulationEvidenceHash || !record.outerDataHash || !record.gas || !finalMaterializationMatches(record, proposal, action)) throw new Error(`delayed completion receipt, gas, principal, or durable envelope mismatch at ${index + 1}`);
        assertUsdcSuccessorReceiptInclusion(record, proposal.effectivePeriod, proposal.deadline);
        const alert = ALERT_KINDS.has(action.kind); if (alert ? !record.observerEvidenceHash || !HASH.test(record.observerEvidenceHash) : record.observerEvidenceHash !== null) throw new Error(`delayed completion observer evidence mismatch at ${index + 1}`);
        expectedLive.push(record); successful++; gas += BigInt(record.ourReceiptGasCost!);
        const before = BigInt(action.before.safeUsdcBalance), after = BigInt(action.after.safeUsdcBalance); if (before > after) outflow += before - after; else if (after > before) inward += after - before;
      } else if ([record.requestHash, record.signatureBundleHash, record.signedCalldataHash, record.simulationEvidenceHash, record.finalOuterMaterialization, record.intentHash, record.transactionHash, record.receipt, record.receiptInclusion, record.observerEvidenceHash].some(value => value !== undefined)) throw new Error(`delayed completion proof row carries private, broadcast, receipt, or observer evidence at ${index + 1}`);
    } else {
      complete = false; if (!PROGRESS.has(record.status)) throw new Error(`delayed completion report progress status mismatch at ${index + 1}`);
      if (value.status === "approved" && Object.keys(value).sort().join(",") !== "commitment,id,status") throw new Error("delayed completion approved row carries progress");
      if (record.status === "outer-pending") { if (!record.intentHash || !record.transactionHash) throw new Error("delayed completion pending row lacks durable hashes"); expectedLive.push(record); }
      if ((record.status === "reverted" || record.status === "stopped") && record.transactionHash) expectedLive.push(record);
    }
    return freeze({ id: action.id, expectedOutcome: action.expectedOutcome, status: record.status, transactionHash: record.transactionHash ?? null, evidenceHash: record.evidenceHash ?? null, observerEvidenceHash: record.observerEvidenceHash ?? null });
  });
  const suffix = journal.liveJournal.entries.slice(15); if (suffix.length !== expectedLive.length) throw new Error("delayed completion report live suffix count mismatch");
  expectedLive.forEach((record, index) => { const entry = suffix[index]!; if (entry.id !== record.id || !record.intentHash || !same(entry.intentHash, record.intentHash) || !record.transactionHash || !same(entry.transactionHash, record.transactionHash) || entry.nonce !== record.outerNonce) throw new Error("delayed completion report live envelope lineage mismatch"); if (record.status === "confirmed" && (entry.status !== "success" || !record.receipt || !entry.receipt || JSON.stringify(record.receipt, (_, value) => typeof value === "bigint" ? value.toString() : value) !== JSON.stringify(entry.receipt, (_, value) => typeof value === "bigint" ? value.toString() : value) || entry.reserved !== BigInt(record.ourReceiptGasCost ?? "-1"))) throw new Error("delayed completion report live receipt accounting mismatch"); if (record.status === "outer-pending" && (entry.status !== "pending" || entry.receipt !== undefined)) throw new Error("delayed completion report pending live entry mismatch"); });
  complete = complete && terminal === 13;
  if (complete) { const last = proposal.actions[12]!.after; if (successful !== 7 || journal.liveJournal.entries.length !== 22 || outflow !== 31_000_000n || inward !== 31_000_000n || last.safeNonce !== "14" || last.delayQueueNonce !== "7" || last.delayTxNonce !== "7" || last.safeUsdcBalance !== "0" || last.funderUsdcBalance !== "40000000") throw new Error("delayed completion terminal counters, live suffix, balances, or principal accounting mismatch"); }
  return freeze({ schemaVersion: 1, scope: "ORDINARY_USDC_DELAYED_COMPLETION_EVIDENCE_REPORT_V1", provenance: { source: "VERIFIED_PERSISTED_PUBLIC_EVIDENCE", rpcReadsPerformedByRenderer: false, filesystemReadsPerformedByRenderer: false, signing: false, simulation: false, approvalConstruction: false, broadcast: false }, stoppedFreshSuccessor: { id: context.certificate.stoppedRow.id, status: context.certificate.stoppedRow.status, outerNonce: context.certificate.stoppedRow.outerNonce, transactionHash: null }, delayedCompletion: { status: complete ? "DELAYED_COMPLETION_13_OF_13_TERMINAL" : "DELAYED_COMPLETION_INCOMPLETE", actionCount: 13, terminalActionCount: terminal, successfulLiveEntryCount: successful, expectedTerminalCounters: { safeNonce: "14", delayQueueNonce: "7", delayTxNonce: "7" }, expectedTerminalBalances: { safeUsdcUnits: "0", funderUsdcUnits: "40000000" }, actions }, accounting: { priorGrossUsdcOutflowUnits: "20000000", newGrossUsdcOutflowUnits: outflow.toString(), aggregateGrossUsdcOutflowUnits: (20_000_000n + outflow).toString(), inwardUsdcFundingUnits: inward.toString(), receiptGasCostWei: gas.toString(), maximumReservationWei: proposal.reservation.successorMaximumReservationWei, maximumCumulativeOutlayWei: proposal.reservation.maximumCumulativeOutlayWei, nettingApplied: false }, claims: { delayedTierLiveEvidenceComplete: complete, repairComplete: false, nativeSafe4337Complete: false, audited: false, mainnetReady: false, productionReady: false } });
}
