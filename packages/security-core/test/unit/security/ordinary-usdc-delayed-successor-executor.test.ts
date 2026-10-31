import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import {
  assertUsdcDelayedSuccessorJournalForTestsOnly,
  createOrdinaryScenarioStore,
  createUsdcDelayedSuccessorExecutionView as createProductionView,
  createUsdcDelayedSuccessorExecutionViewForTestsOnly as createView,
  executeUsdcDelayedSuccessorActionForTestsOnly as executeAction,
  selectUsdcDelayedSuccessorSubmissionActionForTestsOnly as selectAction,
  type CanonicalOrdinaryScenarioState,
  type OrdinaryScenarioExecutionContext,
} from "../../../scripts/live/ordinary-scenario-executor";
import { attachUsdcDelayedSuccessorForTestsOnly as attach } from "../../../scripts/live/ordinary-scenario-usdc-delayed-successor-proposal";
import { approvedDelayedSuccessor } from "../../support/usdc-delayed-successor-fixture";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;

describe("ordinary USDC delayed-tier successor executor", function () {
  it("keeps test authority outside the production execution view", async function () {
    const fixture = await approvedDelayedSuccessor();
    expect(() => createProductionView(fixture.source, fixture.proposal, fixture.approval)).to.throw(/production|opaque|authorization/i);
  });

  it("projects the five-row sibling and selects only its first approved row", async function () {
    const fixture = await approvedDelayedSuccessor();
    const journal = attach(fixture.journal, fixture.proposal, fixture.approval);
    const view = createView(fixture.source, fixture.proposal, fixture.approval);
    expect(view.proposal.actions.filter(action => action.id.startsWith("usdc-delayed-successor-"))).to.have.length(5);
    expect(selectAction(fixture.source, fixture.proposal, fixture.approval, journal).id).to.equal("usdc-delayed-successor-skip-expired");
    assertUsdcDelayedSuccessorJournalForTestsOnly(journal, fixture.source, fixture.proposal, fixture.approval);
  });

  it("round-trips one sibling and rejects header or predecessor replacement", async function () {
    const fixture = await approvedDelayedSuccessor();
    const journal = attach(fixture.journal, fixture.proposal, fixture.approval);
    const directory = mkdtempSync(join(tmpdir(), "usdc-delayed-successor-"));
    const store = createOrdinaryScenarioStore(join(directory, "journal.json"), { proposalHash: journal.proposalHash, approvalHash: journal.approvalHash, funder: journal.funder }, () => journal);
    try {
      expect(store.load().usdcDelayedSuccessor?.actions).to.have.length(5);
      const changedHeader = store.load(); (changedHeader.usdcDelayedSuccessor as any).maximumReservationWei = "1";
      expect(() => store.save(changedHeader)).to.throw(/successor.*header|immutable header/i);
      const changedOld = store.load(); (changedOld.usdcDelayedCompletion!.actions[0] as any).evidenceHash = h("f");
      expect(() => store.save(changedOld)).to.throw(/frozen source|predecessor|fixed field/i);
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("proves expired execution rejection without materializing, signing, or broadcasting", async function () {
    const fixture = await approvedDelayedSuccessor();
    const journal = attach(fixture.journal, fixture.proposal, fixture.approval);
    const first = fixture.proposal.actions[0]!, receipt = { transactionHash: h("1"), status: "success" as const, gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 12_030_000n, blockHash: h("2") };
    journal.usdcDelayedSuccessor.actions[0] = { id: first.id, commitment: first.commitment, status: "confirmed", intentHash: h("3"), transactionHash: receipt.transactionHash, evidenceHash: h("4"), receipt, queueCreatedAt: "1793364000" } as any;
    journal.liveJournal.entries.push({ id: first.id, intentHash: h("3"), transactionHash: receipt.transactionHash, nonce: 917, reserved: 1n, status: "success", receipt });
    const action = fixture.proposal.actions[1]!, before = action.before;
    const state: CanonicalOrdinaryScenarioState = {
      chainId: 11_155_111,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      blockTimestamp: 1_793_365_100n,
      evidenceBasis: { kind: "current-head" },
      planHash: createView(fixture.source, fixture.proposal, fixture.approval).proposal.planHash,
      topologyEvidenceHash: createView(fixture.source, fixture.proposal, fixture.approval).proposal.topologyEvidenceHash,
      publicIdentitiesHash: createView(fixture.source, fixture.proposal, fixture.approval).proposal.publicIdentitiesHash,
      observerReady: true,
      observerEvidenceHash: fixture.proposal.observer.probeEvidenceHash,
      outerNonce: 918,
      funderNativeBalance: 10n ** 18n,
      safeNativeBalance: 0n,
      funderUsdcBalance: BigInt(before.funderUsdcBalance),
      safeUsdcBalance: BigInt(before.safeUsdcBalance),
      safeNonce: BigInt(before.safeNonce),
      delayQueueNonce: BigInt(before.delayQueueNonce),
      delayTxNonce: BigInt(before.delayTxNonce),
      nativeSpend: { window: fixture.certificate.rawNativeSpend.window, baseSpent: BigInt(before.nativeBaseSpent), instantSpent: BigInt(before.nativeInstantSpent) },
      usdcSpend: { window: fixture.certificate.rawUsdcSpend.window, baseSpent: BigInt(before.usdcBaseSpent), instantSpent: BigInt(before.usdcInstantSpent) },
      queue: { queueNonce: 5n, fingerprint: action.queue!.fingerprint, createdAt: 1_793_364_000n, status: "expired", to: action.queue!.to, value: 0n, data: action.queue!.data, operation: 0 },
      dependencies: [{ actionId: first.id, transactionHash: receipt.transactionHash, evidenceHash: h("4") }],
      fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    };
    let materialize = 0, sign = 0, broadcast = 0;
    const context = {
      readState: async () => state,
      materialize: async () => { materialize++; throw new Error("proof must not materialize"); },
      proveRejection: async () => ({ success: false as const, blockNumber: state.blockNumber, blockHash: state.blockHash, revertDataHash: h("5"), postState: state }),
      now: () => new Date(Number(state.blockTimestamp * 1000n)),
      live: { sign: async () => { sign++; throw new Error("proof must not sign"); }, broadcast: async () => { broadcast++; throw new Error("proof must not broadcast"); } },
    } as unknown as OrdinaryScenarioExecutionContext;
    const result = await executeAction(fixture.source, fixture.proposal, fixture.approval, { load: () => journal, save: () => undefined }, context);
    expect(result).to.deep.equal({ status: "REJECTION_PROVED", actionId: action.id });
    expect({ materialize, sign, broadcast }).to.deep.equal({ materialize: 0, sign: 0, broadcast: 0 });
  });
});
