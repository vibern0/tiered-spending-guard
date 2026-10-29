import { expect } from "chai";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { attachUsdcSuccessor } from "../../scripts/live/ordinary-scenario-usdc-successor-proposal";
import { loadUsdcSuccessorPublicInputs, parseUsdcSuccessorCliArguments } from "../../scripts/live/ordinary-scenario-usdc-successor-cli";
import { createRepairMechanicalAdapter } from "../../scripts/live/ordinary-scenario-repair-adapter";
import { createRepairCommandRuntime } from "../../scripts/live/ordinary-scenario-repair-session";
import { PRODUCTION_REPAIR_EXECUTION_DOMAIN, REPAIR_BINDING_HASH, assertRepairActionState, bindRepairCreationApproval, createRepairGroupProposal, loadRepairApproval, recordRepairCreationConfirmation, type RepairCanonicalState } from "../../scripts/live/ordinary-scenario-repair";
import { createOrdinaryScenarioStore, type OrdinaryScenarioJournal } from "../../scripts/live/ordinary-scenario-executor";
import { createUsdcSuccessorPublicExecutionFixture } from "../support/usdc-successor-fixture";

const hash = (suffix: string): Hex => `0x${suffix.padStart(64, "0")}` as Hex;
const publicHash = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const domain = PRODUCTION_REPAIR_EXECUTION_DOMAIN;
const quote = { chainId: 11155111, factory: domain.factory, candidate: domain.candidate, x: 10342510752483659319190807637330965811978365685423845568184481734592673940696n, y: 83007955684183101275699917860538633816962061613045139387258186696967867907135n, verifiers: 1111636484949241205398856388087597953580887526884n, calldata: "0x0d2f048916dda754f7752e800b62ed684f89fb19d607485fbb8b9b77f5d877e4903904d8b784d685cc3013eab599b6d9696b06414ca74554ec8de222b6cdc43de410bc3f000000000000000000000000c2b78104907f722dabac4c69f826a522b2754de4" as Hex, calldataHash: "0x0ed506887dea4406bb68a77a9d4c54b2454946b80b9205772900008859a92c7b" as Hex, gasLimitCap: 740292n, maxFeePerGasCap: 1000000n, maxPriorityFeePerGasCap: 1000000n };
const stringify = (value: unknown) => `${JSON.stringify(value, (_key, child) => typeof child === "bigint" ? child.toString() : child)}\n`;

describe("USDC successor repair production composition", function () {
  it("loads the public successor into the real repair runtime and adapter across rotation", async function () {
    const prepared = await createUsdcSuccessorPublicExecutionFixture();
    try {
      const inputs = await loadUsdcSuccessorPublicInputs(parseUsdcSuccessorCliArguments(prepared.argv), prepared.providers);
      if (!inputs.approval) throw new Error("successor approval missing");
      const journal = structuredClone(attachUsdcSuccessor(inputs.source.journal, inputs.successor, inputs.approval)) as OrdinaryScenarioJournal;
      const successorRecords = inputs.successor.actions.map((action, index) => {
        const confirmed = action.expectedOutcome === "success", transactionHash = hash((index + 1).toString(16).padStart(2, "0")), receipt = { transactionHash, status: "success" as const, gasUsed: 100n + BigInt(index), effectiveGasPrice: 7n, blockNumber: 12_017_000n + BigInt(index), blockHash: hash((index + 40).toString(16).padStart(2, "0")) };
        return { id: action.id, commitment: action.commitment, status: confirmed ? "confirmed" as const : "rejection-proved" as const, evidenceHash: hash((index + 80).toString(16).padStart(2, "0")), ...(confirmed ? { intentHash: hash((index + 120).toString(16).padStart(2, "0")), transactionHash, receipt, outerValue: "0", ourPrincipalDelta: "0", ourReceiptGasCost: (receipt.gasUsed * receipt.effectiveGasPrice).toString() } : {}) };
      });
      journal.usdcSuccessor!.actions.splice(0, journal.usdcSuccessor!.actions.length, ...successorRecords);
      journal.liveJournal.entries.push(...successorRecords.filter(record => record.status === "confirmed").map((record, index) => ({ id: record.id, intentHash: record.intentHash!, transactionHash: record.transactionHash!, nonce: 900 + index, reserved: BigInt(record.ourReceiptGasCost!), status: "success" as const, receipt: record.receipt! })));
      writeFileSync(prepared.journalPath, stringify(journal));

      const confirmed = [...journal.actions, ...journal.hashlessContinuation!.actions.slice(0, 3), ...journal.usdcSuccessor!.actions].filter(record => record.status === "confirmed") as any[];
      const receipts = new Map(confirmed.map(record => [record.transactionHash, record.receipt]));
      const preState: RepairCanonicalState = { chainId: 11155111, blockNumber: 12_018_000n, blockHash: hash("aa"), blockTimestamp: 1_793_232_600n, safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, safeContractSecondary: domain.oldSecondary, candidateRuntimeCodeHash: hash("00"), candidateBindingHash: hash("00"), policyHash: domain.beforePolicyHash, frozen: false, nativeWindow: 1_793_145_600n, nativeBaseSpent: 10_000_000_000_000n, nativeInstantSpent: 30_000_000_000_000n, usdcWindow: 1_793_232_000n, usdcBaseSpent: 10_000_000n, usdcInstantSpent: 30_000_000n, nativeBalance: 0n, usdcBalance: 0n, topologyEvidenceHash: inputs.source.original.topologyEvidenceHash, observerReady: true };
      const postState = (overrides: Partial<RepairCanonicalState> = {}): RepairCanonicalState => ({ ...preState, safeNonce: 16n, delayQueueNonce: 8n, delayTxNonce: 8n, safeContractSecondary: domain.candidate, candidateRuntimeCodeHash: hash("70"), candidateBindingHash: REPAIR_BINDING_HASH, policyHash: domain.afterPolicyHash, ...overrides });
      let composedAdapter: ReturnType<typeof createRepairMechanicalAdapter> | undefined, candidateCreated = false;
      const harness = { current: { getBlock: async () => ({ number: preState.blockNumber, hash: preState.blockHash, timestamp: preState.blockTimestamp }) }, reconstructedProfile: async () => ({}) } as any;
      const dependencies = { environment: {}, domain, ordinaryDomain: undefined, repository: () => prepared.directory, createHarness: () => harness, createAdapter: (input: any) => composedAdapter = createRepairMechanicalAdapter({ domain, creation: input.creation, primary: inputs.source.original.primarySigner, current: {} as never, archive: { getTransactionReceipt: async ({ hash }: { hash: Hex }) => { const receipt = receipts.get(hash); if (!receipt) throw new Error("missing controlled receipt"); return { ...receipt, gasUsed: BigInt(receipt.gasUsed), effectiveGasPrice: BigInt(receipt.effectiveGasPrice), blockNumber: BigInt(receipt.blockNumber) }; } } as never, readStateAtBlock: async phase => phase === "pre-rotation" ? { ...preState, ...(candidateCreated ? { candidateRuntimeCodeHash: hash("70"), candidateBindingHash: REPAIR_BINDING_HASH } : {}) } : postState(), loadPasskey: async () => { throw new Error("public composition must not load signers"); } }), loadCreationQuote: () => quote, submit: async () => { throw new Error("public composition must not submit"); }, now: () => new Date(1_793_232_650_000), awaitApprovalHandoff: async () => { throw new Error("public composition must not await approval"); }, loadUsdcSuccessorLineage: argv => loadUsdcSuccessorPublicInputs(parseUsdcSuccessorCliArguments(argv), prepared.providers) } as any;
      const flagValue = (flag: string) => { const index = prepared.argv.indexOf(flag as any); if (index < 0) throw new Error(`missing ${flag}`); return prepared.argv[index + 1]!; };
      const lineageFlags = ["--recovery-certificate", "--recovery-certificate-hash", "--recovery-proposal", "--recovery-approval", "--recovery-approval-hash", "--primary-bundle-manifest", "--successor-certificate", "--successor-certificate-hash", "--successor-proposal", "--successor-approval", "--successor-approval-hash"].flatMap(flag => [flag, flagValue(flag)]);
      const args = ["--report", flagValue("--original-report"), "--artifact-hash", flagValue("--original-artifact-hash"), "--package-hash", flagValue("--original-package-hash"), "--proposal-hash", flagValue("--original-proposal-hash"), "--original-approval-hash", journal.approvalHash, "--journal", prepared.journalPath, ...lineageFlags];
      const runtime = createRepairCommandRuntime(dependencies), creation = await runtime.creationReview(args);
      candidateCreated = true;
      expect(creation.predecessor).to.include({ kind: "usdc-period-successor-v1", effectivePeriod: "1793232000" });
      expect(creation.baseline).to.include({ nativeWindow: "1793145600", usdcWindow: "1793232000", safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7" });
      expect(composedAdapter).not.to.equal(undefined);

      const reopened = createOrdinaryScenarioStore(prepared.journalPath, { proposalHash: inputs.source.original.proposalHash, approvalHash: journal.approvalHash, funder: inputs.source.original.funder }, () => { throw new Error("repair attachment must reopen from disk"); }); const stored = reopened.load(); reopened.close?.();
      const approvalRaw = JSON.stringify({ schemaVersion: 1, scope: "repair-signer-create-v1", authorization: "EXACT_ACTION_APPROVAL", proposalHash: creation.proposalHash, actionCommitments: [creation.action.commitment], phaseLimitWei: "50000000000000000", maxBroadcastAttempts: 1 });
      bindRepairCreationApproval(stored, creation, loadRepairApproval(creation, approvalRaw, publicHash(approvalRaw))); recordRepairCreationConfirmation(stored, creation, hash("e1"));
      stored.liveJournal.entries.push({ id: "repair-signer-create", intentHash: hash("e2"), transactionHash: hash("e3"), nonce: 920, reserved: 1n, status: "success", receipt: { transactionHash: hash("e3"), status: "success", gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 12_018_001n, blockHash: hash("e4") } });
      const lineage = { kind: "usdc-period-successor-v1" as const, source: inputs.source, certificate: inputs.certificate, successor: inputs.successor, approval: inputs.approval };
      const group = createRepairGroupProposal({ creation, journal: stored, state: { ...preState, candidateRuntimeCodeHash: hash("70"), candidateBindingHash: REPAIR_BINDING_HASH }, assertion: "0x123456", lineage }).proposal;
      expect(group.actions.at(-1)).to.include({ safeNonceAfter: "19", delayQueueNonceAfter: "9", delayTxNonceAfter: "9" });
      assertRepairActionState(group, group.actions[0]!, await composedAdapter!.readStateAt("pre-rotation", inputs.successor.observer.probeEvidenceHash, preState.blockNumber, preState.blockHash), "before");
      assertRepairActionState(group, group.actions[3]!, await composedAdapter!.readStateAt("post-rotation", inputs.successor.observer.probeEvidenceHash, preState.blockNumber, preState.blockHash), "before");

      const expiredRuntime = createRepairCommandRuntime({ ...dependencies, now: () => new Date((Number(BigInt(inputs.successor.observer.expiresAt)) + 1) * 1000), repository: () => { throw new Error("expired receiver must fail before journal lease"); } });
      await expect(expiredRuntime.creationReview(args)).to.be.rejectedWith(/observer.*schedule|freshness|no longer/i);

      const pendingAction = group.actions.at(-1)!, pendingHash = hash("f1"), continuation = stored.repairContinuation!;
      continuation.groupProposalHash = group.proposalHash; continuation.groupApprovalHash = hash("f2");
      continuation.actions.push(...group.actions.map((action, index) => ({ id: action.id, commitment: action.commitment, status: index === 2 ? "rejection-proved" as const : index < group.actions.length - 1 ? "confirmed" as const : "pending" as const, ...(index < group.actions.length - 1 ? { evidenceHash: hash((0xf10 + index).toString(16)) } : { transactionHash: pendingHash }) })));
      stored.liveJournal.entries.push({ id: pendingAction.id, intentHash: hash("f3"), transactionHash: pendingHash, nonce: 921, reserved: 2_000_000_000_000n, status: "pending" });
      const persisted = createOrdinaryScenarioStore(prepared.journalPath, { proposalHash: inputs.source.original.proposalHash, approvalHash: stored.approvalHash, funder: inputs.source.original.funder }, () => { throw new Error("existing journal required"); }); persisted.save(stored); persisted.close?.();
      const creationPath = `${prepared.directory}/creation.json`, groupPath = `${prepared.directory}/group.json`; writeFileSync(creationPath, stringify(creation)); writeFileSync(groupPath, stringify(group));
      let signed = false, broadcast = false, observerMode: string | undefined, recoveredHash: Hex | undefined;
      const confirmedReceipt = { transactionHash: pendingHash, status: "success" as const, gasUsed: 100n, effectiveGasPrice: 1n, blockNumber: 12_018_100n, blockHash: hash("f4") };
      const finalState = postState({ safeNonce: 19n, delayQueueNonce: 9n, delayTxNonce: 9n, frozen: true, blockNumber: confirmedReceipt.blockNumber, blockHash: confirmedReceipt.blockHash });
      const resumeHarness = { current: { getTransactionReceipt: async () => ({ logs: [] }) }, reconstructedProfile: async () => ({}), createLiveContext: async (_mode: string, _funder: Address, persistLive: (journal: any) => Promise<void>) => ({ funder: creation.funder, chainId: async () => 11155111, nonce: async () => 921, balance: async () => 1n, verify: async () => {}, sign: async () => { signed = true; throw new Error("known-hash resume must not sign"); }, broadcast: async () => { broadcast = true; throw new Error("known-hash resume must not broadcast"); }, receipt: async () => undefined, persist: persistLive }) } as any;
      const resumeRuntime = createRepairCommandRuntime({ ...dependencies, environment: {}, now: () => new Date((Number(BigInt(inputs.successor.observer.expiresAt)) + 100) * 1000), createHarness: () => resumeHarness, createAdapter: (input: any) => { observerMode = input.observerMode; return { validateTerminalPrefix: (candidate: OrdinaryScenarioJournal) => composedAdapter!.validateTerminalPrefix(candidate), recoverPendingIntent: async (_group: unknown, _action: unknown, transactionHash: Hex) => { recoveredHash = transactionHash; return { id: pendingAction.id, to: group.safe, data: "0x12", value: 0n, nonce: 921, gas: 2_000_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n }; }, validateReceiptEffect: () => true, readStateAt: async () => finalState, proveFrozenRejections: async () => true }; }, submit: async (_intent: unknown, liveJournal: any, live: any) => { const updated = structuredClone(liveJournal), entry = updated.entries.find((value: any) => value.id === pendingAction.id); entry.status = "success"; entry.receipt = confirmedReceipt; await live.persist(updated); return entry; } });
      const resumeArgs = ["--creation", creationPath, "--creation-hash", creation.proposalHash, ...args, "--group", groupPath, "--group-hash", group.proposalHash, "--observer-ledger", `${prepared.directory}/unused-ledger.json`, "--receiver-ack", `${prepared.directory}/unused-ack.json`];
      expect(await resumeRuntime.tailResumeOne(resumeArgs)).to.deep.equal({ status: "CONFIRMED", actionId: pendingAction.id });
      expect(observerMode).to.equal("historical"); expect(recoveredHash).to.equal(pendingHash); expect(signed).to.equal(false); expect(broadcast).to.equal(false);
    } finally { prepared.cleanup(); }
  });
});
