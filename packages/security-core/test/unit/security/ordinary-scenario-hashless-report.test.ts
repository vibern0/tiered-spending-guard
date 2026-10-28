import { expect } from "chai";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, type Hex } from "viem";
import { ActivityLedger, FileActivityStore } from "../../../src/monitoring/ledger";
import { sha256 } from "../../../scripts/plan-deployment";
import { createOrdinaryScenarioMechanicalExecutionContext, validatePublicReceiverAcknowledgement } from "../../../scripts/live/ordinary-scenario-adapter";
import { createExpiredHashlessContinuationExecutionView } from "../../../scripts/live/ordinary-scenario-executor";
import { createHashlessContinuationProductionDependencies } from "../../../scripts/live/ordinary-scenario-hashless-continuation-cli";
import { hashlessContinuationFixture } from "../../support/hashless-continuation-fixture";
import { renderExpiredHashlessContinuationReport } from "../../../scripts/live/ordinary-scenario-hashless-report";
import {
  PRODUCTION_REPAIR_EXECUTION_DOMAIN,
  bindRepairCreationApproval,
  createRepairCreationProposal,
  createRepairGroupProposal,
  extendJournalForRepair,
  loadRepairApproval,
  recordRepairCreationConfirmation,
  type RepairCanonicalState,
} from "../../../scripts/live/ordinary-scenario-repair";

const safeEvents = parseAbi(["event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)"]);
const delayEvents = parseAbi(["event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)"]);
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hex;
const rawHash = (value: string) => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;

describe("ordinary hashless continuation evidence report", function () {
  it("continuation_confirmation_uses_bound_receiver_expiry", async function () {
    const fixture = await hashlessContinuationFixture();
    const view = createExpiredHashlessContinuationExecutionView(fixture.original, fixture.proposal, fixture.approval);
    const action = view.proposal.actions[19]!;
    expect(action.kind).to.equal("queue-proposal");
    expect(action.queue).not.to.equal(undefined);

    const directory = mkdtempSync(join(tmpdir(), "hashless-report-observer-"));
    const ledgerPath = join(directory, "ledger.json");
    const acknowledgementPath = join(directory, "ack.json");
    const transactionHash = fixture.h("3");
    const blockHash = fixture.h("4");
    const receipt = { transactionHash, status: "success" as const, gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 12_014_100n, blockHash };
    const blockTimestamp = 1_793_211_000n;
    const queue = action.queue!;
    const postState = {
      chainId: 11_155_111,
      blockNumber: receipt.blockNumber,
      blockHash,
      blockTimestamp,
      evidenceBasis: { kind: "receipt-poststate", actionId: action.id, transactionHash, blockNumber: receipt.blockNumber, blockHash },
      queue: { queueNonce: queue.queueNonce, fingerprint: queue.fingerprint, createdAt: blockTimestamp, status: "queued", to: queue.to, value: queue.value, data: queue.data, operation: queue.operation },
    };
    const canonicalTransaction = { to: fixture.original.safe, value: 0n, input: "0x1234" as Hex, nonce: 810, gas: 100n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
    const logs = [
      { address: fixture.original.safe, topics: encodeEventTopics({ abi: safeEvents, eventName: "ExecutionSuccess", args: { txHash: action.safeTxHash! } }), data: encodeAbiParameters([{ type: "uint256" }], [0n]) },
      { address: fixture.original.delay, topics: encodeEventTopics({ abi: delayEvents, eventName: "TransactionAdded", args: { queueNonce: queue.queueNonce, txHash: queue.fingerprint } }), data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }], [queue.to, queue.value, queue.data, queue.operation]) },
    ];
    const archiveClient = { getTransactionReceipt: async () => ({ ...receipt, logs }), getTransaction: async () => canonicalTransaction };
    const expiryIso = new Date(Number(BigInt(fixture.proposal.observer.expiresAt)) * 1000).toISOString();
    const expiryMilliseconds = Number(BigInt(fixture.proposal.observer.expiresAt)) * 1000;
    const now = new Date(expiryMilliseconds + 60_000);
    const alert = { kind: "delayed-queued" as const, chainId: 11_155_111, safe: fixture.original.safe, delay: fixture.original.delay, transactionHash, blockNumber: receipt.blockNumber, logIndex: 0, queueNonce: queue.queueNonce, queueFingerprint: queue.fingerprint, createdAt: blockTimestamp, expiresAt: blockTimestamp + 720n, to: queue.to, value: queue.value, data: queue.data, operation: queue.operation };
    const key = { chainId: 11_155_111, transactionHash, blockHash, logIndex: 0 };
    try {
      const firstStore = new FileActivityStore(ledgerPath); const first = new ActivityLedger(firstStore); first.accept(key, alert); const payloadSha256 = first.payloadHash(alert); firstStore.close();
      const secondStore = new FileActivityStore(ledgerPath); const second = new ActivityLedger(secondStore); second.markDelivered(key, { channel: "webhook", httpStatus: 200, payloadHash: payloadSha256, deliveredAt: new Date(expiryMilliseconds - 2_000).toISOString() }); secondStore.close();
      const acknowledgement = { schemaVersion: 1, endpointHash: fixture.proposal.observer.endpointHash, transactionHash, payloadSha256, receiverRequestId: "fresh-continuation-receiver", receiverRecordedAt: new Date(expiryMilliseconds - 1_500).toISOString(), retrievedAt: new Date(expiryMilliseconds - 1_000).toISOString(), retrievalProvenance: "official-receiver-api", expiresAt: expiryIso };
      writeFileSync(acknowledgementPath, JSON.stringify(acknowledgement));

      const requiredHash = fixture.h("6");
      const argv = ["resume-one", "--source-journal", "journal.json", "--journal", "journal.json", "--original-report", "report.json", "--original-package-hash", requiredHash, "--original-artifact-hash", requiredHash, "--original-proposal-hash", requiredHash, "--certificate", "certificate.json", "--certificate-hash", requiredHash, "--proposal", "proposal.json", "--approval", "approval.json", "--approval-hash", requiredHash, "--observer-ledger", ledgerPath, "--receiver-ack", acknowledgementPath];
      const dependencies = createHashlessContinuationProductionDependencies("/unused", argv, {
        createHarness: (() => ({ createLiveContext: async () => ({}), loadClosedPasskey: async () => { throw new Error("signers are not used during confirmation"); } })) as never,
        createExecutionContext: ((input: any) => createOrdinaryScenarioMechanicalExecutionContext({ ...input, expectedChainId: 11_155_111, currentClient: {}, archiveClient, now: () => now } as never, (async () => postState) as never)) as never,
      });
      const context = await dependencies.createExecutionContext!("resume-one", { original: fixture.original, journal: fixture.journal, continuation: fixture.proposal, approval: fixture.approval } as never, () => fixture.journal);
      const record = { id: action.id, commitment: action.commitment, status: "outer-pending", outerTo: canonicalTransaction.to, outerValue: "0", outerDataHash: keccak256(canonicalTransaction.input), outerNonce: canonicalTransaction.nonce, gas: canonicalTransaction.gas.toString(), maxFeePerGas: canonicalTransaction.maxFeePerGas.toString(), maxPriorityFeePerGas: canonicalTransaction.maxPriorityFeePerGas.toString() } as never;
      const confirmation = await context.confirm(action, { id: action.id, receipt } as never, record);
      expect(confirmation.observerEvidenceHash).to.match(/^0x[0-9a-f]{64}$/);

      writeFileSync(acknowledgementPath, JSON.stringify({ ...acknowledgement, receiverRecordedAt: new Date(expiryMilliseconds + 1).toISOString() }));
      await expect(context.confirm(action, { id: action.id, receipt } as never, record)).to.be.rejectedWith(/timely|expiry/i);
      writeFileSync(acknowledgementPath, JSON.stringify({ ...acknowledgement, endpointHash: fixture.h("f") }));
      await expect(context.confirm(action, { id: action.id, receipt } as never, record)).to.be.rejectedWith(/endpoint|acknowledgement/i);

      const oldEndpoint = fixture.h("9"); const oldTransaction = fixture.h("8"); const oldPayload = fixture.h("7");
      expect(validatePublicReceiverAcknowledgement({ schemaVersion: 1, endpointHash: oldEndpoint, transactionHash: oldTransaction, payloadSha256: oldPayload, receiverRequestId: "ordinary-history", receiverRecordedAt: "2026-10-27T12:00:00Z", retrievedAt: "2026-10-27T12:01:00Z", retrievalProvenance: "official-receiver-api", expiresAt: "2026-10-28T18:51:57Z" }, { endpointHash: oldEndpoint, transactionHash: oldTransaction, payloadSha256: oldPayload, now: new Date("2026-10-29T00:00:00Z") })).to.match(/^0x[0-9a-f]{64}$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const terminalJournal = async () => {
    const fixture = await hashlessContinuationFixture();
    const journal = structuredClone(fixture.journal);
    const records = fixture.proposal.actions.map((action, index) => {
      const confirmed = action.expectedOutcome === "success";
      const transactionHash = hash(40 + index);
      const receipt = { transactionHash, status: "success" as const, gasUsed: 10n, effectiveGasPrice: 10n, blockNumber: 12_014_000n + BigInt(index), blockHash: hash(80 + index) };
      return { id: action.id, commitment: action.commitment, status: confirmed ? "confirmed" as const : "rejection-proved" as const, evidenceHash: hash(120 + index), ...(confirmed ? { transactionHash, receipt, ourReceiptGasCost: "100", ourPrincipalDelta: action.id === "native-queue-ready-replacement-execute" ? "1" : "0" } : {}) };
    });
    journal.hashlessContinuation!.actions.splice(0, 22, ...records);
    journal.liveJournal.entries.push(...records.filter(record => record.status === "confirmed").map((record, index) => ({ id: record.id, intentHash: hash(160 + index), transactionHash: record.transactionHash!, nonce: 810 + index, reserved: 100n, status: "success" as const, receipt: record.receipt! })));
    return { ...fixture, journal, records };
  };

  const terminalRepairJournal = async () => {
    const complete = await terminalJournal();
    const prefixEvidence = [
      ...complete.journal.actions.map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash ?? rawHash(JSON.stringify(complete.proposal.source.stoppedRow)), transactionHash: record.transactionHash })),
      ...complete.records.map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash, transactionHash: record.transactionHash })),
    ];
    const state: RepairCanonicalState = {
      chainId: complete.original.chainId, blockNumber: 12_014_200n, blockHash: hash(0x901), blockTimestamp: 1_793_211_100n,
      safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, safeContractSecondary: PRODUCTION_REPAIR_EXECUTION_DOMAIN.oldSecondary,
      candidateRuntimeCodeHash: hash(0x902), candidateBindingHash: PRODUCTION_REPAIR_EXECUTION_DOMAIN.bindingHash,
      policyHash: PRODUCTION_REPAIR_EXECUTION_DOMAIN.beforePolicyHash, frozen: false,
      nativeWindow: 1_793_145_600n, nativeBaseSpent: 10_000_000_000_000n, nativeInstantSpent: 30_000_000_000_000n,
      usdcWindow: 0n, usdcBaseSpent: 10_000_000n, usdcInstantSpent: 30_000_000n,
      nativeBalance: 0n, usdcBalance: 1_000_000n, topologyEvidenceHash: complete.original.topologyEvidenceHash, observerReady: true,
    };
    const quote = {
      chainId: complete.original.chainId, factory: PRODUCTION_REPAIR_EXECUTION_DOMAIN.factory, candidate: PRODUCTION_REPAIR_EXECUTION_DOMAIN.candidate,
      x: 10342510752483659319190807637330965811978365685423845568184481734592673940696n,
      y: 83007955684183101275699917860538633816962061613045139387258186696967867907135n,
      verifiers: 1111636484949241205398856388087597953580887526884n,
      calldata: "0x0d2f048916dda754f7752e800b62ed684f89fb19d607485fbb8b9b77f5d877e4903904d8b784d685cc3013eab599b6d9696b06414ca74554ec8de222b6cdc43de410bc3f000000000000000000000000c2b78104907f722dabac4c69f826a522b2754de4" as Hex,
      calldataHash: PRODUCTION_REPAIR_EXECUTION_DOMAIN.creationCalldataHash, gasLimitCap: 740292n, maxFeePerGasCap: 1000000n, maxPriorityFeePerGasCap: 1000000n,
    };
    const lineage = { kind: "expired-hashless-continuation-v1" as const, continuation: complete.proposal, approval: complete.approval };
    const creation = createRepairCreationProposal({ proposal: complete.original, journal: complete.journal, evidence: prefixEvidence, lineage, state, quote });
    extendJournalForRepair(complete.journal, creation);
    const creationApprovalRaw = JSON.stringify({ schemaVersion: 1, scope: creation.scope, authorization: "EXACT_ACTION_APPROVAL", proposalHash: creation.proposalHash, actionCommitments: [creation.action.commitment], phaseLimitWei: creation.phaseLimitWei, maxBroadcastAttempts: 1 });
    const creationApproval = loadRepairApproval(creation, creationApprovalRaw, rawHash(creationApprovalRaw));
    bindRepairCreationApproval(complete.journal, creation, creationApproval);
    recordRepairCreationConfirmation(complete.journal, creation, hash(0x903));
    const group = createRepairGroupProposal({ creation, journal: complete.journal, state, assertion: "0x123456", lineage }).proposal;
    const groupApprovalRaw = JSON.stringify({ schemaVersion: 1, scope: group.scope, authorization: "EXACT_ACTION_APPROVAL", proposalHash: group.proposalHash, actionCommitments: group.actions.map(action => action.commitment), phaseLimitWei: group.phaseLimitWei, maxBroadcastAttempts: 1 });
    const groupApproval = loadRepairApproval(group, groupApprovalRaw, rawHash(groupApprovalRaw));
    const repair = complete.journal.repairContinuation!;
    repair.groupProposalHash = group.proposalHash;
    repair.groupApprovalHash = groupApproval.approvalHash;
    const groupRecords = group.actions.map((action, index) => {
      const rejection = action.id === "post-rotation-old-secondary-rejection";
      return { id: action.id, commitment: action.commitment, status: rejection ? "rejection-proved" as const : "confirmed" as const, evidenceHash: hash(0x920 + index), ...(rejection ? {} : { transactionHash: hash(0x940 + index) }) };
    });
    repair.actions.push(...groupRecords);
    complete.journal.liveJournal.entries.push(...groupRecords.filter(record => record.status === "confirmed").map((record, index) => ({
      id: record.id, intentHash: hash(0x960 + index), transactionHash: record.transactionHash!, nonce: 900 + index, reserved: 100n, status: "success" as const,
      receipt: { transactionHash: record.transactionHash!, status: "success" as const, gasUsed: 10n, effectiveGasPrice: 10n, blockNumber: 12_014_300n + BigInt(index), blockHash: hash(0x980 + index) },
    })));
    const repairEvidence = { continuationApproval: complete.approval, creation, creationApproval, group, groupApproval };
    return { ...complete, creation, creationApproval, group, groupApproval, repairEvidence };
  };

  it("never_calls_original_complete_or19_confirmed", async function () {
    const fixture = await hashlessContinuationFixture();
    const report = renderExpiredHashlessContinuationReport(fixture.original, fixture.proposal, fixture.journal) as any;
    expect(report.original).to.deep.include({ status: "INTERRUPTED_HASHLESS_AT_19_OF_38", terminalRowCount: 18 });
    expect(report.original.immutableRow19).to.include({ row: 19, status: "signed-simulated", outerNonce: 809, transactionHash: null, failureCause: null });
    expect(report.continuation.status).to.equal("CONTINUATION_INCOMPLETE");
    expect(JSON.stringify(report.original)).not.to.include("COMPLETE");
    expect(JSON.stringify(report.original.immutableRow19)).not.to.include("confirmed");
    expect(report.task0.status).to.equal("OPEN");
  });

  it("requires22_terminal_evidence_for_continuation_complete", async function () {
    const complete = await terminalJournal();
    const report = renderExpiredHashlessContinuationReport(complete.original, complete.proposal, complete.journal) as any;
    expect(report.continuation).to.include({ status: "EXPIRED_SOURCE_REBASED_CONTINUATION_COMPLETE", terminalActionCount: 22 });
    expect(report.continuation.terminalCounters).to.deep.equal({ safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7" });
    expect(report.task0).to.include({ status: "OPEN", nativeTasks1Through13: "GATED" });

    const missingEvidence = structuredClone(complete.journal);
    delete (missingEvidence.hashlessContinuation!.actions[0] as any).evidenceHash;
    expect(() => renderExpiredHashlessContinuationReport(complete.original, complete.proposal, missingEvidence)).to.throw(/evidence/i);
    const missingReceipt = structuredClone(complete.journal);
    delete (missingReceipt.hashlessContinuation!.actions[0] as any).receipt;
    expect(() => renderExpiredHashlessContinuationReport(complete.original, complete.proposal, missingReceipt)).to.throw(/receipt|live/i);
    const missingLive = structuredClone(complete.journal);
    missingLive.liveJournal.entries.pop();
    expect(() => renderExpiredHashlessContinuationReport(complete.original, complete.proposal, missingLive)).to.throw(/live|catalog/i);
  });

  it("reports_superseded_tail_and_repair_separately", async function () {
    const complete = await terminalJournal();
    const report = renderExpiredHashlessContinuationReport(complete.original, complete.proposal, complete.journal) as any;
    expect(report.supersededOriginalUsdc).to.include({ status: "SUPERSEDED_UNEXECUTED_COMMITMENTS", actionCount: 19 });
    expect(report.supersededOriginalUsdc.actionIds).to.deep.equal(complete.original.actions.slice(19).map(action => action.id));
    expect(report.continuation.actionIds).to.deep.equal(complete.proposal.actions.map(action => action.id));
    expect(report.laterRepair).to.include({ status: "NOT_ATTACHED", predecessor: null });
    expect(report.laterRepair.terminalCounters).to.deep.equal({ safeNonce: "19", delayQueueNonce: "9", delayTxNonce: "9" });
    expect(report.continuation.terminalCounters).to.deep.equal({ safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7" });
  });

  it("authenticates_complete_repair_artifacts_approvals_commitments_and_receipts", async function () {
    const complete = await terminalRepairJournal();
    const report = renderExpiredHashlessContinuationReport(complete.original, complete.proposal, complete.journal, complete.repairEvidence) as any;
    expect(report.laterRepair).to.include({ status: "REPAIR_TERMINAL_EVIDENCE_RECORDED", predecessor: "expired-hashless-continuation-v1", actionCount: 7 });

    const headerMutations: Array<[string, (journal: any) => void]> = [
      ["creation proposal", journal => { journal.repairContinuation.creationProposalHash = hash(0xa01); }],
      ["creation approval", journal => { journal.repairContinuation.creationApprovalHash = hash(0xa02); }],
      ["group proposal", journal => { journal.repairContinuation.groupProposalHash = hash(0xa03); }],
      ["group approval", journal => { journal.repairContinuation.groupApprovalHash = hash(0xa04); }],
      ["prefix", journal => { journal.repairContinuation.prefixHash = hash(0xa05); }],
    ];
    for (const [name, mutate] of headerMutations) { const journal = structuredClone(complete.journal); mutate(journal); expect(() => renderExpiredHashlessContinuationReport(complete.original, complete.proposal, journal, complete.repairEvidence), name).to.throw(/repair|header|predecessor|approval|proposal/i); }

    const changedCommitment = structuredClone(complete.journal); changedCommitment.repairContinuation!.actions[1]!.commitment = hash(0xa06);
    expect(() => renderExpiredHashlessContinuationReport(complete.original, complete.proposal, changedCommitment, complete.repairEvidence)).to.throw(/commitment|catalog|repair/i);

    const firstLive = 24;
    const receiptMutations: Array<[string, (journal: any) => void]> = [
      ["status", journal => { journal.liveJournal.entries[firstLive].status = "reverted"; }],
      ["entry transaction", journal => { journal.liveJournal.entries[firstLive].transactionHash = hash(0xa10); }],
      ["receipt transaction", journal => { journal.liveJournal.entries[firstLive].receipt.transactionHash = hash(0xa11); }],
      ["receipt status", journal => { journal.liveJournal.entries[firstLive].receipt.status = "reverted"; }],
      ["block number", journal => { journal.liveJournal.entries[firstLive].receipt.blockNumber = 0n; }],
      ["block hash", journal => { journal.liveJournal.entries[firstLive].receipt.blockHash = "0x12"; }],
      ["gas used", journal => { journal.liveJournal.entries[firstLive].receipt.gasUsed = 20n; }],
      ["gas price", journal => { journal.liveJournal.entries[firstLive].receipt.effectiveGasPrice = 20n; }],
      ["accounting", journal => { journal.liveJournal.entries[firstLive].reserved = 99n; }],
    ];
    for (const [name, mutate] of receiptMutations) { const journal = structuredClone(complete.journal); mutate(journal); expect(() => renderExpiredHashlessContinuationReport(complete.original, complete.proposal, journal, complete.repairEvidence), name).to.throw(/receipt|live|accounting|repair/i); }
  });

  it("rejects_orphan_extra_duplicate_reordered_and_missing_repair_live_suffixes", async function () {
    const unattached = await terminalJournal();
    unattached.journal.liveJournal.entries.push({ id: "repair-queue", intentHash: hash(0xb01), transactionHash: hash(0xb02), nonce: 900, reserved: 100n, status: "success", receipt: { transactionHash: hash(0xb02), status: "success", gasUsed: 10n, effectiveGasPrice: 10n, blockNumber: 1n, blockHash: hash(0xb03) } });
    expect(() => renderExpiredHashlessContinuationReport(unattached.original, unattached.proposal, unattached.journal)).to.throw(/orphan|suffix|repair/i);

    const complete = await terminalRepairJournal();
    expect(() => renderExpiredHashlessContinuationReport(complete.original, complete.proposal, complete.journal)).to.throw(/context|evidence|repair/i);
    const suffixMutations: Array<[string, (journal: any) => void]> = [
      ["extra", journal => { journal.liveJournal.entries.push(structuredClone(journal.liveJournal.entries.at(-1))); }],
      ["duplicate", journal => { journal.liveJournal.entries[25] = structuredClone(journal.liveJournal.entries[24]); }],
      ["reordered", journal => { [journal.liveJournal.entries[24], journal.liveJournal.entries[25]] = [journal.liveJournal.entries[25], journal.liveJournal.entries[24]]; }],
      ["missing", journal => { journal.liveJournal.entries.splice(24, 1); }],
    ];
    for (const [name, mutate] of suffixMutations) { const journal = structuredClone(complete.journal); mutate(journal); expect(() => renderExpiredHashlessContinuationReport(complete.original, complete.proposal, journal, complete.repairEvidence), name).to.throw(/repair|suffix|live|catalog/i); }
  });

  it("rejects_malformed_or_mixed_lineage_and_never_infers_failed_hashes", async function () {
    const fixture = await hashlessContinuationFixture();
    const malformed = structuredClone(fixture.journal);
    malformed.hashlessContinuation!.proposalHash = fixture.h("ee");
    expect(() => renderExpiredHashlessContinuationReport(fixture.original, fixture.proposal, malformed)).to.throw(/header|lineage|proposal/i);

    const mixed = structuredClone(fixture.journal);
    mixed.repairContinuation = { schemaVersion: 1, predecessor: { kind: "expired-hashless-continuation-v1", actionCount: 41, prefixHash: hash(0xe1), certificateHash: fixture.proposal.certificateHash, continuationProposalHash: fixture.proposal.proposalHash, continuationApprovalHash: mixed.hashlessContinuation!.approvalHash, observerIdentityHash: hash(0xe2), observerEvidenceHash: fixture.proposal.observer.probeEvidenceHash }, prefixHash: hash(0xe1), originalActionCount: 41, cumulativeActualCostWei: "1", creationProposalHash: hash(0xe3), actions: [] };
    expect(() => renderExpiredHashlessContinuationReport(fixture.original, fixture.proposal, mixed)).to.throw(/repair|complete|mixed/i);

    const failed = structuredClone(fixture.journal);
    failed.hashlessContinuation!.actions[0] = { id: fixture.proposal.actions[0]!.id, commitment: fixture.proposal.actions[0]!.commitment, status: "stopped", materializationHash: hash(0xf1) };
    const report = renderExpiredHashlessContinuationReport(fixture.original, fixture.proposal, failed) as any;
    expect(report.continuation.status).to.equal("CONTINUATION_INCOMPLETE");
    expect(report.continuation.actions[0]).to.deep.include({ status: "stopped", transactionHash: null, failureCause: null });
    expect(JSON.stringify(report.continuation.actions[0])).not.to.include("inferred");
  });

});
