import { keccak256, type Hex } from "viem";
import {
  assertUsdcDelayedSuccessorJournal,
  assertUsdcDelayedSuccessorJournalForTestsOnly,
  assertUsdcSuccessorReceiptInclusion,
  type OrdinaryScenarioActionRecord,
  type OrdinaryScenarioJournal,
} from "./ordinary-scenario-executor";
import { isVerifiedUsdcDelayedSuccessorCertificate, isVerifiedUsdcDelayedSuccessorCertificateForTestsOnly, type UsdcDelayedSuccessorSource, type VerifiedUsdcDelayedSuccessorCertificate } from "./ordinary-scenario-usdc-delayed-successor-certificate";
import { assertUsdcDelayedSuccessorAuthorization, assertUsdcDelayedSuccessorAuthorizationForTestsOnly, type UsdcDelayedSuccessorApproval, type UsdcDelayedSuccessorProposal } from "./ordinary-scenario-usdc-delayed-successor-proposal";
import { sha256 } from "../plan-deployment";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const PROGRESS = new Set(["approved", "materialized", "signed-simulated", "outer-pending", "reverted", "stopped"]);
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };
const publicJson = (value: unknown): string => JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child);

type Context = Readonly<{ certificate: VerifiedUsdcDelayedSuccessorCertificate; proposal: UsdcDelayedSuccessorProposal; approval: UsdcDelayedSuccessorApproval }>;

function validateContext(source: UsdcDelayedSuccessorSource, context: Context, journal: OrdinaryScenarioJournal, testOnly: boolean): void {
  if (!(testOnly ? isVerifiedUsdcDelayedSuccessorCertificateForTestsOnly(context.certificate) : isVerifiedUsdcDelayedSuccessorCertificate(context.certificate))) throw new Error("delayed successor report certificate is not opaque for this authority");
  if (testOnly) { assertUsdcDelayedSuccessorAuthorizationForTestsOnly(context.proposal, context.approval); assertUsdcDelayedSuccessorJournalForTestsOnly(journal, source, context.proposal, context.approval); }
  else { assertUsdcDelayedSuccessorAuthorization(context.proposal, context.approval); assertUsdcDelayedSuccessorJournal(journal, source, context.proposal, context.approval); }
  const attached = journal.usdcDelayedSuccessor!;
  if (!same(context.certificate.sourceJournalHash, context.proposal.sourceJournalHash) || !same(context.certificate.certificateHash, context.proposal.certificateHash) || context.certificate.effectivePeriod.toString() !== context.proposal.effectivePeriod || !same(attached.certificateHash, context.proposal.certificateHash) || !same(attached.proposalHash, context.proposal.proposalHash) || !same(attached.approvalHash, context.approval.approvalHash)) throw new Error("delayed successor report source, certificate, proposal, approval, or header binding mismatch");
}

function finalMaterializationMatches(record: OrdinaryScenarioActionRecord, proposal: UsdcDelayedSuccessorProposal, action: UsdcDelayedSuccessorProposal["actions"][number]): boolean {
  const final = record.finalOuterMaterialization; if (!final) return false;
  const facts = { proposalHash: final.proposalHash, actionCommitment: final.actionCommitment, outerNonce: final.outerNonce, gas: final.gas, gasEstimate: final.gasEstimate, maxFeePerGas: final.maxFeePerGas, maxPriorityFeePerGas: final.maxPriorityFeePerGas, pinnedBlockNumber: final.pinnedBlockNumber, pinnedBlockHash: final.pinnedBlockHash, approvedContinuationReservationWei: final.approvedContinuationReservationWei, remainingReservationWei: final.remainingReservationWei };
  return same(final.proposalHash, proposal.proposalHash) && same(final.actionCommitment, action.commitment) && final.outerNonce >= proposal.minimumOuterNonce && final.outerNonce === record.outerNonce && final.gas === record.gas && final.maxFeePerGas === record.maxFeePerGas && final.maxPriorityFeePerGas === record.maxPriorityFeePerGas && BigInt(final.gas) > 0n && BigInt(final.gas) <= BigInt(action.gasLimitCap) && BigInt(final.maxFeePerGas) > 0n && BigInt(final.maxFeePerGas) <= BigInt(action.maxFeePerGasCap) && BigInt(final.maxPriorityFeePerGas) >= 0n && BigInt(final.maxPriorityFeePerGas) <= BigInt(action.maxPriorityFeePerGasCap) && BigInt(final.maxPriorityFeePerGas) <= BigInt(final.maxFeePerGas) && final.approvedContinuationReservationWei === proposal.reservation.successorMaximumReservationWei && same(final.hash, sha256(facts) as Hex);
}

function render(source: UsdcDelayedSuccessorSource, context: Context, journal: OrdinaryScenarioJournal, testOnly: boolean) {
  validateContext(source, context, journal, testOnly);
  const proposal = context.proposal, attached = journal.usdcDelayedSuccessor!;
  let complete = true, terminal = 0, successful = 0, gas = 0n, outflow = 0n, inward = 0n;
  const expectedLive: OrdinaryScenarioActionRecord[] = [];
  const actions = proposal.actions.map((action, index) => {
    const value = attached.actions[index]!, record = value as OrdinaryScenarioActionRecord;
    if (record.id !== action.id || !same(record.commitment, action.commitment)) throw new Error(`delayed successor report action lineage mismatch at ${index + 1}`);
    if (record.status === "confirmed") {
      terminal++; successful++; expectedLive.push(record);
      if (!record.intentHash || !record.transactionHash || !record.receipt || !record.receiptInclusion || !record.finalOuterMaterialization || !record.materializationHash || !record.prestateHash || !record.evidenceHash || !record.requestHash || !record.simulationEvidenceHash || !record.signedCalldataHash || !record.outerDataHash || !record.outerTo || record.outerNonce === undefined || !record.gas || !record.maxFeePerGas || !record.maxPriorityFeePerGas || record.ourPrincipalDelta !== "0" || !record.ourReceiptGasCost || ![record.intentHash, record.transactionHash, record.materializationHash, record.prestateHash, record.evidenceHash, record.requestHash, record.simulationEvidenceHash, record.signedCalldataHash, record.outerDataHash].every(value => HASH.test(value))) throw new Error(`delayed successor receipt, inclusion, envelope, gas, or principal evidence missing at ${index + 1}`);
      if (!HASH.test(record.intentHash) || !same(record.transactionHash, record.receipt.transactionHash) || !same(record.transactionHash, record.receiptInclusion.transactionHash) || record.receipt.status !== "success" || record.receipt.blockNumber.toString() !== record.receiptInclusion.blockNumber || !same(record.receipt.blockHash, record.receiptInclusion.blockHash) || record.receiptInclusion.effectivePeriod !== proposal.effectivePeriod) throw new Error(`delayed successor receipt inclusion mismatch at ${index + 1}`);
      if (BigInt(record.gas) <= 0n || BigInt(record.gas) > BigInt(action.gasLimitCap) || BigInt(record.maxFeePerGas) <= 0n || BigInt(record.maxFeePerGas) > BigInt(action.maxFeePerGasCap) || BigInt(record.maxPriorityFeePerGas) < 0n || BigInt(record.maxPriorityFeePerGas) > BigInt(action.maxPriorityFeePerGasCap) || BigInt(record.maxPriorityFeePerGas) > BigInt(record.maxFeePerGas) || !finalMaterializationMatches(record, proposal, action)) throw new Error(`delayed successor materialization or gas cap mismatch at ${index + 1}`);
      const expectedTo = action.safeTransaction ? source.prior.historical.prior.original.safe : action.transaction.to;
      if (!same(record.outerTo, expectedTo) || record.outerValue !== "0" || !same(record.requestHash, action.safeTxHash ?? action.commitment) || !same(record.outerDataHash, record.signedCalldataHash) || (action.safeTransaction ? !record.signatureBundleHash || !HASH.test(record.signatureBundleHash) : record.signatureBundleHash !== null || !same(record.signedCalldataHash, keccak256(action.transaction.data)))) throw new Error(`delayed successor signed envelope mismatch at ${index + 1}`);
      if (!record.observerEvidenceHash || !HASH.test(record.observerEvidenceHash)) throw new Error(`delayed successor observer evidence missing at ${index + 1}`);
      const receiptGas = record.receipt.gasUsed * record.receipt.effectiveGasPrice;
      if (record.receipt.gasUsed <= 0n || record.receipt.gasUsed > BigInt(record.gas) || record.receipt.effectiveGasPrice < 0n || record.receipt.effectiveGasPrice > BigInt(record.maxFeePerGas) || receiptGas.toString() !== record.ourReceiptGasCost) throw new Error(`delayed successor receipt gas accounting mismatch at ${index + 1}`);
      assertUsdcSuccessorReceiptInclusion(record, proposal.effectivePeriod, proposal.deadline);
      gas += receiptGas;
      const before = BigInt(action.before.safeUsdcBalance), after = BigInt(action.after.safeUsdcBalance); if (before > after) outflow += before - after; else if (after > before) inward += after - before;
    } else if (record.status === "rejection-proved") {
      terminal++;
      if (!record.evidenceHash || !HASH.test(record.evidenceHash) || [record.requestHash, record.signatureBundleHash, record.signedCalldataHash, record.simulationEvidenceHash, record.finalOuterMaterialization, record.intentHash, record.transactionHash, record.receipt, record.receiptInclusion, record.observerEvidenceHash].some(value => value !== undefined)) throw new Error(`delayed successor proof row carries private or broadcast evidence at ${index + 1}`);
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
    historicalStoppedRows: [source.prior.historical.prior.journal.usdcSuccessor?.actions[2], source.prior.journal.usdcFreshSuccessor?.actions[0], source.journal.usdcDelayedCompletion.actions[8]].filter(Boolean).map(action => { const record = action as OrdinaryScenarioActionRecord; return { id: record.id, status: record.status, outerNonce: record.outerNonce ?? null, transactionHash: record.transactionHash ?? null }; }),
    historicalUntouchedRows: [...(source.prior.historical.prior.journal.usdcSuccessor?.actions.slice(3) ?? []), ...(source.prior.journal.usdcFreshSuccessor?.actions.slice(1) ?? [])].map(action => ({ id: action.id, status: action.status })),
    untouchedDelayedCompletionTail: source.journal.usdcDelayedCompletion.actions.slice(9).map(action => ({ id: action.id, status: action.status })),
    delayedSuccessor: { status: complete ? "DELAYED_SUCCESSOR_5_OF_5_TERMINAL" : "DELAYED_SUCCESSOR_INCOMPLETE", actionCount: 5, terminalActionCount: terminal, successfulLiveEntryCount: successful, expectedTerminalCounters: { safeNonce: "14", delayQueueNonce: "7", delayTxNonce: "7" }, expectedTerminalBalances: { safeUsdcUnits: "0", funderUsdcUnits: "40000000" }, actions },
    accounting: { priorGrossUsdcOutflowUnits: "20000000", newGrossUsdcOutflowUnits: outflow.toString(), aggregateGrossUsdcOutflowUnits: (20_000_000n + outflow).toString(), inwardUsdcFundingUnits: inward.toString(), receiptGasCostWei: gas.toString(), maximumReservationWei: proposal.reservation.successorMaximumReservationWei, maximumCumulativeOutlayWei: proposal.reservation.maximumCumulativeOutlayWei, nettingApplied: false },
    claims: { delayedTierLiveEvidenceComplete: complete, repairComplete: false, nativeSafe4337Complete: false, audited: false, mainnetReady: false, productionReady: false },
  });
}

export function renderUsdcDelayedSuccessorReport(source: UsdcDelayedSuccessorSource, context: Context, journal: OrdinaryScenarioJournal) { return render(source, context, journal, false); }
export function renderUsdcDelayedSuccessorReportForTestsOnly(source: UsdcDelayedSuccessorSource, context: Context, journal: OrdinaryScenarioJournal) { return render(source, context, journal, true); }
