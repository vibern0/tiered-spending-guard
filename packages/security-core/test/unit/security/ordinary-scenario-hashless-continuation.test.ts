import { expect } from "chai";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashTypedData, type Address, type Hex } from "viem";
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

const state = (): HashlessControlledState => ({ chainId: 11_155_111, safe, delay, usdc, safeNonce: 7n, delayQueueNonce: 3n, delayTxNonce: 2n, queue: { queueNonce: 2n, to: funder, value: 1n, data: "0x", operation: 0, createdAt: 1_793_208_888n, expiresAt: 1_793_209_608n }, safeNativeBalance: 1n, safeUsdcBalance: 20_000_000n, effectiveGuardWindow: 1_793_145_600n, nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: 1_793_145_600n, baseSpent: 0n, instantSpent: 0n } });
function provider(): HashlessEvidenceProvider {
  const transaction = { hash: consumingHash, recoveredSender: funder, nonce: 809, to: "0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27" as Address, value: 0n, inputHash: "0x25491caa28455d896a7211a1c4532ab1e72412bdb15293292e2e37e5f9406c63" as Hex, gas: 21_000n, maxFeePerGas: 30n, maxPriorityFeePerGas: 2n, blockNumber: 12_013_885n, blockHash: "0x1cd3daf4cef11721feb5d564c0768f42e88d1d14c6c909e64b7cd5532b6f158b" as Hex };
  return { readLatestBlock: async () => latest, readBlock: async number => number === selected.number ? selected : number === certified.number ? certified : number === current.number ? current : number === transaction.blockNumber ? { number, hash: transaction.blockHash, timestamp: 1_793_209_392n } : undefined, readTransaction: async hash => hash === consumingHash ? transaction : undefined, readReceipt: async hash => hash === consumingHash ? { transactionHash: consumingHash, status: "success", blockNumber: transaction.blockNumber, blockHash: transaction.blockHash } : undefined, readTransactionCount: async (_address, block) => block === "pending" || block === "latest" ? 811 : 811, readControlledState: async () => structuredClone(state()) };
}

const original = () => createOrdinaryScenarioProposal(report, { expectedPackageHash: "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", expectedArtifactBytesHash: "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831" });
const observer = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${h("a")}`, endpointHash: h("a"), probeEvidenceHash: h("b"), independentFromProposer: true as const, readyAt: "1793210052", expiresAt: "1793814852" };
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" };
const exactIds = ["native-queue-ready-hashless-skip", "native-queue-ready-replacement", "native-queue-ready-replacement-execute", "usdc-base-x", "usdc-step-up-contract", "usdc-recycle-topup-step-up", "usdc-step-up-ecdsa", "usdc-direct-overspend-rejection", "usdc-replay-rejection", "usdc-unsupported-path-rejection", "usdc-recycle-topup-delayed", "usdc-queue-cancel", "usdc-queue-cancel-early-rejection", "usdc-queue-cancel-action", "usdc-queue-cancelled-execution-rejection", "usdc-queue-expiry", "usdc-queue-expiry-early-rejection", "usdc-queue-expiry-skip", "usdc-queue-expired-execution-rejection", "usdc-queue-execute", "usdc-queue-execute-early-rejection", "usdc-queue-ready-execute"];

describe("expired hashless continuation proposal", function () {
  let directory = ""; let journal: ReturnType<typeof loadHashlessSourceJournalReadOnly>; let certificate: Awaited<ReturnType<typeof verifyHashlessStateCertificate>>;
  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), "hashless-continuation-")); const path = join(directory, "journal.json"); writeFileSync(path, source); journal = loadHashlessSourceJournalReadOnly(path); certificate = await verifyHashlessStateCertificate(artifact, artifactSha, journal, [provider(), provider()]); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  const build = () => createExpiredHashlessContinuationProposal({ original: original(), journal, certificate, observer, caps });

  it("builds_exact22", function () {
    const proposal = build();
    expect(proposal.authorization).to.equal("NONE");
    expect(proposal.actions.map(action => action.id)).to.deep.equal(exactIds);
    expect(proposal.actions.map(action => [action.before.safeNonce, action.after.safeNonce, action.before.delayQueueNonce, action.after.delayQueueNonce, action.before.delayTxNonce, action.after.delayTxNonce])).to.deep.include.members([["7", "7", "3", "3", "2", "3"], ["7", "8", "3", "4", "3", "3"], ["8", "8", "4", "4", "3", "4"]]);
    expect(proposal.actions.at(-1)?.after).to.deep.include({ safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7" });
    expect(proposal.actions[1]?.transaction?.data.slice(0, 10)).to.equal("0x468721a7");
    expect(proposal.actions[0]?.transaction?.data).to.equal("0xb19d4758");
    expect(proposal.actions[2]?.transaction?.data.slice(0, 10)).to.equal("0xee072baf");
  });

  it("rebases_every_usdc_hash", function () {
    const proposal = build();
    const safeActions = proposal.actions.filter(action => action.safeTransaction);
    for (const action of safeActions) { const tx = action.safeTransaction!; expect(hashTypedData({ domain: { chainId: 11155111, verifyingContract: safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { ...tx, value: BigInt(tx.value), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: BigInt(tx.nonce) } })).to.equal(action.safeTxHash); }
    expect(proposal.actions.find(action => action.id === "usdc-base-x")?.safeTxHash).to.not.equal(original().actions[19]?.safeTxHash);
    expect(proposal.actions.filter(action => action.asset === "USDC" && action.queue).every(action => action.queue!.queueNonce >= "4")).to.equal(true);
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
    for (const mutate of [(v: any) => v.approvedActions.reverse(), (v: any) => v.approvedActions.pop(), (v: any) => { v.approvedActions[0].id = "unknown"; }, (v: any) => { v.caps.maxFeePerGas = "999999"; }, (v: any) => { v.observer.probeEvidenceHash = h("c"); }]) { const value = structuredClone(document); mutate(value); const raw = JSON.stringify(value); expect(() => loadExpiredHashlessContinuationApproval(proposal, raw, sha256(value) as Hex)).to.throw; }
  });

  it("budget_and_observer_binding", function () {
    const proposal = build();
    expect(BigInt(proposal.reservation.originalActualGasCostWei) > 0n).to.equal(true);
    expect(BigInt(proposal.reservation.originalPrincipalWei)).to.equal(60_000_000_000_001n);
    expect(BigInt(proposal.reservation.maximumCumulativeOutlayWei) < 50_000_000_000_000_000n).to.equal(true);
    expect(proposal.observer.endpointHash).to.equal(observer.endpointHash);
    expect(JSON.stringify(proposal)).to.not.match(/privateKey|credentialPath|rpcUrl|rawSignature/i);
    expect(() => createExpiredHashlessContinuationProposal({ original: original(), journal, certificate, observer: { ...observer, expiresAt: "1793210053" }, caps })).to.throw(/observer|TTL|expiry/i);
  });

  it("roundtrip_closed_artifact", function () {
    const proposal = build(); const serialized = JSON.stringify(proposal);
    expect(parseExpiredHashlessContinuationProposal(serialized, original(), journal, certificate)).to.deep.equal(proposal);
    for (const mutate of [(v: any) => { v.extra = true; }, (v: any) => { v.actions.pop(); }, (v: any) => { v.actions[0].before.safeNonce = 7; }, (v: any) => { v.proposalHash = h("f"); }]) { const value = JSON.parse(serialized); mutate(value); expect(() => parseExpiredHashlessContinuationProposal(JSON.stringify(value), original(), journal, certificate)).to.throw; }
    const forgedOriginal = structuredClone(original()) as any; forgedOriginal.actions[19].safeTransaction.safeNonce = 999n; expect(() => createExpiredHashlessContinuationProposal({ original: forgedOriginal, journal, certificate, observer, caps })).to.throw(/original proposal hash/i);
  });
});
