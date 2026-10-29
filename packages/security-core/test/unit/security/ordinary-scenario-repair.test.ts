import { expect } from "chai";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, hashTypedData, keccak256, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createOrdinaryScenarioProposal, createOrdinaryScenarioStore, PRODUCTION_ORDINARY_SCENARIO_DOMAIN, type OrdinaryScenarioJournal, type OrdinaryScenarioProposal } from "../../../scripts/live/ordinary-scenario-executor";
import {
  REPAIR_ACTION_IDS,
  REPAIR_BINDING_HASH,
  REPAIR_PROOF_HASH,
  REPAIR_MAINTENANCE,
  REPAIR_RECIPIENT,
  PRODUCTION_REPAIR_EXECUTION_DOMAIN,
  assertRepairActionState,
  assertRepairBaselineUnchanged,
  assertRepairQueueTiming,
  bindRepairCreationApproval,
  createRepairCreationProposal,
  createRepairGroupProposal,
  createRepairPrepareAuthorization,
  extendJournalForRepair,
  loadRepairApproval,
  loadRepairCreationProposal,
  loadRepairGroupProposal,
  recoverCanonicalRepairCalldata,
  recordRepairCreationConfirmation,
  validateRepairCreationReceiptLogs,
  validateRepairCreationSimulation,
  validateTransientRepairQueue,
  verifyRepairPredecessor,
  type RepairCanonicalState,
} from "../../../scripts/live/ordinary-scenario-repair";
import { createRepairCommandRuntime, repairObserverExpectedEffect, runOrdinaryScenarioRepairEntryPoint, runRepairCommand, runRepairQueueSession } from "../../../scripts/live/ordinary-scenario-repair-session";
import { createRepairMechanicalAdapter, createRepairProductionAdapter, materializeRepairPrimaryFirstSafeCall, validateRepairReceiptEffect } from "../../../scripts/live/ordinary-scenario-repair-adapter";
import { encodeSafeContractSignature } from "../../../src/signers/passkey-helpers";
import { hashlessContinuationFixture } from "../../support/hashless-continuation-fixture";
import { ActivityLedger, FileActivityStore } from "../../../src/monitoring/ledger";
import type { ActivityAlert } from "../../../src/monitoring/notifier";
import { sha256 } from "../../../scripts/plan-deployment";
import { attachUsdcSuccessor, createUsdcSuccessorProposal, loadUsdcSuccessorApproval } from "../../../scripts/live/ordinary-scenario-usdc-successor-proposal";
import { createUsdcSuccessorFixture, successorReceiptInclusion, successorSnapshot } from "../../support/usdc-successor-fixture";

const address = (suffix: string) => `0x${suffix.padStart(40, "0")}` as Address;
const hash = (suffix: string) => `0x${suffix.padStart(64, "0")}` as Hex;
const rawHash = (value: string) => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const safe = address("d751a1479f49d63dc61e0081b0b4d8c60623d9a6");
const guard = address("91392b9ae9daba21a1fba3d92fae9fe47a4b48ca");
const delay = address("b8e143098cccb9935228022173c2c987df5fd53a");
const maintenance = address("3d20c6c361bdb1970827c9450beec0e3cd78e654");
const factory = address("f7488ffbe67327ac9f37d5f722d83fc900852fbf");
const oldSecondary = address("f94b0fbdca0ef0bf7bd142af832bab17108c0d42");
const candidate = address("cc3c12cfb2508e5e9e4eb9b21cc44a9deeff0908");
const primary = address("1111");
const fundingAccount = privateKeyToAccount(`0x${"11".repeat(32)}`);
const funder = fundingAccount.address;
const safeExecAbi = [{ type: "function", name: "execTransaction", stateMutability: "payable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "signatures", type: "bytes" }], outputs: [{ type: "bool" }] }] as const;
const createdEvent = { type: "event", name: "Created", inputs: [{ indexed: false, name: "signer", type: "address" }, { indexed: false, name: "x", type: "uint256" }, { indexed: false, name: "y", type: "uint256" }, { indexed: false, name: "verifiers", type: "uint176" }] } as const;
const executionSuccessEvent = { type: "event", name: "ExecutionSuccess", inputs: [{ indexed: true, name: "txHash", type: "bytes32" }, { indexed: false, name: "payment", type: "uint256" }] } as const;
const transactionAddedEvent = { type: "event", name: "TransactionAdded", inputs: [{ indexed: true, name: "queueNonce", type: "uint256" }, { indexed: true, name: "txHash", type: "bytes32" }, { indexed: false, name: "to", type: "address" }, { indexed: false, name: "value", type: "uint256" }, { indexed: false, name: "data", type: "bytes" }, { indexed: false, name: "operation", type: "uint8" }] } as const;

function prefix(): { proposal: OrdinaryScenarioProposal; journal: OrdinaryScenarioJournal; evidence: readonly { actionId: string; evidenceHash: Hex; transactionHash?: Hex }[] } {
  const actions = Array.from({ length: 38 }, (_, index) => Object.freeze({ id: `prefix-${index}`, commitment: hash((index + 1).toString(16)), expectedOutcome: index % 5 === 0 ? "rejection" : "success" }));
  const records = actions.map((action, index) => ({ id: action.id, commitment: action.commitment, status: index % 5 === 0 ? "rejection-proved" as const : "confirmed" as const, evidenceHash: hash((100 + index).toString(16)), transactionHash: index % 5 === 0 ? undefined : hash((200 + index).toString(16)) }));
  const proposal = { schemaVersion: 1, authorization: "NONE", chainId: 11155111, proposalHash: hash("301"), reviewPackageHash: hash("302"), reviewArtifactBytesHash: hash("303"), planHash: hash("304"), topologyEvidenceHash: hash("305"), baselineEvidenceHash: hash("306"), publicIdentitiesHash: hash("307"), observerEvidenceHash: hash("308"), safe, guard, delay, funder, usdc: address("3333"), recipient: funder, primarySigner: primary, safeContractSecondary: oldSecondary, ecdsaSecondary: address("4444"), periodSeconds: "86400", periodAnchor: "0", cooldownSeconds: "120", expirationSeconds: "600", limits: { nativeX: "10000000000000", nativeY: "30000000000000", usdcX: "10000000", usdcY: "30000000" }, inventory: { initialUsdcUnits: "20000000", recycledStepUpUsdcUnits: "10000000", recycledDelayedUsdcUnits: "1000000", grossUsdcUnits: "31000000" }, baselineActualCostWei: "1000", phaseLimitWei: "50000000000000000", actions } as unknown as OrdinaryScenarioProposal;
  const liveEntries = records.filter(record => record.status === "confirmed").map((record, index) => ({ id: record.id, intentHash: hash((400 + index).toString(16)), transactionHash: record.transactionHash!, nonce: index, reserved: 100n, status: "success" as const, receipt: { transactionHash: record.transactionHash!, status: "success" as const, gasUsed: 10n, effectiveGasPrice: 10n, blockNumber: BigInt(500 + index), blockHash: hash((600 + index).toString(16)) } }));
  const journal = { schemaVersion: 1, chainId: 11155111, reviewPackageHash: proposal.reviewPackageHash, proposalHash: proposal.proposalHash, approvalHash: hash("309"), funder, liveJournal: { chainId: 11155111, funder, entries: liveEntries }, actions: records } as OrdinaryScenarioJournal;
  const evidence = records.map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash!, transactionHash: record.transactionHash }));
  return { proposal, journal, evidence };
}

const state = (overrides: Partial<RepairCanonicalState> = {}): RepairCanonicalState => ({
  chainId: 11155111, blockNumber: 12010000n, blockHash: hash("701"), blockTimestamp: 1770000000n,
  safeNonce: 14n, delayQueueNonce: 6n, delayTxNonce: 6n, safeContractSecondary: oldSecondary,
  candidateRuntimeCodeHash: hash("702"), candidateBindingHash: REPAIR_BINDING_HASH,
  policyHash: "0x5b19fb0f9dcc35db4d45ec227f01348985431d74a2092d887bc7b4f26ade4a82", frozen: false,
  nativeWindow: 1769990400n, nativeBaseSpent: 10000000000000n, nativeInstantSpent: 30000000000000n,
  usdcWindow: 1769990400n, usdcBaseSpent: 10000000n, usdcInstantSpent: 30000000n,
  nativeBalance: 1n, usdcBalance: 1n, topologyEvidenceHash: hash("305"), observerReady: true,
  ...overrides,
});

const quote = { chainId: 11155111, factory, candidate, x: 10342510752483659319190807637330965811978365685423845568184481734592673940696n, y: 83007955684183101275699917860538633816962061613045139387258186696967867907135n, verifiers: 1111636484949241205398856388087597953580887526884n, calldata: "0x0d2f048916dda754f7752e800b62ed684f89fb19d607485fbb8b9b77f5d877e4903904d8b784d685cc3013eab599b6d9696b06414ca74554ec8de222b6cdc43de410bc3f000000000000000000000000c2b78104907f722dabac4c69f826a522b2754de4" as Hex, calldataHash: "0x0ed506887dea4406bb68a77a9d4c54b2454946b80b9205772900008859a92c7b" as Hex, gasLimitCap: 740292n, maxFeePerGasCap: 1000000n, maxPriorityFeePerGasCap: 1000000n };

const approveCreation = (journal: OrdinaryScenarioJournal, creation: ReturnType<typeof createRepairCreationProposal>) => {
  extendJournalForRepair(journal, creation);
  const raw = JSON.stringify({ schemaVersion: 1, scope: "repair-signer-create-v1", authorization: "EXACT_ACTION_APPROVAL", proposalHash: creation.proposalHash, actionCommitments: [creation.action.commitment], phaseLimitWei: "50000000000000000", maxBroadcastAttempts: 1 });
  bindRepairCreationApproval(journal, creation, loadRepairApproval(creation, raw, rawHash(raw)));
  recordRepairCreationConfirmation(journal, creation, hash("c01"));
};

async function closedHashlessPredecessor() {
  const fixture = await hashlessContinuationFixture();
  const journal = structuredClone(fixture.journal);
  const continuation = journal.hashlessContinuation!;
  const records = fixture.proposal.actions.map((action, index) => {
    const confirmed = action.expectedOutcome === "success";
    return {
      id: action.id,
      commitment: action.commitment,
      status: confirmed ? "confirmed" as const : "rejection-proved" as const,
      evidenceHash: hash((40 + index).toString(16)),
      ...(confirmed ? {
        transactionHash: hash((80 + index).toString(16)),
        receipt: { transactionHash: hash((80 + index).toString(16)), status: "success" as const, gasUsed: 10n, effectiveGasPrice: 10n, blockNumber: 12_014_000n + BigInt(index), blockHash: hash((120 + index).toString(16)) },
        ourReceiptGasCost: "100",
        ourPrincipalDelta: action.id === "native-queue-ready-replacement-execute" ? "1" : "0",
      } : {}),
    };
  });
  continuation.actions.splice(0, continuation.actions.length, ...records);
  journal.liveJournal.entries.push(...records.filter(record => record.status === "confirmed").map((record, index) => ({
    id: record.id, intentHash: hash((160 + index).toString(16)), transactionHash: record.transactionHash!, nonce: 810 + index, reserved: 100n, status: "success" as const, receipt: record.receipt!,
  })));
  const evidence = [
    ...journal.actions.map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash ?? rawHash(JSON.stringify(fixture.proposal.source.stoppedRow)), transactionHash: record.transactionHash })),
    ...records.map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash, transactionHash: record.transactionHash })),
  ];
  return { ...fixture, journal, evidence };
}

const successorObserver = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${hash("a1")}`, endpointHash: hash("a1"), startupEvidenceHash: hash("a2"), probeEvidenceHash: hash("a3"), independentFromProposer: true as const, readyAt: successorSnapshot.timestamp.toString(), workflowScheduleSeconds: { review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" }, requiredThrough: (successorSnapshot.timestamp + 11_640n).toString(), expiresAt: "1793318400" };
const successorCaps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;

async function closedUsdcSuccessorPredecessor() {
  const fixture = await createUsdcSuccessorFixture();
  const successor = createUsdcSuccessorProposal({ source: fixture.source, certificate: fixture.certificate, observer: successorObserver, caps: successorCaps });
  const approvalDocument = { schemaVersion: 1, scope: "ordinary-usdc-period-successor-v1", authorization: "STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION", authorityEvidenceHash: successor.authorityEvidenceHash, proposalHash: successor.proposalHash, sourceHash: successor.sourceHash, certificateHash: successor.certificateHash, snapshot: successor.snapshot, effectivePeriod: successor.effectivePeriod, deadline: successor.deadline, observer: successor.observer, schedule: successor.schedule, groups: successor.groups, caps: successor.caps, reservation: successor.reservation, maxBroadcastAttempts: 1, approvedActions: successor.actions.map(({ id, commitment }) => ({ id, commitment })) };
  const approval = loadUsdcSuccessorApproval(successor, JSON.stringify(approvalDocument), sha256(approvalDocument) as Hex);
  const journal = structuredClone(attachUsdcSuccessor(fixture.source.journal, successor, approval));
  const records = successor.actions.map((action, index) => {
    const confirmed = action.expectedOutcome === "success";
    const transactionHash = hash((0xb00 + index).toString(16));
    const receipt = { transactionHash, status: "success" as const, gasUsed: 10n + BigInt(index), effectiveGasPrice: 7n, blockNumber: 12_016_100n + BigInt(index), blockHash: hash((0xc00 + index).toString(16)) };
    return {
      id: action.id, commitment: action.commitment, status: confirmed ? "confirmed" as const : "rejection-proved" as const,
      evidenceHash: hash((0xd00 + index).toString(16)),
      ...(confirmed ? { transactionHash, receipt, receiptInclusion: successorReceiptInclusion(receipt, successor.effectivePeriod, 60n + BigInt(index)), outerValue: "0", ourReceiptGasCost: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), ourPrincipalDelta: "0" } : {}),
    };
  });
  journal.usdcSuccessor.actions.splice(0, journal.usdcSuccessor.actions.length, ...records);
  journal.liveJournal.entries.push(...records.filter(record => record.status === "confirmed").map((record, index) => ({ id: record.id, intentHash: hash((0xe00 + index).toString(16)), transactionHash: record.transactionHash!, nonce: 900 + index, reserved: BigInt(record.ourReceiptGasCost!), status: "success" as const, receipt: record.receipt! })));
  const stoppedEvidence = rawHash(JSON.stringify(fixture.source.recovery.source.stoppedRow));
  const evidence = [
    ...journal.actions.map((record, index) => ({ actionId: record.id, evidenceHash: index === 18 ? stoppedEvidence : record.evidenceHash!, transactionHash: record.transactionHash })),
    ...journal.hashlessContinuation!.actions.slice(0, 3).map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash!, transactionHash: record.transactionHash })),
    ...records.map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash, transactionHash: record.transactionHash })),
  ];
  return { ...fixture, successor, approval, journal, records, evidence };
}

describe("closed ordinary repair-to-freeze continuation", () => {
  it("accepts all three closed complete canonical predecessors", async () => {
    const legacy = prefix();
    expect(verifyRepairPredecessor(legacy.proposal, legacy.journal, legacy.evidence)).to.include({ kind: "terminal-first38-v1", actionCount: 38, safeNonce: 14n, delayQueueNonce: 6n, delayTxNonce: 6n });

    const recovered = await closedHashlessPredecessor();
    const predecessor = verifyRepairPredecessor(recovered.original, recovered.journal, recovered.evidence, { kind: "expired-hashless-continuation-v1", continuation: recovered.proposal, approval: recovered.approval });
    expect(predecessor).to.include({ kind: "expired-hashless-continuation-v1", actionCount: 41, safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n });
    expect(predecessor).to.include({ certificateHash: recovered.proposal.certificateHash, continuationProposalHash: recovered.proposal.proposalHash, continuationApprovalHash: recovered.approval.approvalHash, observerEvidenceHash: recovered.proposal.observer.probeEvidenceHash });

    const usdc = await closedUsdcSuccessorPredecessor();
    const usdcPredecessor = verifyRepairPredecessor(usdc.source.original, usdc.journal, usdc.evidence, { kind: "usdc-period-successor-v1", source: usdc.source, certificate: usdc.certificate, successor: usdc.successor, approval: usdc.approval });
    expect(usdcPredecessor).to.include({ kind: "usdc-period-successor-v1", actionCount: 41, safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, effectivePeriod: 1793232000n });
    expect(usdcPredecessor).to.include({ certificateHash: usdc.certificate.certificateHash, continuationProposalHash: usdc.successor.proposalHash, continuationApprovalHash: usdc.approval.approvalHash, observerEvidenceHash: usdc.successor.observer.probeEvidenceHash });
  });

  it("rejects partial mixed forged orphaned or financially mutated USDC successor lineage", async () => {
    const recovered = await closedUsdcSuccessorPredecessor();
    const lineage = { kind: "usdc-period-successor-v1" as const, source: recovered.source, certificate: recovered.certificate, successor: recovered.successor, approval: recovered.approval };
    const partial = structuredClone(recovered.journal); partial.usdcSuccessor!.actions[18] = { id: recovered.successor.actions[18]!.id, commitment: recovered.successor.actions[18]!.commitment, status: "approved" };
    expect(() => verifyRepairPredecessor(recovered.source.original, partial, recovered.evidence, lineage)).to.throw(/successor|complete|canonical/i);
    const mutatedOld = structuredClone(recovered.journal); mutatedOld.hashlessContinuation!.actions[3]!.status = "confirmed" as any;
    expect(() => verifyRepairPredecessor(recovered.source.original, mutatedOld, recovered.evidence, lineage)).to.throw(/untouched|lineage|canonical/i);
    const orphan = structuredClone(recovered.journal); orphan.usdcSuccessor!.sourceHash = hash("bad");
    expect(() => verifyRepairPredecessor(recovered.source.original, orphan, recovered.evidence, lineage)).to.throw(/header|lineage|canonical/i);
    const absentInclusion = structuredClone(recovered.journal); delete (absentInclusion.usdcSuccessor!.actions.find(action => action.status === "confirmed") as any).receiptInclusion;
    expect(() => verifyRepairPredecessor(recovered.source.original, absentInclusion, recovered.evidence, lineage)).to.throw(/receipt inclusion/i);
    const changedInclusion = structuredClone(recovered.journal); (changedInclusion.usdcSuccessor!.actions.find(action => action.status === "confirmed") as any).receiptInclusion.blockHash = hash("bad");
    expect(() => verifyRepairPredecessor(recovered.source.original, changedInclusion, recovered.evidence, lineage)).to.throw(/receipt inclusion/i);
    const lateInclusion = structuredClone(recovered.journal); const later = lateInclusion.usdcSuccessor!.actions.at(-1) as any; later.receiptInclusion.blockTimestamp = recovered.successor.deadline; later.receiptInclusion.effectivePeriod = recovered.successor.deadline;
    expect(() => verifyRepairPredecessor(recovered.source.original, lateInclusion, recovered.evidence, lineage)).to.throw(/receipt inclusion.*outside|effective period/i);
    const badCost = structuredClone(recovered.journal); (badCost.usdcSuccessor!.actions.find(action => action.status === "confirmed") as any).ourReceiptGasCost = "1";
    expect(() => verifyRepairPredecessor(recovered.source.original, badCost, recovered.evidence, lineage)).to.throw(/receipt gas|accounting/i);
    const badNativePrincipal = structuredClone(recovered.journal); (badNativePrincipal.hashlessContinuation!.actions[2] as any).ourPrincipalDelta = "2";
    expect(() => verifyRepairPredecessor(recovered.source.original, badNativePrincipal, recovered.evidence, lineage)).to.throw(/principal accounting/i);
    const badNativeOuterValue = structuredClone(recovered.journal); (badNativeOuterValue.hashlessContinuation!.actions[2] as any).outerValue = "1"; const matchingLive = badNativeOuterValue.liveJournal.entries.find(entry => entry.id === "native-queue-ready-replacement-execute")!; matchingLive.reserved = BigInt(matchingLive.reserved) + 1n;
    expect(() => verifyRepairPredecessor(recovered.source.original, badNativeOuterValue, recovered.evidence, lineage)).to.throw(/principal accounting/i);
    const badNativeReservation = structuredClone(recovered.journal); const nativeLive = badNativeReservation.liveJournal.entries.find(entry => entry.id === "native-queue-ready-replacement-execute")!; nativeLive.reserved = BigInt(nativeLive.reserved) + 1n;
    expect(() => verifyRepairPredecessor(recovered.source.original, badNativeReservation, recovered.evidence, lineage)).to.throw(/live receipt gas accounting/i);
    expect(() => verifyRepairPredecessor(recovered.source.original, recovered.journal, recovered.evidence, { ...lineage, approval: { approvalHash: recovered.approval.approvalHash } as any })).to.throw(/opaque|authorization/i);
    expect(() => verifyRepairPredecessor(recovered.source.original, recovered.journal, recovered.evidence.slice(1), lineage)).to.throw(/evidence|41/i);
    const confirmed = [...recovered.journal.actions, ...recovered.journal.hashlessContinuation!.actions.slice(0, 3), ...recovered.journal.usdcSuccessor!.actions].filter((record): record is any => record.status === "confirmed");
    const adapter = (changedHash?: Hex) => createRepairMechanicalAdapter({ domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN, creation: { safe, guard, delay, funder, candidate, factory, x: quote.x.toString(), y: quote.y.toString(), verifiers: quote.verifiers.toString(), preRotationBlockNumber: "1", preRotationBlockHash: hash("1") }, primary, current: {} as never, archive: { getTransactionReceipt: async ({ hash: transactionHash }: { hash: Hex }) => { const record = confirmed.find(action => action.transactionHash === transactionHash)!; return { ...record.receipt, gasUsed: transactionHash === changedHash ? BigInt(record.receipt.gasUsed) + 1n : BigInt(record.receipt.gasUsed), effectiveGasPrice: BigInt(record.receipt.effectiveGasPrice), blockNumber: BigInt(record.receipt.blockNumber) }; } } as never, readStateAtBlock: async () => { throw new Error("unexpected state read"); }, loadPasskey: async () => { throw new Error("unexpected signer"); } });
    expect(await adapter().validateTerminalPrefix(recovered.journal)).to.have.length(41);
    await expect(adapter(confirmed.at(-1)!.transactionHash).validateTerminalPrefix(recovered.journal)).to.be.rejectedWith(/canonical receipt changed/i);
  });

  it("rebases the USDC successor repair spine while keeping raw native and effective periods separate", async () => {
    const recovered = await closedUsdcSuccessorPredecessor();
    const lineage = { kind: "usdc-period-successor-v1" as const, source: recovered.source, certificate: recovered.certificate, successor: recovered.successor, approval: recovered.approval };
    const before = state({ safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, candidateRuntimeCodeHash: hash("0"), candidateBindingHash: hash("0"), blockTimestamp: 1793232600n, nativeWindow: 1793145600n, usdcWindow: 1793232000n, nativeBaseSpent: 10000000000000n, nativeInstantSpent: 30000000000000n, usdcBaseSpent: 10000000n, usdcInstantSpent: 30000000n, nativeBalance: 0n, usdcBalance: 0n });
    const creation = createRepairCreationProposal({ proposal: recovered.source.original, journal: recovered.journal, evidence: recovered.evidence, lineage, state: before, quote });
    expect(creation.predecessor.kind).to.equal("usdc-period-successor-v1");
    expect(creation.predecessor.effectivePeriod).to.equal("1793232000");
    expect(creation.baseline.nativeWindow).to.equal("1793145600");
    expect(loadRepairCreationProposal(JSON.stringify(creation), creation.proposalHash).action.dependsOn).to.deep.equal(["usdc-successor-queue-ready-execute"]);
    const wrongDependency = structuredClone(creation) as any; wrongDependency.action.dependsOn = ["usdc-queue-ready-execute"]; const { proposalHash: _creationHash, ...wrongCreationBase } = wrongDependency; wrongDependency.proposalHash = rawHash(JSON.stringify(wrongCreationBase));
    expect(() => loadRepairCreationProposal(JSON.stringify(wrongDependency), wrongDependency.proposalHash)).to.throw(/action mismatch/i);
    approveCreation(recovered.journal, creation);
    recovered.journal.liveJournal.entries.push({ id: "repair-signer-create", intentHash: hash("e1"), transactionHash: hash("e2"), nonce: 999, reserved: 4321n, status: "success", receipt: { transactionHash: hash("e2"), status: "success", gasUsed: 4321n, effectiveGasPrice: 1n, blockNumber: 30n, blockHash: hash("e3") } });
    const prepared = createRepairGroupProposal({ creation, journal: recovered.journal, state: state({ ...before, candidateRuntimeCodeHash: hash("702"), candidateBindingHash: REPAIR_BINDING_HASH }), assertion: "0x123456", lineage });
    expect(prepared.proposal.establishedNativeWindow).to.equal("1793145600");
    expect(prepared.proposal.establishedEffectivePeriod).to.equal("1793232000");
    expect(loadRepairGroupProposal(JSON.stringify(prepared.proposal), prepared.proposal.proposalHash).establishedEffectivePeriod).to.equal("1793232000");
    expect(prepared.proposal.actions.at(-1)).to.include({ safeNonceAfter: "19", delayQueueNonceAfter: "9", delayTxNonceAfter: "9" });
    expect(() => assertRepairActionState(prepared.proposal, prepared.proposal.actions[3]!, state({ ...before, safeNonce: 16n, delayQueueNonce: 8n, delayTxNonce: 8n, safeContractSecondary: candidate, policyHash: "0xf77e71d221b6ba2ac8daba8f64e4527ff34322d22449d3159a4b92a0e9f07229", candidateRuntimeCodeHash: hash("702"), candidateBindingHash: REPAIR_BINDING_HASH, blockTimestamp: 1793318400n }), "before")).to.throw(/period rollover/i);
  });

  it("rejects_partial_mixed_forged_or_mutated_lineage", async () => {
    const recovered = await closedHashlessPredecessor();
    const lineage = { kind: "expired-hashless-continuation-v1" as const, continuation: recovered.proposal, approval: recovered.approval };
    const partial = structuredClone(recovered.journal); partial.hashlessContinuation!.actions[21] = { id: recovered.proposal.actions[21]!.id, commitment: recovered.proposal.actions[21]!.commitment, status: "approved" };
    expect(() => verifyRepairPredecessor(recovered.original, partial, recovered.evidence, lineage)).to.throw(/terminal|complete|canonical/i);
    expect(() => verifyRepairPredecessor(recovered.original, recovered.journal, recovered.evidence.slice(1), lineage)).to.throw(/evidence/i);
    const mutated = structuredClone(recovered.journal); (mutated.hashlessContinuation as any).certificateHash = hash("bad");
    expect(() => verifyRepairPredecessor(recovered.original, mutated, recovered.evidence, lineage)).to.throw(/lineage|header|canonical/i);
    const understated = structuredClone(recovered.journal); const understatedAction = understated.hashlessContinuation!.actions.find(action => action.status === "confirmed") as any; understatedAction.ourReceiptGasCost = "1";
    expect(() => verifyRepairPredecessor(recovered.original, understated, recovered.evidence, lineage)).to.throw(/receipt gas|accounting/i);
    const confirmed = [...recovered.journal.actions, ...recovered.journal.hashlessContinuation!.actions].filter((action): action is any => action.status === "confirmed"); const changedHash = confirmed[0]!.transactionHash;
    const adapter = createRepairMechanicalAdapter({ domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN, creation: { safe, guard, delay, funder, candidate, factory, x: quote.x.toString(), y: quote.y.toString(), verifiers: quote.verifiers.toString(), preRotationBlockNumber: "1", preRotationBlockHash: hash("1") }, primary, current: {} as never, archive: { getTransactionReceipt: async ({ hash: transactionHash }: { hash: Hex }) => { const record = confirmed.find(action => action.transactionHash === transactionHash)!; return { ...record.receipt, gasUsed: transactionHash === changedHash ? BigInt(record.receipt.gasUsed) - 1n : BigInt(record.receipt.gasUsed), effectiveGasPrice: BigInt(record.receipt.effectiveGasPrice), blockNumber: BigInt(record.receipt.blockNumber) }; } } as never, readStateAtBlock: async () => { throw new Error("unexpected state read"); }, loadPasskey: async () => { throw new Error("unexpected signer"); } });
    await expect(adapter.validateTerminalPrefix(recovered.journal)).to.be.rejectedWith(/canonical receipt|gas/i);
    expect(() => verifyRepairPredecessor(recovered.original, recovered.journal, recovered.evidence)).to.throw(/lineage|38-action/i);
    expect(() => verifyRepairPredecessor(recovered.original, recovered.journal, recovered.evidence, { ...lineage, approval: { approvalHash: recovered.approval.approvalHash } as any })).to.throw(/opaque|authorization/i);
  });

  it("rebases_repair_entire_spine", async () => {
    const recovered = await closedHashlessPredecessor();
    const lineage = { kind: "expired-hashless-continuation-v1" as const, continuation: recovered.proposal, approval: recovered.approval };
    const before = state({ safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, candidateRuntimeCodeHash: hash("0"), candidateBindingHash: hash("0"), nativeWindow: 1793145600n, usdcWindow: 0n, nativeBaseSpent: 10000000000000n, nativeInstantSpent: 30000000000000n, usdcBaseSpent: 10000000n, usdcInstantSpent: 30000000n, nativeBalance: 0n, usdcBalance: 1000000n });
    const creation = createRepairCreationProposal({ proposal: recovered.original, journal: recovered.journal, evidence: recovered.evidence, lineage, state: before, quote });
    const continuationGas = recovered.proposal.actions.filter(action => action.expectedOutcome === "success").length * 100;
    expect(creation.cumulativeActualCostWei).to.equal((BigInt(recovered.proposal.reservation.originalActualGasCostWei) + 60000000000001n + 1n + BigInt(continuationGas)).toString());
    expect(creation.predecessor.kind).to.equal("expired-hashless-continuation-v1");
    approveCreation(recovered.journal, creation);
    recovered.journal.liveJournal.entries.push({ id: "repair-signer-create", intentHash: recovered.h("e"), transactionHash: recovered.h("d"), nonce: 900, reserved: 4321n, status: "success", receipt: { transactionHash: recovered.h("d"), status: "success", gasUsed: 4321n, effectiveGasPrice: 1n, blockNumber: 30n, blockHash: recovered.h("c") } });
    expect(verifyRepairPredecessor(recovered.original, recovered.journal, recovered.evidence, lineage).prefixHash).to.equal(creation.prefixHash);
    const prepared = createRepairGroupProposal({ creation, journal: recovered.journal, state: state({ ...before, candidateRuntimeCodeHash: hash("702"), candidateBindingHash: REPAIR_BINDING_HASH }), assertion: "0x123456", lineage });
    expect(prepared.proposal.actions.map(action => [action.id, action.safeNonceBefore, action.safeNonceAfter, action.delayQueueNonceBefore, action.delayQueueNonceAfter, action.delayTxNonceBefore, action.delayTxNonceAfter])).to.deep.equal([
      ["repair-queue", "15", "16", "7", "8", "7", "7"], ["repair-ready-execute", "16", "16", "8", "8", "7", "8"], ["post-rotation-old-secondary-rejection", "16", "16", "8", "8", "8", "8"], ["post-rotation-new-secondary-queue", "16", "17", "8", "9", "8", "8"], ["post-rotation-proof-cancel", "17", "18", "9", "9", "8", "9"], ["final-freeze", "18", "19", "9", "9", "9", "9"],
    ]);
    expect(prepared.proposal.repairQueueTiming.queueNonce).to.equal("7");
    const signer = (signerAddress: Address, role: "primary" | "secondary") => ({ address: signerAddress, kind: "safe-contract" as const, role, sign: async () => encodeSafeContractSignature(signerAddress, "0x12") });
    const signed = await materializeRepairPrimaryFirstSafeCall({ chainId: prepared.proposal.chainId, safe: prepared.proposal.safe, to: prepared.proposal.delay, data: prepared.transient.safeTransactionData, nonce: 15n, safeTxHash: prepared.proposal.actions[0]!.safeTxHash!, primary: signer(primary, "primary"), secondary: signer(oldSecondary, "secondary") });
    const decoded = decodeFunctionData({ abi: safeExecAbi, data: signed }); const args = decoded.args as readonly [Address, bigint, Hex, number, bigint, bigint, bigint, Address, Address, Hex]; expect(args[2]).to.equal(prepared.transient.safeTransactionData); expect(hashTypedData({ domain: { chainId: prepared.proposal.chainId, verifyingContract: prepared.proposal.safe }, types: { SafeTx: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" }] }, primaryType: "SafeTx", message: { to: args[0], value: args[1], data: args[2], operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: args[7], refundReceiver: args[8], nonce: 15n } })).to.equal(prepared.proposal.actions[0]!.safeTxHash);
    expect(repairObserverExpectedEffect(prepared.proposal, prepared.proposal.actions[0]!, 1n).queueNonce).to.equal(7n); expect(repairObserverExpectedEffect(prepared.proposal, prepared.proposal.actions[3]!, 1n).queueNonce).to.equal(8n); expect(repairObserverExpectedEffect(prepared.proposal, prepared.proposal.actions[4]!, 1n).cancelledThrough).to.equal(9n);
  });

  it("rejects noncanonical combined live catalogs through an actual disk reload", async () => {
    const recovered = await closedHashlessPredecessor(); const lineage = { kind: "expired-hashless-continuation-v1" as const, continuation: recovered.proposal, approval: recovered.approval };
    const before = state({ safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, candidateRuntimeCodeHash: hash("0"), candidateBindingHash: hash("0"), nativeWindow: 1793145600n, usdcWindow: 0n, nativeBaseSpent: 10000000000000n, nativeInstantSpent: 30000000000000n, usdcBaseSpent: 10000000n, usdcInstantSpent: 30000000n, nativeBalance: 0n, usdcBalance: 1000000n });
    const creation = createRepairCreationProposal({ proposal: recovered.original, journal: recovered.journal, evidence: recovered.evidence, lineage, state: before, quote }); extendJournalForRepair(recovered.journal, creation);
    const identity = { proposalHash: recovered.original.proposalHash, approvalHash: recovered.journal.approvalHash, funder: recovered.original.funder }; const directory = mkdtempSync(join(tmpdir(), "repair-codec-lineage-"));
    const reload = (name: string, journal: OrdinaryScenarioJournal) => { const store = createOrdinaryScenarioStore(join(directory, `${name}.json`), identity, () => journal); store.close?.(); };
    try {
      reload("canonical", structuredClone(recovered.journal));
      const mutations: Array<[string, (journal: OrdinaryScenarioJournal) => void]> = [
        ["extra", journal => { const source = structuredClone(journal.liveJournal.entries[10]!); source.id = "unknown-success"; journal.liveJournal.entries.splice(24, 0, source); }],
        ["duplicate", journal => { journal.liveJournal.entries[11]!.id = journal.liveJournal.entries[10]!.id; }],
        ["reordered", journal => { [journal.liveJournal.entries[10], journal.liveJournal.entries[11]] = [journal.liveJournal.entries[11]!, journal.liveJournal.entries[10]!]; }],
        ["pending", journal => { (journal.liveJournal.entries[10] as any).status = "pending"; delete (journal.liveJournal.entries[10] as any).receipt; }],
        ["reverted", journal => { (journal.liveJournal.entries[10] as any).status = "reverted"; (journal.liveJournal.entries[10]!.receipt as any).status = "reverted"; }],
      ];
      for (const [name, mutate] of mutations) { const journal = structuredClone(recovered.journal); mutate(journal); expect(() => reload(name, journal), name).to.throw(/lineage|catalog|prefix|coexistence/i); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("does not inspect thrown strings or hostile objects at the repair entrypoint", async () => {
    const stringMarker = "SIGNED_SAFE_CALLDATA_MARKER_repair";
    let messageRead = false; let stringified = false;
    const hostile = Object.create(null, {
      message: { get: () => { messageRead = true; throw new Error("message getter evaluated"); } },
      toString: { value: () => { stringified = true; throw new Error("toString evaluated"); } },
    });
    for (const failure of [stringMarker, hostile]) {
      let stderr = ""; let exitCode = 0;
      await runOrdinaryScenarioRepairEntryPoint(Promise.reject(failure), { writeStderr: value => { stderr += value; }, setExitCode: value => { exitCode = value; } });
      expect(exitCode).to.equal(1);
      expect(stderr).to.equal("[ORDINARY_SCENARIO_REPAIR_FAILED] ordinary scenario repair failed\n");
      expect(stderr).not.to.include(stringMarker);
    }
    expect(messageRead).to.equal(false);
    expect(stringified).to.equal(false);
  });

  it("preserves the frozen production proposal and rejects foreign unbranded domains", () => {
    const reportPath = join(process.cwd(), "test/fixtures/ordinary-scenario-review.public.json"); const raw = readFileSync(reportPath, "utf8"); const expected = { expectedPackageHash: "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571" as Hex, expectedArtifactBytesHash: "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831" as Hex };
    expect(createOrdinaryScenarioProposal(raw, expected).proposalHash).to.equal("0x22770c7944ee289543c10090b3483bdcd87f0d2c193887df4f32916c5782e45f");
    expect(() => createOrdinaryScenarioProposal(raw.replace('"11155111"', '"31337"'), { ...expected, expectedArtifactBytesHash: rawHash(raw.replace('"11155111"', '"31337"')) }, { chainId: 31337 })).to.throw("domain is not canonically verified");
  });
  it("hides current observer readiness only from historical pending reconciliation state reads", async () => {
    let readinessCalls = 0; const canonicalBlock = { number: 1n, hash: hash("701"), timestamp: 1n }; const creation = { safe, guard, delay, funder, candidate, factory, x: quote.x.toString(), y: quote.y.toString(), verifiers: quote.verifiers.toString(), preRotationBlockNumber: "1", preRotationBlockHash: hash("702") };
    const current = { getBlock: async () => canonicalBlock, readContract: async () => 0n, getBalance: async () => 0n, getCode: async () => "0x" }; const harness: any = { current, archive: { getBlock: async () => canonicalBlock }, observerReadiness: async () => { readinessCalls += 1; return { ready: false }; }, loadClosedPasskey: async () => { throw new Error("unexpected signer"); } }; const reconstructed: any = { config: { erc20: address("777"), primaryPasskey: primary } };
    const historical = createRepairProductionAdapter({ repository: process.cwd(), harness, reconstructed, creation, domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN, observerMode: "historical" }); await expect(historical.readState("post-rotation", hash("703"))).to.be.rejectedWith(/immutable pre-rotation block changed/); expect(readinessCalls).to.equal(0);
    const fresh = createRepairProductionAdapter({ repository: process.cwd(), harness, reconstructed, creation, domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN, observerMode: "current" }); await expect(fresh.readState("post-rotation", hash("703"))).to.be.rejectedWith(/immutable pre-rotation block changed/); expect(readinessCalls).to.equal(1);
  });
  it("dispatches each of the five runnable main branches exactly once", async () => {
    const seen: string[] = [];
    const runtime = {
      creationReview: async (args: readonly string[]) => seen.push(`creation-review:${args.join(",")}`),
      creationSubmit: async (args: readonly string[]) => seen.push(`creation-submit:${args.join(",")}`),
      prepareQueue: async (args: readonly string[]) => seen.push(`prepare-queue:${args.join(",")}`),
      tailSubmitOne: async (args: readonly string[]) => seen.push(`tail-submit-one:${args.join(",")}`),
      tailResumeOne: async (args: readonly string[]) => seen.push(`tail-resume-one:${args.join(",")}`),
    };
    for (const command of ["creation-review", "creation-submit", "prepare-queue", "tail-submit-one", "tail-resume-one"] as const) await runRepairCommand([command, "--marker", command], runtime);
    expect(seen).to.deep.equal(["creation-review:--marker,creation-review", "creation-submit:--marker,creation-submit", "prepare-queue:--marker,prepare-queue", "tail-submit-one:--marker,tail-submit-one", "tail-resume-one:--marker,tail-resume-one"]);
  });
  it("accepts exactly one canonical factory Created result and rejects missing, duplicate, or mismatched logs", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote });
    const log = { address: factory, topics: encodeEventTopics({ abi: [createdEvent], eventName: "Created" }).filter((topic): topic is Hex => typeof topic === "string"), data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }], [candidate, quote.x, quote.y, quote.verifiers]) };
    expect(validateRepairCreationReceiptLogs(creation, [log])).to.equal(true);
    expect(() => validateRepairCreationReceiptLogs(creation, [])).to.throw("one exact");
    expect(() => validateRepairCreationReceiptLogs(creation, [log, log])).to.throw("one exact");
    const wrong = { ...log, data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }], [oldSecondary, quote.x, quote.y, quote.verifiers]) };
    expect(() => validateRepairCreationReceiptLogs(creation, [wrong])).to.throw("fields mismatch");
  });

  it("preserves the terminal 38-action prefix, embedded LiveJournal, and cumulative phase cost", () => {
    const f = prefix();
    const proposal = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote });
    expect(proposal.action.id).to.equal("repair-signer-create");
    expect(proposal.cumulativeActualCostWei).to.equal((1000n + BigInt(f.journal.liveJournal.entries.length) * 100n).toString());
    expect(proposal.maximumCumulativeOutlayWei).to.equal((BigInt(proposal.cumulativeActualCostWei) + 740292000000n).toString());
    const extended = extendJournalForRepair(f.journal, proposal);
    expect(extended).to.equal(f.journal);
    expect(extended.liveJournal.entries).to.deep.equal(f.journal.liveJournal.entries);
    expect(JSON.stringify(extended, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.to.include("calldata");
    const incomplete = prefix(); incomplete.journal.actions.pop();
    expect(() => createRepairCreationProposal({ ...incomplete, state: state({ candidateRuntimeCodeHash: hash("0") }), quote })).to.throw("38-action");
    expect(() => createRepairCreationProposal({ ...f, state: state({ safeNonce: 15n, candidateRuntimeCodeHash: hash("0") }), quote })).to.throw("nonce");
    expect(validateRepairCreationSimulation(proposal, `0x${candidate.slice(2).padStart(64, "0")}` as Hex)).to.equal(true);
    expect(() => validateRepairCreationSimulation(proposal, `0x${oldSecondary.slice(2).padStart(64, "0")}` as Hex)).to.throw("wrong signer");
    expect(() => validateRepairCreationSimulation(proposal, "0x01")).to.throw("canonical address word");
  });

  it("persists the continuation header in the original atomic journal file", () => {
    const f = prefix(); const proposal = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); extendJournalForRepair(f.journal, proposal);
    const directory = mkdtempSync(join(tmpdir(), "repair-continuation-")); const path = join(directory, "journal.json"); const identity = { proposalHash: f.proposal.proposalHash, approvalHash: f.journal.approvalHash, funder };
    try {
      const first = createOrdinaryScenarioStore(path, identity, () => f.journal); first.save(f.journal); first.close?.();
      const second = createOrdinaryScenarioStore(path, identity, () => { throw new Error("must reload"); });
      expect((second.load() as OrdinaryScenarioJournal & { repairContinuation?: { prefixHash: Hex } }).repairContinuation?.prefixHash).to.equal(proposal.prefixHash);
      expect(second.load().liveJournal.entries).to.have.length(f.journal.liveJournal.entries.length); second.close?.();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects caller-supplied state, evidence, and quote authority before public creation review", async () => {
    const directory = mkdtempSync(join(tmpdir(), "repair-public-review-"));
    const reportPath = join(process.cwd(), "test/fixtures/ordinary-scenario-review.public.json");
    const raw = readFileSync(reportPath, "utf8");
    const original = createOrdinaryScenarioProposal(raw, { expectedPackageHash: "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", expectedArtifactBytesHash: "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831" });
    const approvalHash = hash("abc"); const journalPath = join(directory, "journal.json"); const evidencePath = join(directory, "evidence.json"); const statePath = join(directory, "state.json"); const quotePath = join(directory, "quote.json");
    const terminal = original.actions.map((action, index) => ({ id: action.id, commitment: action.commitment, status: action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed", transactionHash: action.expectedOutcome === "rejection" ? undefined : hash((900 + index).toString(16)), evidenceHash: hash((1000 + index).toString(16)) }));
    writeFileSync(journalPath, JSON.stringify({ schemaVersion: 1, chainId: 11155111, reviewPackageHash: original.reviewPackageHash, proposalHash: original.proposalHash, approvalHash, funder: original.funder, liveJournal: { chainId: 11155111, funder: original.funder, entries: [] }, actions: terminal }));
    writeFileSync(evidencePath, JSON.stringify(terminal.map(action => ({ actionId: action.id, evidenceHash: action.evidenceHash, transactionHash: action.transactionHash }))));
    writeFileSync(statePath, JSON.stringify({ ...state({ candidateRuntimeCodeHash: hash("0"), candidateBindingHash: hash("0"), topologyEvidenceHash: original.topologyEvidenceHash }), blockNumber: "12010000", blockTimestamp: "1770000000", safeNonce: "14", delayQueueNonce: "6", delayTxNonce: "6", nativeWindow: "1769990400", nativeBaseSpent: "10000000000000", nativeInstantSpent: "30000000000000", nativeBalance: "1", usdcBalance: "1" }, (_, value) => typeof value === "bigint" ? value.toString() : value));
    writeFileSync(quotePath, JSON.stringify({ ...quote, x: quote.x.toString(), y: quote.y.toString(), verifiers: quote.verifiers.toString(), gasLimitCap: quote.gasLimitCap.toString(), maxFeePerGasCap: quote.maxFeePerGasCap.toString(), maxPriorityFeePerGasCap: quote.maxPriorityFeePerGasCap.toString() }));
    try {
      for (const [flag, path] of [["--evidence", evidencePath], ["--state", statePath], ["--quote", quotePath]] as const) {
        let error: unknown;
        const runtime = createRepairCommandRuntime({ environment: {}, domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN, ordinaryDomain: PRODUCTION_ORDINARY_SCENARIO_DOMAIN, repository: () => { throw new Error("unexpected repository access"); }, createHarness: () => { throw new Error("unexpected harness access"); }, createAdapter: () => { throw new Error("unexpected adapter access"); }, loadCreationQuote: () => { throw new Error("unexpected quote access"); }, submit: async () => { throw new Error("unexpected submit"); }, now: () => new Date(0), awaitApprovalHandoff: async () => { throw new Error("unexpected approval"); } });
        try { await runtime.creationReview(["--report", reportPath, "--artifact-hash", "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831", "--package-hash", "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", "--proposal-hash", original.proposalHash, "--original-approval-hash", approvalHash, "--journal", journalPath, flag, path]); } catch (caught) { error = caught; }
        expect(String(error)).to.include(`rejects unknown flag ${flag}`);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("loads the complete shared hashless lineage before acquiring the repair journal lease", async () => {
    let loaded: readonly string[] | undefined;
    const runtime = createRepairCommandRuntime({
      environment: {}, domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN, ordinaryDomain: PRODUCTION_ORDINARY_SCENARIO_DOMAIN,
      repository: () => { throw new Error("journal lease was reached before shared loader"); }, createHarness: () => { throw new Error("unexpected harness"); }, createAdapter: () => { throw new Error("unexpected adapter"); }, loadCreationQuote: () => { throw new Error("unexpected quote"); }, submit: async () => { throw new Error("unexpected submit"); }, now: () => new Date(0), awaitApprovalHandoff: async () => { throw new Error("unexpected approval"); },
      loadHashlessLineage: async argv => { loaded = argv; throw new Error("shared loader reached"); },
    });
    const arguments_ = ["--report", "report.json", "--artifact-hash", hash("1"), "--package-hash", hash("2"), "--proposal-hash", hash("3"), "--original-approval-hash", hash("4"), "--journal", "journal.json", "--continuation-certificate", "certificate.json", "--continuation-certificate-hash", hash("5"), "--continuation-proposal", "continuation.json", "--continuation-approval", "approval.json", "--continuation-approval-hash", hash("6")];
    await expect(runtime.creationReview(arguments_)).to.be.rejectedWith("shared loader reached");
    expect(loaded).to.deep.equal(["submit-one", "--source-journal", "journal.json", "--original-report", "report.json", "--original-package-hash", hash("2"), "--original-artifact-hash", hash("1"), "--original-proposal-hash", hash("3"), "--certificate", "certificate.json", "--certificate-hash", hash("5"), "--proposal", "continuation.json", "--approval", "approval.json", "--approval-hash", hash("6"), "--journal", "journal.json"]);
    await expect(runtime.creationReview(arguments_.slice(0, -2))).to.be.rejectedWith("complete shared public loader inputs");
  });

  it("requires the complete unmixed USDC successor flag set and reaches the shared public loader before the writer lease", async () => {
    let loaded: readonly string[] | undefined;
    const runtime = createRepairCommandRuntime({
      environment: {}, domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN, ordinaryDomain: PRODUCTION_ORDINARY_SCENARIO_DOMAIN,
      repository: () => { throw new Error("journal lease reached before USDC loader"); }, createHarness: () => { throw new Error("unexpected harness"); }, createAdapter: () => { throw new Error("unexpected adapter"); }, loadCreationQuote: () => { throw new Error("unexpected quote"); }, submit: async () => { throw new Error("unexpected submit"); }, now: () => new Date(0), awaitApprovalHandoff: async () => { throw new Error("unexpected approval"); },
      loadUsdcSuccessorLineage: async argv => { loaded = argv; throw new Error("USDC shared loader reached"); },
    });
    const flags = ["--recovery-certificate", "recovery-certificate.json", "--recovery-certificate-hash", hash("5"), "--recovery-proposal", "recovery-proposal.json", "--recovery-approval", "recovery-approval.json", "--recovery-approval-hash", hash("6"), "--primary-bundle-manifest", "manifest.json", "--successor-certificate", "successor-certificate.json", "--successor-certificate-hash", hash("7"), "--successor-proposal", "successor-proposal.json", "--successor-approval", "successor-approval.json", "--successor-approval-hash", hash("8")];
    const arguments_ = ["--report", "report.json", "--artifact-hash", hash("1"), "--package-hash", hash("2"), "--proposal-hash", hash("3"), "--original-approval-hash", hash("4"), "--journal", "journal.json", ...flags];
    await expect(runtime.creationReview(arguments_)).to.be.rejectedWith("USDC shared loader reached");
    expect(loaded).to.deep.equal(["submit-one", "--source-journal", "journal.json", "--original-report", "report.json", "--original-package-hash", hash("2"), "--original-artifact-hash", hash("1"), "--original-proposal-hash", hash("3"), ...flags, "--journal", "journal.json"]);
    await expect(runtime.creationReview(arguments_.slice(0, -2))).to.be.rejectedWith("complete shared public loader inputs");
    await expect(runtime.creationReview([...arguments_, "--continuation-certificate", "mixed.json"])).to.be.rejectedWith("cannot mix predecessor routes");
  });

  it("keylessly resumes one known recovered-lineage hash after observer expiry using its timely acknowledgement", async () => {
    const recovered = await closedHashlessPredecessor(); const lineage = { kind: "expired-hashless-continuation-v1" as const, continuation: recovered.proposal, approval: recovered.approval };
    const before = state({ safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, candidateRuntimeCodeHash: hash("0"), candidateBindingHash: hash("0"), nativeWindow: 1793145600n, usdcWindow: 0n, nativeBaseSpent: 10000000000000n, nativeInstantSpent: 30000000000000n, usdcBaseSpent: 10000000n, usdcInstantSpent: 30000000n, nativeBalance: 0n, usdcBalance: 1000000n });
    const creation = createRepairCreationProposal({ proposal: recovered.original, journal: recovered.journal, evidence: recovered.evidence, lineage, state: before, quote }); approveCreation(recovered.journal, creation);
    const group = createRepairGroupProposal({ creation, journal: recovered.journal, state: state({ ...before, candidateRuntimeCodeHash: hash("702"), candidateBindingHash: REPAIR_BINDING_HASH }), assertion: "0x123456", lineage }).proposal; const cancel = group.actions[4]!; const pendingHash = hash("f01");
    const continuation = recovered.journal.repairContinuation!; continuation.groupProposalHash = group.proposalHash; continuation.groupApprovalHash = hash("f02"); continuation.actions.push(...group.actions.map((action, index) => ({ id: action.id, commitment: action.commitment, status: index === 2 ? "rejection-proved" as const : index < 4 ? "confirmed" as const : index === 4 ? "pending" as const : "approved" as const, ...(index < 4 ? { evidenceHash: hash((0xf10 + index).toString(16)) } : {}), ...(index === 4 ? { transactionHash: pendingHash } : {}) })));
    recovered.journal.liveJournal.entries.push({ id: cancel.id, intentHash: hash("f03"), transactionHash: pendingHash, nonce: 901, reserved: 2_000_000_000_000n, status: "pending" });
    const directory = mkdtempSync(join(tmpdir(), "repair-expired-resume-")); const journalPath = join(directory, "journal.json"), creationPath = join(directory, "creation.json"), groupPath = join(directory, "group.json"), ledgerPath = join(directory, "ledger.json"), acknowledgementPath = join(directory, "ack.json");
    try {
      const store = createOrdinaryScenarioStore(journalPath, { proposalHash: recovered.original.proposalHash, approvalHash: recovered.journal.approvalHash, funder: recovered.original.funder }, () => recovered.journal); store.save(recovered.journal); store.close?.(); writeFileSync(creationPath, JSON.stringify(creation)); writeFileSync(groupPath, JSON.stringify(group));
      const blockNumber = 12_020_000n, blockHash = hash("f04"); const expected = repairObserverExpectedEffect(group, cancel, blockNumber); if (expected.kind !== "delayed-cancelled" || expected.cancelledThrough === undefined) throw new Error("expected cancellation observer effect"); const alert: ActivityAlert = { chainId: 11155111, safe: group.safe, transactionHash: pendingHash, blockNumber, logIndex: 0, kind: expected.kind, delay: expected.delay, cancelledThrough: expected.cancelledThrough }; const key = { chainId: 11155111, transactionHash: pendingHash, blockHash, logIndex: 0 }; const readyAtMs = Number(BigInt(recovered.proposal.observer.readyAt)) * 1000; const readyAt = new Date(readyAtMs).toISOString(); const expiresAt = new Date(Number(BigInt(recovered.proposal.observer.expiresAt)) * 1000).toISOString(); const retrievedAt = new Date(readyAtMs + 120_000).toISOString(); const activityStore = new FileActivityStore(ledgerPath); const ledger = new ActivityLedger(activityStore); ledger.accept(key, alert); const payloadSha256 = ledger.payloadHash(alert); ledger.markDelivered(key, { channel: "webhook", httpStatus: 200, payloadHash: payloadSha256, deliveredAt: new Date(readyAtMs + 60_000).toISOString() }); activityStore.close();
      writeFileSync(acknowledgementPath, JSON.stringify({ schemaVersion: 1, endpointHash: recovered.proposal.observer.endpointHash, transactionHash: pendingHash, payloadSha256, receiverRequestId: "repair-expired-resume", receiverRecordedAt: new Date(readyAtMs - 1_000).toISOString(), retrievedAt, retrievalProvenance: "official-receiver-api", expiresAt }));
      let observerMode: string | undefined, recoveredHash: Hex | undefined, signed = false, broadcast = false; const receipt = { transactionHash: pendingHash, status: "success" as const, gasUsed: 100n, effectiveGasPrice: 1n, blockNumber, blockHash };
      const after = state({ ...before, blockNumber, blockHash, safeNonce: 18n, delayQueueNonce: 9n, delayTxNonce: 9n, safeContractSecondary: candidate, candidateRuntimeCodeHash: hash("702"), candidateBindingHash: REPAIR_BINDING_HASH, policyHash: group.afterPolicyHash, frozen: false });
      const harness: any = { current: { getTransactionReceipt: async () => ({ logs: [] }) }, reconstructedProfile: async () => ({}), createLiveContext: async (_mode: string, _funder: Address, persist: (journal: any) => Promise<void>) => ({ funder, chainId: async () => 11155111, nonce: async () => 901, balance: async () => 1n, verify: async () => {}, sign: async () => { signed = true; throw new Error("must not sign"); }, broadcast: async () => { broadcast = true; throw new Error("must not broadcast"); }, receipt: async () => undefined, persist }) };
      const createAdapter: any = (input: any) => { observerMode = input.observerMode; return { validateTerminalPrefix: async () => recovered.evidence, recoverPendingIntent: async (_group: any, _action: any, transactionHash: Hex) => { recoveredHash = transactionHash; return { id: cancel.id, to: group.safe, data: "0x12", value: 0n, nonce: 901, gas: 2_000_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n }; }, validateReceiptEffect: () => true, readStateAt: async () => after, proveFrozenRejections: async () => true }; }; const runtime = createRepairCommandRuntime({ environment: {}, domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN, ordinaryDomain: PRODUCTION_ORDINARY_SCENARIO_DOMAIN, repository: () => directory, createHarness: () => harness, createAdapter, loadCreationQuote: () => quote, now: () => new Date((Number(BigInt(recovered.proposal.observer.expiresAt)) + 100) * 1000), awaitApprovalHandoff: async () => { throw new Error("unexpected approval"); }, loadHashlessLineage: async () => ({ original: recovered.original, journal: recovered.journal, certificate: {} as any, continuation: recovered.proposal, approval: recovered.approval }), submit: async (_intent, liveJournal, live) => { const updated = structuredClone(liveJournal); const entry = updated.entries.find(item => item.id === cancel.id)!; entry.status = "success"; entry.receipt = receipt; await live.persist(updated); return entry; } });
      const common = ["--creation", creationPath, "--creation-hash", creation.proposalHash, "--report", "unused-report.json", "--artifact-hash", recovered.original.reviewArtifactBytesHash, "--package-hash", recovered.original.reviewPackageHash, "--proposal-hash", recovered.original.proposalHash, "--original-approval-hash", recovered.journal.approvalHash, "--journal", journalPath, "--group", groupPath, "--group-hash", group.proposalHash, "--observer-ledger", ledgerPath, "--receiver-ack", acknowledgementPath, "--continuation-certificate", "certificate.json", "--continuation-certificate-hash", recovered.proposal.certificateHash, "--continuation-proposal", "continuation.json", "--continuation-approval", "approval.json", "--continuation-approval-hash", recovered.approval.approvalHash];
      await expect(runtime.tailResumeOne(common)).to.be.rejectedWith("window");
      writeFileSync(acknowledgementPath, JSON.stringify({ schemaVersion: 1, endpointHash: recovered.proposal.observer.endpointHash, transactionHash: pendingHash, payloadSha256, receiverRequestId: "repair-expired-resume", receiverRecordedAt: readyAt, retrievedAt, retrievalProvenance: "official-receiver-api", expiresAt }));
      expect(await runtime.tailResumeOne(common)).to.deep.equal({ status: "CONFIRMED", actionId: cancel.id }); expect(observerMode).to.equal("historical"); expect(recoveredHash).to.equal(pendingHash); expect(signed).to.equal(false); expect(broadcast).to.equal(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("builds only the exact seven-action map and keeps assertion and nested calldata out of public JSON", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote });
    approveCreation(f.journal, creation);
    const assertion = "0x123456" as Hex;
    const prepared = createRepairGroupProposal({ creation, journal: f.journal, state: state(), assertion }); const group = prepared.proposal;
    expect([creation.action.id, ...group.actions.map(action => action.id)]).to.deep.equal(REPAIR_ACTION_IDS);
    expect(group.actions.map(action => [action.safeNonceBefore, action.safeNonceAfter, action.delayQueueNonceBefore, action.delayQueueNonceAfter, action.delayTxNonceBefore, action.delayTxNonceAfter])).to.deep.equal([
      ["14", "15", "6", "7", "6", "6"], ["15", "15", "7", "7", "6", "7"], ["15", "15", "7", "7", "7", "7"],
      ["15", "16", "7", "8", "7", "7"], ["16", "17", "8", "8", "7", "8"], ["17", "18", "8", "8", "8", "8"],
    ]);
    expect(group.actions[2]!.safeTxHash).to.equal(group.actions[3]!.safeTxHash);
    expect(group.actions[1]!.gasLimitCap).to.equal("1000000");
    expect(BigInt(group.maximumCumulativeOutlayWei) - BigInt(group.cumulativeActualCostWei)).to.equal(9_000_000_000_000n);
    const serialized = JSON.stringify(group);
    expect(serialized).not.to.include(assertion.slice(2));
    expect(serialized).not.to.include(prepared.transient.maintenanceCalldata);
    expect(group.repair.assertionHash).to.equal(keccak256(assertion));
    expect(group.repair.proofHash).to.equal(REPAIR_PROOF_HASH);
    expect(group.repair.maintenance.toLowerCase()).to.equal(REPAIR_MAINTENANCE);
    expect(group.recipient.toLowerCase()).to.equal(REPAIR_RECIPIENT);
    expect(group.repairQueueTiming).to.deep.include({ source: "CANONICAL_RECEIPT_CREATED_AT_ONLY", queueNonce: "6", cooldownSeconds: "120", expirationSeconds: "600" });
  });

  it("refreshes creation cost and binds native and USDC baseline state into the group", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    f.journal.liveJournal.entries.push({ id: "repair-signer-create", intentHash: hash("d01"), transactionHash: hash("d02"), nonce: 99, reserved: 4321n, status: "success", receipt: { transactionHash: hash("d02"), status: "success", gasUsed: 4321n, effectiveGasPrice: 1n, blockNumber: 20n, blockHash: hash("d03") } });
    const group = createRepairGroupProposal({ creation, journal: f.journal, state: state(), assertion: "0x123456" }).proposal;
    expect(BigInt(group.cumulativeActualCostWei)).to.equal(BigInt(creation.cumulativeActualCostWei) + 4321n);
    expect(f.journal.repairContinuation?.cumulativeActualCostWei).to.equal(group.cumulativeActualCostWei);
    expect(() => assertRepairBaselineUnchanged(group, state({ usdcInstantSpent: state().usdcInstantSpent + 1n }))).to.throw("balance/counter drift");
    expect(() => assertRepairBaselineUnchanged(group, state({ nativeBalance: 2n }))).to.throw("balance/counter drift");
  });

  it("derives the execution window only from canonical queue receipt timing", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    const group = createRepairGroupProposal({ creation, journal: f.journal, state: state(), assertion: "0x123456" }).proposal;
    const evidence = { transactionHash: hash("e01"), blockNumber: 10n, blockHash: hash("e02"), queueFingerprint: group.repairQueueTiming.queueFingerprint, createdAt: 1000n, readyAt: 1120n, expiresAt: 1720n, maintenanceCalldata: "0x1234" as Hex };
    expect(() => assertRepairQueueTiming(group, evidence, state({ blockTimestamp: 1119n }))).to.throw("not ready");
    assertRepairQueueTiming(group, evidence, state({ blockTimestamp: 1120n }));
    expect(() => assertRepairQueueTiming(group, evidence, state({ blockTimestamp: 1720n }))).to.throw("expired");
    expect(() => assertRepairQueueTiming(group, { ...evidence, readyAt: 1119n }, state({ blockTimestamp: 1120n }))).to.throw("timing evidence");
  });

  it("independently decodes transient repair bytes and rejects every fixed-field or proof mutation", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    const prepared = createRepairGroupProposal({ creation, journal: f.journal, state: state(), assertion: "0x123456" }); const group = prepared.proposal;
    expect(validateTransientRepairQueue(group, prepared.transient.safeTransactionData, prepared.transient.maintenanceCalldata)).to.equal(true);
    const wrong = encodeFunctionData({ abi: [{ type: "function", name: "replaceSigner", stateMutability: "nonpayable", inputs: [{ type: "address", name: "guard" }, { type: "uint8", name: "role" }, { type: "address", name: "expectedOld" }, { type: "address", name: "replacement" }, { type: "address", name: "previousOwner" }, { type: "uint256", name: "threshold" }, { type: "bytes", name: "replacementProof" }] }] as const, functionName: "replaceSigner", args: [guard, 0, oldSecondary, candidate, address("0"), 1n, "0x123456"] });
    expect(() => validateTransientRepairQueue(group, prepared.transient.safeTransactionData, wrong)).to.throw("decoded");
    expect(() => validateTransientRepairQueue(group, `${prepared.transient.safeTransactionData}00` as Hex, prepared.transient.maintenanceCalldata)).to.throw("canonical");
  });

  it("validates the exact Safe and Delay confirmation callbacks and rejects a mutated queue effect", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    const prepared = createRepairGroupProposal({ creation, journal: f.journal, state: state(), assertion: "0x123456" }); const action = prepared.proposal.actions[0]!;
    const topics = (value: ReturnType<typeof encodeEventTopics>) => value.filter((topic): topic is Hex => typeof topic === "string");
    const safeLog = { address: safe, topics: topics(encodeEventTopics({ abi: [executionSuccessEvent], eventName: "ExecutionSuccess", args: { txHash: action.safeTxHash! } })), data: encodeAbiParameters([{ type: "uint256" }], [0n]) };
    const delayLog = { address: delay, topics: topics(encodeEventTopics({ abi: [transactionAddedEvent], eventName: "TransactionAdded", args: { queueNonce: 6n, txHash: action.queueFingerprint! } })), data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }], [maintenance, 0n, prepared.transient.maintenanceCalldata, 1]) };
    expect(validateRepairReceiptEffect(prepared.proposal, action, [safeLog, delayLog], prepared.transient.maintenanceCalldata)).to.equal(true);
    const wrongDelay = { ...delayLog, data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }], [maintenance, 1n, prepared.transient.maintenanceCalldata, 1]) };
    expect(() => validateRepairReceiptEffect(prepared.proposal, action, [safeLog, wrongDelay], prepared.transient.maintenanceCalldata)).to.throw("TransactionAdded");
    expect(() => validateRepairReceiptEffect(prepared.proposal, action, [delayLog], prepared.transient.maintenanceCalldata)).to.throw("Safe execution");
  });

  it("binds valid pre-freeze module behavior and exact frozen owner/module reverts to canonical blocks", async () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    const group = createRepairGroupProposal({ creation, journal: f.journal, state: state(), assertion: "0x123456" }).proposal;
    const frozen = toFunctionSelector("Frozen()"); const delayed = toFunctionSelector("InvalidDelayedAction()"); const unrelated = toFunctionSelector("InvalidSecondarySignature()");
    const before = state({ blockNumber: 12009999n, blockHash: hash("700"), safeNonce: 17n, delayQueueNonce: 8n, delayTxNonce: 8n, safeContractSecondary: candidate, policyHash: group.afterPolicyHash });
    const after = state({ blockNumber: 12010000n, blockHash: hash("701"), safeNonce: 18n, delayQueueNonce: 8n, delayTxNonce: 8n, safeContractSecondary: candidate, policyHash: group.afterPolicyHash, frozen: true });
    const signer = (signerAddress: Address, role: "primary" | "secondary") => ({ address: signerAddress, role, kind: "safe-contract" as const, sign: async () => encodeSafeContractSignature(signerAddress, "0x12") });
    const prove = async (outcomes: readonly unknown[], reread = after) => {
      let call = 0;
      const adapter = createRepairMechanicalAdapter({
        domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN,
        creation: { safe, guard, delay, funder, candidate, factory, x: quote.x.toString(), y: quote.y.toString(), verifiers: quote.verifiers.toString(), preRotationBlockNumber: "1", preRotationBlockHash: hash("1") },
        primary,
        current: { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: blockNumber === before.blockNumber ? before.blockHash : after.blockHash }), call: async () => { const outcome = outcomes[call++]; if (outcome !== undefined) throw outcome; return { data: hash("123") }; } } as never,
        archive: {} as never,
        readStateAtBlock: async (_phase, _observer, blockNumber, blockHash) => { const value = blockNumber === before.blockNumber ? before : reread; expect(blockHash).to.equal(value.blockHash); return value; },
        loadPasskey: async role => role === "primary" ? signer(primary, "primary") : signer(candidate, "secondary"),
      });
      return adapter.proveFrozenRejections(group, hash("308"), after);
    };
    expect(await prove([undefined, { cause: { data: { data: frozen } } }, { cause: { data: delayed } }])).to.equal(true);
    for (const outcomes of [
      [new Error("RPC unavailable"), { cause: { data: frozen } }, { cause: { data: delayed } }],
      [undefined, { cause: { data: unrelated } }, { cause: { data: delayed } }],
      [undefined, new Error("RPC unavailable"), { cause: { data: delayed } }],
      [undefined, undefined, { cause: { data: delayed } }],
      [undefined, { cause: { data: frozen } }, undefined],
      [undefined, { cause: { data: frozen } }, { cause: { data: unrelated } }],
      [undefined, { cause: { data: frozen } }, { cause: { data: frozen } }],
      [undefined, { cause: { data: `${frozen}00` } }, { cause: { data: delayed } }],
      [undefined, new Error(`execution reverted with ${frozen}`), { data: `execution reverted with ${delayed}` }],
    ] as const) await expect(prove(outcomes)).to.be.rejected;
    await expect(prove([undefined, { cause: { data: frozen } }, { cause: { data: delayed } }], { ...after, blockHash: hash("bad") })).to.be.rejected;
  });

  it("binds cancellation observer evidence to cancelledThrough without an inapplicable queue fingerprint", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    const group = createRepairGroupProposal({ creation, journal: f.journal, state: state(), assertion: "0x123456" }).proposal;
    const cancel = group.actions[4]!; const expected = repairObserverExpectedEffect(group, cancel, 123n);
    expect(expected).to.deep.equal({ kind: "delayed-cancelled", safe: group.safe, delay: group.delay, blockNumber: 123n, cancelledThrough: 8n });
    expect(expected).not.to.have.property("queueFingerprint");
  });

  it("enforces each policy phase and applies the native lazy-window gate only to the one-wei proof transaction", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    const group = createRepairGroupProposal({ creation, journal: f.journal, state: state(), assertion: "0x123456" }).proposal;
    assertRepairActionState(group, group.actions[0]!, state(), "before");
    const readyAfter = state({ safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, safeContractSecondary: candidate, policyHash: group.afterPolicyHash });
    assertRepairActionState(group, group.actions[1]!, readyAfter, "after");
    const proofBefore = state({ safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, safeContractSecondary: candidate, policyHash: group.afterPolicyHash });
    assertRepairActionState(group, group.actions[2]!, proofBefore, "before");
    expect(() => assertRepairActionState(group, group.actions[2]!, { ...proofBefore, blockTimestamp: proofBefore.blockTimestamp + 86_400n }, "before")).to.throw("period rollover");
    const cancelBefore = state({ safeNonce: 16n, delayQueueNonce: 8n, delayTxNonce: 7n, safeContractSecondary: candidate, policyHash: group.afterPolicyHash, blockTimestamp: proofBefore.blockTimestamp + 86_400n });
    assertRepairActionState(group, group.actions[4]!, cancelBefore, "before");
  });

  it("accepts only opaque exact creation/group approvals and a prepare grant that cannot authorize signing", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote });
    const prepare = createRepairPrepareAuthorization({ creation, state: state(), purpose: "materialize-one-repair-proof" });
    expect(prepare.authority).to.equal("PREPARE_PROOF_ONLY");
    expect(prepare.safeSignatureAuthority).to.equal(false); expect(prepare.broadcastAuthority).to.equal(false);
    const document = JSON.stringify({ schemaVersion: 1, scope: "repair-signer-create-v1", authorization: "EXACT_ACTION_APPROVAL", proposalHash: creation.proposalHash, actionCommitments: [creation.action.commitment], phaseLimitWei: "50000000000000000", maxBroadcastAttempts: 1 });
    const approvalHash = rawHash(document);
    expect(loadRepairApproval(creation, document, approvalHash).approvalHash).to.equal(approvalHash);
    expect(() => loadRepairApproval(creation, document.replace(creation.action.commitment, hash("fff")), approvalHash)).to.throw("hash");
  });

  it("keeps one proof alive for one bounded review/submit session and never signs before exact approval", async () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    const calls: string[] = []; let persisted = ""; const assertion = "0x123456" as Hex;
    const result = await runRepairQueueSession({
      creation, journal: f.journal, maxApprovalWaitMs: 20,
      publicPreflight: async () => { calls.push("preflight"); return state(); },
      awaitPrepareAuthorization: async () => { calls.push("prepare-approve"); return true; },
      loadReplacementCredential: async () => { calls.push("load-replacement"); return { opaque: true }; },
      signReplacementProof: async () => { calls.push("proof-sign"); return assertion; },
      verifyReplacementProof: async (_proofHash, value) => { calls.push("erc1271"); return value === assertion ? "0x1626ba7e" : "0x"; },
      publishSanitizedProposal: async proposal => { calls.push("publish"); persisted = JSON.stringify(proposal); },
      awaitExactApproval: async proposal => { calls.push("approve"); const raw = JSON.stringify({ schemaVersion: 1, scope: "repair-tail-group-v1", authorization: "EXACT_ACTION_APPROVAL", proposalHash: proposal.proposalHash, actionCommitments: proposal.actions.map(action => action.commitment), phaseLimitWei: "50000000000000000", maxBroadcastAttempts: 1 }); return { raw, hash: rawHash(raw) }; },
      persistJournal: async journal => { calls.push("persist"); expect(JSON.stringify(journal, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.to.include(assertion.slice(2)); },
      materializeSafeTransaction: async (_proposal, transient) => { calls.push("safe-sign"); const signedSafeCalldata = encodeFunctionData({ abi: safeExecAbi, functionName: "execTransaction", args: [delay, 0n, transient.safeTransactionData, 0, 0n, 0n, 0n, address("0"), address("0"), "0x12"] }); return { signedSafeCalldata, liveIntent: { id: "repair-queue", to: safe, data: signedSafeCalldata, value: 0n, nonce: 100, gas: 2_000_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n } }; },
      simulate: async () => { calls.push("simulate"); return { gasEstimate: 1000000n, success: true }; },
      live: { funder, chainId: async () => 11155111, nonce: async () => 100, balance: async () => 10n ** 18n, verify: async () => { calls.push("live-verify"); }, sign: async intent => { calls.push("outer-sign"); return fundingAccount.signTransaction({ chainId: 11155111, type: "eip1559", to: intent.to, data: intent.data, value: intent.value, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }); }, broadcast: async raw => { calls.push("broadcast"); return keccak256(raw); }, receipt: async transactionHash => f.journal.liveJournal.entries.find(entry => entry.transactionHash === transactionHash)?.receipt, persist: async () => { throw new Error("session must replace persistence"); } },
    });
    expect(result.status).to.equal("PENDING");
    expect(calls).to.deep.equal(["preflight", "prepare-approve", "load-replacement", "proof-sign", "erc1271", "publish", "approve", "persist", "preflight", "safe-sign", "simulate", "preflight", "simulate", "live-verify", "outer-sign", "persist", "broadcast"]);
    expect(persisted).not.to.include(assertion.slice(2));
  });

  it("discards the proof on approval timeout and recovers post-inclusion bytes only from canonical public evidence", async () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    let signed = 0;
    await expect(runRepairQueueSession({ creation, journal: f.journal, maxApprovalWaitMs: 5, publicPreflight: async () => state(), awaitPrepareAuthorization: async () => true, loadReplacementCredential: async () => ({}), signReplacementProof: async () => { signed++; return "0x123456"; }, verifyReplacementProof: async () => "0x1626ba7e", publishSanitizedProposal: async () => {}, awaitExactApproval: async () => new Promise(() => {}), persistJournal: async () => {}, materializeSafeTransaction: async () => { throw new Error("must not sign"); }, simulate: async () => { throw new Error("must not simulate"); }, live: { funder, chainId: async () => 11155111, nonce: async () => 0, balance: async () => 0n, verify: async () => {}, sign: async () => { throw new Error("must not sign"); }, broadcast: async () => { throw new Error("must not submit"); }, receipt: async () => undefined, persist: async () => {} } })).to.be.rejectedWith("timed out");
    expect(signed).to.equal(1);
    const prepared = createRepairGroupProposal({ creation, journal: f.journal, state: state(), assertion: "0xabcdef" }); const group = prepared.proposal;
    expect(recoverCanonicalRepairCalldata(group, { safeTransactionData: prepared.transient.safeTransactionData, transactionHash: hash("999"), canonical: true })).to.deep.include({ maintenanceCalldataHash: group.repair.maintenanceCalldataHash });
    expect(() => recoverCanonicalRepairCalldata(group, { safeTransactionData: prepared.transient.safeTransactionData, transactionHash: hash("999"), canonical: false })).to.throw("canonical");
  });

  it("marks an approved proof-bound attempt stopped when state drifts before Safe signing", async () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation); let reads = 0;
    await expect(runRepairQueueSession({ creation, journal: f.journal, maxApprovalWaitMs: 20, publicPreflight: async () => ++reads === 1 ? state() : state({ safeNonce: 15n }), awaitPrepareAuthorization: async () => true, loadReplacementCredential: async () => ({}), signReplacementProof: async () => "0x123456", verifyReplacementProof: async () => "0x1626ba7e", publishSanitizedProposal: async () => {}, awaitExactApproval: async proposal => { const raw = JSON.stringify({ schemaVersion: 1, scope: "repair-tail-group-v1", authorization: "EXACT_ACTION_APPROVAL", proposalHash: proposal.proposalHash, actionCommitments: proposal.actions.map(action => action.commitment), phaseLimitWei: "50000000000000000", maxBroadcastAttempts: 1 }); return { raw, hash: rawHash(raw) }; }, persistJournal: async () => {}, materializeSafeTransaction: async () => { throw new Error("must not sign"); }, simulate: async () => { throw new Error("must not simulate"); }, live: { funder, chainId: async () => 11155111, nonce: async () => 0, balance: async () => 0n, verify: async () => {}, sign: async () => { throw new Error("must not sign"); }, broadcast: async () => { throw new Error("must not submit"); }, receipt: async () => undefined, persist: async () => {} } })).to.be.rejectedWith("state changed");
    expect(f.journal.repairContinuation?.actions[1]?.status).to.equal("stopped");
  });
});
