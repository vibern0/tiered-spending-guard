import { expect } from "chai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOrdinaryScenarioProposal } from "../../scripts/live/ordinary-scenario-executor";
import { createOrdinaryScenarioMechanicalExecutionContext } from "../../scripts/live/ordinary-scenario-adapter";

describe("ordinary scenario expired hashless adapter", function () {
  it("actual_adapter_uses_closed_lineage", function () {
    const forged = { kind: "expired-hashless-continuation-v1", original: {}, continuation: {}, proposal: {} };
    expect(() => createOrdinaryScenarioMechanicalExecutionContext({ proposal: forged } as never, (() => undefined) as never)).to.throw(/closed/i);
  });

  it("durable_hash_precedes_one_broadcast", function () {
    const report = readFileSync(join(__dirname, "../fixtures/ordinary-scenario-review.public.json"), "utf8");
    const proposal = createOrdinaryScenarioProposal(report, { expectedPackageHash: "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", expectedArtifactBytesHash: "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831" });
    const context = createOrdinaryScenarioMechanicalExecutionContext({ proposal, journal: () => ({ actions: [] }) } as never, (() => undefined) as never);
    expect(context.materialize).to.be.a("function");
    expect(context.recoverPending).to.be.a("function");
  });
});
