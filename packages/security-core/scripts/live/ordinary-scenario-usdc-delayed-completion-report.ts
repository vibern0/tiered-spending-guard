import type { Hex } from "viem";
import { assertUsdcDelayedCompletionJournal, type OrdinaryScenarioActionRecord, type OrdinaryScenarioJournal } from "./ordinary-scenario-executor";
import { isVerifiedUsdcDelayedCompletionCertificate, type UsdcDelayedCompletionSource, type VerifiedUsdcDelayedCompletionCertificate } from "./ordinary-scenario-usdc-delayed-completion-certificate";
import { assertUsdcDelayedCompletionAuthorization, type UsdcDelayedCompletionApproval, type UsdcDelayedCompletionProposal } from "./ordinary-scenario-usdc-delayed-completion-proposal";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };
export type UsdcDelayedCompletionReportContext = Readonly<{ certificate: VerifiedUsdcDelayedCompletionCertificate; proposal: UsdcDelayedCompletionProposal; approval: UsdcDelayedCompletionApproval }>;

export function renderUsdcDelayedCompletionReport(source: UsdcDelayedCompletionSource, context: UsdcDelayedCompletionReportContext, journal: OrdinaryScenarioJournal): Readonly<Record<string, any>> {
  if (!isVerifiedUsdcDelayedCompletionCertificate(context.certificate)) throw new Error("delayed completion report certificate is not opaque");
  assertUsdcDelayedCompletionAuthorization(context.proposal, context.approval);
  assertUsdcDelayedCompletionJournal(journal, source, context.proposal, context.approval);
  const attached = journal.usdcDelayedCompletion!;
  let terminal = 0, successful = 0, gas = 0n, outflow = 0n, inward = 0n;
  const actions = context.proposal.actions.map((action, index) => {
    const record = attached.actions[index] as OrdinaryScenarioActionRecord;
    const expected = action.expectedOutcome === "success" ? "confirmed" : "rejection-proved";
    if (record.status === "confirmed" || record.status === "rejection-proved") {
      terminal++;
      if (record.status !== expected || !record.evidenceHash || !HASH.test(record.evidenceHash)) throw new Error("delayed completion terminal outcome or evidence mismatch");
      if (record.status === "confirmed") {
        if (!record.receipt || record.receipt.status !== "success" || !record.transactionHash || record.transactionHash !== record.receipt.transactionHash || !record.ourReceiptGasCost) throw new Error("delayed completion confirmed receipt accounting mismatch");
        successful++; gas += BigInt(record.ourReceiptGasCost);
        const before = BigInt(action.before.safeUsdcBalance), after = BigInt(action.after.safeUsdcBalance); if (before > after) outflow += before - after; if (after > before) inward += after - before;
      } else if (record.transactionHash !== undefined || record.receipt !== undefined) throw new Error("delayed completion proof row broadcast unexpectedly");
    }
    return freeze({ id: action.id, expectedOutcome: action.expectedOutcome, status: record.status, transactionHash: record.transactionHash ?? null, evidenceHash: record.evidenceHash ?? null, observerEvidenceHash: record.observerEvidenceHash ?? null });
  });
  const complete = terminal === 13;
  if (complete && (successful !== 7 || journal.liveJournal.entries.length !== 22 || outflow !== 31_000_000n || inward !== 31_000_000n)) throw new Error("delayed completion terminal count, live suffix, or principal accounting mismatch");
  return freeze({
    schemaVersion: 1,
    scope: "ORDINARY_USDC_DELAYED_COMPLETION_EVIDENCE_REPORT_V1",
    provenance: { source: "VERIFIED_PERSISTED_PUBLIC_EVIDENCE", rpcReadsPerformedByRenderer: false, filesystemReadsPerformedByRenderer: false, signing: false, simulation: false, approvalConstruction: false, broadcast: false },
    stoppedFreshSuccessor: { id: context.certificate.stoppedRow.id, status: context.certificate.stoppedRow.status, outerNonce: context.certificate.stoppedRow.outerNonce, transactionHash: null },
    delayedCompletion: { status: complete ? "DELAYED_COMPLETION_13_OF_13_TERMINAL" : "DELAYED_COMPLETION_INCOMPLETE", actionCount: 13, terminalActionCount: terminal, successfulLiveEntryCount: successful, expectedTerminalCounters: { safeNonce: "14", delayQueueNonce: "7", delayTxNonce: "7" }, expectedTerminalBalances: { safeUsdcUnits: "0", funderUsdcUnits: "40000000" }, actions },
    accounting: { priorGrossUsdcOutflowUnits: "20000000", newGrossUsdcOutflowUnits: outflow.toString(), aggregateGrossUsdcOutflowUnits: (20_000_000n + outflow).toString(), inwardUsdcFundingUnits: inward.toString(), receiptGasCostWei: gas.toString(), maximumReservationWei: context.proposal.reservation.successorMaximumReservationWei, maximumCumulativeOutlayWei: context.proposal.reservation.maximumCumulativeOutlayWei, nettingApplied: false },
    claims: { delayedTierLiveEvidenceComplete: complete, repairComplete: false, nativeSafe4337Complete: false, audited: false, mainnetReady: false, productionReady: false },
  });
}
