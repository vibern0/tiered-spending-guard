import { expect } from "chai";
import { createOrdinaryScenarioMechanicalExecutionContext, createOrdinaryScenarioStateReader } from "../../scripts/live/ordinary-scenario-adapter";
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

  it("proves the exact direct-above-Y row from public block-pinned policy facts without materializing", async function () {
    const f = await approvedDelayedCompletion(), view = createUsdcDelayedCompletionExecutionView(f.source, f.proposal, f.approval);
    const action = view.proposal.actions.find(candidate => candidate.id === "usdc-delayed-completion-direct-above-y-rejection")!;
    const blockHash = `0x${"a".repeat(64)}` as const, blockNumber = 12_000_000n;
    const before = action.before;
    const state = { chainId: 11_155_111, blockNumber, blockHash, blockTimestamp: BigInt(f.proposal.effectivePeriod), evidenceBasis: { kind: "current-head" as const }, planHash: view.proposal.planHash, topologyEvidenceHash: view.proposal.topologyEvidenceHash, publicIdentitiesHash: view.proposal.publicIdentitiesHash, observerReady: true, observerEvidenceHash: view.proposal.observerEvidenceHash, outerNonce: f.proposal.minimumOuterNonce, funderNativeBalance: 10n ** 18n, safeNativeBalance: BigInt(before.safeNativeBalance), funderUsdcBalance: BigInt(before.funderUsdcBalance), safeUsdcBalance: BigInt(before.safeUsdcBalance), safeNonce: BigInt(before.safeNonce), delayQueueNonce: BigInt(before.delayQueueNonce), delayTxNonce: BigInt(before.delayTxNonce), nativeSpend: { window: BigInt(f.proposal.effectivePeriod), baseSpent: BigInt(before.nativeBaseSpent), instantSpent: BigInt(before.nativeInstantSpent) }, usdcSpend: { window: BigInt(f.proposal.effectivePeriod) - 86_400n, baseSpent: BigInt(before.usdcBaseSpent), instantSpent: BigInt(before.usdcInstantSpent) }, queue: undefined, dependencies: [], fees: { maxFeePerGas: 7n, maxPriorityFeePerGas: 7n } };
    let calls = 0, signerLoads = 0;
    const client = { getBlock: async () => ({ number: blockNumber, hash: blockHash }), call: async () => { calls++; throw new Error("direct proof must not simulate a signed call"); } } as never;
    const context = createOrdinaryScenarioMechanicalExecutionContext({ expectedChainId: 11_155_111, proposal: view, journal: () => f.journal, currentClient: client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: view.proposal.observerEvidenceHash }), live: {} as never, loadSigners: async () => { signerLoads++; throw new Error("direct proof must not load signers"); }, receiverReadyAt: new Date(Number(BigInt(f.proposal.observer.readyAt)) * 1000).toISOString(), receiverExpiresAt: new Date(Number(BigInt(f.proposal.observer.expiresAt)) * 1000).toISOString() }, async () => state);
    const proof = await context.proveRejection(action, state);
    expect(proof).to.include({ success: false, proofKind: "public-policy-bound" });
    expect(calls).to.equal(0); expect(signerLoads).to.equal(0);
  });
});
