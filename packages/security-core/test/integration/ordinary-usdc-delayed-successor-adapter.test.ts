import { expect } from "chai";
import { createOrdinaryScenarioStateReader } from "../../scripts/live/ordinary-scenario-adapter";
import { createUsdcDelayedSuccessorExecutionViewForTestsOnly as createView } from "../../scripts/live/ordinary-scenario-executor";
import { approvedDelayedSuccessor } from "../support/usdc-delayed-successor-fixture";

describe("ordinary USDC delayed-tier successor adapter", function () {
  it("accepts the closed successor execution view", async function () {
    const fixture = await approvedDelayedSuccessor();
    const view = createView(fixture.source, fixture.proposal, fixture.approval);
    expect(() => createOrdinaryScenarioStateReader({ repository: process.cwd(), proposal: view, journal: () => fixture.journal, currentClient: {} as never, archiveClient: {} as never, observerReadiness: async () => ({ ready: true, evidenceHash: fixture.proposal.observer.probeEvidenceHash }) })).not.to.throw();
  });
});
