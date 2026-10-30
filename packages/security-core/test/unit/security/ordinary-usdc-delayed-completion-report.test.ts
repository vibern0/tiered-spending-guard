import { expect } from "chai";
import type { Hex } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import type { OrdinaryScenarioJournal } from "../../../scripts/live/ordinary-scenario-executor";
import { renderUsdcDelayedCompletionReport } from "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-report";
import { attachUsdcDelayedCompletion } from "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-proposal";
import { cleanupUsdcRecycleContinuationFixtures } from "../../support/usdc-recycle-continuation-fixture";
import { approvedDelayedCompletion } from "../../support/usdc-delayed-completion-fixture";

const hash = (suffix: string): Hex => `0x${suffix.padStart(64, "0")}` as Hex;
const alerts = new Set(["queue-proposal", "queue-cancellation", "queue-expiry", "ready-delay-execution"]);

function terminalize(value: Awaited<ReturnType<typeof approvedDelayedCompletion>>) {
  const journal = structuredClone(attachUsdcDelayedCompletion(value.journal, value.proposal, value.approval)) as OrdinaryScenarioJournal; let nonce = value.proposal.minimumOuterNonce;
  const records = value.proposal.actions.map((action, index) => {
    const base = { id: action.id, commitment: action.commitment, materializationHash: hash((0xa00 + index).toString(16)), prestateHash: hash((0xa20 + index).toString(16)), outerNonce: nonce, maxFeePerGas: "7", maxPriorityFeePerGas: "7", funderNativeBefore: "1000000000000000000" };
    if (action.expectedOutcome === "rejection") return { ...base, status: "rejection-proved" as const, evidenceHash: hash((0xd00 + index).toString(16)) };
    const outerNonce = nonce++, transactionHash = hash((0xb00 + index).toString(16)), receipt = { transactionHash, status: "success" as const, gasUsed: 10n + BigInt(index), effectiveGasPrice: 7n, blockNumber: 12_027_000n + BigInt(index), blockHash: hash((0xc00 + index).toString(16)) };
    const facts = { proposalHash: value.proposal.proposalHash, actionCommitment: action.commitment, outerNonce, gas: action.gasLimitCap.toString(), gasEstimate: receipt.gasUsed.toString(), maxFeePerGas: "7", maxPriorityFeePerGas: "7", pinnedBlockNumber: (receipt.blockNumber - 1n).toString(), pinnedBlockHash: hash((0xc80 + index).toString(16)), approvedContinuationReservationWei: value.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: value.proposal.reservation.successorMaximumReservationWei };
    return { ...base, outerNonce, status: "confirmed" as const, gas: action.gasLimitCap.toString(), requestHash: action.safeTxHash ?? action.commitment, signatureBundleHash: action.safeTransaction ? hash((0xa40 + index).toString(16)) : null, signedCalldataHash: hash((0xa60 + index).toString(16)), simulationEvidenceHash: hash((0xa80 + index).toString(16)), finalOuterMaterialization: { hash: sha256(facts) as Hex, ...facts }, intentHash: hash((0xe00 + index).toString(16)), transactionHash, outerTo: action.safeTransaction ? value.source.historical.prior.original.safe : action.transaction.to, outerValue: "0", outerDataHash: hash((0xaa0 + index).toString(16)), evidenceHash: hash((0xd00 + index).toString(16)), observerEvidenceHash: alerts.has(action.kind) ? hash((0xf00 + index).toString(16)) : null, receipt, receiptInclusion: { transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, blockTimestamp: (BigInt(value.proposal.effectivePeriod) + 60n + BigInt(index)).toString(), effectivePeriod: value.proposal.effectivePeriod }, ourPrincipalDelta: "0", ourReceiptGasCost: (receipt.gasUsed * receipt.effectiveGasPrice).toString() };
  });
  journal.usdcDelayedCompletion!.actions.splice(0, records.length, ...records);
  journal.liveJournal.entries.push(...records.filter((record): record is typeof record & { status: "confirmed"; intentHash: Hex; transactionHash: Hex; receipt: any; ourReceiptGasCost: string } => record.status === "confirmed").map(record => ({ id: record.id, intentHash: record.intentHash, transactionHash: record.transactionHash, nonce: record.outerNonce, reserved: BigInt(record.ourReceiptGasCost), status: "success" as const, receipt: record.receipt })));
  return { ...value, journal, records };
}

describe("ordinary USDC delayed-completion report", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);
  it("renders an evidence-only incomplete report without side effects", async function () {
    const f = await approvedDelayedCompletion();
    const journal = attachUsdcDelayedCompletion(f.journal, f.proposal, f.approval);
    const report = renderUsdcDelayedCompletionReport(f.source, { certificate: f.certificate, proposal: f.proposal, approval: f.approval }, journal);
    expect(report.delayedCompletion).to.include({ status: "DELAYED_COMPLETION_INCOMPLETE", actionCount: 13, terminalActionCount: 0 });
    expect(report.provenance).to.include({ rpcReadsPerformedByRenderer: false, signing: false, broadcast: false });
  });

  it("requires complete canonical receipts, envelopes, inclusion, observer evidence, and zero principal", async function () {
    const value = terminalize(await approvedDelayedCompletion());
    const report = renderUsdcDelayedCompletionReport(value.source, { certificate: value.certificate, proposal: value.proposal, approval: value.approval }, value.journal) as any;
    expect(report.delayedCompletion).to.include({ status: "DELAYED_COMPLETION_13_OF_13_TERMINAL", successfulLiveEntryCount: 7 });
    const mutations: Array<[string, (journal: OrdinaryScenarioJournal) => void]> = [
      ["inclusion", journal => { delete (journal.usdcDelayedCompletion!.actions[0] as any).receiptInclusion; }],
      ["observer", journal => { (journal.usdcDelayedCompletion!.actions[2] as any).observerEvidenceHash = null; }],
      ["gas", journal => { (journal.usdcDelayedCompletion!.actions[0] as any).ourReceiptGasCost = "1"; }],
      ["principal", journal => { (journal.usdcDelayedCompletion!.actions[0] as any).ourPrincipalDelta = "1"; }],
      ["envelope", journal => { delete (journal.usdcDelayedCompletion!.actions[0] as any).finalOuterMaterialization; }],
      ["mirrored-nonce", journal => { const record = journal.usdcDelayedCompletion!.actions[0] as any; record.outerNonce++; journal.liveJournal.entries[15]!.nonce++; }],
      ["record-gas-cap", journal => { (journal.usdcDelayedCompletion!.actions[0] as any).gas = "740293"; }],
      ["record-fee", journal => { (journal.usdcDelayedCompletion!.actions[0] as any).maxFeePerGas = "8"; }],
      ["destination", journal => { (journal.usdcDelayedCompletion!.actions[0] as any).outerTo = "0x0000000000000000000000000000000000000001"; }],
      ["signature-field", journal => { delete (journal.usdcDelayedCompletion!.actions[2] as any).signatureBundleHash; }],
      ["proof-private", journal => { (journal.usdcDelayedCompletion!.actions[1] as any).requestHash = hash("bad"); }],
      ["live-receipt", journal => { journal.liveJournal.entries[15]!.reserved = 1n; }],
    ];
    for (const [label, mutate] of mutations) { const journal = structuredClone(value.journal); mutate(journal); expect(() => renderUsdcDelayedCompletionReport(value.source, { certificate: value.certificate, proposal: value.proposal, approval: value.approval }, journal), label).to.throw(/inclusion|observer|gas|principal|envelope|proof|live|receipt|materialization/i); }
  });
});
