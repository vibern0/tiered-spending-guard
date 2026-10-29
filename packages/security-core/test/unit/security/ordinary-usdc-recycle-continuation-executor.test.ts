import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { keccak256, type Hex } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import { liveIntentHash } from "../../../scripts/live/submission";
import {
  createOrdinaryScenarioStore,
  createUsdcRecycleContinuationExecutionView,
  executeUsdcRecycleContinuationAction,
  resolveOrdinaryScenarioExecutionProposal,
  selectExpiredHashlessContinuationSubmissionAction,
  selectUsdcSuccessorSubmissionAction,
  selectUsdcRecycleContinuationSubmissionAction,
  type CanonicalOrdinaryScenarioState,
  type OrdinaryScenarioExecutionContext,
} from "../../../scripts/live/ordinary-scenario-executor";
import {
  cleanupUsdcRecycleContinuationFixtures,
  createApprovedUsdcRecycleContinuation,
  recycleSnapshot,
} from "../../support/usdc-recycle-continuation-fixture";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;

describe("ordinary USDC recycle continuation executor", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  function state(f: Awaited<ReturnType<typeof createApprovedUsdcRecycleContinuation>>, outerNonce = f.proposal.minimumOuterNonce): CanonicalOrdinaryScenarioState {
    const before = f.proposal.actions[0]!.before;
    const proposalAction = f.source.prior.recovery.actions.find(action => action.kind === "queue-proposal" && action.queue?.queueNonce === before.queueNonce && action.queue.fingerprint === before.queueFingerprint)!;
    const reviewedQueue = proposalAction.queue!;
    const queueRecord = f.source.prior.journal.hashlessContinuation!.actions.find(action => action.id === proposalAction.id)! as any;
    const oldStepUp = f.source.prior.journal.usdcSuccessor!.actions[1]! as any;
    return {
      chainId: 11_155_111, blockNumber: recycleSnapshot.number + 10n, blockHash: h("d"), blockTimestamp: BigInt(f.proposal.deadline) - 9_000n,
      evidenceBasis: { kind: "current-head" }, planHash: f.source.prior.original.planHash, topologyEvidenceHash: f.source.prior.original.topologyEvidenceHash,
      publicIdentitiesHash: f.source.prior.original.publicIdentitiesHash, observerReady: true, observerEvidenceHash: f.proposal.observer.probeEvidenceHash,
      outerNonce, funderNativeBalance: 10n ** 18n, safeNativeBalance: BigInt(before.safeNativeBalance), funderUsdcBalance: BigInt(before.funderUsdcBalance),
      safeUsdcBalance: BigInt(before.safeUsdcBalance), safeNonce: BigInt(before.safeNonce), delayQueueNonce: BigInt(before.delayQueueNonce), delayTxNonce: BigInt(before.delayTxNonce),
      nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n },
      usdcSpend: { window: 1_793_232_000n, baseSpent: BigInt(before.usdcBaseSpent), instantSpent: BigInt(before.usdcInstantSpent) },
      queue: { queueNonce: BigInt(reviewedQueue.queueNonce), fingerprint: reviewedQueue.fingerprint, createdAt: BigInt(queueRecord.queueCreatedAt!), status: "executed", to: reviewedQueue.to, value: BigInt(reviewedQueue.value), data: reviewedQueue.data, operation: 0 },
      dependencies: [{ actionId: "usdc-successor-step-up-contract", transactionHash: oldStepUp.transactionHash, evidenceHash: oldStepUp.evidenceHash }],
      fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    };
  }

  it("projects the immutable old two plus the exact new 17 and selects only the new head", async function () {
    const f = await createApprovedUsdcRecycleContinuation();
    const view = createUsdcRecycleContinuationExecutionView(f.source, f.proposal, f.approval);
    expect(view.kind).to.equal("usdc-recycle-continuation-v1");
    expect(resolveOrdinaryScenarioExecutionProposal(view).actions.map(action => action.id)).to.deep.equal([
      ...f.source.prior.recovery.actions.slice(0, 3).map(action => action.id),
      ...f.source.priorProposal.actions.slice(0, 2).map(action => action.id),
      ...f.proposal.actions.map(action => action.id),
    ]);
    expect(selectUsdcRecycleContinuationSubmissionAction(f.source, f.proposal, f.approval, f.journal).id).to.equal("usdc-recycle-continuation-recycle-topup-step-up");
    expect(() => selectExpiredHashlessContinuationSubmissionAction(f.source.prior.original, f.source.prior.recovery, f.source.prior.recoveryApproval, f.journal)).to.throw(/frozen|recycle continuation sibling/i);
    expect(() => selectUsdcSuccessorSubmissionAction(f.source.prior, f.source.priorProposal, f.source.priorApproval, f.journal)).to.throw(/frozen|recycle continuation sibling/i);
    expect(() => createUsdcRecycleContinuationExecutionView(f.source, f.proposal, { ...f.approval } as never)).to.throw(/opaque|bound|authorization/i);
  });

  it("round-trips the exact sibling and rejects removal, prefix mutation, and stale reopen", async function () {
    const f = await createApprovedUsdcRecycleContinuation();
    const directory = mkdtempSync(join(tmpdir(), "usdc-recycle-executor-")); const path = join(directory, "journal.json");
    const identity = { proposalHash: f.journal.proposalHash, approvalHash: f.journal.approvalHash, funder: f.journal.funder };
    try {
      const store = createOrdinaryScenarioStore(path, identity, () => f.journal); store.save(f.journal);
      const bytes = readFileSync(path, "utf8");
      expect(store.load().usdcRecycleContinuation?.minimumOuterNonce).to.equal(870);
      const removed = store.load(); delete removed.usdcRecycleContinuation;
      expect(() => store.save(removed)).to.throw(/recycle continuation.*deleted|immutable|cannot be deleted/i);
      const changed = store.load(); (changed.usdcSuccessor!.actions[2]! as any).status = "approved";
      expect(() => store.save(changed)).to.throw(/frozen source|prefix|successor/i);
      expect(readFileSync(path, "utf8")).to.equal(bytes);
      store.close?.();
      const reopened = createOrdinaryScenarioStore(path, identity, () => { throw new Error("must reopen"); });
      expect(reopened.load().usdcRecycleContinuation?.actions).to.have.length(17); reopened.close?.();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("accepts a newer agreed nonce before materialization and freezes one new row only", async function () {
    const f = await createApprovedUsdcRecycleContinuation(); const current = state(f, 901); let materializations = 0;
    const directory = mkdtempSync(join(tmpdir(), "usdc-recycle-nonce-")); const path = join(directory, "journal.json");
    const store = createOrdinaryScenarioStore(path, { proposalHash: f.journal.proposalHash, approvalHash: f.journal.approvalHash, funder: f.journal.funder }, () => f.journal);
    try {
      const context = {
        readState: async () => current,
        materialize: async () => { materializations++; throw new Error("private interruption"); },
        now: () => new Date(Number((BigInt(f.proposal.deadline) - 9_000n) * 1000n)),
      } as unknown as OrdinaryScenarioExecutionContext;
      await expect(executeUsdcRecycleContinuationAction(f.source, f.proposal, f.approval, store, context)).to.be.rejectedWith("private interruption");
      expect(materializations).to.equal(1);
      expect(store.load().usdcSuccessor!.actions[2]!.status).to.equal("signed-simulated");
      expect(store.load().usdcRecycleContinuation!.actions[0]!.status).to.equal("materialized");
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects a nonce below the persisted minimum before private materialization", async function () {
    const f = await createApprovedUsdcRecycleContinuation(901); let materializations = 0;
    const context = { readState: async () => state(f, 900), materialize: async () => { materializations++; throw new Error("must not materialize"); }, now: () => new Date(Number((BigInt(f.proposal.deadline) - 9_000n) * 1000n)) } as unknown as OrdinaryScenarioExecutionContext;
    await expect(executeUsdcRecycleContinuationAction(f.source, f.proposal, f.approval, { load: () => f.journal, save: () => undefined }, context)).to.be.rejectedWith(/minimum outer nonce|checkpoint/i);
    expect(materializations).to.equal(0);
  });

  it("reconciles one durable known hash after the deadline without keys, proof, alert, or rebroadcast", async function () {
    const f = await createApprovedUsdcRecycleContinuation(); const action = f.proposal.actions[0]!; const transactionHash = h("e");
    const intent = { id: action.id, to: action.transaction.to, value: BigInt(action.transaction.value), data: action.transaction.data, nonce: 901, gas: BigInt(action.gasLimitCap), maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    const facts = { proposalHash: f.proposal.proposalHash, actionCommitment: action.commitment, outerNonce: intent.nonce, gas: intent.gas.toString(), gasEstimate: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", pinnedBlockNumber: (recycleSnapshot.number + 10n).toString(), pinnedBlockHash: h("d"), approvedContinuationReservationWei: f.proposal.reservation.continuationMaximumReservationWei, remainingReservationWei: f.proposal.reservation.continuationMaximumReservationWei };
    const journal = structuredClone(f.journal); const storage = journal.usdcRecycleContinuation! as any;
    storage.actions[0] = { id: action.id, commitment: action.commitment, status: "outer-pending", materializationHash: h("3"), finalOuterMaterialization: { hash: sha256(facts), ...facts }, prestateHash: h("1"), outerNonce: intent.nonce, gas: intent.gas.toString(), maxFeePerGas: "1", maxPriorityFeePerGas: "1", requestHash: action.commitment, signatureBundleHash: null, signedCalldataHash: keccak256(intent.data), simulationEvidenceHash: h("2"), intentHash: liveIntentHash(intent, journal.funder), transactionHash, outerTo: intent.to, outerValue: intent.value.toString(), outerDataHash: keccak256(intent.data), funderNativeBefore: (10n ** 18n).toString() };
    journal.liveJournal.entries.push({ id: action.id, intentHash: storage.actions[0].intentHash, transactionHash, nonce: intent.nonce, reserved: intent.gas, status: "pending" });
    const directory = mkdtempSync(join(tmpdir(), "usdc-recycle-keyless-")); const path = join(directory, "journal.json"); const store = createOrdinaryScenarioStore(path, { proposalHash: journal.proposalHash, approvalHash: journal.approvalHash, funder: journal.funder }, () => journal);
    let privateCalls = 0, broadcasts = 0, alerts = 0;
    const context = { recoverPending: async () => intent, proveRejection: async () => { privateCalls++; throw new Error("no new proof"); }, confirm: async () => { alerts++; throw new Error("no alert"); }, now: () => new Date(Number((BigInt(f.proposal.deadline) + 1n) * 1000n)), live: { funder: journal.funder, chainId: async () => 11_155_111, nonce: async () => 902, balance: async () => 0n, sign: async () => { privateCalls++; throw new Error("no key"); }, broadcast: async () => { broadcasts++; throw new Error("no rebroadcast"); }, receipt: async () => undefined } } as unknown as OrdinaryScenarioExecutionContext;
    try {
      expect(await executeUsdcRecycleContinuationAction(f.source, f.proposal, f.approval, store, context)).to.deep.equal({ status: "PENDING", actionId: action.id });
      expect({ privateCalls, broadcasts, alerts }).to.deep.equal({ privateCalls: 0, broadcasts: 0, alerts: 0 });
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("stops only the new row when the frozen materialization block is proven reorged", async function () {
    const f = await createApprovedUsdcRecycleContinuation(); const action = f.proposal.actions[0]!; const current = state(f, 901); let reads = 0, privateSigns = 0;
    const directory = mkdtempSync(join(tmpdir(), "usdc-recycle-reorg-")); const path = join(directory, "journal.json"); const store = createOrdinaryScenarioStore(path, { proposalHash: f.journal.proposalHash, approvalHash: f.journal.approvalHash, funder: f.journal.funder }, () => f.journal);
    const liveIntent = { id: action.id, to: action.transaction.to, value: BigInt(action.transaction.value), data: action.transaction.data, nonce: current.outerNonce, gas: BigInt(action.gasLimitCap), maxFeePerGas: current.fees.maxFeePerGas, maxPriorityFeePerGas: current.fees.maxPriorityFeePerGas };
    const context = {
      readState: async () => { if (reads++ === 0) return current; throw new Error("USDC recycle continuation frozen materialization block changed"); },
      materialize: async () => ({ liveIntent, requestHash: action.commitment, signerRolesHash: sha256(action.signerRoles), signedCalldataHash: keccak256(liveIntent.data), signatureBundleHash: null, transientSignedCalldata: liveIntent.data }),
      simulate: async () => ({ blockNumber: current.blockNumber, blockHash: current.blockHash, success: true, gasEstimate: 1n, resultHash: h("4") }),
      now: () => new Date(Number((BigInt(f.proposal.deadline) - 9_000n) * 1000n)),
      live: { funder: f.journal.funder, chainId: async () => 11_155_111, nonce: async () => current.outerNonce, balance: async () => current.funderNativeBalance, sign: async () => { privateSigns++; throw new Error("must not sign after reorg proof"); }, broadcast: async () => { throw new Error("must not broadcast"); }, receipt: async (hash: Hex) => store.load().liveJournal.entries.find(entry => entry.transactionHash === hash)?.receipt },
    } as unknown as OrdinaryScenarioExecutionContext;
    try {
      await expect(executeUsdcRecycleContinuationAction(f.source, f.proposal, f.approval, store, context)).to.be.rejectedWith("frozen materialization block changed");
      expect(privateSigns).to.equal(0);
      expect(store.load().usdcRecycleContinuation!.actions[0]!.status).to.equal("stopped");
      expect(store.load().usdcSuccessor!.actions[2]!.status).to.equal("signed-simulated");
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });
});
