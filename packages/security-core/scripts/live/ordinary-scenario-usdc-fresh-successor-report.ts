import type { Hex } from "viem";
import { sha256 } from "../plan-deployment";
import { assertUsdcFreshSuccessorJournal, assertUsdcSuccessorReceiptInclusion, type OrdinaryScenarioActionRecord, type OrdinaryScenarioJournal } from "./ordinary-scenario-executor";
import { FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH, isVerifiedUsdcFreshSuccessorCertificate, type VerifiedUsdcFreshSuccessorCertificate } from "./ordinary-scenario-usdc-fresh-successor-certificate";
import { assertUsdcFreshSuccessorAuthorization, type UsdcFreshSuccessorApproval, type UsdcFreshSuccessorProposal } from "./ordinary-scenario-usdc-fresh-successor-proposal";
import type { UsdcRecycleContinuationSource } from "./ordinary-scenario-usdc-recycle-continuation-certificate";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const TERMINAL = new Set(["confirmed", "rejection-proved"]);
const PROGRESS = new Set(["approved", "materialized", "signed-simulated", "outer-pending", "reverted", "stopped"]);
const ALERT_KINDS = new Set(["step-up-transfer", "queue-proposal", "queue-cancellation", "queue-expiry", "ready-delay-execution"]);
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const publicHash = (value: unknown): Hex => sha256(value) as Hex;
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };

export type UsdcFreshSuccessorReportContext = Readonly<{ certificate: VerifiedUsdcFreshSuccessorCertificate; proposal: UsdcFreshSuccessorProposal; approval: UsdcFreshSuccessorApproval }>;

function sameReceipt(record: OrdinaryScenarioActionRecord, entry: OrdinaryScenarioJournal["liveJournal"]["entries"][number]): boolean {
  const left = record.receipt, right = entry.receipt;
  return !!left && !!right && same(left.transactionHash, right.transactionHash) && left.status === right.status && BigInt(left.gasUsed) === right.gasUsed && BigInt(left.effectiveGasPrice) === right.effectiveGasPrice && BigInt(left.blockNumber) === right.blockNumber && same(left.blockHash, right.blockHash);
}

function assertContext(source: UsdcRecycleContinuationSource, context: UsdcFreshSuccessorReportContext, journal: OrdinaryScenarioJournal): void {
  if (!isVerifiedUsdcFreshSuccessorCertificate(context.certificate)) throw new Error("fresh USDC successor report certificate is not opaque and verified");
  assertUsdcFreshSuccessorAuthorization(context.proposal, context.approval);
  assertUsdcFreshSuccessorJournal(journal, source, context.proposal, context.approval, { inMemorySourceOnly: true });
  const certificate = context.certificate, proposal = context.proposal, attached = journal.usdcFreshSuccessor, prior = source.prior.journal;
  if (!attached || journal.usdcRecycleContinuation !== undefined || journal.repairContinuation !== undefined) throw new Error("fresh USDC successor report requires the sole fresh attachment and no repair");
  if (!same(certificate.sourceHash, proposal.sourceHash) || !same(certificate.certificateHash, proposal.certificateHash) || certificate.effectivePeriod.toString() !== proposal.effectivePeriod || !same(attached.sourceHash, proposal.sourceHash) || !same(attached.certificateHash, proposal.certificateHash) || !same(attached.proposalHash, proposal.proposalHash) || !same(attached.approvalHash, context.approval.approvalHash)) throw new Error("fresh USDC successor report source, certificate, proposal, approval, or header mismatch");
  if (attached.schemaVersion !== 1 || attached.scope !== proposal.scope || attached.minimumOuterNonce !== proposal.minimumOuterNonce || attached.effectivePeriod !== proposal.effectivePeriod || attached.deadline !== proposal.deadline || attached.maximumReservationWei !== proposal.reservation.successorMaximumReservationWei || attached.maxBroadcastAttempts !== 1 || attached.repairAuthority !== "NONE" || attached.actions.length !== 18 || attached.actionCommitments.length !== 18) throw new Error("fresh USDC successor report immutable header mismatch");
  if (journal.actions.length !== 19 || !journal.hashlessContinuation || !journal.usdcSuccessor || publicHash(journal.actions) !== publicHash(prior.actions) || publicHash(journal.hashlessContinuation) !== publicHash(prior.hashlessContinuation) || publicHash(journal.usdcSuccessor) !== publicHash(prior.usdcSuccessor) || publicHash(journal.liveJournal.entries.slice(0, 15)) !== publicHash(prior.liveJournal.entries.slice(0, 15))) throw new Error("fresh USDC successor report predecessor lineage changed");
  if (journal.liveJournal.entries.slice(0, 15).some(entry => entry.status !== "success" || !entry.receipt)) throw new Error("fresh USDC successor report historical live prefix is incomplete");
  if (certificate.faucet.transactionHash !== FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH || certificate.faucet.amount !== 20_000_000n || certificate.faucet.preBalance !== 20_000_000n || certificate.faucet.postBalance !== 40_000_000n || certificate.safeUsdcBalance !== 0n || certificate.funderUsdcBalance !== 40_000_000n) throw new Error("fresh USDC successor report faucet or starting balances mismatch");
  const reservation = proposal.reservation;
  if (reservation.newGrossUsdcAllowance !== "31000000" || reservation.aggregateGrossUsdcAllowance !== "51000000" || reservation.inwardUsdcFunding !== "31000000" || reservation.successorMaximumReservationWei !== "15340292000000" || reservation.maximumCumulativeOutlayWei !== "146501418272986") throw new Error("fresh USDC successor report principal, non-netting, or gas reservation mismatch");
}

type Progress = Readonly<{ complete: boolean; terminalCount: number; successfulCount: number; gasCostWei: bigint; newOutflow: bigint; inward: bigint; actions: readonly Readonly<Record<string, unknown>>[] }>;

function validateProgress(context: UsdcFreshSuccessorReportContext, journal: OrdinaryScenarioJournal): Progress {
  const proposal = context.proposal, attached = journal.usdcFreshSuccessor!, expectedLive: Array<{ record: OrdinaryScenarioActionRecord; status: "pending" | "success" | "reverted" }> = [];
  let complete = true, terminalCount = 0, successfulCount = 0, gasCostWei = 0n, newOutflow = 0n, inward = 0n, approvedTail = false;
  const actions = proposal.actions.map((action, index) => {
    const commitment = attached.actionCommitments[index]!, value = attached.actions[index]!;
    if (commitment.id !== action.id || !same(commitment.commitment, action.commitment) || value.id !== action.id || !same(value.commitment, action.commitment)) throw new Error("fresh USDC successor report catalog or commitment mismatch");
    if (value.status === "approved") approvedTail = true; else if (approvedTail) throw new Error("fresh USDC successor report progress is not a contiguous prefix");
    const record = value as OrdinaryScenarioActionRecord, expectedTerminal = action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed";
    if (TERMINAL.has(record.status)) {
      terminalCount++;
      if (record.status !== expectedTerminal || !record.evidenceHash || !HASH.test(record.evidenceHash)) throw new Error(`fresh USDC successor report terminal outcome or evidence mismatch at ${index + 1}`);
      if (record.status === "confirmed") {
        const receipt = record.receipt;
        if (!record.intentHash || !record.transactionHash || !receipt || receipt.status !== "success" || !same(record.transactionHash, receipt.transactionHash) || BigInt(receipt.gasUsed) <= 0n || BigInt(receipt.gasUsed) > BigInt(action.gasLimitCap) || BigInt(receipt.effectiveGasPrice) < 0n || BigInt(receipt.effectiveGasPrice) > BigInt(action.maxFeePerGasCap) || BigInt(record.ourReceiptGasCost ?? "-1") !== BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) || BigInt(record.ourPrincipalDelta ?? "-1") !== 0n || BigInt(record.outerValue ?? "-1") !== 0n) throw new Error(`fresh USDC successor report receipt, gas, or principal accounting mismatch at ${index + 1}`);
        assertUsdcSuccessorReceiptInclusion(record, proposal.effectivePeriod, proposal.deadline);
        if (index === 1 && record.establishedWindow !== proposal.effectivePeriod) throw new Error("fresh USDC successor report base receipt did not establish the fresh period");
        const alert = ALERT_KINDS.has(action.kind); if (alert ? !record.observerEvidenceHash || !HASH.test(record.observerEvidenceHash) : record.observerEvidenceHash !== null) throw new Error(`fresh USDC successor report kind-specific observer evidence mismatch at ${index + 1}`);
        expectedLive.push({ record, status: "success" }); successfulCount++; gasCostWei += BigInt(record.ourReceiptGasCost!);
        const before = BigInt(action.before.safeUsdcBalance), after = BigInt(action.after.safeUsdcBalance); if (after < before) newOutflow += before - after; else if (after > before) inward += after - before;
      } else if (record.transactionHash !== undefined || record.receipt !== undefined || record.observerEvidenceHash !== undefined) throw new Error("fresh USDC successor report proof row carries broadcast or observer evidence");
    } else {
      complete = false;
      if (!PROGRESS.has(record.status)) throw new Error(`fresh USDC successor report progress status mismatch at ${index + 1}`);
      if (record.status === "approved" && Object.keys(record).sort().join(",") !== "commitment,id,status") throw new Error("fresh USDC successor report approved row carries materialized evidence");
      if (record.status === "outer-pending") { if (!record.transactionHash || !record.intentHash) throw new Error("fresh USDC successor report pending row lacks durable hashes"); expectedLive.push({ record, status: "pending" }); }
      if (record.status === "reverted") { if (!record.transactionHash || !record.receipt || record.receipt.status !== "reverted") throw new Error("fresh USDC successor report reverted row lacks its receipt"); expectedLive.push({ record, status: "reverted" }); }
      if (record.status === "stopped" && record.transactionHash && record.receipt) expectedLive.push({ record, status: record.receipt.status });
    }
    return freeze({ id: action.id, expectedOutcome: action.expectedOutcome, status: record.status, transactionHash: record.transactionHash ?? null, evidenceHash: record.evidenceHash ?? null, observerEvidenceHash: record.observerEvidenceHash ?? null });
  });
  const suffix = journal.liveJournal.entries.slice(15);
  if (suffix.length !== expectedLive.length) throw new Error("fresh USDC successor report live suffix count mismatch");
  expectedLive.forEach((expected, index) => { const entry = suffix[index]!; if (entry.id !== expected.record.id || entry.status !== expected.status || !expected.record.transactionHash || !same(entry.transactionHash, expected.record.transactionHash) || !expected.record.intentHash || !same(entry.intentHash, expected.record.intentHash)) throw new Error("fresh USDC successor report live suffix lineage mismatch"); if (expected.status === "success" && (!sameReceipt(expected.record, entry) || entry.reserved !== BigInt(expected.record.ourReceiptGasCost ?? "-1"))) throw new Error("fresh USDC successor report live receipt accounting mismatch"); if (expected.status === "pending" && entry.receipt !== undefined) throw new Error("fresh USDC successor report pending live entry has a receipt"); });
  if (complete) {
    const last = proposal.actions[17]!.after;
    if (terminalCount !== 18 || successfulCount !== 10 || journal.liveJournal.entries.length !== 25 || newOutflow !== 31_000_000n || inward !== 31_000_000n || last.safeNonce !== "17" || last.delayQueueNonce !== "7" || last.delayTxNonce !== "7" || last.safeUsdcBalance !== "0" || last.funderUsdcBalance !== "40000000") throw new Error("fresh USDC successor report completion counts, non-netting totals, balances, or terminal counters mismatch");
  }
  return freeze({ complete, terminalCount, successfulCount, gasCostWei, newOutflow, inward, actions });
}

/** Projects only supplied persisted public evidence. It performs no RPC, filesystem, signing, simulation, approval construction, or broadcast work. */
export function renderUsdcFreshSuccessorReport(source: UsdcRecycleContinuationSource, context: UsdcFreshSuccessorReportContext, journal: OrdinaryScenarioJournal): Readonly<Record<string, unknown>> {
  assertContext(source, context, journal); const progress = validateProgress(context, journal); const oldStopped = journal.usdcSuccessor!.actions[2] as OrdinaryScenarioActionRecord;
  return freeze({
    schemaVersion: 1,
    scope: "ORDINARY_USDC_FRESH_SUCCESSOR_EVIDENCE_REPORT_V1",
    provenance: { source: "VERIFIED_PERSISTED_PUBLIC_EVIDENCE", rpcReadsPerformedByRenderer: false, filesystemReadsPerformedByRenderer: false, signing: false, simulation: false, approvalConstruction: false, broadcast: false },
    original: { status: "INTERRUPTED_HASHLESS_AT_19_OF_38", successfulLiveEntryCount: 10, terminalRowCount: 18, immutableRow19: { status: "signed-simulated", outerNonce: 809, transactionHash: null, failureCause: "UNKNOWN" } },
    nativeRecovery: { status: "NATIVE_RECOVERY_3_OF_22", confirmedActionCount: 3, supersededApprovedActionCount: 19 },
    oldUsdcSuccessor: { status: "OLD_USDC_SUCCESSOR_STOPPED_AT_2_OF_19", confirmedActionCount: 2, immutableRow3: { id: oldStopped.id, status: oldStopped.status, outerNonce: oldStopped.outerNonce ?? 869, transactionHash: null }, supersededApprovedActionCount: 16, grossOutflowUnits: "20000000" },
    freshSuccessor: { status: progress.complete ? "FRESH_USDC_SUCCESSOR_18_OF_18_TERMINAL" : "FRESH_USDC_SUCCESSOR_INCOMPLETE", terminalActionCount: progress.terminalCount, successfulLiveEntryCount: progress.successfulCount, actionCount: 18, effectivePeriod: context.proposal.effectivePeriod, deadline: context.proposal.deadline, expectedTerminalCounters: { safeNonce: "17", delayQueueNonce: "7", delayTxNonce: "7" }, expectedTerminalBalances: { safeUsdcUnits: "0", funderUsdcUnits: "40000000" }, observer: { probeEvidenceHash: context.proposal.observer.probeEvidenceHash, requiredThrough: context.proposal.observer.requiredThrough, expiresAt: context.proposal.observer.expiresAt }, actions: progress.actions },
    combinedEvidence: { successfulLiveEntryCount: 15 + progress.successfulCount, freshTerminalActionCount: progress.terminalCount, proofActionCount: context.proposal.actions.filter(action => action.expectedOutcome === "rejection").length },
    accounting: { priorGrossUsdcOutflowUnits: "20000000", newGrossUsdcOutflowUnits: progress.newOutflow.toString(), aggregateGrossUsdcOutflowUnits: (20_000_000n + progress.newOutflow).toString(), inwardUsdcFundingUnits: progress.inward.toString(), freshReceiptGasCostWei: progress.gasCostWei.toString(), maximumFreshReservationWei: context.proposal.reservation.successorMaximumReservationWei, maximumCumulativeOutlayWei: context.proposal.reservation.maximumCumulativeOutlayWei, nettingApplied: false },
    faucet: { transactionHash: context.certificate.faucet.transactionHash, amountUnits: context.certificate.faucet.amount.toString(), blockNumber: context.certificate.faucet.blockNumber.toString(), blockHash: context.certificate.faucet.blockHash },
    laterRepair: { status: "NOT_AUTHORIZED", predecessor: null, expectedTerminalCounters: { safeNonce: "17", delayQueueNonce: "7", delayTxNonce: "7" } },
    task0: { status: "OPEN", nativeTasks1Through13: "GATED", requiredEvidence: ["fresh-live-receipts-and-effects", "kind-specific-observer-delivery-and-acknowledgement", "root-security-check", "whole-change-independent-review", "browser-and-hardware"] },
    claims: { hardwarePasskeyUxVerified: false, browserPasskeyUxVerified: false, nativeSafe4337Complete: false, audited: false, pullRequestGreen: false, mainnetReady: false, productionReady: false },
  });
}
