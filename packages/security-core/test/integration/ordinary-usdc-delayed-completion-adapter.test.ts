import { expect } from "chai";
import { createOrdinaryScenarioStateReader } from "../../scripts/live/ordinary-scenario-adapter";
import { createUsdcDelayedCompletionExecutionView } from "../../scripts/live/ordinary-scenario-executor";
import { cleanupUsdcRecycleContinuationFixtures } from "../support/usdc-recycle-continuation-fixture";
import { approvedDelayedCompletion } from "../support/usdc-delayed-completion-fixture";

describe("ordinary USDC delayed-completion adapter", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);
  it("accepts the closed delayed-completion execution view", async function () {
    const f = await approvedDelayedCompletion();
    const view = createUsdcDelayedCompletionExecutionView(f.source, f.proposal, f.approval);
    expect(() => createOrdinaryScenarioStateReader({ repository: process.cwd(), proposal: view, journal: () => f.journal, currentClient: {} as never, archiveClient: {} as never, observerReadiness: async () => ({ ready: true, evidenceHash: f.proposal.observer.probeEvidenceHash }) })).not.to.throw();
  });
});
