import { expect } from "chai";
import { keccak256, type Hex } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import type { OrdinaryScenarioJournal } from "../../../scripts/live/ordinary-scenario-executor";
import { renderUsdcDelayedSuccessorReportForTestsOnly as renderReport } from "../../../scripts/live/ordinary-scenario-usdc-delayed-successor-report";
import { attachUsdcDelayedSuccessorForTestsOnly as attach } from "../../../scripts/live/ordinary-scenario-usdc-delayed-successor-proposal";
import { approvedDelayedSuccessor } from "../../support/usdc-delayed-successor-fixture";

const hash = (suffix: string): Hex => `0x${suffix.padStart(64, "0")}` as Hex;
const alerts = new Set(["queue-proposal", "queue-expiry", "ready-delay-execution"]);

function terminalize(value: Awaited<ReturnType<typeof approvedDelayedSuccessor>>) {
  const journal = structuredClone(attach(value.journal, value.proposal, value.approval)) as OrdinaryScenarioJournal;
  let nonce = value.proposal.minimumOuterNonce;
  const records = value.proposal.actions.map((action, index) => {
    const base = { id: action.id, commitment: action.commitment, materializationHash: hash((0xa00 + index).toString(16)), prestateHash: hash((0xa20 + index).toString(16)), outerNonce: nonce, maxFeePerGas: "7", maxPriorityFeePerGas: "7", funderNativeBefore: "1000000000000000000" };
    if (action.expectedOutcome === "rejection") return { ...base, status: "rejection-proved" as const, evidenceHash: hash((0xd00 + index).toString(16)) };
    const outerNonce = nonce++, transactionHash = hash((0xb00 + index).toString(16)), receipt = { transactionHash, status: "success" as const, gasUsed: 10n + BigInt(index), effectiveGasPrice: 7n, blockNumber: 12_030_000n + BigInt(index), blockHash: hash((0xc00 + index).toString(16)) };
    const facts = { proposalHash: value.proposal.proposalHash, actionCommitment: action.commitment, outerNonce, gas: action.gasLimitCap.toString(), gasEstimate: receipt.gasUsed.toString(), maxFeePerGas: "7", maxPriorityFeePerGas: "7", pinnedBlockNumber: (receipt.blockNumber - 1n).toString(), pinnedBlockHash: hash((0xc80 + index).toString(16)), approvedContinuationReservationWei: value.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: value.proposal.reservation.successorMaximumReservationWei };
    const signedCalldataHash = action.safeTransaction ? hash((0xa60 + index).toString(16)) : keccak256(action.transaction.data);
    return { ...base, outerNonce, status: "confirmed" as const, gas: action.gasLimitCap.toString(), requestHash: action.safeTxHash ?? action.commitment, signatureBundleHash: action.safeTransaction ? hash((0xa40 + index).toString(16)) : null, signedCalldataHash, simulationEvidenceHash: hash((0xa80 + index).toString(16)), finalOuterMaterialization: { hash: sha256(facts) as Hex, ...facts }, intentHash: hash((0xe00 + index).toString(16)), transactionHash, outerTo: action.safeTransaction ? value.source.prior.historical.prior.original.safe : action.transaction.to, outerValue: "0", outerDataHash: signedCalldataHash, evidenceHash: hash((0xd00 + index).toString(16)), observerEvidenceHash: alerts.has(action.kind) ? hash((0xf00 + index).toString(16)) : null, receipt, receiptInclusion: { transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, blockTimestamp: (BigInt(value.proposal.effectivePeriod) + 60n + BigInt(index)).toString(), effectivePeriod: value.proposal.effectivePeriod }, ourPrincipalDelta: "0", ourReceiptGasCost: (receipt.gasUsed * receipt.effectiveGasPrice).toString() };
  });
  journal.usdcDelayedSuccessor!.actions.splice(0, records.length, ...records);
  journal.liveJournal.entries.push(...records.filter((record): record is typeof record & { status: "confirmed"; intentHash: Hex; transactionHash: Hex; receipt: any; ourReceiptGasCost: string } => record.status === "confirmed").map(record => ({ id: record.id, intentHash: record.intentHash, transactionHash: record.transactionHash, nonce: record.outerNonce, reserved: BigInt(record.ourReceiptGasCost), status: "success" as const, receipt: record.receipt })));
  return { ...value, journal };
}

describe("ordinary USDC delayed-tier successor report", function () {
  it("reports incomplete evidence without rewriting old stopped rows", async function () {
    const fixture = await approvedDelayedSuccessor();
    const journal = attach(fixture.journal, fixture.proposal, fixture.approval);
    const report = renderReport(fixture.source, { certificate: fixture.certificate, proposal: fixture.proposal, approval: fixture.approval }, journal);
    expect(report.delayedSuccessor).to.include({ status: "DELAYED_SUCCESSOR_INCOMPLETE", actionCount: 5, terminalActionCount: 0 });
    expect(report.stoppedDelayedCompletion).to.include({ id: "usdc-delayed-completion-queue-expiry-skip", status: "signed-simulated", outerNonce: 916, transactionHash: null });
    expect(report.historicalStoppedRows).to.have.length(3);
    expect(report.historicalUntouchedRows).to.have.length(33);
    expect(report.untouchedDelayedCompletionTail).to.have.length(4);
  });

  it("requires three exact receipts, two proofs, observer evidence, and terminal 14/7/7", async function () {
    const value = terminalize(await approvedDelayedSuccessor());
    const report = renderReport(value.source, { certificate: value.certificate, proposal: value.proposal, approval: value.approval }, value.journal) as any;
    expect(report.delayedSuccessor).to.include({ status: "DELAYED_SUCCESSOR_5_OF_5_TERMINAL", successfulLiveEntryCount: 3 });
    expect(report.accounting).to.include({ newGrossUsdcOutflowUnits: "31000000", aggregateGrossUsdcOutflowUnits: "51000000", inwardUsdcFundingUnits: "0" });
    const missing = structuredClone(value.journal); delete (missing.usdcDelayedSuccessor!.actions[4] as any).receiptInclusion;
    expect(() => renderReport(value.source, { certificate: value.certificate, proposal: value.proposal, approval: value.approval }, missing)).to.throw(/inclusion|receipt/i);
    const privateProof = structuredClone(value.journal); (privateProof.usdcDelayedSuccessor!.actions[1] as any).transactionHash = hash("bad");
    expect(() => renderReport(value.source, { certificate: value.certificate, proposal: value.proposal, approval: value.approval }, privateProof)).to.throw(/proof|broadcast|private/i);
    const late = structuredClone(value.journal); (late.usdcDelayedSuccessor!.actions[4] as any).receiptInclusion.blockTimestamp = value.proposal.deadline;
    expect(() => renderReport(value.source, { certificate: value.certificate, proposal: value.proposal, approval: value.approval }, late)).to.throw(/period|deadline|inclusion/i);
    const overGas = structuredClone(value.journal); const over = overGas.usdcDelayedSuccessor!.actions[4] as any; over.receipt.gasUsed = BigInt(over.gas) + 1n; over.ourReceiptGasCost = (over.receipt.gasUsed * over.receipt.effectiveGasPrice).toString(); overGas.liveJournal.entries.at(-1)!.receipt = over.receipt; overGas.liveJournal.entries.at(-1)!.reserved = BigInt(over.ourReceiptGasCost);
    expect(() => renderReport(value.source, { certificate: value.certificate, proposal: value.proposal, approval: value.approval }, overGas)).to.throw(/gas|receipt/i);
    const fabricated = { ...value.certificate, stoppedRow: { ...value.certificate.stoppedRow, outerNonce: 999 } } as any;
    expect(() => renderReport(value.source, { certificate: fabricated, proposal: value.proposal, approval: value.approval }, value.journal)).to.throw(/certificate|opaque|context|binding/i);
    for (const mutate of [
      (journal: any) => { delete journal.usdcDelayedSuccessor.actions[2].requestHash; },
      (journal: any) => { journal.usdcDelayedSuccessor.actions[2].outerDataHash = hash("bad"); },
      (journal: any) => { delete journal.usdcDelayedSuccessor.actions[4].materializationHash; delete journal.usdcDelayedSuccessor.actions[4].prestateHash; },
      (journal: any) => { journal.usdcDelayedSuccessor.actions[1].evidenceHash = "invented"; },
    ]) { const changed = structuredClone(value.journal); mutate(changed); expect(() => renderReport(value.source, { certificate: value.certificate, proposal: value.proposal, approval: value.approval }, changed)).to.throw(/evidence|envelope|materialization|proof|missing/i); }
  });
});
