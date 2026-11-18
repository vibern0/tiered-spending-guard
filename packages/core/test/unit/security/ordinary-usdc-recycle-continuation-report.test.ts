import { expect } from "chai";
import { createHash } from "node:crypto";
import type { Hex } from "viem";
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
  renderUsdcRecycleContinuationReport,
  type UsdcRecycleContinuationRepairReportEvidence,
} from "../../../scripts/live/ordinary-scenario-usdc-recycle-continuation-report";
import {
  cleanupUsdcRecycleContinuationFixtures,
  createApprovedUsdcRecycleContinuation,
} from "../../support/usdc-recycle-continuation-fixture";
import { successorReceiptInclusion } from "../../support/usdc-successor-fixture";

const hash = (value: number | string): Hex => `0x${value.toString(16).padStart(64, "0")}` as Hex;
const rawHash = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;

async function prepared() {
  const fixture = await createApprovedUsdcRecycleContinuation();
  const context = { certificate: fixture.certificate, proposal: fixture.proposal, approval: fixture.approval };
  return { ...fixture, context, journal: structuredClone(fixture.journal) as OrdinaryScenarioJournal };
}

function terminalize(value: Awaited<ReturnType<typeof prepared>>) {
  const journal = structuredClone(value.journal);
  const records = value.proposal.actions.map((action, index) => {
    const confirmed = action.expectedOutcome === "success";
    const transactionHash = hash(0x500 + index);
    const gasUsed = 20n + BigInt(index), effectiveGasPrice = 11n;
    const receipt = { transactionHash, status: "success" as const, gasUsed, effectiveGasPrice, blockNumber: 12_019_500n + BigInt(index), blockHash: hash(0x600 + index) };
    return {
      id: action.id,
      commitment: action.commitment,
      status: confirmed ? "confirmed" as const : "rejection-proved" as const,
      evidenceHash: hash(0x700 + index),
      ...(confirmed ? { transactionHash, receipt, receiptInclusion: successorReceiptInclusion(receipt, value.proposal.effectivePeriod, 120n + BigInt(index)), outerValue: "0", ourReceiptGasCost: (gasUsed * effectiveGasPrice).toString(), ourPrincipalDelta: "0" } : {}),
    };
  });
  journal.usdcRecycleContinuation!.actions.splice(0, records.length, ...records);
  journal.liveJournal.entries.push(...records.filter((record): record is typeof record & { transactionHash: Hex; receipt: NonNullable<typeof record.receipt>; ourReceiptGasCost: string } => record.status === "confirmed").map((record, index) => ({ id: record.id, intentHash: hash(0x800 + index), transactionHash: record.transactionHash, nonce: 900 + index, reserved: BigInt(record.ourReceiptGasCost), status: "success" as const, receipt: record.receipt })));
  return { ...value, journal, records };
}

function prefixEvidence(value: ReturnType<typeof terminalize>) {
  const stoppedEvidence = rawHash(JSON.stringify(value.source.prior.recovery.source.stoppedRow));
  return [
    ...value.journal.actions.map((record, index) => ({ actionId: record.id, evidenceHash: index === 18 ? stoppedEvidence : record.evidenceHash!, transactionHash: record.transactionHash })),
    ...value.journal.hashlessContinuation!.actions.slice(0, 3).map(record => ({ actionId: record.id, evidenceHash: (record as OrdinaryScenarioActionRecord).evidenceHash!, transactionHash: (record as OrdinaryScenarioActionRecord).transactionHash })),
    ...value.journal.usdcSuccessor!.actions.slice(0, 2).map(record => ({ actionId: record.id, evidenceHash: (record as OrdinaryScenarioActionRecord).evidenceHash!, transactionHash: (record as OrdinaryScenarioActionRecord).transactionHash })),
    ...value.records.map(record => ({ actionId: record.id, evidenceHash: record.evidenceHash, transactionHash: "transactionHash" in record ? record.transactionHash : undefined })),
  ];
}

function repairState(value: ReturnType<typeof terminalize>, overrides: Partial<RepairCanonicalState> = {}): RepairCanonicalState {
  return {
    chainId: 11_155_111, blockNumber: 12_020_000n, blockHash: hash(0xa01), blockTimestamp: 1_793_233_000n,
    safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n,
    safeContractSecondary: PRODUCTION_REPAIR_EXECUTION_DOMAIN.oldSecondary,
    candidateRuntimeCodeHash: hash(0), candidateBindingHash: hash(0), policyHash: PRODUCTION_REPAIR_EXECUTION_DOMAIN.beforePolicyHash, frozen: false,
    nativeWindow: value.certificate.rawNativeSpend.window, nativeBaseSpent: value.certificate.rawNativeSpend.baseSpent, nativeInstantSpent: value.certificate.rawNativeSpend.instantSpent,
    usdcWindow: BigInt(value.proposal.effectivePeriod), usdcBaseSpent: 10_000_000n, usdcInstantSpent: 20_000_000n,
    nativeBalance: 0n, usdcBalance: 20_000_000n, topologyEvidenceHash: value.source.prior.original.topologyEvidenceHash, observerReady: true,
    ...overrides,
  };
}

function terminalRepair(value: ReturnType<typeof terminalize>) {
  const lineage = { kind: "usdc-recycle-continuation-v1" as const, source: value.source, certificate: value.certificate, continuation: value.proposal, approval: value.approval };
  const quote = {
    chainId: 11_155_111, factory: PRODUCTION_REPAIR_EXECUTION_DOMAIN.factory, candidate: PRODUCTION_REPAIR_EXECUTION_DOMAIN.candidate,
    x: 10342510752483659319190807637330965811978365685423845568184481734592673940696n,
    y: 83007955684183101275699917860538633816962061613045139387258186696967867907135n,
    verifiers: PRODUCTION_REPAIR_EXECUTION_DOMAIN.verifiers,
    calldata: "0x0d2f048916dda754f7752e800b62ed684f89fb19d607485fbb8b9b77f5d877e4903904d8b784d685cc3013eab599b6d9696b06414ca74554ec8de222b6cdc43de410bc3f000000000000000000000000c2b78104907f722dabac4c69f826a522b2754de4" as Hex,
    calldataHash: PRODUCTION_REPAIR_EXECUTION_DOMAIN.creationCalldataHash,
    gasLimitCap: 740292n, maxFeePerGasCap: 1000000n, maxPriorityFeePerGasCap: 1000000n,
  };
  const creation = createRepairCreationProposal({ proposal: value.source.prior.original, journal: value.journal, evidence: prefixEvidence(value), lineage, state: repairState(value), quote });
  extendJournalForRepair(value.journal, creation);
  const creationRaw = JSON.stringify({ schemaVersion: 1, scope: creation.scope, authorization: "EXACT_ACTION_APPROVAL", proposalHash: creation.proposalHash, actionCommitments: [creation.action.commitment], phaseLimitWei: creation.phaseLimitWei, maxBroadcastAttempts: 1 });
  const creationApproval = loadRepairApproval(creation, creationRaw, rawHash(creationRaw));
  bindRepairCreationApproval(value.journal, creation, creationApproval);
  const creationTransaction = hash(0xf01);
  recordRepairCreationConfirmation(value.journal, creation, hash(0xf02), creationTransaction);
  value.journal.liveJournal.entries.push({ id: creation.action.id, intentHash: hash(0xf03), transactionHash: creationTransaction, nonce: 1000, reserved: 70n, status: "success", receipt: { transactionHash: creationTransaction, status: "success", gasUsed: 10n, effectiveGasPrice: 7n, blockNumber: 12_020_100n, blockHash: hash(0xf04) } });
  const group = createRepairGroupProposal({ creation, journal: value.journal, state: repairState(value, { candidateRuntimeCodeHash: hash(0xa02), candidateBindingHash: REPAIR_BINDING_HASH }), assertion: "0x123456", lineage }).proposal;
  const groupRaw = JSON.stringify({ schemaVersion: 1, scope: group.scope, authorization: "EXACT_ACTION_APPROVAL", proposalHash: group.proposalHash, actionCommitments: group.actions.map(action => action.commitment), phaseLimitWei: group.phaseLimitWei, maxBroadcastAttempts: 1 });
  const groupApproval = loadRepairApproval(group, groupRaw, rawHash(groupRaw));
  value.journal.repairContinuation!.groupProposalHash = group.proposalHash;
  value.journal.repairContinuation!.groupApprovalHash = groupApproval.approvalHash;
  group.actions.forEach((action, index) => {
    const rejection = action.id === "post-rotation-old-secondary-rejection", transactionHash = hash(0xf10 + index);
    value.journal.repairContinuation!.actions.push({ id: action.id, commitment: action.commitment, status: rejection ? "rejection-proved" : "confirmed", evidenceHash: hash(0xf20 + index), ...(rejection ? {} : { transactionHash }) });
    if (!rejection) value.journal.liveJournal.entries.push({ id: action.id, intentHash: hash(0xf30 + index), transactionHash, nonce: 1001 + index, reserved: 70n, status: "success", receipt: { transactionHash, status: "success", gasUsed: 10n, effectiveGasPrice: 7n, blockNumber: 12_020_101n + BigInt(index), blockHash: hash(0xf40 + index) } });
  });
  const repairEvidence: UsdcRecycleContinuationRepairReportEvidence = { creation, creationApproval, group, groupApproval };
  return { ...value, lineage, creation, creationApproval, group, groupApproval, repairEvidence };
}

describe("ordinary USDC recycle continuation persisted-evidence report", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  it("keeps original, native, old stopped USDC, recycle continuation, repair, and Task 0 separate", async function () {
    const value = await prepared();
    const report = renderUsdcRecycleContinuationReport(value.source, value.context, value.journal) as any;
    expect(report.original).to.deep.include({ status: "INTERRUPTED_HASHLESS_AT_19_OF_38", terminalRowCount: 18 });
    expect(report.original.immutableRow19).to.include({ status: "signed-simulated", outerNonce: 809, transactionHash: null, failureCause: "UNKNOWN" });
    expect(report.nativeRecovery).to.include({ status: "NATIVE_RECOVERY_3_OF_22", confirmedActionCount: 3, approvedActionCount: 19 });
    expect(report.oldUsdcSuccessor).to.include({ status: "OLD_USDC_SUCCESSOR_STOPPED_AT_2_OF_19", terminalActionCount: 2, actionCount: 19 });
    expect(report.oldUsdcSuccessor.immutableRow3).to.include({ status: "signed-simulated", transactionHash: null });
    expect(report.recycleContinuation).to.include({ status: "USDC_RECYCLE_CONTINUATION_INCOMPLETE", terminalActionCount: 0, actionCount: 17 });
    expect(report.recycleContinuation.expectedTerminalCounters).to.deep.equal({ safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7" });
    expect(report.laterRepair).to.include({ status: "NOT_ATTACHED", predecessor: null });
    expect(report.task0).to.include({ status: "OPEN", nativeTasks1Through13: "GATED" });
    expect(report.claims).to.deep.include({ hardwarePasskeyUxVerified: false, browserPasskeyUxVerified: false, nativeSafe4337Complete: false, audited: false, pullRequestGreen: false, productionReady: false });
    expect(report.provenance).to.deep.equal({ source: "VERIFIED_PERSISTED_PUBLIC_EVIDENCE", rpcReadsPerformedByRenderer: false, filesystemReadsPerformedByRenderer: false, signing: false, simulation: false, approvalConstruction: false, broadcast: false });
    expect(JSON.stringify(report.oldUsdcSuccessor)).not.to.include("19_OF_19");
  });

  it("requires exact terminal evidence, 24 successful live entries, period, gas, charges, and no principal netting", async function () {
    const value = terminalize(await prepared());
    const report = renderUsdcRecycleContinuationReport(value.source, value.context, value.journal) as any;
    expect(report.recycleContinuation).to.include({ status: "USDC_RECYCLE_CONTINUATION_17_OF_17_TERMINAL", terminalActionCount: 17, successfulLiveEntryCount: 9, semanticUsdcCompletionCount: 19 });
    expect(report.combinedEvidence).to.deep.include({ successfulLiveEntryCount: 24, expectedSafeNonce: "15", expectedDelayQueueNonce: "7", expectedDelayTxNonce: "7" });
    expect(report.accounting).to.deep.include({ invalidationGasCostWei: "124785100000", aggregateKnownChargeWei: "124953955544", grossUsdcOutflow: "11000000", grossUsdcInwardRecycling: "11000000", continuationNativePrincipalWei: "0", nettingApplied: false });
    expect(report.invalidation).to.include({ transactionHash: "0xa81d6df9e9720da44c096b713fdf389fa28ae41aee2224d7f492560ee864781e", nonce: 869, cause: "UNKNOWN" });

    const mutations: Array<[string, (journal: OrdinaryScenarioJournal) => void]> = [
      ["header", journal => { journal.usdcRecycleContinuation!.proposalHash = hash("bad"); }],
      ["old stopped row", journal => { (journal.usdcSuccessor!.actions[2] as any).status = "confirmed"; }],
      ["missing receipt inclusion", journal => { delete (journal.usdcRecycleContinuation!.actions[0] as any).receiptInclusion; }],
      ["late period", journal => { (journal.usdcRecycleContinuation!.actions[0] as any).receiptInclusion.blockTimestamp = journal.usdcRecycleContinuation!.deadline; }],
      ["gas cost", journal => { (journal.usdcRecycleContinuation!.actions[0] as any).ourReceiptGasCost = "1"; }],
      ["principal netting", journal => { (journal.usdcRecycleContinuation!.actions[0] as any).ourPrincipalDelta = "-1000000"; }],
      ["869 charge", journal => { journal.usdcRecycleContinuation!.aggregateKnownChargeWei = "168855544"; }],
      ["31m reset", journal => { journal.usdcRecycleContinuation!.maximumReservationWei = "31000000000000"; }],
      ["live", journal => { journal.liveJournal.entries.pop(); }],
    ];
    for (const [label, mutate] of mutations) {
      const journal = structuredClone(value.journal); mutate(journal);
      expect(() => renderUsdcRecycleContinuationReport(value.source, value.context, journal), label).to.throw(/historical|binding|header|lineage|stopped|receipt|period|gas|accounting|principal|charge|reservation|live/i);
    }
  });

  it("content-binds every historical source record before any recycle progress", async function () {
    const value = await prepared();
    const mutations: Array<[string, (journal: OrdinaryScenarioJournal) => void]> = [
      ["old row 3 outer nonce", journal => { (journal.usdcSuccessor!.actions[2] as any).outerNonce = 870; }],
      ["original receipt gas", journal => { (journal.actions[0] as any).receipt.gasUsed += 1n; }],
      ["native evidence", journal => { (journal.hashlessContinuation!.actions[0] as any).evidenceHash = hash("bad"); }],
      ["predecessor approval header", journal => { journal.approvalHash = hash("bad"); }],
      ["live prefix accounting", journal => { journal.liveJournal.entries[0]!.reserved += 1n; }],
    ];
    for (const [label, mutate] of mutations) {
      const journal = structuredClone(value.journal); mutate(journal);
      expect(() => renderUsdcRecycleContinuationReport(value.source, value.context, journal), label).to.throw(/historical|source|lineage|binding/i);
    }

    const mirroredSource = structuredClone(value.source) as typeof value.source;
    const mirroredJournal = structuredClone(value.journal);
    (mirroredSource.prior.journal.usdcSuccessor!.actions[2] as any).outerNonce = 870;
    (mirroredJournal.usdcSuccessor!.actions[2] as any).outerNonce = 870;
    expect(() => renderUsdcRecycleContinuationReport(mirroredSource, value.context, mirroredJournal)).to.throw(/historical|source|lineage|binding/i);

    const terminal = terminalize(value);
    (terminal.journal.usdcSuccessor!.actions[2] as any).outerNonce = 870;
    expect(() => renderUsdcRecycleContinuationReport(terminal.source, terminal.context, terminal.journal)).to.throw(/historical|source|lineage|binding/i);
  });

  it("never upgrades pending, stopped, late, or forged authority to completion", async function () {
    const value = terminalize(await prepared());
    for (const status of ["outer-pending", "stopped"] as const) {
      const journal = structuredClone(value.journal);
      const record = journal.usdcRecycleContinuation!.actions[16] as OrdinaryScenarioActionRecord;
      record.status = status; delete record.evidenceHash;
      const live = journal.liveJournal.entries.find(entry => entry.id === record.id)!;
      if (status === "stopped") { journal.liveJournal.entries.splice(journal.liveJournal.entries.indexOf(live), 1); delete record.transactionHash; delete record.receipt; }
      else { live.status = "pending"; delete live.receipt; delete record.receipt; }
      const report = renderUsdcRecycleContinuationReport(value.source, value.context, journal) as any;
      expect(report.recycleContinuation.status).to.equal("USDC_RECYCLE_CONTINUATION_INCOMPLETE");
      expect(report.recycleContinuation.actions[16]).to.include({ status, failureCause: null });
    }
    expect(() => renderUsdcRecycleContinuationReport(value.source, { ...value.context, certificate: { ...value.certificate } as any }, value.journal)).to.throw(/certificate|opaque/i);
    expect(() => renderUsdcRecycleContinuationReport(value.source, { ...value.context, approval: { approvalHash: value.approval.approvalHash } as any }, value.journal)).to.throw(/approval|authorization|opaque/i);
    const other = await prepared();
    expect(() => renderUsdcRecycleContinuationReport(value.source, { ...value.context, approval: other.approval }, value.journal)).to.throw(/approval|authorization|opaque/i);
  });

  it("requires complete stage-correct opaque repair context and exact repair receipts", async function () {
    const value = terminalRepair(terminalize(await prepared()));
    const report = renderUsdcRecycleContinuationReport(value.source, value.context, value.journal, value.repairEvidence) as any;
    expect(report.laterRepair).to.include({ status: "REPAIR_TERMINAL_EVIDENCE_RECORDED", predecessor: "usdc-recycle-continuation-v1", actionCount: 7 });
    expect(() => renderUsdcRecycleContinuationReport(value.source, value.context, value.journal)).to.throw(/repair.*context|evidence/i);
    const forged = { ...value.repairEvidence, creationApproval: { approvalHash: value.creationApproval.approvalHash } as any };
    expect(() => renderUsdcRecycleContinuationReport(value.source, value.context, value.journal, forged)).to.throw(/approval|opaque/i);
    const badReceipt = structuredClone(value.journal); badReceipt.liveJournal.entries[24]!.reserved += 1n;
    expect(() => renderUsdcRecycleContinuationReport(value.source, value.context, badReceipt, value.repairEvidence)).to.throw(/receipt|accounting|repair/i);
  });
});
