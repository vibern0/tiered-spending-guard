import { expect } from "chai";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createOrdinaryScenarioProposal, createOrdinaryScenarioStore, type OrdinaryScenarioJournal, type OrdinaryScenarioProposal } from "../../../scripts/live/ordinary-scenario-executor";
import {
  REPAIR_ACTION_IDS,
  REPAIR_BINDING_HASH,
  REPAIR_PROOF_HASH,
  assertRepairActionState,
  bindRepairCreationApproval,
  createRepairCreationProposal,
  createRepairGroupProposal,
  createRepairPrepareAuthorization,
  extendJournalForRepair,
  loadRepairApproval,
  recoverCanonicalRepairCalldata,
  recordRepairCreationConfirmation,
  validateRepairCreationReceiptLogs,
  validateRepairCreationSimulation,
  validateTransientRepairQueue,
  type RepairCanonicalState,
} from "../../../scripts/live/ordinary-scenario-repair";
import { runPublicRepairCreationReview, runRepairQueueSession } from "../../../scripts/live/ordinary-scenario-repair-session";
import { validateRepairReceiptEffect } from "../../../scripts/live/ordinary-scenario-repair-adapter";

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

describe("closed ordinary repair-to-freeze continuation", () => {
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

  it("runs the real public creation-review command path without authority inputs", () => {
    const directory = mkdtempSync(join(tmpdir(), "repair-public-review-"));
    const reportPath = join(process.cwd(), "../../.superpowers/sdd/2026-10-19-native-safe-4337/scenario-review-2m-2026-10-27/ordinary-scenario-review.json");
    const raw = readFileSync(reportPath, "utf8");
    const original = createOrdinaryScenarioProposal(raw, { expectedPackageHash: "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", expectedArtifactBytesHash: "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831" });
    const approvalHash = hash("abc"); const journalPath = join(directory, "journal.json"); const evidencePath = join(directory, "evidence.json"); const statePath = join(directory, "state.json"); const quotePath = join(directory, "quote.json");
    const terminal = original.actions.map((action, index) => ({ id: action.id, commitment: action.commitment, status: action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed", transactionHash: action.expectedOutcome === "rejection" ? undefined : hash((900 + index).toString(16)), evidenceHash: hash((1000 + index).toString(16)) }));
    writeFileSync(journalPath, JSON.stringify({ schemaVersion: 1, chainId: 11155111, reviewPackageHash: original.reviewPackageHash, proposalHash: original.proposalHash, approvalHash, funder: original.funder, liveJournal: { chainId: 11155111, funder: original.funder, entries: [] }, actions: terminal }));
    writeFileSync(evidencePath, JSON.stringify(terminal.map(action => ({ actionId: action.id, evidenceHash: action.evidenceHash, transactionHash: action.transactionHash }))));
    writeFileSync(statePath, JSON.stringify({ ...state({ candidateRuntimeCodeHash: hash("0"), candidateBindingHash: hash("0"), topologyEvidenceHash: original.topologyEvidenceHash }), blockNumber: "12010000", blockTimestamp: "1770000000", safeNonce: "14", delayQueueNonce: "6", delayTxNonce: "6", nativeWindow: "1769990400", nativeBaseSpent: "10000000000000", nativeInstantSpent: "30000000000000", nativeBalance: "1", usdcBalance: "1" }));
    writeFileSync(quotePath, JSON.stringify({ ...quote, x: quote.x.toString(), y: quote.y.toString(), verifiers: quote.verifiers.toString(), gasLimitCap: quote.gasLimitCap.toString(), maxFeePerGasCap: quote.maxFeePerGasCap.toString(), maxPriorityFeePerGasCap: quote.maxPriorityFeePerGasCap.toString() }));
    try {
      const result = runPublicRepairCreationReview(["--report", reportPath, "--artifact-hash", "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831", "--package-hash", "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", "--proposal-hash", original.proposalHash, "--original-approval-hash", approvalHash, "--journal", journalPath, "--evidence", evidencePath, "--state", statePath, "--quote", quotePath], {});
      expect(result.action.id).to.equal("repair-signer-create"); expect(result.authorization).to.equal("NONE");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("builds only the exact seven-action map and keeps assertion and nested calldata out of public JSON", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote });
    approveCreation(f.journal, creation);
    const assertion = "0x123456" as Hex;
    const prepared = createRepairGroupProposal({ creation, journal: f.journal, state: state(), maintenance, recipient: funder, assertion }); const group = prepared.proposal;
    expect([creation.action.id, ...group.actions.map(action => action.id)]).to.deep.equal(REPAIR_ACTION_IDS);
    expect(group.actions.map(action => [action.safeNonceBefore, action.safeNonceAfter, action.delayQueueNonceBefore, action.delayQueueNonceAfter, action.delayTxNonceBefore, action.delayTxNonceAfter])).to.deep.equal([
      ["14", "15", "6", "7", "6", "6"], ["15", "15", "7", "7", "6", "7"], ["15", "15", "7", "7", "7", "7"],
      ["15", "16", "7", "8", "7", "7"], ["16", "17", "8", "8", "7", "8"], ["17", "18", "8", "8", "8", "8"],
    ]);
    expect(group.actions[2]!.safeTxHash).to.equal(group.actions[3]!.safeTxHash);
    const serialized = JSON.stringify(group);
    expect(serialized).not.to.include(assertion.slice(2));
    expect(serialized).not.to.include(prepared.transient.maintenanceCalldata);
    expect(group.repair.assertionHash).to.equal(keccak256(assertion));
    expect(group.repair.proofHash).to.equal(REPAIR_PROOF_HASH);
  });

  it("independently decodes transient repair bytes and rejects every fixed-field or proof mutation", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    const prepared = createRepairGroupProposal({ creation, journal: f.journal, state: state(), maintenance, recipient: funder, assertion: "0x123456" }); const group = prepared.proposal;
    expect(validateTransientRepairQueue(group, prepared.transient.safeTransactionData, prepared.transient.maintenanceCalldata)).to.equal(true);
    const wrong = encodeFunctionData({ abi: [{ type: "function", name: "replaceSigner", stateMutability: "nonpayable", inputs: [{ type: "address", name: "guard" }, { type: "uint8", name: "role" }, { type: "address", name: "expectedOld" }, { type: "address", name: "replacement" }, { type: "address", name: "previousOwner" }, { type: "uint256", name: "threshold" }, { type: "bytes", name: "replacementProof" }] }] as const, functionName: "replaceSigner", args: [guard, 0, oldSecondary, candidate, address("0"), 1n, "0x123456"] });
    expect(() => validateTransientRepairQueue(group, prepared.transient.safeTransactionData, wrong)).to.throw("decoded");
    expect(() => validateTransientRepairQueue(group, `${prepared.transient.safeTransactionData}00` as Hex, prepared.transient.maintenanceCalldata)).to.throw("canonical");
  });

  it("validates the exact Safe and Delay confirmation callbacks and rejects a mutated queue effect", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    const prepared = createRepairGroupProposal({ creation, journal: f.journal, state: state(), maintenance, recipient: funder, assertion: "0x123456" }); const action = prepared.proposal.actions[0]!;
    const topics = (value: ReturnType<typeof encodeEventTopics>) => value.filter((topic): topic is Hex => typeof topic === "string");
    const safeLog = { address: safe, topics: topics(encodeEventTopics({ abi: [executionSuccessEvent], eventName: "ExecutionSuccess", args: { txHash: action.safeTxHash! } })), data: encodeAbiParameters([{ type: "uint256" }], [0n]) };
    const delayLog = { address: delay, topics: topics(encodeEventTopics({ abi: [transactionAddedEvent], eventName: "TransactionAdded", args: { queueNonce: 6n, txHash: action.queueFingerprint! } })), data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }], [maintenance, 0n, prepared.transient.maintenanceCalldata, 1]) };
    expect(validateRepairReceiptEffect(prepared.proposal, action, [safeLog, delayLog], prepared.transient.maintenanceCalldata)).to.equal(true);
    const wrongDelay = { ...delayLog, data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }], [maintenance, 1n, prepared.transient.maintenanceCalldata, 1]) };
    expect(() => validateRepairReceiptEffect(prepared.proposal, action, [safeLog, wrongDelay], prepared.transient.maintenanceCalldata)).to.throw("TransactionAdded");
    expect(() => validateRepairReceiptEffect(prepared.proposal, action, [delayLog], prepared.transient.maintenanceCalldata)).to.throw("Safe execution");
  });

  it("enforces each policy phase and applies the native lazy-window gate only to the one-wei proof transaction", () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    const group = createRepairGroupProposal({ creation, journal: f.journal, state: state(), maintenance, recipient: funder, assertion: "0x123456" }).proposal;
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
      creation, journal: f.journal, maintenance, recipient: funder, maxApprovalWaitMs: 20,
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
    expect(calls).to.deep.equal(["preflight", "prepare-approve", "load-replacement", "proof-sign", "erc1271", "publish", "approve", "persist", "preflight", "safe-sign", "simulate", "preflight", "live-verify", "outer-sign", "persist", "broadcast"]);
    expect(persisted).not.to.include(assertion.slice(2));
  });

  it("discards the proof on approval timeout and recovers post-inclusion bytes only from canonical public evidence", async () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation);
    let signed = 0;
    await expect(runRepairQueueSession({ creation, journal: f.journal, maintenance, recipient: funder, maxApprovalWaitMs: 5, publicPreflight: async () => state(), awaitPrepareAuthorization: async () => true, loadReplacementCredential: async () => ({}), signReplacementProof: async () => { signed++; return "0x123456"; }, verifyReplacementProof: async () => "0x1626ba7e", publishSanitizedProposal: async () => {}, awaitExactApproval: async () => new Promise(() => {}), persistJournal: async () => {}, materializeSafeTransaction: async () => { throw new Error("must not sign"); }, simulate: async () => { throw new Error("must not simulate"); }, live: { funder, chainId: async () => 11155111, nonce: async () => 0, balance: async () => 0n, verify: async () => {}, sign: async () => { throw new Error("must not sign"); }, broadcast: async () => { throw new Error("must not submit"); }, receipt: async () => undefined, persist: async () => {} } })).to.be.rejectedWith("timed out");
    expect(signed).to.equal(1);
    const prepared = createRepairGroupProposal({ creation, journal: f.journal, state: state(), maintenance, recipient: funder, assertion: "0xabcdef" }); const group = prepared.proposal;
    expect(recoverCanonicalRepairCalldata(group, { safeTransactionData: prepared.transient.safeTransactionData, transactionHash: hash("999"), canonical: true })).to.deep.include({ maintenanceCalldataHash: group.repair.maintenanceCalldataHash });
    expect(() => recoverCanonicalRepairCalldata(group, { safeTransactionData: prepared.transient.safeTransactionData, transactionHash: hash("999"), canonical: false })).to.throw("canonical");
  });

  it("marks an approved proof-bound attempt stopped when state drifts before Safe signing", async () => {
    const f = prefix(); const creation = createRepairCreationProposal({ ...f, state: state({ candidateRuntimeCodeHash: hash("0") }), quote }); approveCreation(f.journal, creation); let reads = 0;
    await expect(runRepairQueueSession({ creation, journal: f.journal, maintenance, recipient: funder, maxApprovalWaitMs: 20, publicPreflight: async () => ++reads === 1 ? state() : state({ safeNonce: 15n }), awaitPrepareAuthorization: async () => true, loadReplacementCredential: async () => ({}), signReplacementProof: async () => "0x123456", verifyReplacementProof: async () => "0x1626ba7e", publishSanitizedProposal: async () => {}, awaitExactApproval: async proposal => { const raw = JSON.stringify({ schemaVersion: 1, scope: "repair-tail-group-v1", authorization: "EXACT_ACTION_APPROVAL", proposalHash: proposal.proposalHash, actionCommitments: proposal.actions.map(action => action.commitment), phaseLimitWei: "50000000000000000", maxBroadcastAttempts: 1 }); return { raw, hash: rawHash(raw) }; }, persistJournal: async () => {}, materializeSafeTransaction: async () => { throw new Error("must not sign"); }, simulate: async () => { throw new Error("must not simulate"); }, live: { funder, chainId: async () => 11155111, nonce: async () => 0, balance: async () => 0n, verify: async () => {}, sign: async () => { throw new Error("must not sign"); }, broadcast: async () => { throw new Error("must not submit"); }, receipt: async () => undefined, persist: async () => {} } })).to.be.rejectedWith("state changed");
    expect(f.journal.repairContinuation?.actions[1]?.status).to.equal("stopped");
  });
});
