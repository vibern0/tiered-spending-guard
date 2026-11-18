import { expect } from "chai";
import { createOrdinaryScenarioMechanicalExecutionContext, createOrdinaryScenarioStateReader, normalizeOrdinaryScenarioAdapterInputForTestsOnly } from "../../scripts/live/ordinary-scenario-adapter";
import { createUsdcDelayedSuccessorExecutionViewForTestsOnly as createView } from "../../scripts/live/ordinary-scenario-executor";
import { attachUsdcDelayedSuccessorForTestsOnly as attach } from "../../scripts/live/ordinary-scenario-usdc-delayed-successor-proposal";
import { approvedDelayedSuccessor } from "../support/usdc-delayed-successor-fixture";

describe("ordinary USDC delayed-tier successor adapter", function () {
  it("accepts the closed successor execution view", async function () {
    const fixture = await approvedDelayedSuccessor();
    attach(fixture.journal, fixture.proposal, fixture.approval);
    const view = createView(fixture.source, fixture.proposal, fixture.approval);
    expect(() => createOrdinaryScenarioStateReader({ repository: process.cwd(), proposal: view, journal: () => fixture.journal, currentClient: {} as never, archiveClient: {} as never, observerReadiness: async () => ({ ready: true, evidenceHash: fixture.proposal.observer.probeEvidenceHash }) })).not.to.throw();
    const normalized = normalizeOrdinaryScenarioAdapterInputForTestsOnly({ proposal: view, journal: () => fixture.journal });
    expect(normalized.journal().actions).to.have.length(14);
    expect(normalized.journal().actions.some(action => action.id === "usdc-delayed-completion-queue-expiry")).to.equal(true);
    expect(() => createOrdinaryScenarioMechanicalExecutionContext({ expectedChainId: 11_155_111, proposal: view, journal: () => fixture.journal, currentClient: {} as never, archiveClient: {} as never, observerReadiness: async () => ({ ready: true, evidenceHash: fixture.proposal.observer.probeEvidenceHash }), live: {} as never, loadSigners: async () => { throw new Error("unused"); } }, async () => { throw new Error("unused"); })).to.throw(/observer ready|expiry forwarding/i);
    expect(() => createOrdinaryScenarioMechanicalExecutionContext({ expectedChainId: 11_155_111, proposal: view, journal: () => fixture.journal, currentClient: {} as never, archiveClient: {} as never, observerReadiness: async () => ({ ready: true, evidenceHash: fixture.proposal.observer.probeEvidenceHash }), live: {} as never, loadSigners: async () => { throw new Error("unused"); }, receiverReadyAt: new Date(Number(BigInt(fixture.proposal.observer.readyAt)) * 1000).toISOString(), receiverExpiresAt: new Date(Number(BigInt(fixture.proposal.observer.expiresAt)) * 1000).toISOString() }, async () => { throw new Error("unused"); })).not.to.throw();
  });
});
