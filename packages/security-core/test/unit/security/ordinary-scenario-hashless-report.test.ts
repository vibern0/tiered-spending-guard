import { expect } from "chai";
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

const safeEvents = parseAbi(["event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)"]);
const delayEvents = parseAbi(["event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)"]);
const hash = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hex;

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
    const now = new Date((Number(BigInt(fixture.proposal.observer.expiresAt)) - 60) * 1000);
    const alert = { kind: "delayed-queued" as const, chainId: 11_155_111, safe: fixture.original.safe, delay: fixture.original.delay, transactionHash, blockNumber: receipt.blockNumber, logIndex: 0, queueNonce: queue.queueNonce, queueFingerprint: queue.fingerprint, createdAt: blockTimestamp, expiresAt: blockTimestamp + 720n, to: queue.to, value: queue.value, data: queue.data, operation: queue.operation };
    const key = { chainId: 11_155_111, transactionHash, blockHash, logIndex: 0 };
    try {
      const firstStore = new FileActivityStore(ledgerPath); const first = new ActivityLedger(firstStore); first.accept(key, alert); const payloadSha256 = first.payloadHash(alert); firstStore.close();
      const secondStore = new FileActivityStore(ledgerPath); const second = new ActivityLedger(secondStore); second.markDelivered(key, { channel: "webhook", httpStatus: 200, payloadHash: payloadSha256, deliveredAt: new Date(now.getTime() - 2_000).toISOString() }); secondStore.close();
      writeFileSync(acknowledgementPath, JSON.stringify({ schemaVersion: 1, endpointHash: fixture.proposal.observer.endpointHash, transactionHash, payloadSha256, receiverRequestId: "fresh-continuation-receiver", receiverRecordedAt: new Date(now.getTime() - 1_500).toISOString(), retrievedAt: new Date(now.getTime() - 1_000).toISOString(), retrievalProvenance: "official-receiver-api", expiresAt: expiryIso }));

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
    complete.journal.repairContinuation = {
      schemaVersion: 1,
      predecessor: { kind: "expired-hashless-continuation-v1", actionCount: 41, prefixHash: hash(0xd1), certificateHash: complete.proposal.certificateHash, continuationProposalHash: complete.proposal.proposalHash, continuationApprovalHash: complete.journal.hashlessContinuation!.approvalHash, observerIdentityHash: sha256(complete.proposal.observer) as Hex, observerEvidenceHash: complete.proposal.observer.probeEvidenceHash },
      prefixHash: hash(0xd1), originalActionCount: 41, cumulativeActualCostWei: "1", creationProposalHash: hash(0xd3),
      actions: [{ id: "repair-signer-create", commitment: hash(0xd4), status: "proposed" }],
    };
    const report = renderExpiredHashlessContinuationReport(complete.original, complete.proposal, complete.journal) as any;
    expect(report.supersededOriginalUsdc).to.include({ status: "SUPERSEDED_UNEXECUTED_COMMITMENTS", actionCount: 19 });
    expect(report.supersededOriginalUsdc.actionIds).to.deep.equal(complete.original.actions.slice(19).map(action => action.id));
    expect(report.continuation.actionIds).to.deep.equal(complete.proposal.actions.map(action => action.id));
    expect(report.laterRepair).to.include({ status: "REPAIR_INCOMPLETE", predecessor: "expired-hashless-continuation-v1" });
    expect(report.laterRepair.terminalCounters).to.deep.equal({ safeNonce: "19", delayQueueNonce: "9", delayTxNonce: "9" });
    expect(report.continuation.terminalCounters).to.deep.equal({ safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7" });

    const reordered = structuredClone(complete.journal);
    reordered.repairContinuation!.actions = [
      { id: "repair-queue", commitment: hash(0xd5), status: "proposed" },
      { id: "repair-signer-create", commitment: hash(0xd4), status: "proposed" },
    ];
    expect(() => renderExpiredHashlessContinuationReport(complete.original, complete.proposal, reordered)).to.throw(/repair.*order|catalog.*order/i);
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
