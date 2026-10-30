import { expect } from "chai";
import { renderUsdcDelayedCompletionReport } from "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-report";
import { attachUsdcDelayedCompletion } from "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-proposal";
import { cleanupUsdcRecycleContinuationFixtures } from "../../support/usdc-recycle-continuation-fixture";
import { approvedDelayedCompletion } from "../../support/usdc-delayed-completion-fixture";

describe("ordinary USDC delayed-completion report", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);
  it("renders an evidence-only incomplete report without side effects", async function () {
    const f = await approvedDelayedCompletion();
    const journal = attachUsdcDelayedCompletion(f.journal, f.proposal, f.approval);
    const report = renderUsdcDelayedCompletionReport(f.source, { certificate: f.certificate, proposal: f.proposal, approval: f.approval }, journal);
    expect(report.delayedCompletion).to.include({ status: "DELAYED_COMPLETION_INCOMPLETE", actionCount: 13, terminalActionCount: 0 });
    expect(report.provenance).to.include({ rpcReadsPerformedByRenderer: false, signing: false, broadcast: false });
  });
});
