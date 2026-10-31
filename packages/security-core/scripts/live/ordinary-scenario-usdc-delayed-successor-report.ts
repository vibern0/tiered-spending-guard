import { keccak256, type Hex } from "viem";
import {
  assertUsdcDelayedSuccessorJournal,
  assertUsdcDelayedSuccessorJournalForTestsOnly,
  type OrdinaryScenarioActionRecord,
  type OrdinaryScenarioJournal,
} from "./ordinary-scenario-executor";
import type { UsdcDelayedSuccessorSource, VerifiedUsdcDelayedSuccessorCertificate } from "./ordinary-scenario-usdc-delayed-successor-certificate";
import type { UsdcDelayedSuccessorApproval, UsdcDelayedSuccessorProposal } from "./ordinary-scenario-usdc-delayed-successor-proposal";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const PROGRESS = new Set(["approved", "materialized", "signed-simulated", "outer-pending", "reverted", "stopped"]);
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };
const publicJson = (value: unknown): string => JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child);

type Context = Readonly<{ certificate: VerifiedUsdcDelayedSuccessorCertificate; proposal: UsdcDelayedSuccessorProposal; approval: UsdcDelayedSuccessorApproval }>;

function render(source: UsdcDelayedSuccessorSource, context: Context, journal: OrdinaryScenarioJournal, testOnly: boolean) {
  (testOnly ? assertUsdcDelayedSuccessorJournalForTestsOnly : assertUsdcDelayedSuccessorJournal)(journal, source, context.proposal, context.approval);
  const proposal = context.proposal, attached = journal.usdcDelayedSuccessor!;
  let complete = true, terminal = 0, successful = 0, gas = 0n, outflow = 0n, inward = 0n;
  const expectedLive: OrdinaryScenarioActionRecord[] = [];
  const actions = proposal.actions.map((action, index) => {
    const value = attached.actions[index]!, record = value as OrdinaryScenarioActionRecord;
    if (record.id !== action.id || !same(record.commitment, action.commitment)) throw new Error(`delayed successor report action lineage mismatch at ${index + 1}`);
    if (record.status === "confirmed") {
      terminal++; successful++; expectedLive.push(record);
      if (!record.intentHash || !record.transactionHash || !record.receipt || !record.receiptInclusion || !record.finalOuterMaterialization || !record.evidenceHash || !record.simulationEvidenceHash || !record.signedCalldataHash || !record.outerTo || record.outerNonce === undefined || !record.gas || !record.maxFeePerGas || !record.maxPriorityFeePerGas || record.ourPrincipalDelta !== "0" || !record.ourReceiptGasCost) throw new Error(`delayed successor receipt, inclusion, envelope, gas, or principal evidence missing at ${index + 1}`);
      if (!HASH.test(record.intentHash) || !same(record.transactionHash, record.receipt.transactionHash) || !same(record.transactionHash, record.receiptInclusion.transactionHash) || record.receipt.status !== "success" || record.receipt.blockNumber.toString() !== record.receiptInclusion.blockNumber || !same(record.receipt.blockHash, record.receiptInclusion.blockHash) || record.receiptInclusion.effectivePeriod !== proposal.effectivePeriod) throw new Error(`delayed successor receipt inclusion mismatch at ${index + 1}`);
      if (record.gas !== action.gasLimitCap || BigInt(record.maxFeePerGas) > BigInt(action.maxFeePerGasCap) || BigInt(record.maxPriorityFeePerGas) > BigInt(action.maxPriorityFeePerGasCap) || record.finalOuterMaterialization.proposalHash !== proposal.proposalHash || record.finalOuterMaterialization.actionCommitment !== action.commitment || record.finalOuterMaterialization.outerNonce !== record.outerNonce || record.finalOuterMaterialization.gas !== record.gas) throw new Error(`delayed successor materialization or gas cap mismatch at ${index + 1}`);
      const expectedTo = action.safeTransaction ? source.prior.historical.prior.original.safe : action.transaction.to;
      if (!same(record.outerTo, expectedTo) || record.outerValue !== "0" || (action.safeTransaction ? !record.signatureBundleHash || !HASH.test(record.signatureBundleHash) : record.signatureBundleHash !== null || !same(record.signedCalldataHash, keccak256(action.transaction.data)) || !same(record.outerDataHash!, record.signedCalldataHash))) throw new Error(`delayed successor signed envelope mismatch at ${index + 1}`);
      if (!record.observerEvidenceHash || !HASH.test(record.observerEvidenceHash)) throw new Error(`delayed successor observer evidence missing at ${index + 1}`);
      const receiptGas = record.receipt.gasUsed * record.receipt.effectiveGasPrice;
      if (receiptGas.toString() !== record.ourReceiptGasCost) throw new Error(`delayed successor receipt gas accounting mismatch at ${index + 1}`);
      gas += receiptGas;
      const before = BigInt(action.before.safeUsdcBalance), after = BigInt(action.after.safeUsdcBalance); if (before > after) outflow += before - after; else if (after > before) inward += after - before;
    } else if (record.status === "rejection-proved") {
      terminal++;
      if (!record.evidenceHash || [record.requestHash, record.signatureBundleHash, record.signedCalldataHash, record.simulationEvidenceHash, record.finalOuterMaterialization, record.intentHash, record.transactionHash, record.receipt, record.receiptInclusion, record.observerEvidenceHash].some(value => value !== undefined)) throw new Error(`delayed successor proof row carries private or broadcast evidence at ${index + 1}`);
    } else {
      complete = false;
      if (!PROGRESS.has(record.status)) throw new Error(`delayed successor report progress status mismatch at ${index + 1}`);
      if (value.status === "approved" && Object.keys(value).sort().join(",") !== "commitment,id,status") throw new Error("delayed successor approved row carries progress");
      if (record.status === "outer-pending") { if (!record.intentHash || !record.transactionHash) throw new Error("delayed successor pending row lacks durable hashes"); expectedLive.push(record); }
      if ((record.status === "reverted" || record.status === "stopped") && record.transactionHash) expectedLive.push(record);
    }
    return freeze({ id: action.id, expectedOutcome: action.expectedOutcome, status: record.status, transactionHash: record.transactionHash ?? null, evidenceHash: record.evidenceHash ?? null, observerEvidenceHash: record.observerEvidenceHash ?? null });
  });
  const suffix = journal.liveJournal.entries.slice(19);
  if (suffix.length !== expectedLive.length) throw new Error("delayed successor report live suffix count mismatch");
  expectedLive.forEach((record, index) => {
    const entry = suffix[index]!;
    if (entry.id !== record.id || !record.intentHash || !same(entry.intentHash, record.intentHash) || !record.transactionHash || !same(entry.transactionHash, record.transactionHash) || entry.nonce !== record.outerNonce) throw new Error("delayed successor report live envelope lineage mismatch");
    if (record.status === "confirmed" && (entry.status !== "success" || !record.receipt || !entry.receipt || publicJson(record.receipt) !== publicJson(entry.receipt) || entry.reserved !== BigInt(record.ourReceiptGasCost ?? "-1"))) throw new Error("delayed successor report live receipt accounting mismatch");
    if (record.status === "outer-pending" && (entry.status !== "pending" || entry.receipt !== undefined)) throw new Error("delayed successor report pending live entry mismatch");
  });
  complete = complete && terminal === 5;
  if (complete) {
    const last = proposal.actions[4]!.after;
    if (successful !== 3 || journal.liveJournal.entries.length !== 22 || outflow !== 31_000_000n || inward !== 0n || last.safeNonce !== "14" || last.delayQueueNonce !== "7" || last.delayTxNonce !== "7" || last.safeUsdcBalance !== "0" || last.funderUsdcBalance !== "40000000") throw new Error("delayed successor terminal counters, live suffix, balances, or principal accounting mismatch");
  }
  return freeze({
    schemaVersion: 1,
    scope: "ORDINARY_USDC_DELAYED_SUCCESSOR_EVIDENCE_REPORT_V1",
    provenance: { source: "VERIFIED_PERSISTED_PUBLIC_EVIDENCE", rpcReadsPerformedByRenderer: false, filesystemReadsPerformedByRenderer: false, signing: false, simulation: false, approvalConstruction: false, broadcast: false },
    stoppedDelayedCompletion: { id: context.certificate.stoppedRow.id, status: context.certificate.stoppedRow.status, outerNonce: context.certificate.stoppedRow.outerNonce, transactionHash: null },
    delayedSuccessor: { status: complete ? "DELAYED_SUCCESSOR_5_OF_5_TERMINAL" : "DELAYED_SUCCESSOR_INCOMPLETE", actionCount: 5, terminalActionCount: terminal, successfulLiveEntryCount: successful, expectedTerminalCounters: { safeNonce: "14", delayQueueNonce: "7", delayTxNonce: "7" }, expectedTerminalBalances: { safeUsdcUnits: "0", funderUsdcUnits: "40000000" }, actions },
    accounting: { priorGrossUsdcOutflowUnits: "20000000", newGrossUsdcOutflowUnits: outflow.toString(), aggregateGrossUsdcOutflowUnits: (20_000_000n + outflow).toString(), inwardUsdcFundingUnits: inward.toString(), receiptGasCostWei: gas.toString(), maximumReservationWei: proposal.reservation.successorMaximumReservationWei, maximumCumulativeOutlayWei: proposal.reservation.maximumCumulativeOutlayWei, nettingApplied: false },
    claims: { delayedTierLiveEvidenceComplete: complete, repairComplete: false, nativeSafe4337Complete: false, audited: false, mainnetReady: false, productionReady: false },
  });
}

export function renderUsdcDelayedSuccessorReport(source: UsdcDelayedSuccessorSource, context: Context, journal: OrdinaryScenarioJournal) { return render(source, context, journal, false); }
export function renderUsdcDelayedSuccessorReportForTestsOnly(source: UsdcDelayedSuccessorSource, context: Context, journal: OrdinaryScenarioJournal) { return render(source, context, journal, true); }
