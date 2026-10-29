import { expect } from "chai";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { type Hex } from "viem";
import {
  createRepairCommandRuntime,
  runRepairCommand,
} from "../../../scripts/live/ordinary-scenario-repair-session";
import {
  createRepairCreationProposal,
  loadRepairCreationProposal,
  verifyRepairPredecessor,
} from "../../../scripts/live/ordinary-scenario-repair";
import { createOrdinaryScenarioStore } from "../../../scripts/live/ordinary-scenario-executor";
import { successorReceiptInclusion } from "../../support/usdc-successor-fixture";
import {
  cleanupUsdcRecycleContinuationFixtures,
  createApprovedUsdcRecycleContinuation,
} from "../../support/usdc-recycle-continuation-fixture";

const hash = (value: number): Hex => `0x${value.toString(16).padStart(64, "0")}` as Hex;

async function closedRecyclePredecessor() {
  const fixture = await createApprovedUsdcRecycleContinuation();
  const journal = structuredClone(fixture.journal);
  const records = fixture.proposal.actions.map((action, index) => {
    const confirmed = action.expectedOutcome === "success";
    const transactionHash = hash(0x500 + index);
    const receipt = { transactionHash, status: "success" as const, gasUsed: 20n + BigInt(index), effectiveGasPrice: 11n, blockNumber: 12_019_500n + BigInt(index), blockHash: hash(0x600 + index) };
    return {
      id: action.id,
      commitment: action.commitment,
      status: confirmed ? "confirmed" as const : "rejection-proved" as const,
      evidenceHash: hash(0x700 + index),
      ...(confirmed ? { transactionHash, receipt, receiptInclusion: successorReceiptInclusion(receipt, fixture.proposal.effectivePeriod, 120n + BigInt(index)), outerValue: "0", ourReceiptGasCost: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), ourPrincipalDelta: "0" } : {}),
    };
  });
  journal.usdcRecycleContinuation!.actions.splice(0, records.length, ...records);
  journal.liveJournal.entries.push(...records.filter(record => record.status === "confirmed").map((record, index) => ({ id: record.id, intentHash: hash(0x800 + index), transactionHash: record.transactionHash!, nonce: 900 + index, reserved: BigInt(record.ourReceiptGasCost!), status: "success" as const, receipt: record.receipt! })));
  const stoppedEvidence = `0x${createHash("sha256").update(JSON.stringify(fixture.source.prior.recovery.source.stoppedRow)).digest("hex")}` as Hex;
  const evidence = [
    ...journal.actions.map((record, index) => ({ actionId: record.id, evidenceHash: index === 18 ? stoppedEvidence : record.evidenceHash!, transactionHash: record.transactionHash })),
    ...journal.hashlessContinuation!.actions.slice(0, 3).map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash!, transactionHash: record.transactionHash })),
    ...journal.usdcSuccessor!.actions.slice(0, 2).map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash!, transactionHash: record.transactionHash })),
    ...records.map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash, transactionHash: record.transactionHash })),
  ];
  const lineage = { kind: "usdc-recycle-continuation-v1" as const, source: fixture.source, certificate: fixture.certificate, continuation: fixture.proposal, approval: fixture.approval };
  return { ...fixture, journal, records, evidence, lineage };
}

describe("closed recycle continuation repair predecessor", () => {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  it("accepts only the exact original19/native3/old2/new17 lineage", async () => {
    const fixture = await closedRecyclePredecessor();
    const predecessor = verifyRepairPredecessor(fixture.source.prior.original, fixture.journal, fixture.evidence, fixture.lineage as never);
    expect(predecessor).to.include({ kind: "usdc-recycle-continuation-v1", actionCount: 41, safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, effectivePeriod: 1_793_232_000n });
    expect(fixture.journal.liveJournal.entries).to.have.length(24);
    expect(fixture.journal.usdcSuccessor!.actions[2]!.status).to.equal("signed-simulated");
  });

  it("rejects incomplete new terminal evidence and old row3 terminalization", async () => {
    const fixture = await closedRecyclePredecessor();
    const incomplete = structuredClone(fixture.journal); incomplete.usdcRecycleContinuation!.actions[16]!.status = "approved";
    expect(() => verifyRepairPredecessor(fixture.source.prior.original, incomplete, fixture.evidence, fixture.lineage as never)).to.throw(/recycle|terminal|complete|canonical/i);
    const oldRow = structuredClone(fixture.journal); oldRow.usdcSuccessor!.actions[2]!.status = "confirmed" as never;
    expect(() => verifyRepairPredecessor(fixture.source.prior.original, oldRow, fixture.evidence, fixture.lineage as never)).to.throw(/old|stopped|source|canonical/i);
  });

  it("binds the repair spine to the recycle terminal dependency", async () => {
    const fixture = await closedRecyclePredecessor();
    const state = { chainId: 11155111, blockNumber: 12_020_000n, blockHash: hash(0xa01), blockTimestamp: 1_793_233_000n, safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, safeContractSecondary: fixture.source.prior.original.safeContractSecondary, candidateRuntimeCodeHash: hash(0), candidateBindingHash: hash(0), policyHash: "0x5b19fb0f9dcc35db4d45ec227f01348985431d74a2092d887bc7b4f26ade4a82" as Hex, frozen: false as const, nativeWindow: 1_793_145_600n, nativeBaseSpent: 10_000_000_000_000n, nativeInstantSpent: 30_000_000_000_000n, usdcWindow: 1_793_232_000n, usdcBaseSpent: 10_000_000n, usdcInstantSpent: 20_000_000n, nativeBalance: 0n, usdcBalance: 20_000_000n, topologyEvidenceHash: hash(0xa02), observerReady: true };
    const quote = { chainId: 11155111, factory: "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf", candidate: "0xCc3C12cFB2508E5E9E4EB9b21CC44A9dEEFf0908", x: 10342510752483659319190807637330965811978365685423845568184481734592673940696n, y: 83007955684183101275699917860538633816962061613045139387258186696967867907135n, verifiers: 1111636484949241205398856388087597953580887526884n, calldata: "0x0d2f048916dda754f7752e800b62ed684f89fb19d607485fbb8b9b77f5d877e4903904d8b784d685cc3013eab599b6d9696b06414ca74554ec8de222b6cdc43de410bc3f000000000000000000000000c2b78104907f722dabac4c69f826a522b2754de4", calldataHash: "0x0ed506887dea4406bb68a77a9d4c54b2454946b80b9205772900008859a92c7b", gasLimitCap: 740292n, maxFeePerGasCap: 1000000n, maxPriorityFeePerGasCap: 1000000n } as const;
    const creation = createRepairCreationProposal({ proposal: fixture.source.prior.original, journal: fixture.journal, evidence: fixture.evidence, lineage: fixture.lineage as never, state, quote });
    expect(loadRepairCreationProposal(JSON.stringify(creation), creation.proposalHash).action.dependsOn).to.deep.equal(["usdc-recycle-continuation-queue-ready-execute"]);
  });

  it("atomically reopens recycle and repair coexistence without flattening the stopped old row", async () => {
    const fixture = await closedRecyclePredecessor();
    const predecessor = verifyRepairPredecessor(fixture.source.prior.original, fixture.journal, fixture.evidence, fixture.lineage as never);
    const journal = structuredClone(fixture.journal);
    journal.repairContinuation = { schemaVersion: 1, predecessor: { kind: predecessor.kind, actionCount: predecessor.actionCount, prefixHash: predecessor.prefixHash, certificateHash: predecessor.certificateHash, continuationProposalHash: predecessor.continuationProposalHash, continuationApprovalHash: predecessor.continuationApprovalHash, observerIdentityHash: predecessor.observerIdentityHash, observerEvidenceHash: predecessor.observerEvidenceHash, effectivePeriod: predecessor.effectivePeriod!.toString(), rawNativeSpend: predecessor.rawNativeSpend!, rawUsdcSpend: predecessor.rawUsdcSpend! } as never, prefixHash: predecessor.prefixHash, originalActionCount: 41, cumulativeActualCostWei: predecessor.cumulativeActualCostWei.toString(), creationProposalHash: hash(0xb01), actions: [] };
    const directory = mkdtempSync(join(tmpdir(), "recycle-repair-reopen-")); const path = join(directory, "journal.json");
    const identity = { proposalHash: journal.proposalHash, approvalHash: journal.approvalHash, funder: journal.funder };
    const store = createOrdinaryScenarioStore(path, identity, () => journal);
    try {
      store.save(journal);
      const reopened = store.load();
      expect(reopened.repairContinuation!.predecessor!.kind).to.equal("usdc-recycle-continuation-v1");
      expect(reopened.liveJournal.entries.slice(0, 15).map(entry => entry.id)).to.deep.equal(journal.liveJournal.entries.slice(0, 15).map(entry => entry.id));
      expect(reopened.usdcSuccessor!.actions[2]!.status).to.equal("signed-simulated");
    } finally { store.close?.(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("routes the complete most-specific recycle flag set through the recycle lineage loader before the writer lease", async () => {
    const fixture = await createApprovedUsdcRecycleContinuation(); let loads = 0;
    const values = new Map<string, string>([
      ["--report", "report"], ["--artifact-hash", hash(1)], ["--package-hash", hash(2)], ["--proposal-hash", fixture.source.prior.original.proposalHash], ["--original-approval-hash", fixture.journal.approvalHash], ["--journal", "journal"], ["--output", "output"],
      ...["--recovery-certificate", "--recovery-certificate-hash", "--recovery-proposal", "--recovery-approval", "--recovery-approval-hash", "--primary-bundle-manifest", "--successor-certificate", "--successor-certificate-hash", "--successor-proposal", "--successor-approval", "--successor-approval-hash", "--source-manifest", "--source-step-up-ledger", "--source-step-up-ack", "--recycle-certificate", "--recycle-certificate-hash", "--recycle-proposal", "--recycle-approval", "--recycle-approval-hash"].map((flag, index) => [flag, `value-${index}`] as [string, string]),
    ]);
    const args = [...values].flat();
    const runtime = createRepairCommandRuntime({ environment: {}, domain: (await import("../../../scripts/live/ordinary-scenario-repair")).PRODUCTION_REPAIR_EXECUTION_DOMAIN, ordinaryDomain: (await import("../../../scripts/live/ordinary-scenario-executor")).PRODUCTION_ORDINARY_SCENARIO_DOMAIN, repository: () => { throw new Error("recycle loader completed before writer lease"); }, createHarness: () => { throw new Error("unexpected harness"); }, createAdapter: () => { throw new Error("unexpected adapter"); }, loadCreationQuote: () => { throw new Error("unexpected quote"); }, submit: async () => { throw new Error("unexpected submit"); }, now: () => new Date(1_793_300_000_000), awaitApprovalHandoff: async () => { throw new Error("unexpected approval"); }, loadUsdcRecycleContinuationLineage: async argv => { loads++; expect(argv[0]).to.equal("submit-one"); return { source: fixture.source, certificate: fixture.certificate, continuation: fixture.proposal, approval: fixture.approval }; } });
    await expect(runRepairCommand(["creation-review", ...args], runtime)).to.be.rejectedWith(/terminal journal/i);
    expect(loads).to.equal(1);
    values.delete("--recycle-approval-hash");
    await expect(runRepairCommand(["creation-review", ...[...values].flat()], runtime)).to.be.rejectedWith(/complete shared public loader inputs/i);
    expect(loads).to.equal(1);
  });
});
