import { expect } from "chai";
import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import type { OrdinaryScenarioActionRecord, OrdinaryScenarioJournal } from "../../../scripts/live/ordinary-scenario-executor";
import {
  PRODUCTION_REPAIR_EXECUTION_DOMAIN,
  REPAIR_BINDING_HASH,
  bindRepairCreationApproval,
  createRepairCreationProposal,
  createRepairGroupProposal,
  extendJournalForRepair,
  loadRepairApproval,
  recordRepairCreationConfirmation,
  type RepairCanonicalState,
} from "../../../scripts/live/ordinary-scenario-repair";
import {
  attachUsdcSuccessor,
  createUsdcSuccessorProposal,
  loadUsdcSuccessorApproval,
} from "../../../scripts/live/ordinary-scenario-usdc-successor-proposal";
import {
  renderUsdcSuccessorReport,
  type UsdcSuccessorReportContext,
  type UsdcSuccessorRepairReportEvidence,
} from "../../../scripts/live/ordinary-scenario-usdc-successor-report";
import { createUsdcSuccessorFixture, successorReceiptInclusion, successorSnapshot } from "../../support/usdc-successor-fixture";

const hash = (suffix: string) => `0x${suffix.padStart(64, "0")}` as Hex;
const rawHash = (value: string) => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const observer = {
  kind: "https-webhook" as const,
  publicId: `temporary-test-receiver:${hash("a1")}`,
  endpointHash: hash("a1"),
  startupEvidenceHash: hash("a2"),
  probeEvidenceHash: hash("a3"),
  independentFromProposer: true as const,
  readyAt: successorSnapshot.timestamp.toString(),
  workflowScheduleSeconds: { review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" },
  requiredThrough: (successorSnapshot.timestamp + 11_640n).toString(),
  expiresAt: "1793318400",
};
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;

function approvalDocument(proposal: ReturnType<typeof createUsdcSuccessorProposal>) {
  return {
    schemaVersion: 1,
    scope: "ordinary-usdc-period-successor-v1",
    authorization: "STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION",
    authorityEvidenceHash: proposal.authorityEvidenceHash,
    proposalHash: proposal.proposalHash,
    sourceHash: proposal.sourceHash,
    certificateHash: proposal.certificateHash,
    snapshot: proposal.snapshot,
    effectivePeriod: proposal.effectivePeriod,
    deadline: proposal.deadline,
    observer: proposal.observer,
    schedule: proposal.schedule,
    groups: proposal.groups,
    caps: proposal.caps,
    reservation: proposal.reservation,
    maxBroadcastAttempts: 1,
    approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })),
  };
}

async function prepared() {
  const fixture = await createUsdcSuccessorFixture();
  const proposal = createUsdcSuccessorProposal({ source: fixture.source, certificate: fixture.certificate, observer, caps });
  const document = approvalDocument(proposal);
  const approval = loadUsdcSuccessorApproval(proposal, JSON.stringify(document), sha256(document) as Hex);
  const journal = structuredClone(attachUsdcSuccessor(fixture.source.journal, proposal, approval)) as OrdinaryScenarioJournal;
  const context: UsdcSuccessorReportContext = { certificate: fixture.certificate, proposal, approval };
  return { ...fixture, proposal, approval, context, journal };
}

function terminalize(value: Awaited<ReturnType<typeof prepared>>) {
  const journal = structuredClone(value.journal);
  const records = value.proposal.actions.map((action, index) => {
    const confirmed = action.expectedOutcome === "success";
    const transactionHash = hash((0xb00 + index).toString(16));
    const gasUsed = 10n + BigInt(index);
    const effectiveGasPrice = 7n;
    const receipt = { transactionHash, status: "success" as const, gasUsed, effectiveGasPrice, blockNumber: 12_016_100n + BigInt(index), blockHash: hash((0xc00 + index).toString(16)) };
    return {
      id: action.id,
      commitment: action.commitment,
      status: confirmed ? "confirmed" as const : "rejection-proved" as const,
      evidenceHash: hash((0xd00 + index).toString(16)),
      ...(confirmed ? {
        transactionHash,
        receipt,
        receiptInclusion: successorReceiptInclusion(receipt, value.proposal.effectivePeriod, 60n + BigInt(index)),
        outerValue: "0",
        ourReceiptGasCost: (gasUsed * effectiveGasPrice).toString(),
        ourPrincipalDelta: "0",
        ...(index === 0 ? { establishedWindow: value.proposal.effectivePeriod } : {}),
      } : {}),
    };
  });
  journal.usdcSuccessor!.actions.splice(0, 19, ...records);
  journal.liveJournal.entries.push(...records.filter((record): record is typeof record & { transactionHash: Hex; receipt: NonNullable<typeof record.receipt>; ourReceiptGasCost: string } => record.status === "confirmed").map((record, index) => ({
    id: record.id,
    intentHash: hash((0xe00 + index).toString(16)),
    transactionHash: record.transactionHash,
    nonce: 900 + index,
    reserved: BigInt(record.ourReceiptGasCost),
    status: "success" as const,
    receipt: record.receipt,
  })));
  return { ...value, journal, records };
}

function prefixEvidence(value: ReturnType<typeof terminalize>) {
  const stoppedEvidence = rawHash(JSON.stringify(value.source.recovery.source.stoppedRow));
  return [
    ...value.journal.actions.map((record, index) => ({ actionId: record.id, evidenceHash: index === 18 ? stoppedEvidence : record.evidenceHash!, transactionHash: record.transactionHash })),
    ...value.journal.hashlessContinuation!.actions.slice(0, 3).map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash!, transactionHash: record.transactionHash })),
    ...value.records.map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash, transactionHash: record.transactionHash })),
  ];
}

function repairState(value: ReturnType<typeof terminalize>, overrides: Partial<RepairCanonicalState> = {}): RepairCanonicalState {
  return {
    chainId: 11_155_111,
    blockNumber: 12_016_200n,
    blockHash: hash("701"),
    blockTimestamp: BigInt(value.proposal.effectivePeriod) + 600n,
    safeNonce: 15n,
    delayQueueNonce: 7n,
    delayTxNonce: 7n,
    safeContractSecondary: PRODUCTION_REPAIR_EXECUTION_DOMAIN.oldSecondary,
    candidateRuntimeCodeHash: hash("0"),
    candidateBindingHash: hash("0"),
    policyHash: PRODUCTION_REPAIR_EXECUTION_DOMAIN.beforePolicyHash,
    frozen: false,
    nativeWindow: value.certificate.rawNativeSpend.window,
    nativeBaseSpent: value.certificate.rawNativeSpend.baseSpent,
    nativeInstantSpent: value.certificate.rawNativeSpend.instantSpent,
    usdcWindow: BigInt(value.proposal.effectivePeriod),
    usdcBaseSpent: 10_000_000n,
    usdcInstantSpent: 30_000_000n,
    nativeBalance: 0n,
    usdcBalance: 0n,
    topologyEvidenceHash: value.source.original.topologyEvidenceHash,
    observerReady: true,
    ...overrides,
  };
}

function terminalRepair(value: ReturnType<typeof terminalize>) {
  const lineage = { kind: "usdc-period-successor-v1" as const, source: value.source, certificate: value.certificate, successor: value.proposal, approval: value.approval };
  const quote = {
    chainId: 11_155_111,
    factory: PRODUCTION_REPAIR_EXECUTION_DOMAIN.factory,
    candidate: PRODUCTION_REPAIR_EXECUTION_DOMAIN.candidate,
    x: 10342510752483659319190807637330965811978365685423845568184481734592673940696n,
    y: 83007955684183101275699917860538633816962061613045139387258186696967867907135n,
    verifiers: PRODUCTION_REPAIR_EXECUTION_DOMAIN.verifiers,
    calldata: "0x0d2f048916dda754f7752e800b62ed684f89fb19d607485fbb8b9b77f5d877e4903904d8b784d685cc3013eab599b6d9696b06414ca74554ec8de222b6cdc43de410bc3f000000000000000000000000c2b78104907f722dabac4c69f826a522b2754de4" as Hex,
    calldataHash: PRODUCTION_REPAIR_EXECUTION_DOMAIN.creationCalldataHash,
    gasLimitCap: 740292n,
    maxFeePerGasCap: 1000000n,
    maxPriorityFeePerGasCap: 1000000n,
  };
  const creation = createRepairCreationProposal({ proposal: value.source.original, journal: value.journal, evidence: prefixEvidence(value), lineage, state: repairState(value), quote });
  extendJournalForRepair(value.journal, creation);
  const creationRaw = JSON.stringify({ schemaVersion: 1, scope: creation.scope, authorization: "EXACT_ACTION_APPROVAL", proposalHash: creation.proposalHash, actionCommitments: [creation.action.commitment], phaseLimitWei: creation.phaseLimitWei, maxBroadcastAttempts: 1 });
  const creationApproval = loadRepairApproval(creation, creationRaw, rawHash(creationRaw));
  bindRepairCreationApproval(value.journal, creation, creationApproval);
  const creationTransaction = hash("f01");
  recordRepairCreationConfirmation(value.journal, creation, hash("f02"), creationTransaction);
  value.journal.liveJournal.entries.push({ id: creation.action.id, intentHash: hash("f03"), transactionHash: creationTransaction, nonce: 1000, reserved: 70n, status: "success", receipt: { transactionHash: creationTransaction, status: "success", gasUsed: 10n, effectiveGasPrice: 7n, blockNumber: 12_016_300n, blockHash: hash("f04") } });
  const group = createRepairGroupProposal({ creation, journal: value.journal, state: repairState(value, { candidateRuntimeCodeHash: hash("702"), candidateBindingHash: REPAIR_BINDING_HASH }), assertion: "0x123456", lineage }).proposal;
  const groupRaw = JSON.stringify({ schemaVersion: 1, scope: group.scope, authorization: "EXACT_ACTION_APPROVAL", proposalHash: group.proposalHash, actionCommitments: group.actions.map(action => action.commitment), phaseLimitWei: group.phaseLimitWei, maxBroadcastAttempts: 1 });
  const groupApproval = loadRepairApproval(group, groupRaw, rawHash(groupRaw));
  value.journal.repairContinuation!.groupProposalHash = group.proposalHash;
  value.journal.repairContinuation!.groupApprovalHash = groupApproval.approvalHash;
  group.actions.forEach((action, index) => {
    const rejection = action.id === "post-rotation-old-secondary-rejection";
    const transactionHash = hash((0xf10 + index).toString(16));
    value.journal.repairContinuation!.actions.push({ id: action.id, commitment: action.commitment, status: rejection ? "rejection-proved" : "confirmed", evidenceHash: hash((0xf20 + index).toString(16)), ...(rejection ? {} : { transactionHash }) });
    if (!rejection) value.journal.liveJournal.entries.push({ id: action.id, intentHash: hash((0xf30 + index).toString(16)), transactionHash, nonce: 1001 + index, reserved: 70n, status: "success", receipt: { transactionHash, status: "success", gasUsed: 10n, effectiveGasPrice: 7n, blockNumber: 12_016_301n + BigInt(index), blockHash: hash((0xf40 + index).toString(16)) } });
  });
  const repairEvidence: UsdcSuccessorRepairReportEvidence = { creation, creationApproval, group, groupApproval };
  return { ...value, creation, creationApproval, group, groupApproval, repairEvidence };
}

describe("ordinary USDC successor persisted-evidence report", function () {
  it("keeps original interruption, native recovery, superseded tail, successor, repair, and Task 0 separate", async function () {
    const value = await prepared();
    value.cleanup();
    const report = renderUsdcSuccessorReport(value.source, value.context, value.journal) as any;
    expect(report.original).to.deep.include({ status: "INTERRUPTED_HASHLESS_AT_19_OF_38", terminalRowCount: 18 });
    expect(report.original.immutableRow19).to.include({ status: "signed-simulated", outerNonce: 809, transactionHash: null, failureCause: "UNKNOWN" });
    expect(report.nativeRecovery).to.include({ status: "NATIVE_RECOVERY_3_OF_22", confirmedActionCount: 3, approvedActionCount: 19 });
    expect(report.supersededOriginalUsdc).to.include({ status: "SUPERSEDED_UNEXECUTED_COMMITMENTS", actionCount: 19 });
    expect(report.successor).to.include({ status: "USDC_SUCCESSOR_INCOMPLETE", actionCount: 19, terminalActionCount: 0 });
    expect(report.laterRepair).to.include({ status: "NOT_ATTACHED", predecessor: null });
    expect(report.task0).to.include({ status: "OPEN", nativeTasks1Through13: "GATED" });
    expect(report.provenance).to.deep.equal({ source: "VERIFIED_PERSISTED_PUBLIC_EVIDENCE", rpcReadsPerformedByRenderer: false, filesystemReadsPerformedByRenderer: false, signing: false, simulation: false, approvalConstruction: false, broadcast: false });
    expect(JSON.stringify(report.nativeRecovery)).not.to.include("COMPLETE");
  });

  it("requires the exact terminal catalog, 24 successful entries, receipt costs, period, and observer-bound proposal", async function () {
    const value = terminalize(await prepared());
    const report = renderUsdcSuccessorReport(value.source, value.context, value.journal) as any;
    expect(report.successor).to.include({ status: "USDC_SUCCESSOR_19_OF_19_TERMINAL", terminalActionCount: 19, successfulLiveEntryCount: 11, effectivePeriod: value.proposal.effectivePeriod });
    expect(report.successor.observer).to.deep.equal({ probeEvidenceHash: value.proposal.observer.probeEvidenceHash, requiredThrough: value.proposal.observer.requiredThrough, expiresAt: value.proposal.observer.expiresAt });

    const mutations: Array<[string, (journal: OrdinaryScenarioJournal) => void]> = [
      ["header", journal => { journal.usdcSuccessor!.proposalHash = hash("bad"); }],
      ["old tail", journal => { journal.hashlessContinuation!.actions[3] = { ...(journal.hashlessContinuation!.actions[3] as any), status: "confirmed" }; }],
      ["evidence", journal => { delete (journal.usdcSuccessor!.actions[0] as any).evidenceHash; }],
      ["receipt", journal => { delete (journal.usdcSuccessor!.actions[0] as any).receipt; }],
      ["receipt inclusion absent", journal => { delete (journal.usdcSuccessor!.actions[0] as any).receiptInclusion; }],
      ["receipt inclusion changed", journal => { (journal.usdcSuccessor!.actions[0] as any).receiptInclusion.blockHash = hash("bad"); }],
      ["later receipt inclusion outside period", journal => { (journal.usdcSuccessor!.actions[18] as any).receiptInclusion.blockTimestamp = journal.usdcSuccessor!.deadline; (journal.usdcSuccessor!.actions[18] as any).receiptInclusion.effectivePeriod = journal.usdcSuccessor!.deadline; }],
      ["cost", journal => { (journal.usdcSuccessor!.actions[0] as any).ourReceiptGasCost = "1"; }],
      ["principal", journal => { (journal.usdcSuccessor!.actions[0] as any).ourPrincipalDelta = "1"; }],
      ["period", journal => { (journal.usdcSuccessor!.actions[0] as any).establishedWindow = "1793145600"; }],
      ["live", journal => { journal.liveJournal.entries.pop(); }],
    ];
    for (const [label, mutate] of mutations) {
      const journal = structuredClone(value.journal); mutate(journal);
      expect(() => renderUsdcSuccessorReport(value.source, value.context, journal), label).to.throw(/header|lineage|tail|evidence|receipt|accounting|period|live|catalog/i);
    }
  });

  it("never upgrades partial, pending, stopped, reverted, or forged authority to completion", async function () {
    const value = terminalize(await prepared());
    for (const status of ["outer-pending", "stopped", "reverted"] as const) {
      const journal = structuredClone(value.journal);
      const record = journal.usdcSuccessor!.actions[18] as OrdinaryScenarioActionRecord;
      record.status = status;
      if (status !== "reverted") delete record.receipt;
      delete record.evidenceHash;
      const live = journal.liveJournal.entries.find(entry => entry.id === record.id)!;
      if (status === "stopped") {
        journal.liveJournal.entries.splice(journal.liveJournal.entries.indexOf(live), 1);
        delete record.transactionHash;
      } else {
        live.status = status === "outer-pending" ? "pending" : "reverted";
        if (status === "reverted") {
          record.receipt = { ...record.receipt!, status: "reverted" };
          live.receipt = { ...live.receipt!, status: "reverted" };
        } else delete live.receipt;
      }
      const report = renderUsdcSuccessorReport(value.source, value.context, journal) as any;
      expect(report.successor.status).to.equal("USDC_SUCCESSOR_INCOMPLETE");
      expect(report.successor.actions[18]).to.include({ status, failureCause: null });
    }
    expect(() => renderUsdcSuccessorReport(value.source, { ...value.context, certificate: { ...value.certificate } as any }, value.journal)).to.throw(/certificate|opaque/i);
    expect(() => renderUsdcSuccessorReport(value.source, { ...value.context, approval: { approvalHash: value.approval.approvalHash } as any }, value.journal)).to.throw(/approval|authorization|opaque/i);
    const other = await prepared();
    expect(() => renderUsdcSuccessorReport(value.source, { ...value.context, approval: other.approval }, value.journal)).to.throw(/approval|authorization|opaque/i);
  });

  it("requires complete stage-correct opaque repair context and exact repair receipts", async function () {
    const value = terminalRepair(terminalize(await prepared()));
    expect(value.journal.repairContinuation!.cumulativeActualCostWei).to.equal(value.group.cumulativeActualCostWei);
    const report = renderUsdcSuccessorReport(value.source, value.context, value.journal, value.repairEvidence) as any;
    expect(report.laterRepair).to.include({ status: "REPAIR_TERMINAL_EVIDENCE_RECORDED", predecessor: "usdc-period-successor-v1", actionCount: 7 });
    expect(() => renderUsdcSuccessorReport(value.source, value.context, value.journal)).to.throw(/repair.*context|evidence/i);
    const forged = { ...value.repairEvidence, creationApproval: { approvalHash: value.creationApproval.approvalHash } as any };
    expect(() => renderUsdcSuccessorReport(value.source, value.context, value.journal, forged)).to.throw(/approval|opaque/i);
    const badReceipt = structuredClone(value.journal); badReceipt.liveJournal.entries[24]!.reserved += 1n;
    expect(() => renderUsdcSuccessorReport(value.source, value.context, badReceipt, value.repairEvidence)).to.throw(/receipt|accounting|repair/i);
  });
});
