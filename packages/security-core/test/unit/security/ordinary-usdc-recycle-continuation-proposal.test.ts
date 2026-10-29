import { expect } from "chai";
import { decodeFunctionData, hashTypedData, type Hex } from "viem";
import { queueFingerprint, queueMonitoringFingerprint } from "../../../src/queue/delay";
import { SAFE_TX_TYPES } from "../../../src/signers/types";
import { sha256 } from "../../../scripts/plan-deployment";
import { verifyUsdcRecycleContinuationCertificate } from "../../../scripts/live/ordinary-scenario-usdc-recycle-continuation-certificate";
import {
  USDC_RECYCLE_CONTINUATION_GROUPS,
  USDC_RECYCLE_CONTINUATION_SCHEDULE,
  assertUsdcRecycleContinuationAdmission,
  assertUsdcRecycleContinuationAuthorization,
  attachUsdcRecycleContinuation,
  createUsdcRecycleContinuationProposal,
  loadUsdcRecycleContinuationApproval,
  parseUsdcRecycleContinuationProposal,
} from "../../../scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal";
import {
  cleanupUsdcRecycleContinuationFixtures,
  createUsdcRecycleContinuationSource,
  recycleFixture,
  recycleProviders,
} from "../../support/usdc-recycle-continuation-fixture";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const authorityEvidenceHash = "0xc7dca18faa9a9bf1cb2028c8bb77a5ccf8b0577145a408dd301d043be09bad3b" as Hex;
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;
const suffixes = [
  "recycle-topup-step-up", "step-up-ecdsa", "direct-overspend-rejection", "replay-rejection", "unsupported-path-rejection",
  "recycle-topup-delayed", "queue-cancel", "queue-cancel-early-rejection", "queue-cancel-action", "queue-cancelled-execution-rejection",
  "queue-expiry", "queue-expiry-early-rejection", "queue-expiry-skip", "queue-expired-execution-rejection", "queue-execute",
  "queue-execute-early-rejection", "queue-ready-execute",
] as const;
const expectedIds = suffixes.map(value => `usdc-recycle-continuation-${value}`);
const expectedKinds = ["controlled-recipient-recycled-funding", "step-up-transfer", "expected-direct-rejection", "expected-replay-rejection", "expected-unsupported-rejection", "controlled-recipient-recycled-funding", "queue-proposal", "expected-early-rejection", "queue-cancellation", "expected-cancelled-rejection", "queue-proposal", "expected-early-rejection", "queue-expiry", "expected-expired-rejection", "queue-proposal", "expected-early-rejection", "ready-delay-execution"];
const expectedRoles = [["funder"], ["primary-passkey", "legacy-ecdsa-secondary"], ["primary-passkey", "safe-contract-secondary"], ["replay previously reviewed signed envelope only in later executor"], ["primary-passkey", "safe-contract-secondary"], ["funder"], ["primary-passkey", "safe-contract-secondary"], [], ["primary-passkey", "safe-contract-secondary"], [], ["primary-passkey", "safe-contract-secondary"], [], [], [], ["primary-passkey", "safe-contract-secondary"], [], []];
const expectedDependencies = [
  ["usdc-successor-step-up-contract"], [expectedIds[0]], [expectedIds[1]], ["usdc-successor-base-x"], [expectedIds[1]], [expectedIds[1]],
  [expectedIds[5]], [expectedIds[6]], [expectedIds[6]], [expectedIds[8]], [expectedIds[8]], [expectedIds[10]], [expectedIds[10]],
  [expectedIds[12]], [expectedIds[12]], [expectedIds[14]], [expectedIds[15]],
];
const tokenAbi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool" }] }, { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool" }] }] as const;

type Proposal = ReturnType<typeof createUsdcRecycleContinuationProposal>;
function approvalDocument(proposal: Proposal) {
  return {
    schemaVersion: 1,
    scope: "ordinary-usdc-recycle-continuation-v1",
    authorization: "STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION",
    authorityEvidenceHash,
    proposalHash: proposal.proposalHash,
    sourceHash: proposal.sourceHash,
    certificateHash: proposal.certificateHash,
    snapshot: proposal.snapshot,
    currentCheckpoint: proposal.currentCheckpoint,
    minimumOuterNonce: proposal.minimumOuterNonce,
    effectivePeriod: proposal.effectivePeriod,
    deadline: proposal.deadline,
    observer: proposal.observer,
    schedule: proposal.schedule,
    groups: proposal.groups,
    caps: proposal.caps,
    reservation: proposal.reservation,
    repairAuthority: "NONE",
    sharedBudgetCharges: proposal.sharedBudgetCharges,
    maxBroadcastAttempts: 1,
    approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })),
  };
}

describe("ordinary USDC recycle continuation proposal", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  async function context(nonce = 870) {
    const source = await createUsdcRecycleContinuationSource();
    const certificate = await verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { snapshotNonce: nonce }, { snapshotNonce: nonce }));
    const proposal = createUsdcRecycleContinuationProposal({ source, certificate, observer: structuredClone(source.priorProposal.observer), caps });
    return { source, certificate, proposal };
  }

  it("rebuilds the literal remaining 17 actions and exact transaction identities from the opaque predecessor", async function () {
    const { source, proposal } = await context();
    expect(proposal.actions.map(action => action.id)).to.deep.equal(expectedIds);
    expect(proposal.actions.map(action => action.kind)).to.deep.equal(expectedKinds);
    expect(proposal.actions.map(action => action.signerRoles)).to.deep.equal(expectedRoles);
    expect(proposal.actions.map(action => action.dependsOn)).to.deep.equal(expectedDependencies);
    const direct = proposal.actions.slice(0, 6).map(action => decodeFunctionData({ abi: tokenAbi, data: action.safeTransaction?.data ?? action.transaction.data }));
    expect(direct.map(call => [call.functionName, call.args?.[1]?.toString()])).to.deep.equal([["transfer", "10000000"], ["transfer", "10000000"], ["transfer", "1"], ["transfer", "10000000"], ["approve", "1"], ["transfer", "1000000"]]);
    expect(proposal.actions.filter(action => action.expectedOutcome === "success" && action.safeTransaction).map(action => action.safeTransaction!.nonce)).to.deep.equal(["10", "11", "12", "13", "14"]);
    expect(proposal.actions.filter(action => action.queue).map(action => action.queue!.queueNonce)).to.deep.equal(["4", "4", "4", "5", "5", "5", "5", "6", "6", "6"]);
    expect(proposal.actions[16]!.after).to.include({ safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7", safeNativeBalance: "0", safeUsdcBalance: "0", funderUsdcBalance: "20000000" });
    for (const action of proposal.actions) {
      if (action.safeTransaction) expect(action.safeTxHash).to.equal(hashTypedData({ domain: { chainId: 11_155_111, verifyingContract: source.prior.original.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { ...action.safeTransaction, value: BigInt(action.safeTransaction.value), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: BigInt(action.safeTransaction.nonce) } }));
      if (action.queue) {
        const item = { safe: source.prior.original.safe, delay: source.prior.original.delay, to: action.queue.to, value: BigInt(action.queue.value), data: action.queue.data, operation: 0 as const, queueNonce: BigInt(action.queue.queueNonce) };
        expect(action.queue.fingerprint).to.equal(queueFingerprint(item));
        expect(action.queue.monitoringFingerprint).to.equal(queueMonitoringFingerprint(item));
      }
    }
    expect(proposal.actions[3]!.transaction).to.deep.equal(source.priorProposal.actions[5]!.transaction);
    proposal.actions.forEach((action, index) => {
      expect(action.commitment).not.to.equal(source.priorProposal.actions[index + 2]!.commitment);
      const { commitment: _commitment, ...descriptor } = action;
      expect(action.commitment).to.equal(sha256({ ...descriptor, currentCheckpoint: proposal.currentCheckpoint, minimumOuterNonce: proposal.minimumOuterNonce }));
    });
  });

  it("binds the authenticated checkpoint, inherited observer, fixed groups, and closed shared budget", async function () {
    const { source, certificate, proposal } = await context();
    expect(USDC_RECYCLE_CONTINUATION_SCHEDULE).to.deep.equal({ review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300", reviewAdmission: "11640", initialExecutionAdmission: "8040", reconciliationMargin: "840" });
    expect(USDC_RECYCLE_CONTINUATION_GROUPS).to.deep.equal([{ start: 1, end: 5, budgetSeconds: "2400" }, { start: 6, end: 10, budgetSeconds: "1500" }, { start: 11, end: 14, budgetSeconds: "1800" }, { start: 15, end: 17, budgetSeconds: "1500" }]);
    expect(proposal).to.include({ scope: "ordinary-usdc-recycle-continuation-v1", authorization: "NONE", chainId: 11_155_111, authorityEvidenceHash, minimumOuterNonce: 870, effectivePeriod: "1793232000", deadline: "1793318400", maxBroadcastAttempts: 1 });
    expect(proposal.currentCheckpoint).to.deep.equal(certificate.currentCheckpoint);
    expect(JSON.stringify(proposal.observer)).to.equal(JSON.stringify(source.priorProposal.observer));
    expect(proposal.reservation).to.deep.equal({ phaseLimitWei: "50000000000000000", canonicalPriorGasCostWei: "71036172317440", priorGrossNativePrincipalWei: "60000000000002", continuationNativePrincipalWei: "0", originalAggregateGasAllowanceWei: "16080584000000", priorActualGasCostWei: "168855544", invalidationGasCostWei: "124785100000", aggregateKnownChargeWei: "124953955544", remainingAggregateAllowanceWei: "15955630044456", continuationMaximumReservationWei: "12080584000000", unusedAggregateAllowanceWei: "3875046044456", maximumPhaseOutlayWei: "143241710272986", grossUsdcOutflow: "11000000", grossUsdcInwardRecycling: "11000000" });
    expect(proposal.sharedBudgetCharges).to.deep.equal({ priorActualGasCostWei: "168855544", invalidationGasCostWei: "124785100000", aggregateKnownChargeWei: "124953955544" });
    expect(Object.isFrozen(proposal)).to.equal(true);
    const refreshed = structuredClone(source.priorProposal.observer) as any; refreshed.probeEvidenceHash = h("d");
    expect(() => createUsdcRecycleContinuationProposal({ source, certificate, observer: refreshed, caps })).to.throw(/observer|inherited|probe/i);
    const duplicateProbe = structuredClone(source.priorProposal.observer) as any; duplicateProbe.probeEvidenceHash = duplicateProbe.startupEvidenceHash;
    expect(() => createUsdcRecycleContinuationProposal({ source, certificate, observer: duplicateProbe, caps })).to.throw(/observer|inherited|probe/i);
    expect(() => createUsdcRecycleContinuationProposal({ source, certificate, observer: { ...source.priorProposal.observer, refreshed: true } as any, caps })).to.throw(/observer|shape|inherited/i);
    expect(() => createUsdcRecycleContinuationProposal({ source, certificate, observer: source.priorProposal.observer, caps: { ...caps, fundingGasLimit: "740293" } })).to.throw(/caps|literal/i);
  });

  it("independently reduces nine broadcasts, gas, outward USDC, inward USDC, and whole-phase outlay", async function () {
    const { proposal } = await context();
    let broadcasts = 0, safeOutflow = 0n, inward = 0n, gas = 0n;
    for (const action of proposal.actions.filter(candidate => candidate.expectedOutcome === "success")) {
      broadcasts++;
      gas += BigInt(action.gasLimitCap) * BigInt(action.maxFeePerGasCap);
      const safeDelta = BigInt(action.before.safeUsdcBalance) - BigInt(action.after.safeUsdcBalance);
      const funderDelta = BigInt(action.after.funderUsdcBalance) - BigInt(action.before.funderUsdcBalance);
      if (safeDelta > 0n) safeOutflow += safeDelta;
      if (funderDelta < 0n) inward += -funderDelta;
    }
    expect({ broadcasts, rejections: proposal.actions.filter(action => action.expectedOutcome === "rejection").length, gas, safeOutflow, inward }).to.deep.equal({ broadcasts: 9, rejections: 8, gas: 12_080_584_000_000n, safeOutflow: 11_000_000n, inward: 11_000_000n });
    expect(BigInt(proposal.reservation.canonicalPriorGasCostWei) + 60_000_000_000_002n + 124_953_955_544n + 12_080_584_000_000n).to.equal(143_241_710_272_986n);
    expect(BigInt(proposal.reservation.maximumPhaseOutlayWei)).to.equal(143_241_710_272_986n);
  });

  it("changes every commitment when the authenticated nonce checkpoint changes", async function () {
    const first = await context(870); const second = await context(901);
    expect(second.proposal.minimumOuterNonce).to.equal(901);
    expect(first.proposal.actions.map(action => action.commitment)).not.to.deep.equal(second.proposal.actions.map(action => action.commitment));
  });

  it("strictly parses only the regenerated closed proposal and rejects source, suffix, and budget forgery", async function () {
    const { source, certificate, proposal } = await context();
    expect(parseUsdcRecycleContinuationProposal(JSON.stringify(proposal), source, certificate).proposalHash).to.equal(proposal.proposalHash);
    for (const mutate of [
      (body: any) => { body.actions[0].id += "-2"; },
      (body: any) => { body.actions[0].commitment = h("1"); },
      (body: any) => { body.actions.reverse(); },
      (body: any) => { body.startIndex = 3; },
      (body: any) => { body.reservation.remainingAggregateAllowanceWei = "16080584000000"; },
      (body: any) => { body.reservation.grossUsdcOutflow = "0"; },
      (body: any) => { body.reservation.invalidationGasCostWei = "0"; },
      (body: any) => { body.reservation.grossUsdcInwardRecycling = "31000000"; },
      (body: any) => { body.reservation.continuationMaximumReservationWei = "15955630044457"; },
      (body: any) => { body.currentCheckpoint.pendingNonce = 871; },
    ]) {
      const body = JSON.parse(JSON.stringify(proposal)); mutate(body);
      expect(() => parseUsdcRecycleContinuationProposal(JSON.stringify(body), source, certificate)).to.throw(/shape|drift|catalog|budget|checkpoint|proposal/i);
    }
    expect(() => createUsdcRecycleContinuationProposal({ source: structuredClone(source) as any, certificate, observer: proposal.observer, caps })).to.throw(/opaque|source|certificate/i);
    expect(() => createUsdcRecycleContinuationProposal({ source, certificate: { ...certificate } as any, observer: proposal.observer, caps })).to.throw(/opaque|certificate/i);
  });

  it("loads one exact standing approval with no repair authority and shared charges", async function () {
    const { source, proposal } = await context(); const document = approvalDocument(proposal); const approval = loadUsdcRecycleContinuationApproval(proposal, JSON.stringify(document), sha256(document) as Hex);
    expect(() => assertUsdcRecycleContinuationAuthorization(proposal, approval)).not.to.throw();
    expect(() => assertUsdcRecycleContinuationAuthorization(proposal, { ...approval } as any)).to.throw(/opaque|bound/i);
    expect(() => assertUsdcRecycleContinuationAuthorization(proposal, source.priorApproval as any)).to.throw(/opaque|bound/i);
    for (const mutate of [
      (body: any) => { body.authorization = "EXPLICIT_GROUP_APPROVAL"; },
      (body: any) => { body.repairAuthority = "FINANCIAL_REPAIR"; },
      (body: any) => { body.sharedBudgetCharges.aggregateKnownChargeWei = "0"; },
      (body: any) => { body.minimumOuterNonce = 869; },
      (body: any) => { body.approvedActions[0].commitment = h("2"); },
      (body: any) => { body.humanReviewedProposalHash = proposal.proposalHash; },
    ]) {
      const body = structuredClone(document) as any; mutate(body);
      expect(() => loadUsdcRecycleContinuationApproval(proposal, JSON.stringify(body), sha256(body) as Hex)).to.throw(/shape|authority|repair|budget|checkpoint|action|binding/i);
    }
  });

  it("attaches one exact storage sibling with checkpoint and minimum nonce", async function () {
    const { source, proposal } = await context(); const document = approvalDocument(proposal); const approval = loadUsdcRecycleContinuationApproval(proposal, JSON.stringify(document), sha256(document) as Hex);
    const old = JSON.stringify(source.prior.journal.usdcSuccessor); const journal = attachUsdcRecycleContinuation(source.prior.journal, proposal, approval);
    expect(JSON.stringify(journal.usdcSuccessor)).to.equal(old);
    expect(journal.usdcRecycleContinuation.currentCheckpoint).to.deep.equal(proposal.currentCheckpoint);
    expect(journal.usdcRecycleContinuation.minimumOuterNonce).to.equal(870);
    expect(journal.usdcRecycleContinuation.actions).to.have.length(17);
    expect(journal.usdcRecycleContinuation.actions.every(action => action.status === "approved")).to.equal(true);
    expect(() => attachUsdcRecycleContinuation(journal, proposal, approval)).to.throw(/already|attached/i);
  });

  it("admits by fresh minimum remaining time while preserving historical observer fields", async function () {
    const { certificate, proposal } = await context(); const deadline = BigInt(proposal.deadline); const expiry = BigInt(proposal.observer.expiresAt); const at = (remaining: bigint) => new Date(Number((deadline - remaining) * 1000n));
    const chainPastHistoricalRequiredThrough = BigInt(proposal.observer.requiredThrough) + 1n;
    expect(chainPastHistoricalRequiredThrough > BigInt(certificate.snapshot.timestamp)).to.equal(true);
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[0]!, chainPastHistoricalRequiredThrough, at(11_640n), "review")).not.to.throw();
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[0]!, deadline - 11_639n, at(11_640n), "review")).to.throw(/11640|remaining/i);
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[0]!, deadline - 8_040n, at(8_040n), "scenario")).not.to.throw();
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[5]!, deadline - 5_640n, at(5_640n), "scenario")).not.to.throw();
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[10]!, deadline - 4_140n, at(4_140n), "scenario")).not.to.throw();
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[14]!, deadline - 2_340n, at(2_340n), "scenario")).not.to.throw();
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[6]!, deadline - 2_340n, at(2_340n), "private")).to.throw(/queue|margin|remaining/i);
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[6]!, deadline - 2_341n, at(2_341n), "broadcast")).not.to.throw();
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[0]!, deadline - 1n, at(1n), "private")).not.to.throw();
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[0]!, deadline, at(0n), "broadcast")).to.throw(/deadline|period/i);
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[0]!, deadline - 1n, new Date(Number((deadline + 1n) * 1000n)), "private")).to.throw(/UTC|deadline|remaining/i);
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[0]!, expiry, at(20_000n), "private")).to.throw(/deadline|receiver|expiry/i);
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[0]!, BigInt(proposal.effectivePeriod) - 1n, at(20_000n), "private")).to.throw(/period|chain/i);
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, expectedIds[0]!, deadline - 1n, new Date(Number.NaN), "private")).to.throw(/finite|date|UTC/i);
    expect(() => assertUsdcRecycleContinuationAdmission(proposal, "usdc-successor-recycle-topup-step-up", deadline - 8_040n, at(8_040n), "scenario")).to.throw(/action|catalog/i);
  });
});
