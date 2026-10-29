import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { keccak256 } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import {
  createOrdinaryScenarioStore,
  createUsdcSuccessorExecutionView,
  executeUsdcSuccessorAction,
  resolveOrdinaryScenarioExecutionProposal,
  selectUsdcSuccessorSubmissionAction,
  type CanonicalOrdinaryScenarioState,
  type OrdinaryScenarioExecutionContext,
  type OrdinaryScenarioActionRecord,
} from "../../../scripts/live/ordinary-scenario-executor";
import { liveIntentHash } from "../../../scripts/live/submission";
import { createOrdinaryScenarioMechanicalExecutionContext } from "../../../scripts/live/ordinary-scenario-adapter";
import {
  attachUsdcSuccessor,
  createUsdcSuccessorProposal,
  loadUsdcSuccessorApproval,
} from "../../../scripts/live/ordinary-scenario-usdc-successor-proposal";
import { createUsdcSuccessorFixture, successorSnapshot } from "../../support/usdc-successor-fixture";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;
const observer = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${h("1")}`, endpointHash: h("1"), startupEvidenceHash: h("2"), probeEvidenceHash: h("3"), independentFromProposer: true as const, readyAt: successorSnapshot.timestamp.toString(), workflowScheduleSeconds: { review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" }, requiredThrough: (successorSnapshot.timestamp + 11_640n).toString(), expiresAt: "1793318400" };

function approvalDocument(proposal: ReturnType<typeof createUsdcSuccessorProposal>) {
  return { schemaVersion: 1, scope: "ordinary-usdc-period-successor-v1", authorization: "STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION", authorityEvidenceHash: proposal.authorityEvidenceHash, proposalHash: proposal.proposalHash, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, snapshot: proposal.snapshot, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, observer: proposal.observer, schedule: proposal.schedule, groups: proposal.groups, caps: proposal.caps, reservation: proposal.reservation, maxBroadcastAttempts: 1, approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
}

describe("ordinary USDC successor executor", function () {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  async function prepared() {
    const fixture = await createUsdcSuccessorFixture(); cleanup = fixture.cleanup;
    const proposal = createUsdcSuccessorProposal({ source: fixture.source, certificate: fixture.certificate, observer, caps });
    const document = approvalDocument(proposal);
    const approval = loadUsdcSuccessorApproval(proposal, JSON.stringify(document), sha256(document) as Hex);
    const journal = attachUsdcSuccessor(fixture.source.journal, proposal, approval);
    return { ...fixture, proposal, approval, journal };
  }

  function completedRecord(f: Awaited<ReturnType<typeof prepared>>, index: number): OrdinaryScenarioActionRecord {
    const action = f.proposal.actions[index]!;
    const transactionHash = sha256({ action: action.id, index, kind: "successor-test-transaction" }) as Hex;
    const facts = { proposalHash: f.proposal.proposalHash, actionCommitment: action.commitment, outerNonce: 900 + index, gas: action.gasLimitCap.toString(), gasEstimate: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", pinnedBlockNumber: successorSnapshot.number.toString(), pinnedBlockHash: successorSnapshot.hash, approvedContinuationReservationWei: f.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: f.proposal.reservation.successorMaximumReservationWei };
    return { id: action.id, commitment: action.commitment, status: action.expectedOutcome === "success" ? "confirmed" : "rejection-proved", finalOuterMaterialization: { hash: sha256(facts) as Hex, ...facts }, ...(action.expectedOutcome === "success" ? { transactionHash } : {}), ...(action.kind === "queue-proposal" ? { queueCreatedAt: (successorSnapshot.timestamp - 300n).toString() } : {}), evidenceHash: sha256({ action: action.id, outcome: action.expectedOutcome }) as Hex };
  }

  function advancedJournal(f: Awaited<ReturnType<typeof prepared>>, index: number): typeof f.journal {
    const journal = structuredClone(f.journal);
    for (let cursor = 0; cursor < index; cursor++) journal.usdcSuccessor!.actions[cursor] = completedRecord(f, cursor);
    return journal;
  }

  function currentState(f: Awaited<ReturnType<typeof prepared>>, patch: Partial<CanonicalOrdinaryScenarioState> = {}, actionIndex = 0, journal = f.journal): CanonicalOrdinaryScenarioState {
    const action = createUsdcSuccessorExecutionView(f.source, f.proposal, f.approval).proposal.actions.slice(-19)[actionIndex]!; const controlled = action.before;
    const dependencies = action.dependsOn.map(id => {
      const record = [...journal.actions, ...journal.hashlessContinuation!.actions, ...journal.usdcSuccessor!.actions].find(entry => entry.id === id && entry.status === "confirmed") as any;
      if (!record?.evidenceHash) throw new Error(`fixture dependency ${id} missing`);
      return { actionId: id, transactionHash: record.transactionHash, blockHash: record.receipt?.blockHash, evidenceHash: record.evidenceHash };
    });
    const reviewedAction = controlled.queueFingerprint === null ? undefined : [...f.proposal.actions, ...f.source.recovery.actions].find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce.toString() === controlled.queueNonce && candidate.queue.fingerprint === controlled.queueFingerprint); const reviewedQueue = reviewedAction?.queue; const queueRecord = reviewedAction && [...journal.hashlessContinuation!.actions, ...journal.usdcSuccessor!.actions].find(entry => entry.id === reviewedAction.id && entry.status === "confirmed") as any;
    const queueStatus = controlled.queueStatus === "QUEUED_CONDITIONAL" ? "queued" : controlled.queueStatus === "EXPIRED_CONDITIONAL" ? "expired" : "executed";
    const queue = reviewedQueue ? { queueNonce: BigInt(reviewedQueue.queueNonce), fingerprint: reviewedQueue.fingerprint, createdAt: BigInt(queueRecord.queueCreatedAt), status: queueStatus as "queued" | "expired" | "executed", to: reviewedQueue.to, value: BigInt(reviewedQueue.value), data: reviewedQueue.data, operation: 0 as const } : undefined;
    const usdcWindow = controlled.usdcBaseSpent === "0" && controlled.usdcInstantSpent === "0" ? 0n : BigInt(f.proposal.effectivePeriod);
    return { chainId: 11_155_111, blockNumber: successorSnapshot.number, blockHash: successorSnapshot.hash, blockTimestamp: successorSnapshot.timestamp, evidenceBasis: { kind: "current-head" }, planHash: f.source.original.planHash, topologyEvidenceHash: f.source.original.topologyEvidenceHash, publicIdentitiesHash: f.source.original.publicIdentitiesHash, observerReady: true, observerEvidenceHash: f.proposal.observer.probeEvidenceHash, outerNonce: 900, funderNativeBalance: 10n ** 18n, safeNativeBalance: BigInt(controlled.safeNativeBalance), funderUsdcBalance: BigInt(controlled.funderUsdcBalance), safeUsdcBalance: BigInt(controlled.safeUsdcBalance), safeNonce: BigInt(controlled.safeNonce), delayQueueNonce: BigInt(controlled.delayQueueNonce), delayTxNonce: BigInt(controlled.delayTxNonce), nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: usdcWindow, baseSpent: BigInt(controlled.usdcBaseSpent), instantSpent: BigInt(controlled.usdcInstantSpent) }, queue, dependencies, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, ...patch };
  }

  it("creates one closed successor-only view and selects no superseded USDC slot", async function () {
    const f = await prepared();
    const view = createUsdcSuccessorExecutionView(f.source, f.proposal, f.approval);
    expect(view.kind).to.equal("usdc-period-successor-v1");
    expect(resolveOrdinaryScenarioExecutionProposal(view).actions.slice(-19).map(action => action.id)).to.deep.equal(f.proposal.actions.map(action => action.id));
    expect(view.proposal.actions.slice(-19).every(action => action.id.startsWith("usdc-successor-"))).to.equal(true);
    expect(selectUsdcSuccessorSubmissionAction(f.source, f.proposal, f.approval, f.journal).id).to.equal("usdc-successor-base-x");
    expect(() => createUsdcSuccessorExecutionView(f.source, f.proposal, { ...f.approval } as never)).to.throw(/opaque|bound|authorization/i);
  });

  it("uses exact later successor IDs for heads, dependencies, queue lookup, and replay while rejecting old USDC progress", async function () {
    const f = await prepared();
    for (const index of [3, 5, 8, 10, 18]) {
      const journal = advancedJournal(f, index);
      expect(selectUsdcSuccessorSubmissionAction(f.source, f.proposal, f.approval, journal).id).to.equal(f.proposal.actions[index]!.id);
    }

    const oldProgress = advancedJournal(f, 8); oldProgress.hashlessContinuation!.actions[3] = { ...completedRecord(f, 0), id: "usdc-base-x", commitment: oldProgress.hashlessContinuation!.actions[3]!.commitment };
    expect(() => selectUsdcSuccessorSubmissionAction(f.source, f.proposal, f.approval, oldProgress)).to.throw(/superseded USDC source|source.*untouched|frozen source|binding/i);

    const queueIndex = 10; const queued = advancedJournal(f, queueIndex); const queueState = currentState(f, {}, queueIndex, queued); let queuedAction = "";
    const queueContext = { readState: async (action: { id: string }) => { queuedAction = action.id; return queueState; }, materialize: async () => { throw new Error("queue dependency and receipt lookup reached exact head"); }, now: () => new Date(Number(queueState.blockTimestamp * 1000n)) } as unknown as OrdinaryScenarioExecutionContext;
    await expect(executeUsdcSuccessorAction(f.source, f.proposal, f.approval, { load: () => queued, save: () => undefined }, queueContext)).to.be.rejectedWith("queue dependency and receipt lookup reached exact head");
    expect(queuedAction).to.equal(f.proposal.actions[queueIndex]!.id);

    const replayIndex = 5; const replayJournal = advancedJournal(f, replayIndex); const replayState = currentState(f, {}, replayIndex, replayJournal); let replaySource = "";
    const replayContext = { readState: async () => replayState, recoverReplay: async (_action: unknown, source: OrdinaryScenarioActionRecord) => { replaySource = source.id; throw new Error("exact replay source reached"); }, now: () => new Date(Number(replayState.blockTimestamp * 1000n)) } as unknown as OrdinaryScenarioExecutionContext;
    await expect(executeUsdcSuccessorAction(f.source, f.proposal, f.approval, { load: () => replayJournal, save: () => undefined }, replayContext)).to.be.rejectedWith("exact replay source reached");
    expect(replaySource).to.equal(f.proposal.actions[replayIndex]!.dependsOn[0]);
  });

  it("round-trips the exact sibling and rejects header deletion or detached mutation", async function () {
    const f = await prepared(); const directory = mkdtempSync(join(tmpdir(), "usdc-successor-executor-"));
    const path = join(directory, "journal.json"); const identity = { proposalHash: f.journal.proposalHash, approvalHash: f.journal.approvalHash, funder: f.journal.funder };
    try {
      const store = createOrdinaryScenarioStore(path, identity, () => f.journal); store.save(f.journal);
      expect(store.load().usdcSuccessor?.proposalHash).to.equal(f.proposal.proposalHash);
      const removed = store.load(); delete removed.usdcSuccessor;
      expect(() => store.save(removed)).to.throw(/USDC successor.*deleted|immutable header|cannot be deleted/i);
      const changed = store.load(); changed.usdcSuccessor!.actions[0]!.commitment = h("9");
      expect(() => store.save(changed)).to.throw(/USDC successor.*identity|commitment|lineage/i);
      store.close?.();
      const reopened = createOrdinaryScenarioStore(path, identity, () => { throw new Error("must reload"); });
      expect(reopened.load().actions).to.have.length(19); expect(reopened.load().hashlessContinuation?.actions).to.have.length(22); expect(reopened.load().usdcSuccessor?.actions).to.have.length(19); reopened.close?.();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects stale raw-native drift before any private callback while accepting a newer effective period", async function () {
    const f = await prepared();
    let materializations = 0; let saves = 0;
    const state = currentState(f, { nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_001n, instantSpent: 30_000_000_000_000n } });
    const context = { readState: async () => state, materialize: async () => { materializations++; throw new Error("must not materialize"); }, now: () => new Date(Number((BigInt(f.proposal.effectivePeriod) + 1n) * 1000n)) } as unknown as OrdinaryScenarioExecutionContext;
    await expect(executeUsdcSuccessorAction(f.source, f.proposal, f.approval, { load: () => f.journal, save: () => { saves++; } }, context)).to.be.rejectedWith(/raw native|native spend|tuple/i);
    expect({ materializations, saves }).to.deep.equal({ materializations: 0, saves: 0 });
  });

  it("persists one immutable materialization after attachment and blocks expired admission before persistence", async function () {
    const f = await prepared(); const directory = mkdtempSync(join(tmpdir(), "usdc-successor-lifecycle-")); const path = join(directory, "journal.json"); const identity = { proposalHash: f.journal.proposalHash, approvalHash: f.journal.approvalHash, funder: f.journal.funder };
    try {
      const store = createOrdinaryScenarioStore(path, identity, () => f.journal); const state = currentState(f); let materializations = 0;
      const expectedBefore = createUsdcSuccessorExecutionView(f.source, f.proposal, f.approval).proposal.actions.slice(-19)[0]!.before;
      expect({ safeNativeBalance: state.safeNativeBalance.toString(), funderUsdcBalance: state.funderUsdcBalance.toString(), safeUsdcBalance: state.safeUsdcBalance.toString(), safeNonce: state.safeNonce.toString(), delayQueueNonce: state.delayQueueNonce.toString(), delayTxNonce: state.delayTxNonce.toString(), nativeBaseSpent: state.nativeSpend.baseSpent.toString(), nativeInstantSpent: state.nativeSpend.instantSpent.toString(), usdcBaseSpent: state.usdcSpend.baseSpent.toString(), usdcInstantSpent: state.usdcSpend.instantSpent.toString(), queueStatus: state.queue ? "EXECUTED_CONDITIONAL" : "EMPTY", queueNonce: state.queue?.queueNonce.toString() ?? null, queueFingerprint: state.queue?.fingerprint ?? null }).to.deep.equal(expectedBefore);
      const context = { readState: async () => state, materialize: async () => { materializations++; throw new Error("intentional private interruption"); }, now: () => new Date(Number(state.blockTimestamp * 1000n)) } as unknown as OrdinaryScenarioExecutionContext;
      await expect(executeUsdcSuccessorAction(f.source, f.proposal, f.approval, store, context)).to.be.rejectedWith("intentional private interruption");
      expect(materializations).to.equal(1); expect(store.load().usdcSuccessor!.actions[0]!.status).to.equal("materialized");
      await expect(executeUsdcSuccessorAction(f.source, f.proposal, f.approval, store, context)).to.be.rejectedWith(/interrupted|stopped/i); expect(materializations).to.equal(1); store.close?.();

      const secondPath = join(directory, "expired.json"); const fresh = await prepared(); const second = createOrdinaryScenarioStore(secondPath, { proposalHash: fresh.journal.proposalHash, approvalHash: fresh.journal.approvalHash, funder: fresh.journal.funder }, () => fresh.journal); let expiredMaterializations = 0; const expiredState = currentState(fresh);
      const expired = { readState: async () => expiredState, materialize: async () => { expiredMaterializations++; throw new Error("must not load private material"); }, now: () => new Date(Number(BigInt(fresh.proposal.deadline) * 1000n)) } as unknown as OrdinaryScenarioExecutionContext;
      await expect(executeUsdcSuccessorAction(fresh.source, fresh.proposal, fresh.approval, second, expired)).to.be.rejectedWith(/deadline|remaining/i); expect(expiredMaterializations).to.equal(0); expect(second.load().usdcSuccessor!.actions[0]!.status).to.equal("approved"); second.close?.();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("persists a late alert receipt as stopped before observer confirmation is available", async function () {
    const f = await prepared(); const directory = mkdtempSync(join(tmpdir(), "usdc-successor-late-alert-")); const actionIndex = 8; const advanced = advancedJournal(f, actionIndex); const action = createUsdcSuccessorExecutionView(f.source, f.proposal, f.approval).proposal.actions.slice(-19)[actionIndex]!; expect(action.kind).to.equal("queue-proposal"); const transactionHash = h("a"); const blockHash = h("b");
    const intent = { id: action.id, to: f.source.original.safe, value: 0n, data: "0x1234" as Hex, nonce: 900, gas: action.gasLimitCap, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    const facts = { proposalHash: f.proposal.proposalHash, actionCommitment: action.commitment, outerNonce: intent.nonce, gas: intent.gas.toString(), gasEstimate: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", pinnedBlockNumber: successorSnapshot.number.toString(), pinnedBlockHash: successorSnapshot.hash, approvedContinuationReservationWei: f.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: f.proposal.reservation.successorMaximumReservationWei };
    const record: OrdinaryScenarioActionRecord = { id: action.id, commitment: action.commitment, status: "outer-pending", finalOuterMaterialization: { hash: sha256(facts) as Hex, ...facts }, outerNonce: intent.nonce, gas: intent.gas.toString(), maxFeePerGas: "1", maxPriorityFeePerGas: "1", intentHash: liveIntentHash(intent, f.journal.funder), transactionHash, outerTo: intent.to, outerValue: "0", outerDataHash: keccak256(intent.data), funderNativeBefore: (10n ** 18n).toString() };
    advanced.usdcSuccessor!.actions[actionIndex] = record; advanced.liveJournal.entries.push({ id: action.id, intentHash: record.intentHash!, transactionHash, nonce: intent.nonce, reserved: intent.gas, status: "pending" }); const path = join(directory, "journal.json"); const store = createOrdinaryScenarioStore(path, { proposalHash: advanced.proposalHash, approvalHash: advanced.approvalHash, funder: advanced.funder }, () => advanced);
    const receipt = { transactionHash, status: "success" as const, gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: successorSnapshot.number + 100n, blockHash };
    const lateState = { ...currentState(f), blockNumber: receipt.blockNumber, blockHash, blockTimestamp: BigInt(f.proposal.deadline) + 1n, evidenceBasis: { kind: "receipt-poststate" as const, actionId: action.id, transactionHash, blockNumber: receipt.blockNumber, blockHash } };
    let confirmationCalls = 0;
    const context = { recoverPending: async () => intent, inspectReceiptPostState: async () => lateState, confirm: async () => { confirmationCalls++; throw new Error("observer acknowledgement is absent"); }, live: { funder: f.journal.funder, chainId: async () => 11_155_111, nonce: async () => 901, balance: async () => 0n, sign: async () => { throw new Error("private signer must stay unloaded"); }, broadcast: async () => { throw new Error("known hash must not rebroadcast"); }, receipt: async () => receipt } } as unknown as OrdinaryScenarioExecutionContext;
    try {
      await expect(executeUsdcSuccessorAction(f.source, f.proposal, f.approval, store, context)).to.be.rejectedWith(/outside the approved effective period|preserved.*stopped/i);
      const current = store.load(); const persisted = current.usdcSuccessor!.actions[actionIndex] as OrdinaryScenarioActionRecord; expect(persisted.status).to.equal("stopped"); expect(persisted.receipt?.transactionHash).to.equal(transactionHash); expect(persisted.receiptInclusion).to.deep.equal({ transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash, blockTimestamp: lateState.blockTimestamp.toString(), effectivePeriod: f.proposal.deadline }); expect(current.liveJournal.entries[13]!.status).to.equal("success"); expect(confirmationCalls).to.equal(0);
      const changed = store.load(); (changed.usdcSuccessor!.actions[actionIndex]!.receiptInclusion as any).blockTimestamp = (lateState.blockTimestamp + 1n).toString(); expect(() => store.save(changed)).to.throw(/receipt inclusion.*changed|fixed field/i); store.close?.();
      const reopened = createOrdinaryScenarioStore(path, { proposalHash: advanced.proposalHash, approvalHash: advanced.approvalHash, funder: advanced.funder }, () => { throw new Error("must reload stopped receipt"); }); expect(reopened.load().usdcSuccessor!.actions[actionIndex]!.receiptInclusion).to.deep.equal(persisted.receiptInclusion); reopened.close?.();
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("persists an in-period known-hash inclusion before observer confirmation and reloads it while pending", async function () {
    const f = await prepared(); const directory = mkdtempSync(join(tmpdir(), "usdc-successor-inclusion-")); const actionIndex = 0; const advanced = advancedJournal(f, actionIndex); const action = createUsdcSuccessorExecutionView(f.source, f.proposal, f.approval).proposal.actions.slice(-19)[actionIndex]!; const transactionHash = h("c"); const blockHash = h("d");
    const intent = { id: action.id, to: f.source.original.safe, value: 0n, data: "0x1234" as Hex, nonce: 900, gas: action.gasLimitCap, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    const facts = { proposalHash: f.proposal.proposalHash, actionCommitment: action.commitment, outerNonce: intent.nonce, gas: intent.gas.toString(), gasEstimate: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", pinnedBlockNumber: successorSnapshot.number.toString(), pinnedBlockHash: successorSnapshot.hash, approvedContinuationReservationWei: f.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: f.proposal.reservation.successorMaximumReservationWei };
    const record: OrdinaryScenarioActionRecord = { id: action.id, commitment: action.commitment, status: "outer-pending", finalOuterMaterialization: { hash: sha256(facts) as Hex, ...facts }, outerNonce: intent.nonce, gas: intent.gas.toString(), maxFeePerGas: "1", maxPriorityFeePerGas: "1", intentHash: liveIntentHash(intent, f.journal.funder), transactionHash, outerTo: intent.to, outerValue: "0", outerDataHash: keccak256(intent.data), funderNativeBefore: (10n ** 18n).toString() };
    advanced.usdcSuccessor!.actions[actionIndex] = record; advanced.liveJournal.entries.push({ id: action.id, intentHash: record.intentHash!, transactionHash, nonce: intent.nonce, reserved: intent.gas, status: "pending" }); const path = join(directory, "journal.json"); const identity = { proposalHash: advanced.proposalHash, approvalHash: advanced.approvalHash, funder: advanced.funder }; const store = createOrdinaryScenarioStore(path, identity, () => advanced);
    const receipt = { transactionHash, status: "success" as const, gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: successorSnapshot.number + 101n, blockHash }; const blockTimestamp = BigInt(f.proposal.effectivePeriod) + 60n;
    const receiptState = { ...currentState(f), blockNumber: receipt.blockNumber, blockHash, blockTimestamp, evidenceBasis: { kind: "receipt-poststate" as const, actionId: action.id, transactionHash, blockNumber: receipt.blockNumber, blockHash } };
    const context = { recoverPending: async () => intent, inspectReceiptPostState: async () => receiptState, confirm: async () => { throw new Error("observer acknowledgement is absent"); }, live: { funder: f.journal.funder, chainId: async () => 11_155_111, nonce: async () => 901, balance: async () => 0n, sign: async () => { throw new Error("private signer must stay unloaded"); }, broadcast: async () => { throw new Error("known hash must not rebroadcast"); }, receipt: async () => receipt } } as unknown as OrdinaryScenarioExecutionContext;
    try {
      await expect(executeUsdcSuccessorAction(f.source, f.proposal, f.approval, store, context)).to.be.rejectedWith("observer acknowledgement is absent");
      const persisted = store.load().usdcSuccessor!.actions[actionIndex]!; expect(persisted.status).to.equal("outer-pending"); expect(persisted.receiptInclusion).to.deep.equal({ transactionHash, blockNumber: receipt.blockNumber.toString(), blockHash, blockTimestamp: blockTimestamp.toString(), effectivePeriod: f.proposal.effectivePeriod }); store.close?.();
      const reopened = createOrdinaryScenarioStore(path, identity, () => { throw new Error("must reload inclusion"); }); expect(reopened.load().usdcSuccessor!.actions[actionIndex]!.receiptInclusion).to.deep.equal(persisted.receiptInclusion); reopened.close?.();
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("requires exact nonempty observer window forwarding in the shared adapter", async function () {
    const f = await prepared(); const view = createUsdcSuccessorExecutionView(f.source, f.proposal, f.approval); const input = { expectedChainId: 11_155_111, proposal: view, journal: () => f.journal, currentClient: {}, archiveClient: {}, observerReadiness: async () => ({ ready: true, evidenceHash: f.proposal.observer.probeEvidenceHash }), verifyProfileAtBlock: async () => undefined, live: {}, loadSigners: async () => { throw new Error("unused"); } } as never;
    expect(() => createOrdinaryScenarioMechanicalExecutionContext(input, (async () => { throw new Error("unused"); }) as never)).to.throw(/observer ready and expiry forwarding/i);
    expect(() => createOrdinaryScenarioMechanicalExecutionContext({ ...input, receiverReadyAt: f.proposal.observer.readyAt, receiverExpiresAt: f.proposal.observer.expiresAt } as never, (async () => { throw new Error("unused"); }) as never)).not.to.throw();
  });
});
