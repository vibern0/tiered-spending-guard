import { expect } from "chai";
import type { Hex } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import type { OrdinaryScenarioJournal } from "../../../scripts/live/ordinary-scenario-executor";
import { verifyUsdcFreshSuccessorCertificate } from "../../../scripts/live/ordinary-scenario-usdc-fresh-successor-certificate";
import { attachUsdcFreshSuccessor, createUsdcFreshSuccessorProposal, loadUsdcFreshSuccessorApproval } from "../../../scripts/live/ordinary-scenario-usdc-fresh-successor-proposal";
import { renderUsdcFreshSuccessorReport, type UsdcFreshSuccessorReportContext } from "../../../scripts/live/ordinary-scenario-usdc-fresh-successor-report";
import { cleanupUsdcRecycleContinuationFixtures } from "../../support/usdc-recycle-continuation-fixture";
import { createFreshSource, freshPrimary, freshProviders, freshSnapshot } from "../../support/usdc-fresh-successor-fixture";
import { successorReceiptInclusion } from "../../support/usdc-successor-fixture";

const hash = (suffix: string): Hex => `0x${suffix.padStart(64, "0")}` as Hex;
const observer = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${hash("a1")}`, endpointHash: hash("a1"), startupEvidenceHash: hash("a2"), probeEvidenceHash: hash("a3"), independentFromProposer: true as const, readyAt: freshSnapshot.timestamp.toString(), workflowScheduleSeconds: { review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" }, requiredThrough: (freshSnapshot.timestamp + 11_640n).toString(), expiresAt: "1793404800" };
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;
const alerts = new Set(["step-up-transfer", "queue-proposal", "queue-cancellation", "queue-expiry", "ready-delay-execution"]);

async function prepared() {
  const source = await createFreshSource(), certificate = await verifyUsdcFreshSuccessorCertificate(source, freshPrimary, await freshProviders(source)), proposal = createUsdcFreshSuccessorProposal({ source, certificate, observer, caps });
  const document = { schemaVersion: 1, scope: proposal.scope, authorization: "FOCUSED_BOUNDED_SUCCESSOR_AUTHORIZATION", authorityEvidenceHash: proposal.authorityEvidenceHash, proposalHash: proposal.proposalHash, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, snapshot: proposal.snapshot, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, observer: proposal.observer, schedule: proposal.schedule, groups: proposal.groups, caps: proposal.caps, reservation: proposal.reservation, maxBroadcastAttempts: 1, repairAuthority: "NONE", approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
  const approval = loadUsdcFreshSuccessorApproval(proposal, JSON.stringify(document), sha256(document) as Hex), journal = structuredClone(attachUsdcFreshSuccessor(source.prior.journal, proposal, approval)) as OrdinaryScenarioJournal, context: UsdcFreshSuccessorReportContext = { certificate, proposal, approval };
  return { source, certificate, proposal, approval, journal, context };
}

function terminalize(value: Awaited<ReturnType<typeof prepared>>) {
  let nextOuterNonce = 870;
  const journal = structuredClone(value.journal), records = value.proposal.actions.map((action, index) => {
    const outerNonce = nextOuterNonce;
    const materialized = { materializationHash: hash((0xa00 + index).toString(16)), prestateHash: hash((0xa20 + index).toString(16)), outerNonce, maxFeePerGas: "7", maxPriorityFeePerGas: "7", funderNativeBefore: "1000000000000000000" };
    if (action.expectedOutcome === "rejection") return { id: action.id, commitment: action.commitment, status: "rejection-proved" as const, ...materialized, evidenceHash: hash((0xd00 + index).toString(16)) };
    nextOuterNonce++;
    const transactionHash = hash((0xb00 + index).toString(16)), receipt = { transactionHash, status: "success" as const, gasUsed: 10n + BigInt(index), effectiveGasPrice: 7n, blockNumber: 12_026_900n + BigInt(index), blockHash: hash((0xc00 + index).toString(16)) }, observerEvidenceHash = alerts.has(action.kind) ? hash((0xf00 + index).toString(16)) : null;
    const facts = { proposalHash: value.proposal.proposalHash, actionCommitment: action.commitment, outerNonce, gas: action.gasLimitCap.toString(), gasEstimate: receipt.gasUsed.toString(), maxFeePerGas: "7", maxPriorityFeePerGas: "7", pinnedBlockNumber: (receipt.blockNumber - 1n).toString(), pinnedBlockHash: hash((0xc80 + index).toString(16)), approvedContinuationReservationWei: value.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: value.proposal.reservation.successorMaximumReservationWei };
    return { id: action.id, commitment: action.commitment, status: "confirmed" as const, ...materialized, gas: action.gasLimitCap.toString(), requestHash: action.safeTxHash ?? action.commitment, signatureBundleHash: action.safeTransaction ? hash((0xa40 + index).toString(16)) : null, signedCalldataHash: hash((0xa60 + index).toString(16)), simulationEvidenceHash: hash((0xa80 + index).toString(16)), finalOuterMaterialization: { hash: sha256(facts) as Hex, ...facts }, intentHash: hash((0xe00 + index).toString(16)), transactionHash, outerTo: action.publicTransaction?.to ?? value.source.prior.original.safe, outerValue: "0", outerDataHash: hash((0xaa0 + index).toString(16)), evidenceHash: hash((0xd00 + index).toString(16)), observerEvidenceHash, receipt, receiptInclusion: successorReceiptInclusion(receipt, value.proposal.effectivePeriod, 60n + BigInt(index)), ourPrincipalDelta: "0", ourReceiptGasCost: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), ...(index === 1 ? { establishedWindow: value.proposal.effectivePeriod } : {}) };
  });
  journal.usdcFreshSuccessor!.actions.splice(0, 18, ...records);
  journal.liveJournal.entries.push(...records.filter((record): record is typeof record & { outerNonce: number; intentHash: Hex; transactionHash: Hex; receipt: { transactionHash: Hex; status: "success"; gasUsed: bigint; effectiveGasPrice: bigint; blockNumber: bigint; blockHash: Hex }; ourReceiptGasCost: string } => record.status === "confirmed").map(record => ({ id: record.id, intentHash: record.intentHash, transactionHash: record.transactionHash, nonce: record.outerNonce, reserved: BigInt(record.ourReceiptGasCost), status: "success" as const, receipt: record.receipt })));
  return { ...value, journal, records };
}

describe("ordinary USDC fresh successor persisted-evidence report", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  it("keeps original, native, old stopped USDC, fresh progress, and unauthorized repair separate", async function () {
    const value = await prepared(), copiedSource = { ...value.source }, report = renderUsdcFreshSuccessorReport(copiedSource, value.context, value.journal) as any;
    expect(report.original).to.include({ status: "INTERRUPTED_HASHLESS_AT_19_OF_38", successfulLiveEntryCount: 10 });
    expect(report.nativeRecovery).to.include({ status: "NATIVE_RECOVERY_3_OF_22", confirmedActionCount: 3, supersededApprovedActionCount: 19 });
    expect(report.oldUsdcSuccessor).to.include({ status: "OLD_USDC_SUCCESSOR_STOPPED_AT_2_OF_19", confirmedActionCount: 2, supersededApprovedActionCount: 16, grossOutflowUnits: "20000000" });
    expect(report.freshSuccessor).to.include({ status: "FRESH_USDC_SUCCESSOR_INCOMPLETE", terminalActionCount: 0, successfulLiveEntryCount: 0, actionCount: 18 });
    expect(report.combinedEvidence).to.deep.equal({ successfulLiveEntryCount: 15, freshTerminalActionCount: 0, proofActionCount: 8 });
    expect(report.laterRepair).to.deep.include({ status: "NOT_AUTHORIZED", predecessor: null });
    expect(report.provenance).to.deep.equal({ source: "VERIFIED_PERSISTED_PUBLIC_EVIDENCE", rpcReadsPerformedByRenderer: false, filesystemReadsPerformedByRenderer: false, signing: false, simulation: false, approvalConstruction: false, broadcast: false });
  });

  it("requires 18 terminal rows, ten fresh receipts, 25 total live entries, 31/51 gross units, alerts, and 17/7/7", async function () {
    const value = terminalize(await prepared()), report = renderUsdcFreshSuccessorReport(value.source, value.context, value.journal) as any;
    expect(report.freshSuccessor).to.include({ status: "FRESH_USDC_SUCCESSOR_18_OF_18_TERMINAL", terminalActionCount: 18, successfulLiveEntryCount: 10, effectivePeriod: value.proposal.effectivePeriod });
    expect(report.freshSuccessor.expectedTerminalCounters).to.deep.equal({ safeNonce: "17", delayQueueNonce: "7", delayTxNonce: "7" });
    expect(report.freshSuccessor.expectedTerminalBalances).to.deep.equal({ safeUsdcUnits: "0", funderUsdcUnits: "40000000" });
    expect(report.combinedEvidence).to.deep.equal({ successfulLiveEntryCount: 25, freshTerminalActionCount: 18, proofActionCount: 8 });
    expect(report.accounting).to.include({ priorGrossUsdcOutflowUnits: "20000000", newGrossUsdcOutflowUnits: "31000000", aggregateGrossUsdcOutflowUnits: "51000000", inwardUsdcFundingUnits: "31000000", nettingApplied: false });
    expect(report.faucet).to.include({ amountUnits: "20000000" });
  });

  it("rejects late/missing inclusion, gas drift, netting-like principal, wrong alerts, header drift, old-row completion, and live loss", async function () {
    const value = terminalize(await prepared());
    const mutations: Array<[string, (journal: OrdinaryScenarioJournal) => void]> = [
      ["missing inclusion", journal => { delete (journal.usdcFreshSuccessor!.actions[0] as any).receiptInclusion; }],
      ["late receipt", journal => { (journal.usdcFreshSuccessor!.actions[17] as any).receiptInclusion.blockTimestamp = journal.usdcFreshSuccessor!.deadline; (journal.usdcFreshSuccessor!.actions[17] as any).receiptInclusion.effectivePeriod = journal.usdcFreshSuccessor!.deadline; }],
      ["gas", journal => { (journal.usdcFreshSuccessor!.actions[0] as any).ourReceiptGasCost = "1"; }],
      ["netting", journal => { (journal.usdcFreshSuccessor!.actions[0] as any).ourPrincipalDelta = "31000000"; }],
      ["observer", journal => { (journal.usdcFreshSuccessor!.actions[2] as any).observerEvidenceHash = null; }],
      ["header", journal => { (journal.usdcFreshSuccessor as any).proposalHash = hash("bad"); }],
      ["old row", journal => { (journal.usdcSuccessor!.actions[3] as any).status = "confirmed"; }],
      ["live", journal => { journal.liveJournal.entries.pop(); }],
      ["durable envelope", journal => { delete (journal.usdcFreshSuccessor!.actions[0] as any).finalOuterMaterialization; }],
      ["proof materialization", journal => { delete (journal.usdcFreshSuccessor!.actions[4] as any).materializationHash; }],
    ];
    for (const [label, mutate] of mutations) { const journal = structuredClone(value.journal); mutate(journal); expect(() => renderUsdcFreshSuccessorReport(value.source, value.context, journal), label).to.throw(/inclusion|period|receipt|gas|principal|observer|header|lineage|live|accounting|frozen|durable|materialization|envelope|source/i); }
  });

  it("never upgrades partial or forged authority/faucet context to completion", async function () {
    const value = terminalize(await prepared()), partial = structuredClone(value.journal); partial.usdcFreshSuccessor!.actions[17] = { id: value.proposal.actions[17]!.id, commitment: value.proposal.actions[17]!.commitment, status: "approved" }; partial.liveJournal.entries.pop();
    const report = renderUsdcFreshSuccessorReport(value.source, value.context, partial) as any; expect(report.freshSuccessor.status).to.equal("FRESH_USDC_SUCCESSOR_INCOMPLETE"); expect(report.combinedEvidence.successfulLiveEntryCount).to.equal(24);
    expect(() => renderUsdcFreshSuccessorReport(value.source, { ...value.context, certificate: { ...value.certificate, faucet: { ...value.certificate.faucet, amount: 19_000_000n } } as any }, value.journal)).to.throw(/certificate|opaque/i);
    expect(() => renderUsdcFreshSuccessorReport(value.source, { ...value.context, approval: { approvalHash: value.approval.approvalHash } as any }, value.journal)).to.throw(/approval|authorization|opaque/i);
    const forgedSource = structuredClone(value.source), forgedJournal = structuredClone(value.journal); (forgedSource.prior.journal.actions[0] as any).evidenceHash = hash("feed"); (forgedJournal.actions[0] as any).evidenceHash = hash("feed");
    expect(() => renderUsdcFreshSuccessorReport(forgedSource, value.context, forgedJournal)).to.throw(/source|history|frozen|changed/i);
  });
});
