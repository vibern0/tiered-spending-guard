import { expect } from "chai";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, hashTypedData, parseAbi, type Address, type Hex } from "viem";
import { queueMonitoringFingerprint } from "../../../src/queue/delay";
import { SAFE_TX_TYPES } from "../../../src/signers/types";
import { sha256 } from "../../../scripts/plan-deployment";
import { createOrdinaryScenarioProposal } from "../../../scripts/live/ordinary-scenario-executor";
import {
  loadHashlessSourceJournalReadOnly,
  verifyHashlessStateCertificate,
  type HashlessControlledState,
  type HashlessEvidenceProvider,
} from "../../../scripts/live/ordinary-scenario-hashless-certificate";
import {
  assertExpiredHashlessContinuationAuthorization,
  attachExpiredHashlessContinuation,
  createExpiredHashlessContinuationProposal,
  loadExpiredHashlessContinuationApproval,
  parseExpiredHashlessContinuationProposal,
} from "../../../scripts/live/ordinary-scenario-hashless-continuation";

const fixtures = join(__dirname, "../../fixtures/ordinary-hashless");
const report = readFileSync(join(__dirname, "../../fixtures/ordinary-scenario-review.public.json"), "utf8");
const source = readFileSync(join(fixtures, "first38-live-journal-2026-10-28.json"), "utf8");
const artifact = readFileSync(join(fixtures, "hashless-public-state-2026-10-28.json"), "utf8");
const artifactSha = "0xfc9c71e506c6941496501178fc2b826575ede10839fc61fbda838bb747a8f339" as Hex;
const rawHash = (value: string) => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const h = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const funder = "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address;
const safe = "0xd751a1479f49d63DC61E0081B0b4d8c60623D9a6" as Address;
const delay = "0xB8E143098CcCb9935228022173c2c987DF5FD53a" as Address;
const usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const selected = { number: 12_013_857n, hash: "0x197add23b0385bce509adab0a3f3234b58b71e63d0ebccad9aa2e99ba5f44e20" as Hex, timestamp: 1_793_209_056n };
const certified = { number: 12_013_934n, hash: "0x05d0f3b8f503bfee60455adc88c717e330aa2bafaffb6badca3b5c8215f3948e" as Hex, timestamp: 1_793_209_980n };
const current = { number: 12_013_940n, hash: h("7"), timestamp: 1_793_210_052n };
const latest = { number: 12_013_945n, hash: h("8"), timestamp: 1_793_210_112n };
const consumingHash = "0x83923abf9c1224125296a3485f8cc0a910e7f729ea5d5a73d6f01bf1cdbfe1f5" as Hex;

const state = (): HashlessControlledState => ({ chainId: 11_155_111, safe, delay, usdc, safeNonce: 7n, delayQueueNonce: 3n, delayTxNonce: 2n, queue: { queueNonce: 2n, to: funder, value: 1n, data: "0x", operation: 0, createdAt: 1_793_208_888n, expiresAt: 1_793_209_608n }, safeNativeBalance: 1n, safeUsdcBalance: 20_000_000n, funderUsdcBalance: 0n, effectiveGuardWindow: 1_793_145_600n, nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: 1_793_145_600n, baseSpent: 0n, instantSpent: 0n } });
function provider(): HashlessEvidenceProvider {
  const transaction = { hash: consumingHash, recoveredSender: funder, nonce: 809, to: "0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27" as Address, value: 0n, inputHash: "0x25491caa28455d896a7211a1c4532ab1e72412bdb15293292e2e37e5f9406c63" as Hex, gas: 21_000n, maxFeePerGas: 30n, maxPriorityFeePerGas: 2n, blockNumber: 12_013_885n, blockHash: "0x1cd3daf4cef11721feb5d564c0768f42e88d1d14c6c909e64b7cd5532b6f158b" as Hex };
  return { readLatestBlock: async () => latest, readBlock: async number => number === selected.number ? selected : number === certified.number ? certified : number === current.number ? current : number === transaction.blockNumber ? { number, hash: transaction.blockHash, timestamp: 1_793_209_392n } : undefined, readTransaction: async hash => hash === consumingHash ? transaction : undefined, readReceipt: async hash => hash === consumingHash ? { transactionHash: consumingHash, status: "success", blockNumber: transaction.blockNumber, blockHash: transaction.blockHash } : undefined, readTransactionCount: async (_address, block) => block === "pending" || block === "latest" ? 811 : 811, readControlledState: async () => structuredClone(state()) };
}

const original = () => createOrdinaryScenarioProposal(report, { expectedPackageHash: "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", expectedArtifactBytesHash: "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831" });
const schedule = { review: "3600", execution: "960", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" };
const observer = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${h("a")}`, endpointHash: h("a"), probeEvidenceHash: h("b"), independentFromProposer: true as const, readyAt: "1793210052", workflowScheduleSeconds: schedule, requiredThrough: "1793215452", expiresAt: "1793215452" };
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" };
const exactIds = ["native-queue-ready-hashless-skip", "native-queue-ready-replacement", "native-queue-ready-replacement-execute", "usdc-base-x", "usdc-step-up-contract", "usdc-recycle-topup-step-up", "usdc-step-up-ecdsa", "usdc-direct-overspend-rejection", "usdc-replay-rejection", "usdc-unsupported-path-rejection", "usdc-recycle-topup-delayed", "usdc-queue-cancel", "usdc-queue-cancel-early-rejection", "usdc-queue-cancel-action", "usdc-queue-cancelled-execution-rejection", "usdc-queue-expiry", "usdc-queue-expiry-early-rejection", "usdc-queue-expiry-skip", "usdc-queue-expired-execution-rejection", "usdc-queue-execute", "usdc-queue-execute-early-rejection", "usdc-queue-ready-execute"];
const exactCatalog = [
  ["queue-expiry", [], [], "7/3/2", "7/3/3"], ["queue-proposal", ["primary-passkey", "safe-contract-secondary"], [exactIds[0]], "7/3/3", "8/4/3"], ["ready-delay-execution", [], [exactIds[1]], "8/4/3", "8/4/4"],
  ["base-transfer", ["primary-passkey"], ["usdc-funding", exactIds[2]], "8/4/4", "9/4/4"], ["step-up-transfer", ["primary-passkey", "safe-contract-secondary"], [exactIds[3]], "9/4/4", "10/4/4"], ["controlled-recipient-recycled-funding", ["funder"], [exactIds[4]], "10/4/4", "10/4/4"],
  ["step-up-transfer", ["primary-passkey", "legacy-ecdsa-secondary"], [exactIds[5]], "10/4/4", "11/4/4"], ["expected-direct-rejection", ["primary-passkey", "safe-contract-secondary"], [exactIds[6]], "11/4/4", "11/4/4"], ["expected-replay-rejection", ["replay previously reviewed signed envelope only in later executor"], [exactIds[3]], "11/4/4", "11/4/4"],
  ["expected-unsupported-rejection", ["primary-passkey", "safe-contract-secondary"], [exactIds[6]], "11/4/4", "11/4/4"], ["controlled-recipient-recycled-funding", ["funder"], [exactIds[6]], "11/4/4", "11/4/4"], ["queue-proposal", ["primary-passkey", "safe-contract-secondary"], [exactIds[10]], "11/4/4", "12/5/4"],
  ["expected-early-rejection", [], [exactIds[11]], "12/5/4", "12/5/4"], ["queue-cancellation", ["primary-passkey", "safe-contract-secondary"], [exactIds[11]], "12/5/4", "13/5/5"], ["expected-cancelled-rejection", [], [exactIds[13]], "13/5/5", "13/5/5"],
  ["queue-proposal", ["primary-passkey", "safe-contract-secondary"], [exactIds[13]], "13/5/5", "14/6/5"], ["expected-early-rejection", [], [exactIds[15]], "14/6/5", "14/6/5"], ["queue-expiry", [], [exactIds[15]], "14/6/5", "14/6/6"], ["expected-expired-rejection", [], [exactIds[17]], "14/6/6", "14/6/6"],
  ["queue-proposal", ["primary-passkey", "safe-contract-secondary"], [exactIds[17]], "14/6/6", "15/7/6"], ["expected-early-rejection", [], [exactIds[19]], "15/7/6", "15/7/6"], ["ready-delay-execution", [], [exactIds[20]], "15/7/6", "15/7/7"],
] as const;

describe("expired hashless continuation proposal", function () {
  let directory = ""; let journal: ReturnType<typeof loadHashlessSourceJournalReadOnly>; let certificate: Awaited<ReturnType<typeof verifyHashlessStateCertificate>>;
  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), "hashless-continuation-")); const path = join(directory, "journal.json"); writeFileSync(path, source); journal = loadHashlessSourceJournalReadOnly(path); certificate = await verifyHashlessStateCertificate(artifact, artifactSha, journal, [provider(), provider()]); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const build = () => createExpiredHashlessContinuationProposal({ original: original(), journal, certificate, observer, caps });

  it("builds_exact22", function () {
    const proposal = build();
    expect(proposal.authorization).to.equal("NONE");
    expect(proposal.actions.map(action => action.id)).to.deep.equal(exactIds);
    expect(proposal.actions.map(action => [action.kind, action.signerRoles, action.dependsOn, `${action.before.safeNonce}/${action.before.delayQueueNonce}/${action.before.delayTxNonce}`, `${action.after.safeNonce}/${action.after.delayQueueNonce}/${action.after.delayTxNonce}`])).to.deep.equal(exactCatalog);
    expect(proposal.actions.map(action => [action.before.safeNonce, action.after.safeNonce, action.before.delayQueueNonce, action.after.delayQueueNonce, action.before.delayTxNonce, action.after.delayTxNonce])).to.deep.include.members([["7", "7", "3", "3", "2", "3"], ["7", "8", "3", "4", "3", "3"], ["8", "8", "4", "4", "3", "4"]]);
    expect(proposal.actions.at(-1)?.after).to.deep.include({ safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7" });
    expect(proposal.actions[1]?.transaction?.data.slice(0, 10)).to.equal("0x468721a7");
    expect(proposal.actions[0]?.transaction?.data).to.equal("0xb19d4758");
    expect(proposal.actions[2]?.transaction?.data.slice(0, 10)).to.equal("0xee072baf");
    const stateTuple = (action: typeof proposal.actions[number], side: "before" | "after") => { const value = action[side]; return `${value.safeNativeBalance}/${value.safeUsdcBalance}/${value.funderUsdcBalance}/${value.usdcBaseSpent}/${value.usdcInstantSpent}/${value.queueStatus}/${value.queueNonce}`; };
    const s0 = "1/20000000/0/0/0/EXPIRED/2", s1 = "1/20000000/0/0/0/EXPIRED_SKIPPED/2", s2 = "1/20000000/0/0/0/QUEUED/3", s3 = "0/20000000/0/0/0/EXECUTED/3";
    const u0 = "0/20000000/0/0/0/EXECUTED_CONDITIONAL/3", u1 = "0/10000000/10000000/10000000/10000000/EXECUTED_CONDITIONAL/3", u2 = "0/0/20000000/10000000/20000000/EXECUTED_CONDITIONAL/3", u3 = "0/10000000/10000000/10000000/20000000/EXECUTED_CONDITIONAL/3", u4 = "0/0/20000000/10000000/30000000/EXECUTED_CONDITIONAL/3", u5 = "0/1000000/19000000/10000000/30000000/EXECUTED_CONDITIONAL/3";
    const u6 = "0/1000000/19000000/10000000/30000000/QUEUED_CONDITIONAL/4", u7 = "0/1000000/19000000/10000000/30000000/CANCELLED_CONDITIONAL/4", u8 = "0/1000000/19000000/10000000/30000000/QUEUED_CONDITIONAL/5", u9 = "0/1000000/19000000/10000000/30000000/EXPIRED_CONDITIONAL/5", u10 = "0/1000000/19000000/10000000/30000000/QUEUED_CONDITIONAL/6", u11 = "0/0/20000000/10000000/30000000/EXECUTED_CONDITIONAL/6";
    const expectedStateSpine = [[s0, s1], [s1, s2], [s2, s3], [u0, u1], [u1, u2], [u2, u3], [u3, u4], [u4, u4], [u4, u4], [u4, u4], [u4, u5], [u5, u6], [u6, u6], [u6, u7], [u7, u7], [u7, u8], [u8, u8], [u8, u9], [u9, u9], [u9, u10], [u10, u10], [u10, u11]];
    expect(proposal.actions.map(action => [stateTuple(action, "before"), stateTuple(action, "after")])).to.deep.equal(expectedStateSpine);
  });

  it("rebases_every_usdc_hash", function () {
    const proposal = build();
    const safeActions = proposal.actions.filter(action => action.safeTransaction);
    for (const action of safeActions) { const tx = action.safeTransaction!; expect(hashTypedData({ domain: { chainId: 11155111, verifyingContract: safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { ...tx, value: BigInt(tx.value), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: BigInt(tx.nonce) } })).to.equal(action.safeTxHash); }
    expect(proposal.actions.find(action => action.id === "usdc-base-x")?.safeTxHash).to.not.equal(original().actions[19]?.safeTxHash);
    expect(proposal.actions.filter(action => action.asset === "USDC" && action.queue).every(action => action.queue!.queueNonce >= "4")).to.equal(true);
    const cancellation = proposal.actions.find(action => action.id === "usdc-queue-cancel-action")!;
    const decodedCancellation = decodeFunctionData({ abi: parseAbi(["function setTxNonce(uint256)"]), data: cancellation.transaction.data });
    expect(decodedCancellation.functionName).to.equal("setTxNonce");
    expect(decodedCancellation.args[0]).to.equal(5n);
    for (const action of proposal.actions.filter(action => action.queue)) {
      const item = action.queue!;
      expect(item.monitoringFingerprint, action.id).to.equal(queueMonitoringFingerprint({ safe, delay, queueNonce: BigInt(item.queueNonce), to: item.to, value: BigInt(item.value), data: item.data, operation: 0 }));
    }
    const delayAbi = parseAbi(["function execTransactionFromModule(address,uint256,bytes,uint8)", "function executeNextTx(address,uint256,bytes,uint8)", "function setTxNonce(uint256)", "function skipExpired()"]);
    const tokenAbi = parseAbi(["function transfer(address,uint256)", "function approve(address,uint256)"]);
    const expectedCalls = ["skipExpired", "execTransactionFromModule", "executeNextTx", "transfer", "transfer", "transfer", "transfer", "transfer", "transfer", "approve", "transfer", "execTransactionFromModule", "executeNextTx", "setTxNonce", "executeNextTx", "execTransactionFromModule", "executeNextTx", "skipExpired", "executeNextTx", "execTransactionFromModule", "executeNextTx", "executeNextTx"];
    const observed = proposal.actions.map(action => decodeFunctionData({ abi: action.transaction.to.toLowerCase() === delay.toLowerCase() ? delayAbi : tokenAbi, data: action.transaction.data }));
    expect(observed.map(call => call.functionName)).to.deep.equal(expectedCalls);
    const tokenCall = (index: number) => { const call = observed[index]!; if (call.functionName === "transfer" || call.functionName === "approve") return call; const nested = call.args?.[2]; return decodeFunctionData({ abi: tokenAbi, data: nested as Hex }); };
    for (const index of [3, 4, 6, 8]) { const call = tokenCall(index); expect(call.functionName).to.equal("transfer"); expect(call.args?.[0]).to.equal(funder); expect(call.args?.[1]).to.equal(10_000_000n); }
    expect(tokenCall(5).args).to.deep.equal([safe, 10_000_000n]);
    expect(tokenCall(7).args).to.deep.equal([funder, 1n]);
    expect(tokenCall(9).functionName).to.equal("approve"); expect(tokenCall(9).args).to.deep.equal([funder, 1n]);
    expect(tokenCall(10).args).to.deep.equal([safe, 1_000_000n]);
    for (const index of [11, 12, 14, 15, 16, 18, 19, 20, 21]) expect(tokenCall(index).args).to.deep.equal([funder, 1_000_000n]);
  });

  it("approval_is_separate_opaque_and_exact", function () {
    const proposal = build();
    const document = { schemaVersion: 1, scope: "first38-native-ready-hashless-expired-v1", authorization: "EXPLICIT_GROUP_APPROVAL", proposalHash: proposal.proposalHash, certificateHash: proposal.certificateHash, observer: proposal.observer, caps: proposal.caps, reservation: proposal.reservation, derivations: proposal.derivations, maxBroadcastAttempts: 1, approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
    const serialized = JSON.stringify(document); const approval = loadExpiredHashlessContinuationApproval(proposal, serialized, sha256(document) as Hex);
    expect(() => assertExpiredHashlessContinuationAuthorization({ ...proposal } as never, approval)).to.throw(/opaque|bound/i);
    expect(() => assertExpiredHashlessContinuationAuthorization(proposal, { ...approval } as never)).to.throw(/opaque|bound/i);
    expect(() => assertExpiredHashlessContinuationAuthorization(proposal, approval)).not.to.throw();
    expect(() => attachExpiredHashlessContinuation(journal, proposal, { approvalHash: rawHash(serialized) } as never)).to.throw(/opaque|approval/i);
    expect(attachExpiredHashlessContinuation(journal, proposal, approval).hashlessContinuation?.actions).to.have.length(22);
    const oldApproval = readFileSync(join(fixtures, "first38-approval-2026-10-28.json"), "utf8");
    expect(() => loadExpiredHashlessContinuationApproval(proposal, oldApproval, sha256(JSON.parse(oldApproval)) as Hex)).to.throw();
    for (const mutate of [(v: any) => v.approvedActions.reverse(), (v: any) => v.approvedActions.pop(), (v: any) => { v.approvedActions[0].id = "unknown"; }, (v: any) => { v.caps.maxFeePerGas = "999999"; }, (v: any) => { v.observer.probeEvidenceHash = h("c"); }]) { const value = structuredClone(document); mutate(value); const raw = JSON.stringify(value); expect(() => loadExpiredHashlessContinuationApproval(proposal, raw, sha256(value) as Hex)).to.throw(); }
  });

  it("budget_and_observer_binding", function () {
    const proposal = build();
    expect(BigInt(proposal.reservation.originalActualGasCostWei) > 0n).to.equal(true);
    expect(BigInt(proposal.reservation.originalPrincipalWei)).to.equal(60_000_000_000_001n);
    expect(BigInt(proposal.reservation.maximumCumulativeOutlayWei) < 50_000_000_000_000_000n).to.equal(true);
    expect(proposal.observer.endpointHash).to.equal(observer.endpointHash);
    expect(JSON.stringify(proposal)).to.not.match(/privateKey|credentialPath|rpcUrl|rawSignature/i);
    expect(proposal.observer.workflowScheduleSeconds).to.deep.equal(schedule);
    expect(proposal.observer.requiredThrough).to.equal("1793215452");
    expect(() => createExpiredHashlessContinuationProposal({ original: original(), journal, certificate, observer: { ...observer, expiresAt: "1793215451" }, caps })).to.throw(/observer|schedule|expiry|deadline/i);
    expect(() => createExpiredHashlessContinuationProposal({ original: original(), journal, certificate, observer: { ...observer, workflowScheduleSeconds: { ...schedule, execution: "959" } }, caps })).to.throw(/execution|schedule/i);
  });

  it("roundtrip_closed_artifact", function () {
    const proposal = build(); const serialized = JSON.stringify(proposal);
    expect(parseExpiredHashlessContinuationProposal(serialized, original(), journal, certificate)).to.deep.equal(proposal);
    for (const mutate of [(v: any) => { v.extra = true; }, (v: any) => { v.actions.pop(); }, (v: any) => { v.actions[0].before.safeNonce = 7; }, (v: any) => { v.proposalHash = h("f"); }]) { const value = JSON.parse(serialized); mutate(value); expect(() => parseExpiredHashlessContinuationProposal(JSON.stringify(value), original(), journal, certificate)).to.throw(); }
    const forgedOriginal = structuredClone(original()) as any; forgedOriginal.actions[19].safeTransaction.safeNonce = 999n; expect(() => createExpiredHashlessContinuationProposal({ original: forgedOriginal, journal, certificate, observer, caps })).to.throw(/original proposal hash/i);
  });

  it("keeps creation pristine and parses the same approved epoch after append-only growth", function () {
    const proposal = build();
    const document = { schemaVersion: 1, scope: "first38-native-ready-hashless-expired-v1", authorization: "EXPLICIT_GROUP_APPROVAL", proposalHash: proposal.proposalHash, certificateHash: proposal.certificateHash, observer: proposal.observer, caps: proposal.caps, reservation: proposal.reservation, derivations: proposal.derivations, maxBroadcastAttempts: 1, approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
    const approval = loadExpiredHashlessContinuationApproval(proposal, JSON.stringify(document), sha256(document) as Hex);
    attachExpiredHashlessContinuation(journal, proposal, approval);
    expect(() => attachExpiredHashlessContinuation(journal, proposal, approval)).to.throw(/existing|attached|continuation/i);
    expect(() => createExpiredHashlessContinuationProposal({ original: original(), journal, certificate, observer, caps })).to.throw(/existing|pristine|continuation/i);
    journal.liveJournal.entries.push({ ...journal.liveJournal.entries[0]!, id: "native-queue-ready-hashless-skip" });
    expect(parseExpiredHashlessContinuationProposal(JSON.stringify(proposal), original(), journal, certificate).proposalHash).to.equal(proposal.proposalHash);
    (journal as any).hashlessContinuation = undefined;
    expect(() => parseExpiredHashlessContinuationProposal(JSON.stringify(proposal), original(), journal, certificate)).to.throw(/lineage|malformed/i);
  });
});
