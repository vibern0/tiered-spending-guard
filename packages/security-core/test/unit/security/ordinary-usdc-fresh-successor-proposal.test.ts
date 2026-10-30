import { expect } from "chai";
import { decodeFunctionData, hashTypedData, type Hex } from "viem";
import { queueFingerprint, queueMonitoringFingerprint } from "../../../src/queue/delay";
import { SAFE_TX_TYPES } from "../../../src/signers/types";
import { sha256 } from "../../../scripts/plan-deployment";
import {
  FRESH_SUCCESSOR_GROUPS,
  FRESH_SUCCESSOR_SCHEDULE,
  assertUsdcFreshSuccessorAdmission,
  assertUsdcFreshSuccessorAuthorization,
  attachUsdcFreshSuccessor,
  createUsdcFreshSuccessorProposal,
  getUsdcFreshSuccessorApprovalPublicValue,
  loadUsdcFreshSuccessorApproval,
  parseUsdcFreshSuccessorProposal,
} from "../../../scripts/live/ordinary-scenario-usdc-fresh-successor-proposal";
import { verifyUsdcFreshSuccessorCertificate } from "../../../scripts/live/ordinary-scenario-usdc-fresh-successor-certificate";
import {
  cleanupUsdcRecycleContinuationFixtures,
} from "../../support/usdc-recycle-continuation-fixture";
import {
  createFreshSource,
  freshPrimary,
  freshProviders,
  freshSnapshot,
} from "../../support/usdc-fresh-successor-fixture";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;
const observer = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${h("1")}`, endpointHash: h("1"), startupEvidenceHash: h("2"), probeEvidenceHash: h("3"), independentFromProposer: true as const, readyAt: freshSnapshot.timestamp.toString(), workflowScheduleSeconds: { review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" }, requiredThrough: (freshSnapshot.timestamp + 11_640n).toString(), expiresAt: "1793404800" };
const ids = ["prefund-all", "base-x", "step-up-contract", "step-up-ecdsa", "direct-overspend-rejection", "replay-rejection", "unsupported-path-rejection", "queue-cancel", "queue-cancel-early-rejection", "queue-cancel-action", "queue-cancelled-execution-rejection", "queue-expiry", "queue-expiry-early-rejection", "queue-expiry-skip", "queue-expired-execution-rejection", "queue-execute", "queue-execute-early-rejection", "queue-ready-execute"].map(id => `usdc-fresh-successor-${id}`);
const kinds = ["controlled-recipient-funding", "base-transfer", "step-up-transfer", "step-up-transfer", "expected-direct-rejection", "expected-replay-rejection", "expected-unsupported-rejection", "queue-proposal", "expected-early-rejection", "queue-cancellation", "expected-cancelled-rejection", "queue-proposal", "expected-early-rejection", "queue-expiry", "expected-expired-rejection", "queue-proposal", "expected-early-rejection", "ready-delay-execution"];
const tokenAbi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool" }] }, { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool" }] }] as const;

function approvalDocument(proposal: ReturnType<typeof createUsdcFreshSuccessorProposal>) {
  return { schemaVersion: 1, scope: "ordinary-usdc-fresh-period-successor-v1", authorization: "FOCUSED_BOUNDED_SUCCESSOR_AUTHORIZATION", authorityEvidenceHash: proposal.authorityEvidenceHash, proposalHash: proposal.proposalHash, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, snapshot: proposal.snapshot, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, observer: proposal.observer, schedule: proposal.schedule, groups: proposal.groups, caps: proposal.caps, reservation: proposal.reservation, maxBroadcastAttempts: 1, repairAuthority: "NONE", approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
}

describe("ordinary USDC fresh-period successor proposal", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  async function fixture() {
    const source = await createFreshSource();
    const certificate = await verifyUsdcFreshSuccessorCertificate(source, freshPrimary, await freshProviders(source));
    const proposal = createUsdcFreshSuccessorProposal({ source, certificate, observer, caps });
    return { source, certificate, proposal };
  }

  it("constructs the literal 18-action catalog with exact identities and dependencies", async function () {
    const { source, proposal } = await fixture();
    expect(proposal.actions.map(action => action.id)).to.deep.equal(ids);
    expect(proposal.actions.map(action => action.kind)).to.deep.equal(kinds);
    expect(proposal.actions.map(action => action.dependsOn)).to.deep.equal([
      ["usdc-successor-step-up-contract"], [ids[0]], [ids[1]], [ids[2]], [ids[3]], [ids[1]], [ids[3]], [ids[3]], [ids[7]], [ids[7]], [ids[9]], [ids[9]], [ids[11]], [ids[11]], [ids[13]], [ids[13]], [ids[15]], [ids[16]],
    ]);
    const decoded = proposal.actions.slice(0, 7).map(action => decodeFunctionData({ abi: tokenAbi, data: action.safeTransaction?.data ?? action.transaction.data }));
    expect(decoded.map(call => [call.functionName, call.args?.[1]?.toString()])).to.deep.equal([["transfer", "31000000"], ["transfer", "10000000"], ["transfer", "10000000"], ["transfer", "10000000"], ["transfer", "1"], ["transfer", "10000000"], ["approve", "1"]]);
    for (const action of proposal.actions.slice(7)) if (action.queue) expect(decodeFunctionData({ abi: tokenAbi, data: action.queue.data }).args?.[1]).to.equal(1_000_000n);
    expect(proposal.actions.filter(action => action.expectedOutcome === "success" && action.safeTransaction).map(action => action.safeTransaction!.nonce)).to.deep.equal(["10", "11", "12", "13", "14", "15", "16"]);
    expect(proposal.actions.filter(action => action.queue).map(action => action.queue!.queueNonce)).to.deep.equal(["4", "4", "4", "5", "5", "5", "5", "6", "6", "6"]);
    for (const action of proposal.actions) {
      if (action.safeTransaction) expect(action.safeTxHash).to.equal(hashTypedData({ domain: { chainId: 11_155_111, verifyingContract: source.prior.original.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { ...action.safeTransaction, value: BigInt(action.safeTransaction.value), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: BigInt(action.safeTransaction.nonce) } }));
      if (action.queue) { const item = { safe: source.prior.original.safe, delay: source.prior.original.delay, to: action.queue.to, value: BigInt(action.queue.value), data: action.queue.data, operation: 0 as const, queueNonce: BigInt(action.queue.queueNonce) }; expect(action.queue.fingerprint).to.equal(queueFingerprint(item)); expect(action.queue.monitoringFingerprint).to.equal(queueMonitoringFingerprint(item)); }
    }
  });

  it("binds stale prefund state, fresh-period counters, balances, and terminal nonces", async function () {
    const { proposal } = await fixture();
    expect(proposal.actions[0]!.before).to.include({ safeNonce: "10", delayQueueNonce: "4", delayTxNonce: "4", safeUsdcBalance: "0", funderUsdcBalance: "40000000", usdcBaseSpent: "10000000", usdcInstantSpent: "20000000" });
    expect(proposal.actions[0]!.after).to.include({ safeUsdcBalance: "31000000", funderUsdcBalance: "9000000", usdcBaseSpent: "10000000", usdcInstantSpent: "20000000" });
    expect(proposal.actions.slice(1, 4).map(action => [action.after.usdcBaseSpent, action.after.usdcInstantSpent, action.after.safeUsdcBalance, action.after.funderUsdcBalance])).to.deep.equal([["10000000", "10000000", "21000000", "19000000"], ["10000000", "20000000", "11000000", "29000000"], ["10000000", "30000000", "1000000", "39000000"]]);
    expect(proposal.actions[17]!.after).to.include({ safeNonce: "17", delayQueueNonce: "7", delayTxNonce: "7", safeUsdcBalance: "0", funderUsdcBalance: "40000000", usdcBaseSpent: "10000000", usdcInstantSpent: "30000000" });
  });

  it("independently reduces ten broadcasts, eight proofs, gross principal, and gas reservation", async function () {
    const { proposal } = await fixture();
    const broadcasts = proposal.actions.filter(action => action.expectedOutcome === "success");
    expect(broadcasts).to.have.length(10);
    expect(proposal.actions.filter(action => action.expectedOutcome === "rejection")).to.have.length(8);
    let safeOutflow = 0n, inwardFunding = 0n, gas = 0n;
    for (const action of broadcasts) {
      const safeDelta = BigInt(action.before.safeUsdcBalance) - BigInt(action.after.safeUsdcBalance);
      const funderDelta = BigInt(action.before.funderUsdcBalance) - BigInt(action.after.funderUsdcBalance);
      if (safeDelta > 0n) safeOutflow += safeDelta;
      if (funderDelta > 0n) inwardFunding += funderDelta;
      gas += BigInt(action.gasLimitCap) * BigInt(action.maxFeePerGasCap);
    }
    expect({ safeOutflow, inwardFunding, gas }).to.deep.equal({ safeOutflow: 31_000_000n, inwardFunding: 31_000_000n, gas: 15_340_292_000_000n });
    expect(proposal.reservation).to.deep.include({ newGrossUsdcAllowance: "31000000", aggregateGrossUsdcAllowance: "51000000", inwardUsdcFunding: "31000000", successorMaximumReservationWei: "15340292000000", remainingOldSuccessorAllowanceWei: "15955630044456", spareOldSuccessorAllowanceWei: "615338044456", maximumCumulativeOutlayWei: "146501418272986" });
  });

  it("strictly parses only the regenerated proposal and rejects catalog or header drift", async function () {
    const { source, certificate, proposal } = await fixture();
    expect(parseUsdcFreshSuccessorProposal(JSON.stringify(proposal), source, certificate).proposalHash).to.equal(proposal.proposalHash);
    for (const mutate of [(body: any) => body.actions.reverse(), (body: any) => body.actions.push(body.actions[0]), (body: any) => { body.actions[0].safeTxHash = h("4"); }, (body: any) => { body.effectivePeriod = "1793232000"; }, (body: any) => { body.reservation.aggregateGrossUsdcAllowance = "31000000"; }]) {
      const changed = JSON.parse(JSON.stringify(proposal)); mutate(changed);
      expect(() => parseUsdcFreshSuccessorProposal(JSON.stringify(changed), source, certificate)).to.throw(/shape|drift|catalog|period|reservation|proposal/i);
    }
  });

  it("loads one exact focused approval with no repair authority", async function () {
    const { proposal } = await fixture();
    const document = approvalDocument(proposal); const hash = sha256(document) as Hex;
    const approval = loadUsdcFreshSuccessorApproval(proposal, JSON.stringify(document), hash);
    expect(() => assertUsdcFreshSuccessorAuthorization(proposal, approval)).not.to.throw();
    expect(getUsdcFreshSuccessorApprovalPublicValue(approval)).to.deep.equal(document);
    for (const mutate of [(body: any) => { body.authorization = "STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION"; }, (body: any) => { body.repairAuthority = "AUTHORIZED"; }, (body: any) => { body.maxBroadcastAttempts = 2; }, (body: any) => { body.approvedActions.pop(); }, (body: any) => { body.approvedActions[0].commitment = h("5"); }]) {
      const changed = structuredClone(document) as any; mutate(changed);
      expect(() => loadUsdcFreshSuccessorApproval(proposal, JSON.stringify(changed), sha256(changed) as Hex)).to.throw(/binding|authority|repair|attempt|action|count/i);
    }
    expect(() => assertUsdcFreshSuccessorAuthorization(structuredClone(proposal) as any, approval)).to.throw(/opaque|bound/i);
  });

  it("attaches one exact sibling without changing predecessor bytes", async function () {
    const { source, proposal } = await fixture(); const document = approvalDocument(proposal); const approval = loadUsdcFreshSuccessorApproval(proposal, JSON.stringify(document), sha256(document) as Hex);
    const before = JSON.stringify({ hashlessContinuation: source.prior.journal.hashlessContinuation, usdcSuccessor: source.prior.journal.usdcSuccessor });
    expect(() => attachUsdcFreshSuccessor(structuredClone(source.prior.journal), proposal, approval)).to.throw(/source|journal|detached|bound/i);
    (source.prior.journal as any).repairContinuation = {};
    expect(() => attachUsdcFreshSuccessor(source.prior.journal, proposal, approval)).to.throw(/source|journal|repair|changed/i);
    delete (source.prior.journal as any).repairContinuation;
    const journal = attachUsdcFreshSuccessor(source.prior.journal, proposal, approval);
    expect(JSON.stringify({ hashlessContinuation: journal.hashlessContinuation, usdcSuccessor: journal.usdcSuccessor })).to.equal(before);
    expect(journal.usdcFreshSuccessor.actions).to.have.length(18);
    expect(() => attachUsdcFreshSuccessor(journal, proposal, approval)).to.throw(/already|attached/i);
  });

  it("binds schedule, observer lifetime, period, deadline, group budgets, and one attempt", async function () {
    const { source, certificate, proposal } = await fixture();
    expect(FRESH_SUCCESSOR_SCHEDULE).to.deep.equal({ review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300", reviewAdmission: "11640", initialExecutionAdmission: "8040", reconciliationMargin: "840" });
    expect(FRESH_SUCCESSOR_GROUPS).to.deep.equal([{ start: 1, end: 7, budgetSeconds: "2400" }, { start: 8, end: 11, budgetSeconds: "1500" }, { start: 12, end: 15, budgetSeconds: "1800" }, { start: 16, end: 18, budgetSeconds: "1500" }]);
    expect(proposal).to.include({ authorization: "NONE", effectivePeriod: "1793318400", deadline: "1793404800", maxBroadcastAttempts: 1 });
    const deadline = BigInt(proposal.deadline), at = (remaining: bigint) => new Date(Number((deadline - remaining) * 1000n));
    expect(() => assertUsdcFreshSuccessorAdmission(proposal, ids[0]!, deadline - 11_640n, at(11_640n), "review")).not.to.throw();
    expect(() => assertUsdcFreshSuccessorAdmission(proposal, ids[0]!, deadline - 11_639n, at(11_640n), "review")).to.throw(/11640|remaining/i);
    expect(() => assertUsdcFreshSuccessorAdmission(proposal, ids[0]!, deadline - 8_040n, at(8_040n), "scenario")).not.to.throw();
    expect(() => assertUsdcFreshSuccessorAdmission(proposal, ids[7]!, deadline - 5_640n, at(5_640n), "scenario")).not.to.throw();
    expect(() => assertUsdcFreshSuccessorAdmission(proposal, ids[11]!, deadline - 4_140n, at(4_140n), "scenario")).not.to.throw();
    expect(() => assertUsdcFreshSuccessorAdmission(proposal, ids[15]!, deadline - 2_340n, at(2_340n), "scenario")).not.to.throw();
    expect(() => assertUsdcFreshSuccessorAdmission(proposal, ids[7]!, deadline - 2_340n, at(2_340n), "private")).to.throw(/queue|margin|remaining/i);
    expect(() => assertUsdcFreshSuccessorAdmission(proposal, ids[7]!, deadline - 2_341n, at(2_341n), "private")).not.to.throw();
    const short = { ...observer, requiredThrough: (freshSnapshot.timestamp + 11_639n).toString() };
    expect(() => createUsdcFreshSuccessorProposal({ source, certificate, observer: short, caps })).to.throw(/11640|observer|schedule/i);
    const priorObserver = source.priorProposal.observer;
    const reused = { ...observer, publicId: `temporary-test-receiver:${priorObserver.endpointHash}`, endpointHash: priorObserver.endpointHash, startupEvidenceHash: priorObserver.startupEvidenceHash, probeEvidenceHash: priorObserver.probeEvidenceHash };
    expect(() => createUsdcFreshSuccessorProposal({ source, certificate, observer: reused, caps })).to.throw(/fresh|prior|observer|identity/i);
  });
});
