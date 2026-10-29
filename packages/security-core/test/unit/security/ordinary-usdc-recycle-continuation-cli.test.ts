import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import {
  USDC_RECYCLE_CONTINUATION_COMMANDS,
  createUsdcRecycleContinuationProductionDependencies,
  loadUsdcRecycleContinuationPublicInputs,
  parseUsdcRecycleContinuationCliArguments,
  runUsdcRecycleContinuationEntryPoint,
  runUsdcRecycleContinuationCli,
  withOnePinnedGetCodeRetry,
} from "../../../scripts/live/ordinary-scenario-usdc-recycle-continuation-cli";
import { loadUsdcRecycleContinuationSourceJournalReadOnly, serializeUsdcRecycleContinuationCertificate, type UsdcRecycleContinuationSource } from "../../../scripts/live/ordinary-scenario-usdc-recycle-continuation-certificate";
import { adoptHashlessSourceJournalReadOnlySnapshot } from "../../../scripts/live/ordinary-scenario-hashless-certificate";
import { createAuthorizedUsdcRecycleContinuation, recycleFixture, recycleProviders, trackedRecycleJournal, cleanupUsdcRecycleContinuationFixtures } from "../../support/usdc-recycle-continuation-fixture";
import { canonicalUsdcSuccessorState, oldUsdcRecoveryProvider, usdcSuccessorFixture } from "../../support/usdc-successor-fixture";
import type { UsdcSuccessorEvidenceProvider, UsdcSuccessorSource } from "../../../scripts/live/ordinary-scenario-usdc-successor-certificate";
import { loadUsdcSuccessorPublicInputs, parseUsdcSuccessorCliArguments } from "../../../scripts/live/ordinary-scenario-usdc-successor-cli";

const fixtureDirectory = join(__dirname, "../../fixtures");

function priorProvider(source: UsdcSuccessorSource): UsdcSuccessorEvidenceProvider {
  const snapshot = { number: 12_019_201n, hash: "0xd7fceb0b7f4bbb2164db7a23d2452944889035f25307a69bfb93845ebafbc251" as Hex, timestamp: 1_793_273_232n };
  const rows = source.journal.hashlessContinuation!.actions.slice(0, 3) as Array<Record<string, any>>;
  const blocks = new Map<bigint, { number: bigint; hash: Hex; timestamp: bigint }>([[snapshot.number, snapshot]]);
  rows.forEach((row, index) => blocks.set(BigInt(row.receipt.blockNumber), { number: BigInt(row.receipt.blockNumber), hash: row.receipt.blockHash, timestamp: 1_793_230_000n + BigInt(index * 500) }));
  const stateAt = (blockNumber: bigint) => {
    const block = blocks.get(blockNumber)!; const state = { ...canonicalUsdcSuccessorState(source.original), blockNumber, blockHash: block.hash };
    const index = rows.findIndex(row => BigInt(row.receipt.blockNumber) === blockNumber);
    if (index === 0) return { ...state, safeNonce: 7n, delayQueueNonce: 3n, delayTxNonce: 3n, safeNativeBalance: 1n };
    if (index === 1) { const queue = source.recovery.actions[1]!.queue!; return { ...state, safeNonce: 8n, delayQueueNonce: 4n, delayTxNonce: 3n, safeNativeBalance: 1n, queue: { queueNonce: BigInt(queue.queueNonce), fingerprint: queue.fingerprint, createdAt: block.timestamp, to: queue.to, value: BigInt(queue.value), data: queue.data, operation: queue.operation } }; }
    return state;
  };
  return {
    readLatestBlock: async () => ({ number: snapshot.number + 5n, hash: `0x${"9".repeat(64)}` as Hex, timestamp: snapshot.timestamp + 60n }),
    readBlock: async number => blocks.get(number),
    readTransaction: async hash => { const row = rows.find(item => item.transactionHash === hash); return row ? { hash, from: source.original.funder, nonce: row.outerNonce, to: row.outerTo, value: BigInt(row.outerValue), inputHash: row.outerDataHash, gas: BigInt(row.gas), type: "eip1559" as const, chainId: 11_155_111, maxFeePerGas: BigInt(row.maxFeePerGas), maxPriorityFeePerGas: BigInt(row.maxPriorityFeePerGas), blockNumber: BigInt(row.receipt.blockNumber), blockHash: row.receipt.blockHash } : undefined; },
    readReceipt: async hash => { const row = rows.find(item => item.transactionHash === hash); return row ? { transactionHash: hash, status: row.receipt.status, blockNumber: BigInt(row.receipt.blockNumber), blockHash: row.receipt.blockHash, gasUsed: BigInt(row.receipt.gasUsed), effectiveGasPrice: BigInt(row.receipt.effectiveGasPrice) } : undefined; },
    readTransactionCount: async () => 866,
    readControlledState: async blockNumber => structuredClone(stateAt(blockNumber)),
  };
}

async function preparePublicCli() {
  const authorized = await createAuthorizedUsdcRecycleContinuation(); const tracked = trackedRecycleJournal();
  const directory = mkdtempSync(join(tmpdir(), "usdc-recycle-cli-"));
  const write = (name: string, value: string) => { const path = join(directory, name); writeFileSync(path, value); return path; };
  const recoveryCertificate = write("recovery-certificate.json", usdcSuccessorFixture.recoveryCertificate), recoveryProposal = write("recovery-proposal.json", usdcSuccessorFixture.recoveryProposal), recoveryApproval = write("recovery-approval.json", usdcSuccessorFixture.recoveryApproval);
  const primaryManifest = write("primary-manifest.json", usdcSuccessorFixture.primary.manifest);
  write("ledger-source-native-item2.json", usdcSuccessorFixture.primary.ledgerSourceNativeItem2); write("ledger-replacement-native-item3.json", usdcSuccessorFixture.primary.ledgerReplacementNativeItem3); write("ack-native-queue-ready-hashless-skip.json", usdcSuccessorFixture.primary.ackNativeQueueReadyHashlessSkip); write("ack-native-queue-ready-replacement.json", usdcSuccessorFixture.primary.ackNativeQueueReadyReplacement); write("ack-native-queue-ready-replacement-execute.json", usdcSuccessorFixture.primary.ackNativeQueueReadyReplacementExecute);
  const priorCertificate = write("prior-certificate.json", recycleFixture.priorCertificate), priorProposal = write("prior-proposal.json", recycleFixture.priorProposal), priorApproval = write("prior-approval.json", recycleFixture.priorApproval);
  const sourceManifest = write("source-manifest.json", recycleFixture.primary.manifest), sourceLedger = write("source-ledger.json", recycleFixture.primary.stepUpLedger), sourceAck = write("source-ack.json", recycleFixture.primary.stepUpAcknowledgement);
  const recycleCertificate = write("recycle-certificate.json", serializeUsdcRecycleContinuationCertificate(authorized.certificate)), recycleProposal = write("recycle-proposal.json", `${JSON.stringify(authorized.proposal)}\n`);
  const approvalDocument = { schemaVersion: 1, scope: "ordinary-usdc-recycle-continuation-v1", authorization: "STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION", authorityEvidenceHash: authorized.proposal.authorityEvidenceHash, proposalHash: authorized.proposal.proposalHash, sourceHash: authorized.proposal.sourceHash, certificateHash: authorized.proposal.certificateHash, snapshot: authorized.proposal.snapshot, currentCheckpoint: authorized.proposal.currentCheckpoint, minimumOuterNonce: authorized.proposal.minimumOuterNonce, effectivePeriod: authorized.proposal.effectivePeriod, deadline: authorized.proposal.deadline, observer: authorized.proposal.observer, schedule: authorized.proposal.schedule, groups: authorized.proposal.groups, caps: authorized.proposal.caps, reservation: authorized.proposal.reservation, repairAuthority: "NONE", sharedBudgetCharges: authorized.proposal.sharedBudgetCharges, maxBroadcastAttempts: 1, approvedActions: authorized.proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
  const recycleApproval = write("recycle-approval.json", `${JSON.stringify(approvalDocument)}\n`);
  const common = ["--source-journal", tracked.path, "--original-report", join(fixtureDirectory, "ordinary-scenario-review.public.json"), "--original-package-hash", "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", "--original-artifact-hash", "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831", "--original-proposal-hash", authorized.source.prior.original.proposalHash, "--recovery-certificate", recoveryCertificate, "--recovery-certificate-hash", authorized.source.prior.recovery.certificateHash, "--recovery-proposal", recoveryProposal, "--recovery-approval", recoveryApproval, "--recovery-approval-hash", authorized.source.prior.recoveryApproval.approvalHash, "--primary-bundle-manifest", primaryManifest, "--successor-certificate", priorCertificate, "--successor-certificate-hash", authorized.source.priorCertificate.certificateHash, "--successor-proposal", priorProposal, "--successor-approval", priorApproval, "--successor-approval-hash", authorized.source.priorApproval.approvalHash, "--source-manifest", sourceManifest, "--source-step-up-ledger", sourceLedger, "--source-step-up-ack", sourceAck] as const;
  const reviewArgs = ["review", ...common] as const;
  const oldArgs = ["submit-one", ...common.slice(0, 32)] as const;
  const execution = ["--recycle-certificate", recycleCertificate, "--recycle-certificate-hash", authorized.certificate.certificateHash, "--recycle-proposal", recycleProposal, "--recycle-approval", recycleApproval, "--recycle-approval-hash", authorized.approval.approvalHash, "--journal", tracked.path] as const;
  const submitArgs = ["submit-one", ...common, ...execution] as const, resumeArgs = ["resume-one", ...common, ...execution] as const;
  const providers = { predecessor: { recovery: [oldUsdcRecoveryProvider(), oldUsdcRecoveryProvider()] as const, successor: (source: UsdcSuccessorSource) => [priorProvider(source), priorProvider(source)] as const }, recycle: (source: UsdcRecycleContinuationSource) => recycleProviders(source), now: () => new Date("2026-10-29T12:01:00Z") };
  return { authorized, tracked, directory, reviewArgs, oldArgs, submitArgs, resumeArgs, providers, cleanup: () => { rmSync(directory, { recursive: true, force: true }); cleanupUsdcRecycleContinuationFixtures(); } };
}

describe("ordinary USDC recycle continuation CLI", function () {
  this.timeout(30_000);
  it("exposes only review, submit-one, and resume-one with a closed parser", function () {
    expect(USDC_RECYCLE_CONTINUATION_COMMANDS).to.deep.equal(["review", "submit-one", "resume-one"]);
    expect(parseUsdcRecycleContinuationCliArguments(["review", "--source-journal", "/public/source"])).to.include({ command: "review" });
    expect(() => parseUsdcRecycleContinuationCliArguments(["review", "--rpc", "https://override.invalid"])).to.throw(/malformed|flag/i);
  });

  it("retries one explicit-block getCode -32001 once with identical arguments and 250ms wait", async function () {
    const calls: unknown[] = []; const waits: number[] = [];
    const client = {
      getCode: async (parameters: unknown) => {
        calls.push(parameters);
        if (calls.length === 1) throw Object.assign(new Error("historical state unavailable"), { code: -32001 });
        return "0x1234";
      },
      getBlock: async () => "unchanged",
    };
    const wrapped = withOnePinnedGetCodeRetry(client, async milliseconds => { waits.push(milliseconds); });
    const parameters = { address: "0x0000000000000000000000000000000000000001", blockNumber: 12n };
    expect(await wrapped.getCode(parameters)).to.equal("0x1234");
    expect(calls).to.deep.equal([parameters, parameters]);
    expect(waits).to.deep.equal([250]);
    expect(await wrapped.getBlock()).to.equal("unchanged");
  });

  it("applies the same single eth_getCode budget to viem's getBytecode action", async function () {
    let calls = 0; const waits: number[] = [];
    const client = withOnePinnedGetCodeRetry({ getBytecode: async (_parameters: unknown) => { calls++; if (calls === 1) throw Object.assign(new Error("eth_getCode unavailable"), { code: -32001 }); return "0x6000"; } }, async milliseconds => { waits.push(milliseconds); });
    expect(await client.getBytecode({ blockNumber: 99n })).to.equal("0x6000"); expect(calls).to.equal(2); expect(waits).to.deep.equal([250]);
  });

  it("consumes the retry budget per provider and never retries non-pinned or later failures", async function () {
    let calls = 0;
    const client = { getCode: async (_parameters?: unknown) => { calls++; throw Object.assign(new Error("missing"), { code: -32001 }); } };
    const wrapped = withOnePinnedGetCodeRetry(client, async () => undefined);
    await expect(wrapped.getCode({ blockNumber: 12n })).to.be.rejectedWith("missing");
    expect(calls).to.equal(2);
    await expect(wrapped.getCode({ blockNumber: 13n })).to.be.rejectedWith("missing");
    expect(calls).to.equal(3);
    await expect(withOnePinnedGetCodeRetry(client).getCode({ blockTag: "latest" })).to.be.rejectedWith("missing");
    expect(calls).to.equal(4);
  });

  it("does not retry another JSON-RPC code or accept a returned runtime through the proxy", async function () {
    let failures = 0;
    const nonRetryable = withOnePinnedGetCodeRetry({ getCode: async (_parameters: unknown) => { failures++; throw Object.assign(new Error("other RPC failure"), { code: -32603 }); } }, async () => { throw new Error("must not wait"); });
    await expect(nonRetryable.getCode({ blockNumber: 1n })).to.be.rejectedWith("other RPC failure"); expect(failures).to.equal(1);
    let returns = 0;
    const returned = withOnePinnedGetCodeRetry({ getCode: async (_parameters: unknown) => { returns++; return "0xdead"; } }, async () => { throw new Error("must not wait"); });
    expect(await returned.getCode({ blockNumber: 1n })).to.equal("0xdead"); expect(returns).to.equal(1);
  });

  it("keeps retry budgets independent per provider and emits only a static entrypoint failure", async function () {
    const make = () => { let calls = 0; return { client: withOnePinnedGetCodeRetry({ getCode: async (_parameters: unknown) => { calls++; if (calls === 1) throw Object.assign(new Error("provider secret"), { code: -32001 }); return "0x01"; } }, async () => undefined), calls: () => calls }; };
    const left = make(), right = make();
    expect(await left.client.getCode({ blockNumber: 1n })).to.equal("0x01"); expect(await right.client.getCode({ blockNumber: 1n })).to.equal("0x01"); expect([left.calls(), right.calls()]).to.deep.equal([2, 2]);
    let stderr = "", exitCode = 0;
    await runUsdcRecycleContinuationEntryPoint(Promise.reject(new Error("provider secret https://private.invalid")), { writeStderr: value => { stderr += value; }, setExitCode: value => { exitCode = value; } });
    expect(exitCode).to.equal(1); expect(stderr).to.equal("[ORDINARY_USDC_RECYCLE_CONTINUATION_FAILED] ordinary USDC recycle continuation failed\n"); expect(stderr).not.to.include("private.invalid");
  });

  it("loads genuine public lineage and emits a nonauthorizing 17-action review", async function () {
    const prepared = await preparePublicCli();
    try {
      const inputs = await loadUsdcRecycleContinuationPublicInputs(parseUsdcRecycleContinuationCliArguments(prepared.reviewArgs), prepared.providers);
      expect(inputs.approval).to.equal(undefined); expect(inputs.continuation.actions).to.have.length(17);
      const review = await runUsdcRecycleContinuationCli(prepared.reviewArgs, { environment: {}, providers: prepared.providers, now: prepared.providers.now });
      expect(review).to.include({ scope: "ORDINARY_USDC_RECYCLE_CONTINUATION_UNSIGNED_REVIEW_V1", authorization: "NONE", actionCount: 17, signing: false, broadcast: false });
    } finally { prepared.cleanup(); }
  });

  it("keeps the old successor loader default path unchanged", async function () {
    const prepared = await preparePublicCli();
    try {
      const old = await loadUsdcSuccessorPublicInputs(parseUsdcSuccessorCliArguments(prepared.oldArgs), prepared.providers.predecessor);
      expect(old.successor.proposalHash).to.equal(prepared.authorized.source.priorProposal.proposalHash); expect(old.approval?.approvalHash).to.equal(prepared.authorized.source.priorApproval.approvalHash);
    } finally { prepared.cleanup(); }
  });

  it("rejects a mutated descendant journal before historical capability restoration", async function () {
    const prepared = await preparePublicCli();
    try {
      const decoded = loadUsdcRecycleContinuationSourceJournalReadOnly(prepared.tracked.path, "pinned");
      const mutated = structuredClone(decoded) as any; mutated.unreviewedSibling = { authority: true };
      expect(() => adoptHashlessSourceJournalReadOnlySnapshot(prepared.tracked.path, mutated)).to.throw(/does not match its stable file/);
    } finally { prepared.cleanup(); }
  });

  it("persists one attachment under the real store lease and reloads it in a fresh invocation", async function () {
    const prepared = await preparePublicCli(); let contexts = 0;
    const dependencies = () => ({ environment: { LIVE_SUBMIT: "YES" }, providers: prepared.providers, now: prepared.providers.now, publicPreflight: async () => undefined, createExecutionContext: async (_mode: unknown, inputs: any, journal: () => any) => { contexts++; expect(journal().usdcRecycleContinuation.proposalHash).to.equal(inputs.continuation.proposalHash); throw new Error(`DEFAULT_BOUNDARY_${contexts}`); } });
    try {
      await expect(runUsdcRecycleContinuationCli(prepared.submitArgs, dependencies() as never)).to.be.rejectedWith("DEFAULT_BOUNDARY_1");
      expect(JSON.parse(readFileSync(prepared.tracked.path, "utf8")).usdcRecycleContinuation.actions).to.have.length(17);
      await expect(runUsdcRecycleContinuationCli(prepared.submitArgs, dependencies() as never)).to.be.rejectedWith("DEFAULT_BOUNDARY_2");
      expect(contexts).to.equal(2);
    } finally { prepared.cleanup(); }
  });

  it("rejects resume credentials and cannot select the stopped old row without one new pending hash", async function () {
    const prepared = await preparePublicCli();
    try {
      await expect(runUsdcRecycleContinuationCli(prepared.resumeArgs, { environment: { LIVE_PRIMARY_CREDENTIAL_FILE: "/private" }, providers: prepared.providers })).to.be.rejectedWith(/private authority/);
      await expect(runUsdcRecycleContinuationCli(prepared.resumeArgs, { environment: {}, providers: prepared.providers, now: prepared.providers.now })).to.be.rejectedWith(/attached continuation/);
    } finally { prepared.cleanup(); }
  });

  it("composes the production state-reader seam and real default adapter with exact observer ISO bounds", async function () {
    const prepared = await preparePublicCli(); let reads = 0; const selected: string[] = [];
    try {
      const inputs = await loadUsdcRecycleContinuationPublicInputs(parseUsdcRecycleContinuationCliArguments(prepared.submitArgs), prepared.providers);
      const fakeHarness = { current: {}, archive: {}, reconstructedProfile: async () => ({}), observerReadiness: async () => ({ ready: true, evidenceHash: inputs.continuation.observer.probeEvidenceHash }), loadClosedPasskey: async () => { throw new Error("signers stay lazy during construction"); }, loadClosedProofSigner: async () => { throw new Error("unused"); }, createLiveContext: async () => ({}) } as never;
      const dependencies = createUsdcRecycleContinuationProductionDependencies("/public/repository", prepared.submitArgs, { createHarness: () => fakeHarness, createStateReader: (() => async (action: any) => { reads++; selected.push(action.id); return { blockTimestamp: BigInt(inputs.certificate.snapshot.timestamp) } as never; }) as never });
      await dependencies.publicPreflight!("submit-one", inputs); await dependencies.publicPreflight!("submit-one", inputs);
      expect(reads).to.equal(2); expect(selected).to.deep.equal([inputs.continuation.actions[0]!.id, inputs.continuation.actions[0]!.id]); expect(selected[0]).not.to.equal(inputs.source.priorProposal.actions[2]!.id);
      const context = await dependencies.createExecutionContext!("submit-one", inputs, () => inputs.source.prior.journal);
      expect(context.inspectReceiptPostState).to.be.a("function");
    } finally { prepared.cleanup(); }
  });
});
