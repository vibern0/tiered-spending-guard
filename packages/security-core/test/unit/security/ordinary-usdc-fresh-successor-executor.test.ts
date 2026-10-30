import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, keccak256, type Hex } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import { liveIntentHash } from "../../../scripts/live/submission";
import { createOrdinaryScenarioMechanicalExecutionContext } from "../../../scripts/live/ordinary-scenario-adapter";
import {
  createOrdinaryScenarioStore,
  createUsdcFreshSuccessorExecutionView,
  executeUsdcFreshSuccessorAction,
  selectUsdcFreshSuccessorSubmissionAction,
  type CanonicalOrdinaryScenarioState,
  type OrdinaryScenarioExecutionContext,
} from "../../../scripts/live/ordinary-scenario-executor";
import {
  attachUsdcFreshSuccessor,
  createUsdcFreshSuccessorProposal,
  loadUsdcFreshSuccessorApproval,
} from "../../../scripts/live/ordinary-scenario-usdc-fresh-successor-proposal";
import { verifyUsdcFreshSuccessorCertificate } from "../../../scripts/live/ordinary-scenario-usdc-fresh-successor-certificate";
import { cleanupUsdcRecycleContinuationFixtures } from "../../support/usdc-recycle-continuation-fixture";
import { createFreshSource, freshPrimary, freshProviders, freshSnapshot } from "../../support/usdc-fresh-successor-fixture";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;
const observer = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${h("1")}`, endpointHash: h("1"), startupEvidenceHash: h("2"), probeEvidenceHash: h("3"), independentFromProposer: true as const, readyAt: freshSnapshot.timestamp.toString(), workflowScheduleSeconds: { review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" }, requiredThrough: (freshSnapshot.timestamp + 11_640n).toString(), expiresAt: "1793404800" };

async function approved() {
  const source = await createFreshSource();
  const certificate = await verifyUsdcFreshSuccessorCertificate(source, freshPrimary, await freshProviders(source));
  const proposal = createUsdcFreshSuccessorProposal({ source, certificate, observer, caps });
  const document = { schemaVersion: 1, scope: proposal.scope, authorization: "FOCUSED_BOUNDED_SUCCESSOR_AUTHORIZATION", authorityEvidenceHash: proposal.authorityEvidenceHash, proposalHash: proposal.proposalHash, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, snapshot: proposal.snapshot, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, observer: proposal.observer, schedule: proposal.schedule, groups: proposal.groups, caps: proposal.caps, reservation: proposal.reservation, maxBroadcastAttempts: 1, repairAuthority: "NONE", approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
  const approval = loadUsdcFreshSuccessorApproval(proposal, JSON.stringify(document), sha256(document) as Hex);
  const journal = attachUsdcFreshSuccessor(source.prior.journal, proposal, approval);
  return { source, certificate, proposal, approval, journal };
}

describe("ordinary USDC fresh successor executor", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  it("builds only the closed 3+2+18 execution view and selects its first row", async function () {
    const f = await approved(); const view = createUsdcFreshSuccessorExecutionView(f.source, f.proposal, f.approval);
    expect(view.kind).to.equal("usdc-fresh-period-successor-v1");
    expect(view.proposal.actions.map(action => action.id)).to.deep.equal([
      "native-queue-ready-hashless-skip", "native-queue-ready-replacement", "native-queue-ready-replacement-execute",
      "usdc-successor-base-x", "usdc-successor-step-up-contract", ...f.proposal.actions.map(action => action.id),
    ]);
    expect(selectUsdcFreshSuccessorSubmissionAction(f.source, f.proposal, f.approval, f.journal).id).to.equal("usdc-fresh-successor-prefund-all");
  });

  it("round-trips one exact append-only sibling and rejects source/header/catalog drift", async function () {
    const f = await approved(); const directory = mkdtempSync(join(tmpdir(), "usdc-fresh-store-"));
    const identity = { proposalHash: f.journal.proposalHash, approvalHash: f.journal.approvalHash, funder: f.journal.funder };
    const store = createOrdinaryScenarioStore(join(directory, "journal.json"), identity, () => f.journal);
    try {
      expect(store.load().usdcFreshSuccessor?.actions).to.have.length(18);
      const changed = store.load(); changed.usdcFreshSuccessor!.actions.reverse();
      expect(() => store.save(changed)).to.throw(/catalog|identity|reorder|lineage/i);
      const header = store.load(); header.usdcFreshSuccessor!.minimumOuterNonce++;
      expect(() => store.save(header)).to.throw(/header|immutable|minimum/i);
      const predecessor = store.load(); predecessor.usdcSuccessor!.actions[2] = { ...predecessor.usdcSuccessor!.actions[2]!, status: "stopped" } as any;
      expect(() => store.save(predecessor)).to.throw(/frozen|source|prefix|status/i);
      const multirow = store.load();
      multirow.usdcFreshSuccessor!.actions[0] = { ...multirow.usdcFreshSuccessor!.actions[0]!, status: "materialized" } as any;
      multirow.usdcFreshSuccessor!.actions[1] = { ...multirow.usdcFreshSuccessor!.actions[1]!, status: "materialized" } as any;
      expect(() => store.save(multirow)).to.throw(/one|selected|row|multiple|order/i);
      const later = store.load(); later.usdcFreshSuccessor!.actions[1] = { ...later.usdcFreshSuccessor!.actions[1]!, status: "materialized" } as any;
      expect(() => store.save(later)).to.throw(/selected|row|order|first|head|prefix/i);
      const wrongOutcome = store.load(); const first = f.proposal.actions[0]!, facts = { proposalHash: f.proposal.proposalHash, actionCommitment: first.commitment, outerNonce: 870, gas: first.gasLimitCap, gasEstimate: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", pinnedBlockNumber: freshSnapshot.number.toString(), pinnedBlockHash: freshSnapshot.hash, approvedContinuationReservationWei: f.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: f.proposal.reservation.successorMaximumReservationWei };
      wrongOutcome.usdcFreshSuccessor!.actions[0] = { id: first.id, commitment: first.commitment, status: "rejection-proved", finalOuterMaterialization: { hash: sha256(facts) as Hex, ...facts }, evidenceHash: h("9") } as any;
      expect(() => store.save(wrongOutcome)).to.throw(/outcome|status|rejection/i);
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("admits prefund only with the exact stale prior-period tuple and minimum outer nonce", async function () {
    const f = await approved(); const action = f.proposal.actions[0]!; const view = createUsdcFreshSuccessorExecutionView(f.source, f.proposal, f.approval);
    const queueAction = view.proposal.actions.find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce === 3n)!;
    const queueRecord = f.journal.hashlessContinuation!.actions[1] as any;
    const dependency = f.journal.usdcSuccessor!.actions[1] as any;
    const state = (window = 1_793_232_000n, outerNonce = 870): CanonicalOrdinaryScenarioState => ({
      chainId: 11_155_111, blockNumber: freshSnapshot.number, blockHash: freshSnapshot.hash, blockTimestamp: freshSnapshot.timestamp, evidenceBasis: { kind: "current-head" },
      planHash: view.proposal.planHash, topologyEvidenceHash: view.proposal.topologyEvidenceHash, publicIdentitiesHash: view.proposal.publicIdentitiesHash,
      observerReady: true, observerEvidenceHash: view.proposal.observerEvidenceHash, outerNonce, funderNativeBalance: 10n ** 18n,
      safeNativeBalance: 0n, funderUsdcBalance: 40_000_000n, safeUsdcBalance: 0n, safeNonce: 10n, delayQueueNonce: 4n, delayTxNonce: 4n,
      nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window, baseSpent: 10_000_000n, instantSpent: 20_000_000n },
      queue: { queueNonce: 3n, fingerprint: queueAction.queue!.fingerprint, createdAt: BigInt(queueRecord.queueCreatedAt), status: "executed", to: queueAction.queue!.to, value: queueAction.queue!.value, data: queueAction.queue!.data, operation: 0 },
      dependencies: [{ actionId: dependency.id, transactionHash: dependency.transactionHash, blockHash: dependency.receipt.blockHash, evidenceHash: dependency.evidenceHash }], fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n },
    });
    const run = async (current: CanonicalOrdinaryScenarioState) => {
      const directory = mkdtempSync(join(tmpdir(), "usdc-fresh-exec-")); const store = createOrdinaryScenarioStore(join(directory, "journal.json"), { proposalHash: f.journal.proposalHash, approvalHash: f.journal.approvalHash, funder: f.journal.funder }, () => f.journal); let materialized = 0;
      const context = { readState: async () => current, materialize: async () => { materialized++; throw new Error("materialization boundary reached"); }, now: () => new Date(Number(freshSnapshot.timestamp * 1000n)) } as unknown as OrdinaryScenarioExecutionContext;
      try { return await executeUsdcFreshSuccessorAction(f.source, f.proposal, f.approval, store, context); } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
    };
    await expect(run(state())).to.be.rejectedWith("materialization boundary reached");
    await expect(run(state(BigInt(f.proposal.effectivePeriod)))).to.be.rejectedWith(/stale USDC tuple|raw USDC period/i);
    await expect(run(state(1_793_232_000n, 869))).to.be.rejectedWith(/minimum|checkpoint|nonce/i);
    const directory = mkdtempSync(join(tmpdir(), "usdc-fresh-altered-prefund-")); const store = createOrdinaryScenarioStore(join(directory, "journal.json"), { proposalHash: f.journal.proposalHash, approvalHash: f.journal.approvalHash, funder: f.journal.funder }, () => f.journal);
    const altered = encodeFunctionData({ abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "transfer", args: [f.source.prior.original.safe, 30_000_000n] });
    let simulations = 0, signs = 0, broadcasts = 0;
    const malicious = { readState: async () => state(), materialize: async () => ({ liveIntent: { id: action.id, to: action.transaction.to, value: 0n, data: altered, nonce: 870, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, requestHash: action.commitment, signerRolesHash: sha256(action.signerRoles), signedCalldataHash: keccak256(altered), signatureBundleHash: null, transientSignedCalldata: altered }), simulate: async () => { simulations++; throw new Error("must not simulate altered prefund"); }, now: () => new Date(Number(freshSnapshot.timestamp * 1000n)), live: { sign: async () => { signs++; throw new Error("must not sign altered prefund"); }, broadcast: async () => { broadcasts++; throw new Error("must not broadcast altered prefund"); } } } as unknown as OrdinaryScenarioExecutionContext;
    try {
      await expect(executeUsdcFreshSuccessorAction(f.source, f.proposal, f.approval, store, malicious)).to.be.rejectedWith(/public transaction changed|approval|materialized/i);
      expect({ simulations, signs, broadcasts }).to.deep.equal({ simulations: 0, signs: 0, broadcasts: 0 });
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
    expect(action.before.usdcBaseSpent).to.equal("10000000");
  });

  it("reconciles a durable prefund hash keylessly and permanently stops a wrong stale-window poststate", async function () {
    const f = await approved(); const view = createUsdcFreshSuccessorExecutionView(f.source, f.proposal, f.approval); const action = view.proposal.actions[5]!; const transactionHash = h("a"), blockHash = h("b");
    const intent = { id: action.id, to: action.publicTransaction!.to, value: action.publicTransaction!.value, data: action.publicTransaction!.data, nonce: 870, gas: action.gasLimitCap, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
    const facts = { proposalHash: f.proposal.proposalHash, actionCommitment: action.commitment, outerNonce: 870, gas: action.gasLimitCap.toString(), gasEstimate: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", pinnedBlockNumber: freshSnapshot.number.toString(), pinnedBlockHash: freshSnapshot.hash, approvedContinuationReservationWei: f.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: f.proposal.reservation.successorMaximumReservationWei };
    const journal = structuredClone(f.journal); journal.usdcFreshSuccessor!.actions[0] = { id: action.id, commitment: action.commitment, status: "outer-pending", materializationHash: h("4"), finalOuterMaterialization: { hash: sha256(facts) as Hex, ...facts }, prestateHash: h("5"), outerNonce: 870, gas: action.gasLimitCap.toString(), maxFeePerGas: "1", maxPriorityFeePerGas: "1", requestHash: action.commitment, signatureBundleHash: null, signedCalldataHash: keccak256(intent.data), simulationEvidenceHash: h("6"), intentHash: liveIntentHash(intent, journal.funder), transactionHash, outerTo: intent.to, outerValue: "0", outerDataHash: keccak256(intent.data), funderNativeBefore: (10n ** 18n).toString() };
    journal.liveJournal.entries.push({ id: action.id, intentHash: liveIntentHash(intent, journal.funder), transactionHash, nonce: 870, reserved: action.gasLimitCap, status: "pending" });
    const directory = mkdtempSync(join(tmpdir(), "usdc-fresh-keyless-")); const store = createOrdinaryScenarioStore(join(directory, "journal.json"), { proposalHash: journal.proposalHash, approvalHash: journal.approvalHash, funder: journal.funder }, () => journal);
    const queueAction = view.proposal.actions.find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce === 3n)!; const queueRecord = journal.hashlessContinuation!.actions[1] as any;
    const receipt = { transactionHash, status: "success" as const, gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: freshSnapshot.number + 20n, blockHash };
    const wrongPoststate: CanonicalOrdinaryScenarioState = { chainId: 11_155_111, blockNumber: receipt.blockNumber, blockHash, blockTimestamp: BigInt(f.proposal.effectivePeriod) + 60n, evidenceBasis: { kind: "receipt-poststate", actionId: action.id, transactionHash, blockNumber: receipt.blockNumber, blockHash }, planHash: view.proposal.planHash, topologyEvidenceHash: view.proposal.topologyEvidenceHash, publicIdentitiesHash: view.proposal.publicIdentitiesHash, observerReady: true, observerEvidenceHash: view.proposal.observerEvidenceHash, outerNonce: 871, funderNativeBalance: 10n ** 18n - 1n, safeNativeBalance: 0n, funderUsdcBalance: 9_000_000n, safeUsdcBalance: 31_000_000n, safeNonce: 10n, delayQueueNonce: 4n, delayTxNonce: 4n, nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: BigInt(f.proposal.effectivePeriod), baseSpent: 10_000_000n, instantSpent: 20_000_000n }, queue: { queueNonce: 3n, fingerprint: queueAction.queue!.fingerprint, createdAt: BigInt(queueRecord.queueCreatedAt), status: "executed", to: queueAction.queue!.to, value: queueAction.queue!.value, data: queueAction.queue!.data, operation: 0 }, dependencies: [], fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } };
    let signs = 0, broadcasts = 0;
    const context = { recoverPending: async () => intent, inspectReceiptPostState: async () => wrongPoststate, confirm: async () => ({ postState: wrongPoststate, effect: { kind: "erc20-funding" as const, token: f.source.prior.original.usdc, from: f.source.prior.original.funder, to: f.source.prior.original.safe, amount: 31_000_000n }, observerEvidenceHash: null }), live: { funder: journal.funder, chainId: async () => 11_155_111, nonce: async () => 871, balance: async () => 0n, sign: async () => { signs++; throw new Error("known hash must not sign"); }, broadcast: async () => { broadcasts++; throw new Error("known hash must not rebroadcast"); }, receipt: async () => receipt } } as unknown as OrdinaryScenarioExecutionContext;
    try {
      await expect(executeUsdcFreshSuccessorAction(f.source, f.proposal, f.approval, store, context)).to.be.rejectedWith(/raw spend period drift/i);
      const stopped = store.load().usdcFreshSuccessor!.actions[0]! as any; expect(stopped.status).to.equal("stopped"); expect(stopped.receiptInclusion).to.deep.include({ transactionHash, effectivePeriod: f.proposal.effectivePeriod }); expect({ signs, broadcasts }).to.deep.equal({ signs: 0, broadcasts: 0 });
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("composes adapter, executor, and atomic store to one signer call before any broadcast", async function () {
    const f = await approved(); const view = createUsdcFreshSuccessorExecutionView(f.source, f.proposal, f.approval); const action = view.proposal.actions[5]!; const queueAction = view.proposal.actions.find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce === 3n)!; const queueRecord = f.journal.hashlessContinuation!.actions[1] as any; const dependency = f.journal.usdcSuccessor!.actions[1] as any;
    const state: CanonicalOrdinaryScenarioState = { chainId: 11_155_111, blockNumber: freshSnapshot.number, blockHash: freshSnapshot.hash, blockTimestamp: freshSnapshot.timestamp, evidenceBasis: { kind: "current-head" }, planHash: view.proposal.planHash, topologyEvidenceHash: view.proposal.topologyEvidenceHash, publicIdentitiesHash: view.proposal.publicIdentitiesHash, observerReady: true, observerEvidenceHash: view.proposal.observerEvidenceHash, outerNonce: 870, funderNativeBalance: 10n ** 18n, safeNativeBalance: 0n, funderUsdcBalance: 40_000_000n, safeUsdcBalance: 0n, safeNonce: 10n, delayQueueNonce: 4n, delayTxNonce: 4n, nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: 1_793_232_000n, baseSpent: 10_000_000n, instantSpent: 20_000_000n }, queue: { queueNonce: 3n, fingerprint: queueAction.queue!.fingerprint, createdAt: BigInt(queueRecord.queueCreatedAt), status: "executed", to: queueAction.queue!.to, value: queueAction.queue!.value, data: queueAction.queue!.data, operation: 0 }, dependencies: [{ actionId: dependency.id, transactionHash: dependency.transactionHash, blockHash: dependency.receipt.blockHash, evidenceHash: dependency.evidenceHash }], fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } };
    const client = { getBlock: async () => ({ number: state.blockNumber, hash: state.blockHash, timestamp: state.blockTimestamp }), call: async () => ({ data: `0x${"0".repeat(63)}1` as Hex }), estimateGas: async () => 53_859n };
    let signs = 0, broadcasts = 0;
    const directory = mkdtempSync(join(tmpdir(), "usdc-fresh-composed-")); const store = createOrdinaryScenarioStore(join(directory, "journal.json"), { proposalHash: f.journal.proposalHash, approvalHash: f.journal.approvalHash, funder: f.journal.funder }, () => f.journal);
    const readyAt = new Date(Number(BigInt(f.proposal.observer.readyAt) * 1000n)).toISOString(), expiresAt = new Date(Number(BigInt(f.proposal.observer.expiresAt) * 1000n)).toISOString();
    const context = createOrdinaryScenarioMechanicalExecutionContext({ expectedChainId: 11_155_111, proposal: view, journal: () => store.load(), currentClient: client as never, archiveClient: client as never, observerReadiness: async () => ({ ready: true, evidenceHash: f.proposal.observer.probeEvidenceHash }), receiverReadyAt: readyAt, receiverExpiresAt: expiresAt, live: { funder: f.journal.funder, chainId: async () => 11_155_111, nonce: async () => 870, balance: async () => 10n ** 18n, sign: async () => { signs++; throw new Error("controlled signing boundary"); }, broadcast: async () => { broadcasts++; throw new Error("must not broadcast without signed bytes"); }, receipt: async (hash: Hex) => store.load().liveJournal.entries.find(entry => entry.transactionHash === hash)?.receipt }, loadSigners: async () => { throw new Error("public prefund must not load Safe signers"); }, now: () => new Date(Number(freshSnapshot.timestamp * 1000n)) } as never, (async () => state) as never);
    try {
      await expect(executeUsdcFreshSuccessorAction(f.source, f.proposal, f.approval, store, context)).to.be.rejectedWith(/local transaction signing failed|controlled signing boundary/i);
      expect({ signs, broadcasts }).to.deep.equal({ signs: 1, broadcasts: 0 });
      expect(store.load().usdcFreshSuccessor!.actions[0]!.status).to.equal("signed-simulated");
      expect(action.kind).to.equal("controlled-recipient-funding");
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("uses only the fresh base establishment and requires the current window on later rows", async function () {
    const f = await approved(); const forged = structuredClone(f.journal);
    for (let index = 0; index < 2; index++) {
      const action = f.proposal.actions[index]!, facts = { proposalHash: f.proposal.proposalHash, actionCommitment: action.commitment, outerNonce: 870 + index, gas: action.gasLimitCap, gasEstimate: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", pinnedBlockNumber: freshSnapshot.number.toString(), pinnedBlockHash: freshSnapshot.hash, approvedContinuationReservationWei: f.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: f.proposal.reservation.successorMaximumReservationWei };
      forged.usdcFreshSuccessor!.actions[index] = { id: action.id, commitment: action.commitment, status: "confirmed", finalOuterMaterialization: { hash: sha256(facts) as Hex, ...facts }, transactionHash: h(index ? "d" : "c"), evidenceHash: h(index ? "f" : "e"), ...(index === 1 ? { establishedWindow: f.proposal.effectivePeriod } : {}) } as any;
    }
    expect(() => selectUsdcFreshSuccessorSubmissionAction(f.source, f.proposal, f.approval, forged)).to.throw(/durable|live|receipt|lineage/i);
    const advanced = structuredClone(f.journal);
    for (let index = 0; index < 2; index++) {
      const action = f.proposal.actions[index]!, outerNonce = 870 + index, transactionHash = h(index ? "d" : "c"), intentHash = h(index ? "b" : "a"), receipt = { transactionHash, status: "success" as const, gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: freshSnapshot.number, blockHash: freshSnapshot.hash };
      const facts = { proposalHash: f.proposal.proposalHash, actionCommitment: action.commitment, outerNonce, gas: action.gasLimitCap, gasEstimate: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", pinnedBlockNumber: freshSnapshot.number.toString(), pinnedBlockHash: freshSnapshot.hash, approvedContinuationReservationWei: f.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: f.proposal.reservation.successorMaximumReservationWei };
      advanced.usdcFreshSuccessor!.actions[index] = { id: action.id, commitment: action.commitment, status: "confirmed", materializationHash: h("4"), finalOuterMaterialization: { hash: sha256(facts) as Hex, ...facts }, prestateHash: h("5"), outerNonce, gas: action.gasLimitCap, maxFeePerGas: "1", maxPriorityFeePerGas: "1", requestHash: action.commitment, signatureBundleHash: null, signedCalldataHash: h("6"), simulationEvidenceHash: h("7"), intentHash, transactionHash, outerTo: f.journal.funder, outerValue: "0", outerDataHash: h("8"), evidenceHash: h(index ? "f" : "e"), receipt, receiptInclusion: { transactionHash, blockNumber: freshSnapshot.number.toString(), blockHash: freshSnapshot.hash, blockTimestamp: (BigInt(f.proposal.effectivePeriod) + 1n).toString(), effectivePeriod: f.proposal.effectivePeriod }, ...(index === 1 ? { establishedWindow: f.proposal.effectivePeriod } : {}) } as any;
      advanced.liveJournal.entries.push({ id: action.id, intentHash, transactionHash, nonce: outerNonce, reserved: 1n, status: "success", receipt });
    }
    expect(selectUsdcFreshSuccessorSubmissionAction(f.source, f.proposal, f.approval, advanced).id).to.equal("usdc-fresh-successor-step-up-contract");
    const view = createUsdcFreshSuccessorExecutionView(f.source, f.proposal, f.approval), action = view.proposal.actions[7]!, controlled = action.before, queueAction = view.proposal.actions.find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce === 3n)!, queueRecord = advanced.hashlessContinuation!.actions[1] as any, dependency = advanced.usdcFreshSuccessor!.actions[1] as any;
    const state = (window: bigint): CanonicalOrdinaryScenarioState => ({ chainId: 11_155_111, blockNumber: freshSnapshot.number, blockHash: freshSnapshot.hash, blockTimestamp: freshSnapshot.timestamp, evidenceBasis: { kind: "current-head" }, planHash: view.proposal.planHash, topologyEvidenceHash: view.proposal.topologyEvidenceHash, publicIdentitiesHash: view.proposal.publicIdentitiesHash, observerReady: true, observerEvidenceHash: view.proposal.observerEvidenceHash, outerNonce: 872, funderNativeBalance: 10n ** 18n, safeNativeBalance: BigInt(controlled.safeNativeBalance), funderUsdcBalance: BigInt(controlled.funderUsdcBalance), safeUsdcBalance: BigInt(controlled.safeUsdcBalance), safeNonce: BigInt(controlled.safeNonce), delayQueueNonce: BigInt(controlled.delayQueueNonce), delayTxNonce: BigInt(controlled.delayTxNonce), nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window, baseSpent: BigInt(controlled.usdcBaseSpent), instantSpent: BigInt(controlled.usdcInstantSpent) }, queue: { queueNonce: 3n, fingerprint: queueAction.queue!.fingerprint, createdAt: BigInt(queueRecord.queueCreatedAt), status: "executed", to: queueAction.queue!.to, value: queueAction.queue!.value, data: queueAction.queue!.data, operation: 0 }, dependencies: [{ actionId: dependency.id, transactionHash: dependency.transactionHash, evidenceHash: dependency.evidenceHash }], fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } });
    let materializations = 0; const context = (window: bigint) => ({ readState: async () => state(window), materialize: async () => { materializations++; throw new Error("fresh later row reached"); }, now: () => new Date(Number(freshSnapshot.timestamp * 1000n)) }) as unknown as OrdinaryScenarioExecutionContext;
    await expect(executeUsdcFreshSuccessorAction(f.source, f.proposal, f.approval, { load: () => advanced, save: () => undefined }, context(1_793_232_000n))).to.be.rejectedWith(/raw USDC period|period rollover|window/i);
    expect(materializations).to.equal(0);
    await expect(executeUsdcFreshSuccessorAction(f.source, f.proposal, f.approval, { load: () => advanced, save: () => undefined }, context(BigInt(f.proposal.effectivePeriod)))).to.be.rejectedWith("fresh later row reached");
    expect(materializations).to.equal(1);
  });
});
