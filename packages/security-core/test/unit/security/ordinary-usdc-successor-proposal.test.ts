import { expect } from "chai";
import { decodeFunctionData, hashTypedData, type Hex } from "viem";
import { SAFE_TX_TYPES } from "../../../src/signers/types";
import { queueFingerprint, queueMonitoringFingerprint } from "../../../src/queue/delay";
import { sha256 } from "../../../scripts/plan-deployment";
import { reverifyUsdcSuccessorCertificate, serializeUsdcSuccessorCertificate } from "../../../scripts/live/ordinary-scenario-usdc-successor-certificate";
import {
  USDC_SUCCESSOR_GROUPS,
  USDC_SUCCESSOR_SCHEDULE,
  assertUsdcSuccessorAdmission,
  assertUsdcSuccessorAuthorization,
  attachUsdcSuccessor,
  createUsdcSuccessorProposal,
  loadUsdcSuccessorApproval,
  parseUsdcSuccessorProposal,
} from "../../../scripts/live/ordinary-scenario-usdc-successor-proposal";
import { createUsdcSuccessorFixture, createUsdcSuccessorSource, successorSnapshot, usdcSuccessorFixture, usdcSuccessorProvider } from "../../support/usdc-successor-fixture";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const authorityEvidenceHash = "0xc7dca18faa9a9bf1cb2028c8bb77a5ccf8b0577145a408dd301d043be09bad3b" as Hex;
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;
const observer = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${h("1")}`, endpointHash: h("1"), startupEvidenceHash: h("2"), probeEvidenceHash: h("3"), independentFromProposer: true as const, readyAt: successorSnapshot.timestamp.toString(), workflowScheduleSeconds: { review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" }, requiredThrough: (successorSnapshot.timestamp + 11_640n).toString(), expiresAt: "1793318400" };
const expectedIds = ["base-x", "step-up-contract", "recycle-topup-step-up", "step-up-ecdsa", "direct-overspend-rejection", "replay-rejection", "unsupported-path-rejection", "recycle-topup-delayed", "queue-cancel", "queue-cancel-early-rejection", "queue-cancel-action", "queue-cancelled-execution-rejection", "queue-expiry", "queue-expiry-early-rejection", "queue-expiry-skip", "queue-expired-execution-rejection", "queue-execute", "queue-execute-early-rejection", "queue-ready-execute"].map(value => `usdc-successor-${value}`);
const expectedKinds = ["base-transfer", "step-up-transfer", "controlled-recipient-recycled-funding", "step-up-transfer", "expected-direct-rejection", "expected-replay-rejection", "expected-unsupported-rejection", "controlled-recipient-recycled-funding", "queue-proposal", "expected-early-rejection", "queue-cancellation", "expected-cancelled-rejection", "queue-proposal", "expected-early-rejection", "queue-expiry", "expected-expired-rejection", "queue-proposal", "expected-early-rejection", "ready-delay-execution"];
const expectedRoles = [["primary-passkey"], ["primary-passkey", "safe-contract-secondary"], ["funder"], ["primary-passkey", "legacy-ecdsa-secondary"], ["primary-passkey", "safe-contract-secondary"], ["replay previously reviewed signed envelope only in later executor"], ["primary-passkey", "safe-contract-secondary"], ["funder"], ["primary-passkey", "safe-contract-secondary"], [], ["primary-passkey", "safe-contract-secondary"], [], ["primary-passkey", "safe-contract-secondary"], [], [], [], ["primary-passkey", "safe-contract-secondary"], [], []];
const tokenAbi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool" }] }, { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool" }] }] as const;

function approvalDocument(proposal: ReturnType<typeof createUsdcSuccessorProposal>) {
  return { schemaVersion: 1, scope: "ordinary-usdc-period-successor-v1", authorization: "STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION", authorityEvidenceHash, proposalHash: proposal.proposalHash, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, snapshot: proposal.snapshot, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, observer: proposal.observer, schedule: proposal.schedule, groups: proposal.groups, caps: proposal.caps, reservation: proposal.reservation, maxBroadcastAttempts: 1, approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
}

describe("ordinary USDC successor proposal", function () {
  let fixture: Awaited<ReturnType<typeof createUsdcSuccessorFixture>>;
  afterEach(() => fixture?.cleanup());
  async function proposal() { fixture = await createUsdcSuccessorFixture(); return createUsdcSuccessorProposal({ source: fixture.source, certificate: fixture.certificate, observer, caps }); }

  it("constructs the exact closed 19-action successor and independently bound transaction identities", async function () {
    const value = await proposal();
    expect(value.actions.map(action => action.id)).to.deep.equal(expectedIds);
    expect(value.actions.map(action => action.kind)).to.deep.equal(expectedKinds);
    expect(value.actions.map(action => action.signerRoles)).to.deep.equal(expectedRoles);
    expect(value.actions.map(action => action.dependsOn)).to.deep.equal([["usdc-funding", "native-queue-ready-replacement-execute"], [expectedIds[0]], [expectedIds[1]], [expectedIds[2]], [expectedIds[3]], [expectedIds[0]], [expectedIds[3]], [expectedIds[3]], [expectedIds[7]], [expectedIds[8]], [expectedIds[8]], [expectedIds[10]], [expectedIds[10]], [expectedIds[12]], [expectedIds[12]], [expectedIds[14]], [expectedIds[14]], [expectedIds[16]], [expectedIds[17]]]);
    const directTokenCalls = value.actions.slice(0, 8).map(action => decodeFunctionData({ abi: tokenAbi, data: action.safeTransaction?.data ?? action.transaction.data }));
    expect(directTokenCalls.map(call => [call.functionName, call.args?.[1]?.toString()])).to.deep.equal([["transfer", "10000000"], ["transfer", "10000000"], ["transfer", "10000000"], ["transfer", "10000000"], ["transfer", "1"], ["transfer", "10000000"], ["approve", "1"], ["transfer", "1000000"]]);
    for (const action of value.actions.slice(8)) if (action.queue) expect(decodeFunctionData({ abi: tokenAbi, data: action.queue.data }).args?.[1]).to.equal(1_000_000n);
    expect(value.actions.filter(action => action.expectedOutcome === "success" && action.safeTransaction).map(action => action.safeTransaction!.nonce)).to.deep.equal(["8", "9", "10", "11", "12", "13", "14"]);
    expect(value.actions.filter(action => action.queue).map(action => action.queue!.queueNonce)).to.deep.equal(["4", "4", "4", "5", "5", "5", "5", "6", "6", "6"]);
    expect(value.actions.map(action => [action.before.usdcBaseSpent, action.before.usdcInstantSpent, action.after.usdcBaseSpent, action.after.usdcInstantSpent]).slice(0, 4)).to.deep.equal([["0", "0", "10000000", "10000000"], ["10000000", "10000000", "10000000", "20000000"], ["10000000", "20000000", "10000000", "20000000"], ["10000000", "20000000", "10000000", "30000000"]]);
    expect(value.actions[18]!.after).to.include({ safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7", safeNativeBalance: "0", safeUsdcBalance: "0", funderUsdcBalance: "20000000" });
    for (const action of value.actions) {
      if (action.safeTransaction) expect(action.safeTxHash).to.equal(hashTypedData({ domain: { chainId: 11_155_111, verifyingContract: fixture.source.original.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { ...action.safeTransaction, value: BigInt(action.safeTransaction.value), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: BigInt(action.safeTransaction.nonce) } }));
      if (action.queue) { const item = { safe: fixture.source.original.safe, delay: fixture.source.original.delay, to: action.queue.to, value: BigInt(action.queue.value), data: action.queue.data, operation: 0 as const, queueNonce: BigInt(action.queue.queueNonce) }; expect(action.queue.fingerprint).to.equal(queueFingerprint(item)); expect(action.queue.monitoringFingerprint).to.equal(queueMonitoringFingerprint(item)); }
    }
    expect(value.actions[0]!.safeTxHash).to.equal(fixture.source.recovery.actions[3]!.safeTxHash);
    expect(value.actions[0]!.commitment).not.to.equal(fixture.source.recovery.actions[3]!.commitment);
  });

  it("binds fixed schedule, observer, period, authority source, and aggregate accounting", async function () {
    const value = await proposal();
    expect(USDC_SUCCESSOR_SCHEDULE).to.deep.equal({ review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300", reviewAdmission: "11640", initialExecutionAdmission: "8040", reconciliationMargin: "840" });
    expect(USDC_SUCCESSOR_GROUPS).to.deep.equal([{ start: 1, end: 7, budgetSeconds: "2400" }, { start: 8, end: 12, budgetSeconds: "1500" }, { start: 13, end: 16, budgetSeconds: "1800" }, { start: 17, end: 19, budgetSeconds: "1500" }]);
    expect(value).to.include({ scope: "ordinary-usdc-period-successor-v1", authorization: "NONE", authorityEvidenceHash, effectivePeriod: "1793232000", deadline: "1793318400", maxBroadcastAttempts: 1 });
    expect(value.reservation).to.deep.equal({ phaseLimitWei: "50000000000000000", priorActualGasCostWei: "71036172317440", priorPrincipalWei: "60000000000002", successorMaximumReservationWei: "16080584000000", aggregateSuccessorAllowanceWei: "16080584000000", maximumCumulativeOutlayWei: "147116756317442", grossUsdcAllowance: "31000000", recycledUsdcAllowance: "11000000" });
    expect(Object.isFrozen(value)).to.equal(true); expect(Object.isFrozen(value.actions)).to.equal(true); expect(Object.isFrozen(value.observer)).to.equal(true);
    const wrongSchedule = structuredClone(observer) as any; wrongSchedule.workflowScheduleSeconds.execution = "7199";
    expect(() => createUsdcSuccessorProposal({ source: fixture.source, certificate: fixture.certificate, observer: wrongSchedule, caps })).to.throw(/schedule|7200/i);
    expect(() => createUsdcSuccessorProposal({ source: structuredClone(fixture.source), certificate: fixture.certificate, observer, caps })).to.throw(/opaque|source|certificate/i);
    fixture.source.journal.liveJournal.entries[0]!.id = "mutated-after-certificate";
    expect(() => createUsdcSuccessorProposal({ source: fixture.source, certificate: fixture.certificate, observer, caps })).to.throw(/snapshot|changed|source/i);
  });

  it("independently reduces the decoded expected-success catalog into its principal and gas caps", async function () {
    const value = await proposal();
    let safeOutflow = 0n, inwardRecycling = 0n, gasReservation = 0n;
    for (const action of value.actions.filter(candidate => candidate.expectedOutcome === "success")) {
      const safeDelta = BigInt(action.before.safeUsdcBalance) - BigInt(action.after.safeUsdcBalance);
      const funderDelta = BigInt(action.after.funderUsdcBalance) - BigInt(action.before.funderUsdcBalance);
      if (safeDelta > 0n) {
        const decoded = decodeFunctionData({ abi: tokenAbi, data: action.kind === "ready-delay-execution" ? action.queue!.data : action.safeTransaction!.data });
        expect(decoded.functionName).to.equal("transfer"); expect(decoded.args?.[1]).to.equal(safeDelta); safeOutflow += safeDelta;
      }
      if (funderDelta < 0n) {
        const decoded = decodeFunctionData({ abi: tokenAbi, data: action.transaction.data });
        expect(decoded.functionName).to.equal("transfer"); expect(decoded.args?.[1]).to.equal(-funderDelta); inwardRecycling += -funderDelta;
      }
      gasReservation += BigInt(action.gasLimitCap) * BigInt(action.maxFeePerGasCap);
    }
    expect({ safeOutflow, inwardRecycling, gasReservation }).to.deep.equal({ safeOutflow: 31_000_000n, inwardRecycling: 11_000_000n, gasReservation: 16_080_584_000_000n });
  });

  it("strictly parses only the regenerated closed proposal", async function () {
    const value = await proposal();
    expect(parseUsdcSuccessorProposal(JSON.stringify(value), fixture.source, fixture.certificate).proposalHash).to.equal(value.proposalHash);
    for (const mutate of [(body: any) => { body.actions[0].id = "usdc-base-x"; }, (body: any) => { body.actions[0].safeTxHash = h("4"); }, (body: any) => { body.actions.reverse(); }, (body: any) => { body.actions.push(body.actions[0]); }]) { const body = JSON.parse(JSON.stringify(value)); mutate(body); expect(() => parseUsdcSuccessorProposal(JSON.stringify(body), fixture.source, fixture.certificate)).to.throw(/shape|drift|catalog|proposal/i); }
  });

  it("rejects a pinned reverified source with a tracked fourteenth live entry during creation", async function () {
    const cleanProposal = await proposal();
    const serializedCertificate = serializeUsdcSuccessorCertificate(fixture.certificate);
    const value = JSON.parse(usdcSuccessorFixture.sourceJournal);
    value.liveJournal.entries.push({ ...value.liveJournal.entries[12], id: "later-success" });
    const progressed = await createUsdcSuccessorSource(`${JSON.stringify(value)}\n`);
    const certificate = await reverifyUsdcSuccessorCertificate(serializedCertificate, fixture.certificate.certificateHash, progressed, usdcSuccessorFixture.primary, [usdcSuccessorProvider(0, progressed), usdcSuccessorProvider(1, progressed)]);
    expect(() => createUsdcSuccessorProposal({ source: progressed, certificate, observer, caps })).to.throw(/clean|13|later|progress/i);
    expect(parseUsdcSuccessorProposal(JSON.stringify(cleanProposal), progressed, certificate).proposalHash).to.equal(cleanProposal.proposalHash);
  });

  it("loads one content-bound standing approval and rejects old, cloned, and forged authority", async function () {
    const value = await proposal(); const document = approvalDocument(value); const serialized = JSON.stringify(document); const expectedHash = sha256(document) as Hex; const approval = loadUsdcSuccessorApproval(value, serialized, expectedHash);
    expect(approval.approvalHash).to.equal(expectedHash); expect(() => assertUsdcSuccessorAuthorization(value, approval)).not.to.throw();
    expect(() => assertUsdcSuccessorAuthorization(value, { ...approval } as any)).to.throw(/opaque|bound/i);
    const second = createUsdcSuccessorProposal({ source: fixture.source, certificate: fixture.certificate, observer: { ...observer, startupEvidenceHash: h("5") }, caps }); expect(() => assertUsdcSuccessorAuthorization(second, approval)).to.throw(/opaque|bound/i);
    expect(() => assertUsdcSuccessorAuthorization(value, fixture.source.recoveryApproval as any)).to.throw(/opaque|bound/i);
    for (const mutate of [(body: any) => { body.authorization = "EXPLICIT_GROUP_APPROVAL"; }, (body: any) => { body.authorityEvidenceHash = h("6"); }, (body: any) => { body.snapshot.timestamp = "1793232051"; }, (body: any) => { body.maxBroadcastAttempts = 2; }, (body: any) => { body.approvedActions[0].commitment = h("7"); }, (body: any) => { body.humanReviewedProposalHash = value.proposalHash; }]) { const body = structuredClone(document) as any; mutate(body); expect(() => loadUsdcSuccessorApproval(value, JSON.stringify(body), sha256(body) as Hex)).to.throw(/shape|binding|authority|attempt|action/i); }
  });

  it("attaches one exact frozen sibling without mutating predecessor lineage", async function () {
    const value = await proposal(); const document = approvalDocument(value); const approval = loadUsdcSuccessorApproval(value, JSON.stringify(document), sha256(document) as Hex); const before = JSON.stringify(fixture.source.journal.hashlessContinuation); const journal = attachUsdcSuccessor(fixture.source.journal, value, approval);
    expect(JSON.stringify(journal.hashlessContinuation)).to.equal(before); expect(journal.usdcSuccessor.actions).to.have.length(19); expect(journal.usdcSuccessor.actions.every(action => action.status === "approved")).to.equal(true);
    expect(() => attachUsdcSuccessor(journal, value, approval)).to.throw(/already|attached/i);
  });

  it("enforces review, scenario, queue-margin, UTC, chain, receiver, rollover, and deadline boundaries", async function () {
    const value = await proposal(); const deadline = BigInt(value.deadline); const at = (remaining: bigint) => new Date(Number((deadline - remaining) * 1000n));
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[0]!, deadline - 11_640n, at(11_640n), "review")).not.to.throw();
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[0]!, deadline - 11_639n, at(11_640n), "review")).to.throw(/11640|remaining/i);
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[0]!, deadline - 8_040n, at(8_040n), "scenario")).not.to.throw();
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[7]!, deadline - 5_640n, at(5_640n), "scenario")).not.to.throw();
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[12]!, deadline - 4_140n, at(4_140n), "scenario")).not.to.throw();
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[16]!, deadline - 2_340n, at(2_340n), "scenario")).not.to.throw();
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[8]!, deadline - 2_340n, at(2_340n), "private")).to.throw(/queue|margin|remaining/i);
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[8]!, deadline - 2_341n, at(2_341n), "private")).not.to.throw();
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[0]!, deadline, at(0n), "broadcast")).to.throw(/deadline|period/i);
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[0]!, deadline - 1n, new Date(Number((deadline + 1n) * 1000n)), "broadcast")).to.throw(/UTC|deadline|remaining/i);
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[0]!, BigInt(value.effectivePeriod) - 1n, at(20_000n), "broadcast")).to.throw(/period|chain/i);
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[0]!, deadline + 86_400n, at(20_000n), "broadcast")).to.throw(/period|rollover|deadline/i);
    const shorterObserver = { ...observer, expiresAt: (deadline - 1_000n).toString() }; const shorter = createUsdcSuccessorProposal({ source: fixture.source, certificate: fixture.certificate, observer: shorterObserver, caps }); const expiry = BigInt(shorterObserver.expiresAt);
    expect(() => assertUsdcSuccessorAdmission(shorter, expectedIds[0]!, expiry - 1n, new Date(Number((expiry + 1n) * 1000n)), "broadcast")).to.throw(/receiver|expiry|remaining/i);
    expect(() => assertUsdcSuccessorAdmission(value, expectedIds[0]!, deadline - 1n, new Date(Number.NaN), "broadcast")).to.throw(/finite|date|UTC/i);
    expect(() => assertUsdcSuccessorAdmission(value, "usdc-base-x", deadline - 8_040n, at(8_040n), "scenario")).to.throw(/action|catalog/i);
  });

  it("does not derive fresh signing authority from expired time or structural proposal copies", async function () {
    const value = await proposal(); const document = approvalDocument(value); const approval = loadUsdcSuccessorApproval(value, JSON.stringify(document), sha256(document) as Hex); expect(() => assertUsdcSuccessorAuthorization(structuredClone(value) as any, approval)).to.throw(/opaque|bound/i); expect(() => assertUsdcSuccessorAdmission(value, expectedIds[18]!, BigInt(value.deadline), new Date(Number(BigInt(value.deadline) * 1000n)), "private")).to.throw(/deadline|period/i);
  });
});
