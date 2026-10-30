import { expect } from "chai";
import {
  createOrdinaryScenarioStore,
  createUsdcDelayedCompletionExecutionView as createProductionUsdcDelayedCompletionExecutionView,
  createUsdcDelayedCompletionExecutionViewForTestsOnly as createUsdcDelayedCompletionExecutionView,
  executeUsdcDelayedCompletionActionForTestsOnly as executeUsdcDelayedCompletionAction,
  selectUsdcDelayedCompletionSubmissionActionForTestsOnly as selectUsdcDelayedCompletionSubmissionAction,
  type CanonicalOrdinaryScenarioState,
  type OrdinaryScenarioExecutionContext,
} from "../../../scripts/live/ordinary-scenario-executor";
import { attachUsdcDelayedCompletionForTestsOnly as attachUsdcDelayedCompletion } from "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-proposal";
import { cleanupUsdcRecycleContinuationFixtures } from "../../support/usdc-recycle-continuation-fixture";
import { approvedDelayedCompletion } from "../../support/usdc-delayed-completion-fixture";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";

describe("ordinary USDC delayed-completion executor", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);
  it("rejects test-only certificate/proposal authority at the production execution boundary", async function () {
    const f = await approvedDelayedCompletion();
    expect(() => createProductionUsdcDelayedCompletionExecutionView(f.source, f.proposal, f.approval)).to.throw(/production authorization|opaque|bound/i);
  });
  it("projects only the new sibling and selects one exact approved row", async function () {
    const f = await approvedDelayedCompletion();
    const attached = attachUsdcDelayedCompletion(f.journal, f.proposal, f.approval);
    const view = createUsdcDelayedCompletionExecutionView(f.source, f.proposal, f.approval);
    expect(view.proposal.actions.filter(action => action.id.startsWith("usdc-delayed-completion-"))).to.have.length(13);
    expect(selectUsdcDelayedCompletionSubmissionAction(f.source, f.proposal, f.approval, attached).id).to.equal("usdc-delayed-completion-prefund-all");
  });

  it("round-trips the sole sibling through the atomic journal store", async function () {
    const f = await approvedDelayedCompletion();
    const attached = attachUsdcDelayedCompletion(f.journal, f.proposal, f.approval);
    const directory = mkdtempSync(join(tmpdir(), "usdc-delayed-completion-"));
    const store = createOrdinaryScenarioStore(join(directory, "journal.json"), { proposalHash: attached.proposalHash, approvalHash: attached.approvalHash, funder: attached.funder }, () => attached);
    try {
      const loaded = store.load();
      expect(loaded.usdcDelayedCompletion?.actions).to.have.length(13);
      expect(selectUsdcDelayedCompletionSubmissionAction(f.source, f.proposal, f.approval, loaded).id).to.equal("usdc-delayed-completion-prefund-all");
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects delayed header replacement and multiple-row progress in one atomic save", async function () {
    const f = await approvedDelayedCompletion();
    const attached = attachUsdcDelayedCompletion(f.journal, f.proposal, f.approval);
    const directory = mkdtempSync(join(tmpdir(), "usdc-delayed-monotonic-"));
    const store = createOrdinaryScenarioStore(join(directory, "journal.json"), { proposalHash: attached.proposalHash, approvalHash: attached.approvalHash, funder: attached.funder }, () => attached);
    try {
      const header = store.load(); (header.usdcDelayedCompletion as any).maximumReservationWei = "1";
      expect(() => store.save(header)).to.throw(/delayed completion.*header|immutable header/i);
      const multiple = store.load();
      for (const index of [0, 1]) multiple.usdcDelayedCompletion!.actions[index] = { ...multiple.usdcDelayedCompletion!.actions[index]!, status: "materialized" } as any;
      expect(() => store.save(multiple)).to.throw(/only one selected row|multiple|selected catalog head/i);
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("proves direct above-Y rejection without private materialization, signing, or broadcast", async function () {
    const f = await approvedDelayedCompletion(); const journal = attachUsdcDelayedCompletion(f.journal, f.proposal, f.approval); const view = createUsdcDelayedCompletionExecutionView(f.source, f.proposal, f.approval);
    const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex, delayed = f.proposal.actions, attached = journal.usdcDelayedCompletion.actions;
    const receipt = { transactionHash: h("2"), status: "success" as const, gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 12_026_900n, blockHash: h("3") };
    attached[0] = { id: delayed[0]!.id, commitment: delayed[0]!.commitment, status: "confirmed", intentHash: h("1"), transactionHash: receipt.transactionHash, evidenceHash: h("4"), receipt } as any;
    journal.liveJournal.entries.push({ id: delayed[0]!.id, intentHash: h("1"), transactionHash: receipt.transactionHash, nonce: 906, reserved: 1n, status: "success", receipt });
    const action = view.proposal.actions.find(candidate => candidate.id === delayed[1]!.id)!, before = action.before;
    const state: CanonicalOrdinaryScenarioState = { chainId: 11_155_111, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, blockTimestamp: 1_793_365_200n, evidenceBasis: { kind: "current-head" }, planHash: view.proposal.planHash, topologyEvidenceHash: view.proposal.topologyEvidenceHash, publicIdentitiesHash: view.proposal.publicIdentitiesHash, observerReady: true, observerEvidenceHash: view.proposal.observerEvidenceHash, outerNonce: 907, funderNativeBalance: 10n ** 18n, safeNativeBalance: 0n, funderUsdcBalance: BigInt(before.funderUsdcBalance), safeUsdcBalance: BigInt(before.safeUsdcBalance), safeNonce: BigInt(before.safeNonce), delayQueueNonce: BigInt(before.delayQueueNonce), delayTxNonce: BigInt(before.delayTxNonce), nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: 1_793_232_000n, baseSpent: 10_000_000n, instantSpent: 20_000_000n }, dependencies: [{ actionId: delayed[0]!.id, transactionHash: receipt.transactionHash, evidenceHash: h("4") }], fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } };
    let materialize = 0, sign = 0, broadcast = 0;
    const context = { readState: async () => state, materialize: async () => { materialize++; throw new Error("direct proof must not materialize"); }, proveRejection: async (_action: unknown, _state: unknown, prepared: unknown) => { expect(prepared).to.equal(undefined); return { success: false as const, blockNumber: state.blockNumber, blockHash: state.blockHash, revertDataHash: h("5"), postState: state }; }, now: () => new Date(Number(state.blockTimestamp * 1000n)), live: { sign: async () => { sign++; throw new Error("proof must not sign"); }, broadcast: async () => { broadcast++; throw new Error("proof must not broadcast"); } } } as unknown as OrdinaryScenarioExecutionContext;
    const result = await executeUsdcDelayedCompletionAction(f.source, f.proposal, f.approval, { load: () => journal, save: () => undefined }, context);
    expect(result).to.deep.equal({ status: "REJECTION_PROVED", actionId: delayed[1]!.id }); expect({ materialize, sign, broadcast }).to.deep.equal({ materialize: 0, sign: 0, broadcast: 0 });
  });

  it("proves an early rejection without signing or broadcasting and preserves stale counters", async function () {
    const f = await approvedDelayedCompletion(); const journal = attachUsdcDelayedCompletion(f.journal, f.proposal, f.approval); const view = createUsdcDelayedCompletionExecutionView(f.source, f.proposal, f.approval);
    const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex, delayed = f.proposal.actions, attached = journal.usdcDelayedCompletion.actions;
    attached[0] = { id: delayed[0]!.id, commitment: delayed[0]!.commitment, status: "confirmed", intentHash: h("1"), transactionHash: h("2"), evidenceHash: h("3") } as any;
    attached[1] = { id: delayed[1]!.id, commitment: delayed[1]!.commitment, status: "rejection-proved", evidenceHash: h("4") } as any;
    const receipt = { transactionHash: h("6"), status: "success" as const, gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 12_026_900n, blockHash: h("7") };
    attached[2] = { id: delayed[2]!.id, commitment: delayed[2]!.commitment, status: "confirmed", intentHash: h("5"), transactionHash: receipt.transactionHash, evidenceHash: h("8"), receipt, queueCreatedAt: "1793365200" } as any;
    journal.liveJournal.entries.push({ id: delayed[0]!.id, intentHash: h("1"), transactionHash: h("2"), nonce: 871, reserved: 1n, status: "success" }, { id: delayed[2]!.id, intentHash: h("5"), transactionHash: receipt.transactionHash, nonce: 872, reserved: 1n, status: "success", receipt });
    const action = view.proposal.actions.find(candidate => candidate.id === delayed[3]!.id)!, before = action.before;
    const state: CanonicalOrdinaryScenarioState = { chainId: 11_155_111, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, blockTimestamp: 1_793_365_200n, evidenceBasis: { kind: "queue-receipt", proposalActionId: delayed[2]!.id, transactionHash: receipt.transactionHash }, planHash: view.proposal.planHash, topologyEvidenceHash: view.proposal.topologyEvidenceHash, publicIdentitiesHash: view.proposal.publicIdentitiesHash, observerReady: true, observerEvidenceHash: view.proposal.observerEvidenceHash, outerNonce: 908, funderNativeBalance: 10n ** 18n, safeNativeBalance: 0n, funderUsdcBalance: BigInt(before.funderUsdcBalance), safeUsdcBalance: BigInt(before.safeUsdcBalance), safeNonce: BigInt(before.safeNonce), delayQueueNonce: BigInt(before.delayQueueNonce), delayTxNonce: BigInt(before.delayTxNonce), nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: 1_793_232_000n, baseSpent: 10_000_000n, instantSpent: 20_000_000n }, queue: { queueNonce: action.queue!.queueNonce, fingerprint: action.queue!.fingerprint, createdAt: 1_793_365_200n, status: "queued", to: action.queue!.to, value: action.queue!.value, data: action.queue!.data, operation: 0 }, dependencies: [{ actionId: delayed[2]!.id, transactionHash: receipt.transactionHash, evidenceHash: h("8") }], fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } };
    let materialize = 0, sign = 0, broadcast = 0;
    const context = { readState: async () => state, materialize: async () => { materialize++; throw new Error("proof must not materialize"); }, proveRejection: async () => ({ success: false as const, blockNumber: state.blockNumber, blockHash: state.blockHash, revertDataHash: h("9"), postState: state }), now: () => new Date(Number(state.blockTimestamp * 1000n)), live: { sign: async () => { sign++; throw new Error("proof must not sign"); }, broadcast: async () => { broadcast++; throw new Error("proof must not broadcast"); } } } as unknown as OrdinaryScenarioExecutionContext;
    const result = await executeUsdcDelayedCompletionAction(f.source, f.proposal, f.approval, { load: () => journal, save: () => undefined }, context);
    expect(result).to.deep.equal({ status: "REJECTION_PROVED", actionId: delayed[3]!.id }); expect({ materialize, sign, broadcast }).to.deep.equal({ materialize: 0, sign: 0, broadcast: 0 });
  });
});
