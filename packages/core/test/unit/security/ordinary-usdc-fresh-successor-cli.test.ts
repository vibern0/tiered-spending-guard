import { expect } from "chai";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, type Hex } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import {
  USDC_FRESH_SUCCESSOR_COMMANDS,
  createUsdcFreshSuccessorObserverBinding,
  createUsdcFreshSuccessorProductionDependencies,
  loadUsdcFreshSuccessorPublicInputs,
  parseUsdcFreshSuccessorCliArguments,
  runUsdcFreshSuccessorCli,
  runUsdcFreshSuccessorEntryPoint,
} from "../../../scripts/live/ordinary-scenario-usdc-fresh-successor-cli";
import { serializeUsdcFreshSuccessorCertificate, verifyUsdcFreshSuccessorCertificate } from "../../../scripts/live/ordinary-scenario-usdc-fresh-successor-certificate";
import { createUsdcFreshSuccessorProposal } from "../../../scripts/live/ordinary-scenario-usdc-fresh-successor-proposal";
import { createOrdinaryScenarioMechanicalExecutionContext } from "../../../scripts/live/ordinary-scenario-adapter";
import { createUsdcFreshSuccessorExecutionView, type CanonicalOrdinaryScenarioState } from "../../../scripts/live/ordinary-scenario-executor";
import { oldUsdcRecoveryProvider, usdcSuccessorFixture } from "../../support/usdc-successor-fixture";
import type { UsdcSuccessorSource } from "../../../scripts/live/ordinary-scenario-usdc-successor-certificate";
import { cleanupUsdcRecycleContinuationFixtures, genuinePriorCertificateProvider, recycleFixture, trackedRecycleJournal } from "../../support/usdc-recycle-continuation-fixture";
import { createFreshSource, freshPrimary, freshProviders, freshSnapshot } from "../../support/usdc-fresh-successor-fixture";

const fixtureDirectory = join(__dirname, "../../fixtures");
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;
const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const replaceFlag = (args: readonly string[], flag: string, value: string): string[] => { const copy = [...args], index = copy.indexOf(flag); if (index < 0) throw new Error(`missing ${flag}`); copy[index + 1] = value; return copy; };

function observerFiles(directory: string) {
  const endpointHash = `0x${"88".repeat(32)}` as Hex, started = new Date(Number(freshSnapshot.timestamp * 1000n)).toISOString(), ready = new Date(Number((freshSnapshot.timestamp + 10n) * 1000n)).toISOString(), expires = new Date(1_793_404_800_000).toISOString();
  const startup = `${JSON.stringify({ schemaVersion: 1, scope: "USDC_FRESH_SUCCESSOR_OBSERVER_STARTUP_V1", publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startedAt: started, expiresAt: expires, signing: false, broadcast: false })}\n`;
  const startupPath = join(directory, "observer-startup.json"); writeFileSync(startupPath, startup);
  const startupEvidenceHash = `0x${createHash("sha256").update(startup).digest("hex")}`;
  const probe = `${JSON.stringify({ schemaVersion: 1, scope: "USDC_FRESH_SUCCESSOR_OBSERVER_PROBE_V1", publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startupEvidenceHash, probedAt: ready, expiresAt: expires, delivery: "DELIVERED", acknowledgement: "ACKNOWLEDGED", signing: false, broadcast: false })}\n`;
  const probePath = join(directory, "observer-probe.json"); writeFileSync(probePath, probe);
  return { startupPath, probePath, now: () => new Date(Number((freshSnapshot.timestamp + 10n) * 1000n)) };
}

async function prepare() {
  const source = await createFreshSource(), certificate = await verifyUsdcFreshSuccessorCertificate(source, freshPrimary, await freshProviders(source)); const tracked = trackedRecycleJournal();
  const directory = mkdtempSync(join(tmpdir(), "usdc-fresh-cli-")); const write = (name: string, value: string) => { const path = join(directory, name); writeFileSync(path, value); return path; };
  const recoveryCertificate = write("recovery-certificate.json", usdcSuccessorFixture.recoveryCertificate), recoveryProposal = write("recovery-proposal.json", usdcSuccessorFixture.recoveryProposal), recoveryApproval = write("recovery-approval.json", usdcSuccessorFixture.recoveryApproval), primaryManifest = write("primary-manifest.json", usdcSuccessorFixture.primary.manifest);
  write("ledger-source-native-item2.json", usdcSuccessorFixture.primary.ledgerSourceNativeItem2); write("ledger-replacement-native-item3.json", usdcSuccessorFixture.primary.ledgerReplacementNativeItem3); write("ack-native-queue-ready-hashless-skip.json", usdcSuccessorFixture.primary.ackNativeQueueReadyHashlessSkip); write("ack-native-queue-ready-replacement.json", usdcSuccessorFixture.primary.ackNativeQueueReadyReplacement); write("ack-native-queue-ready-replacement-execute.json", usdcSuccessorFixture.primary.ackNativeQueueReadyReplacementExecute);
  const priorCertificate = write("prior-certificate.json", recycleFixture.priorCertificate), priorProposal = write("prior-proposal.json", recycleFixture.priorProposal), priorApproval = write("prior-approval.json", recycleFixture.priorApproval), sourceManifest = write("source-manifest.json", recycleFixture.primary.manifest), sourceLedger = write("source-ledger.json", recycleFixture.primary.stepUpLedger), sourceAck = write("source-ack.json", recycleFixture.primary.stepUpAcknowledgement), observer = observerFiles(directory);
  const binding = createUsdcFreshSuccessorObserverBinding(readFileSync(observer.startupPath, "utf8"), readFileSync(observer.probePath, "utf8"), observer.now()); const proposal = createUsdcFreshSuccessorProposal({ source, certificate, observer: binding, caps });
  const document = { schemaVersion: 1, scope: proposal.scope, authorization: "FOCUSED_BOUNDED_SUCCESSOR_AUTHORIZATION", authorityEvidenceHash: proposal.authorityEvidenceHash, proposalHash: proposal.proposalHash, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, snapshot: proposal.snapshot, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, observer: proposal.observer, schedule: proposal.schedule, groups: proposal.groups, caps: proposal.caps, reservation: proposal.reservation, maxBroadcastAttempts: 1, repairAuthority: "NONE", approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
  const approvalPath = write("fresh-approval.json", `${JSON.stringify(document)}\n`), approvalHash = sha256(document) as Hex, certificatePath = write("fresh-certificate.json", serializeUsdcFreshSuccessorCertificate(certificate)), proposalPath = write("fresh-proposal.json", `${JSON.stringify(proposal)}\n`);
  const common = ["--source-journal", tracked.path, "--original-report", join(fixtureDirectory, "ordinary-scenario-review.public.json"), "--original-package-hash", "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", "--original-artifact-hash", "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831", "--original-proposal-hash", source.prior.original.proposalHash, "--recovery-certificate", recoveryCertificate, "--recovery-certificate-hash", source.prior.recovery.certificateHash, "--recovery-proposal", recoveryProposal, "--recovery-approval", recoveryApproval, "--recovery-approval-hash", source.prior.recoveryApproval.approvalHash, "--primary-bundle-manifest", primaryManifest, "--successor-certificate", priorCertificate, "--successor-certificate-hash", source.priorCertificate.certificateHash, "--successor-proposal", priorProposal, "--successor-approval", priorApproval, "--successor-approval-hash", source.priorApproval.approvalHash, "--source-manifest", sourceManifest, "--source-step-up-ledger", sourceLedger, "--source-step-up-ack", sourceAck] as const;
  const execution = ["--fresh-certificate", certificatePath, "--fresh-certificate-hash", certificate.certificateHash, "--fresh-proposal", proposalPath, "--fresh-approval", approvalPath, "--fresh-approval-hash", approvalHash, "--journal", tracked.path] as const;
  const providers = { predecessor: { recovery: [oldUsdcRecoveryProvider(), oldUsdcRecoveryProvider()] as const, successor: (prior: UsdcSuccessorSource) => [genuinePriorCertificateProvider(prior), genuinePriorCertificateProvider(prior)] as const }, fresh: (freshSource: typeof source) => freshProviders(freshSource), now: observer.now };
  return { source, certificate, proposal, tracked, directory, providers, reviewArgs: ["review", ...common, "--observer-startup", observer.startupPath, "--observer-probe", observer.probePath] as const, submitArgs: ["submit-one", ...common, ...execution] as const, resumeArgs: ["resume-one", ...common, ...execution] as const, cleanup: () => { rmSync(directory, { recursive: true, force: true }); cleanupUsdcRecycleContinuationFixtures(); } };
}

describe("ordinary USDC fresh successor CLI", function () {
  this.timeout(30_000);
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  it("exposes only the closed one-action commands and flags", function () {
    expect(USDC_FRESH_SUCCESSOR_COMMANDS).to.deep.equal(["review", "submit-one", "resume-one"]);
    expect(parseUsdcFreshSuccessorCliArguments(["review", "--source-journal", "/public/source"])).to.include({ command: "review" });
    expect(() => parseUsdcFreshSuccessorCliArguments(["review", "--rpc", "https://override.invalid"])).to.throw(/malformed|flag/i);
  });

  it("binds a new observer with the exact 11640-second budget and rejects expiry", function () {
    const directory = mkdtempSync(join(tmpdir(), "fresh-observer-"));
    try { const files = observerFiles(directory), binding = createUsdcFreshSuccessorObserverBinding(readFileSync(files.startupPath, "utf8"), readFileSync(files.probePath, "utf8"), files.now()); expect(BigInt(binding.requiredThrough) - BigInt(binding.readyAt)).to.equal(11_640n); expect(binding.workflowScheduleSeconds.execution).to.equal("7200"); expect(() => createUsdcFreshSuccessorObserverBinding(readFileSync(files.startupPath, "utf8"), readFileSync(files.probePath, "utf8"), new Date(1_793_404_799_000))).to.throw(/TTL|insufficient/i); } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("loads exact public lineage and emits one unsigned 18-action review without private callbacks", async function () {
    const prepared = await prepare(); let contexts = 0;
    try { const inputs = await loadUsdcFreshSuccessorPublicInputs(parseUsdcFreshSuccessorCliArguments(prepared.reviewArgs), prepared.providers); expect(inputs.approval).to.equal(undefined); const review = await runUsdcFreshSuccessorCli(prepared.reviewArgs, { environment: {}, providers: prepared.providers, now: prepared.providers.now, publicPreflight: async () => undefined, createExecutionContext: async () => { contexts++; throw new Error("private"); } }); expect(review).to.include({ scope: "ORDINARY_USDC_FRESH_SUCCESSOR_UNSIGNED_REVIEW_V1", authorization: "NONE", actionCount: 18, signing: false, broadcast: false }); expect(contexts).to.equal(0); } finally { prepared.cleanup(); }
  });

  it("rejects authority and provider overrides and emits only a static entrypoint failure", async function () {
    const prepared = await prepare();
    try { await expect(runUsdcFreshSuccessorCli(prepared.reviewArgs, { environment: { LIVE_FUNDING_KEY_FILE: "/private" }, providers: prepared.providers })).to.be.rejectedWith(/private authority/); await expect(runUsdcFreshSuccessorCli(prepared.reviewArgs, { environment: { SEPOLIA_RPC_URL: "https://override.invalid" }, providers: prepared.providers })).to.be.rejectedWith(/overrides/); let stderr = "", exitCode = 0; await runUsdcFreshSuccessorEntryPoint(Promise.reject(new Error("secret https://private.invalid")), { writeStderr: value => { stderr += value; }, setExitCode: value => { exitCode = value; } }); expect(exitCode).to.equal(1); expect(stderr).to.equal("[ORDINARY_USDC_FRESH_SUCCESSOR_FAILED] ordinary USDC fresh successor failed\n"); expect(stderr).not.to.include("private.invalid"); } finally { prepared.cleanup(); }
  });

  it("rejects wrong artifact hashes, faucet evidence, stale source state, and exhausted admission time", async function () {
    const prepared = await prepare();
    try {
      await expect(loadUsdcFreshSuccessorPublicInputs(parseUsdcFreshSuccessorCliArguments(replaceFlag(prepared.submitArgs, "--fresh-certificate-hash", h("9"))), prepared.providers)).to.be.rejectedWith(/certificate.*hash/i);
      const wrongFaucet = { ...prepared.providers, fresh: (source: typeof prepared.source) => freshProviders(source, { faucetLog: { amount: 19_000_000n } }, { faucetLog: { amount: 19_000_000n } }) };
      await expect(loadUsdcFreshSuccessorPublicInputs(parseUsdcFreshSuccessorCliArguments(prepared.reviewArgs), wrongFaucet)).to.be.rejectedWith(/faucet|transfer|amount/i);
      const staleDrift = { ...prepared.providers, fresh: (source: typeof prepared.source) => freshProviders(source, { state: { usdcSpend: { window: 1_793_232_000n, baseSpent: 0n, instantSpent: 0n } } }, { state: { usdcSpend: { window: 1_793_232_000n, baseSpent: 0n, instantSpent: 0n } } }) };
      await expect(loadUsdcFreshSuccessorPublicInputs(parseUsdcFreshSuccessorCliArguments(prepared.reviewArgs), staleDrift)).to.be.rejectedWith(/state|profile|spend/i);
      const late = () => new Date(Number((BigInt(prepared.proposal.deadline) - 11_000n) * 1000n));
      await expect(runUsdcFreshSuccessorCli(prepared.reviewArgs, { environment: {}, providers: { ...prepared.providers, now: late }, now: late, publicPreflight: async () => undefined })).to.be.rejectedWith(/TTL|admission|budget|freshness|insufficient/i);
    } finally { prepared.cleanup(); }
  });

  it("attaches once under the physical writer lease and refuses submit/resume mode confusion", async function () {
    const prepared = await prepare(); let contexts = 0;
    try { await expect(runUsdcFreshSuccessorCli(prepared.resumeArgs, { environment: {}, providers: prepared.providers, now: prepared.providers.now })).to.be.rejectedWith(/attached successor|exactly one durable pending/i); await expect(runUsdcFreshSuccessorCli(prepared.submitArgs, { environment: { LIVE_SUBMIT: "YES" }, providers: prepared.providers, now: prepared.providers.now, publicPreflight: async () => undefined, createExecutionContext: async (_mode, inputs, journal) => { contexts++; expect(journal().usdcFreshSuccessor?.proposalHash).to.equal(inputs.successor.proposalHash); throw new Error("CONTROLLED_CONTEXT"); } })).to.be.rejectedWith("CONTROLLED_CONTEXT"); expect(contexts).to.equal(1); expect(JSON.parse(readFileSync(prepared.tracked.path, "utf8")).usdcFreshSuccessor.actions).to.have.length(18); await expect(runUsdcFreshSuccessorCli(prepared.submitArgs, { environment: {}, providers: prepared.providers })).to.be.rejectedWith(/submit.*live|live.*submit/i); } finally { prepared.cleanup(); }
  });

  it("composes the real adapter and atomic store to one controlled signing failure, then fails closed", async function () {
    const prepared = await prepare(); let signs = 0, broadcasts = 0;
    const createExecutionContext = async (_mode: "submit-one" | "resume-one", inputs: any, journal: () => any) => {
      const view = createUsdcFreshSuccessorExecutionView(inputs.source, inputs.successor, inputs.approval), queueAction = view.proposal.actions.find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce === 3n)!, queueRecord = journal().hashlessContinuation.actions[1], dependency = journal().usdcSuccessor.actions[1];
      const state: CanonicalOrdinaryScenarioState = { chainId: 11_155_111, blockNumber: freshSnapshot.number, blockHash: freshSnapshot.hash, blockTimestamp: freshSnapshot.timestamp, evidenceBasis: { kind: "current-head" }, planHash: view.proposal.planHash, topologyEvidenceHash: view.proposal.topologyEvidenceHash, publicIdentitiesHash: view.proposal.publicIdentitiesHash, observerReady: true, observerEvidenceHash: inputs.successor.observer.probeEvidenceHash, outerNonce: 870, funderNativeBalance: 10n ** 18n, safeNativeBalance: 0n, funderUsdcBalance: 40_000_000n, safeUsdcBalance: 0n, safeNonce: 10n, delayQueueNonce: 4n, delayTxNonce: 4n, nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: 1_793_232_000n, baseSpent: 10_000_000n, instantSpent: 20_000_000n }, queue: { queueNonce: 3n, fingerprint: queueAction.queue!.fingerprint, createdAt: BigInt(queueRecord.queueCreatedAt), status: "executed", to: queueAction.queue!.to, value: queueAction.queue!.value, data: queueAction.queue!.data, operation: 0 }, dependencies: [{ actionId: dependency.id, transactionHash: dependency.transactionHash, blockHash: dependency.receipt.blockHash, evidenceHash: dependency.evidenceHash }], fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } };
      const client = { getBlock: async () => ({ number: state.blockNumber, hash: state.blockHash, timestamp: state.blockTimestamp }), call: async () => ({ data: encodeAbiParameters([{ type: "bool" }], [true]) }), estimateGas: async () => 53_859n };
      return createOrdinaryScenarioMechanicalExecutionContext({ expectedChainId: 11_155_111, proposal: view, journal, currentClient: client as never, archiveClient: client as never, observerReadiness: async () => ({ ready: true, evidenceHash: inputs.successor.observer.probeEvidenceHash }), receiverReadyAt: new Date(Number(BigInt(inputs.successor.observer.readyAt)) * 1000).toISOString(), receiverExpiresAt: new Date(Number(BigInt(inputs.successor.observer.expiresAt)) * 1000).toISOString(), live: { funder: journal().funder, chainId: async () => 11_155_111, nonce: async () => 870, balance: async () => 10n ** 18n, sign: async () => { signs++; throw new Error("wrong controlled key"); }, broadcast: async () => { broadcasts++; throw new Error("must not broadcast"); }, receipt: async (hash: Hex) => journal().liveJournal.entries.find((entry: any) => entry.transactionHash === hash)?.receipt }, loadSigners: async () => { throw new Error("prefund must not load Safe signers"); }, now: prepared.providers.now } as never, (async () => state) as never);
    };
    const dependencies = { environment: { LIVE_SUBMIT: "YES" }, providers: prepared.providers, now: prepared.providers.now, publicPreflight: async () => undefined, createExecutionContext };
    try { await expect(runUsdcFreshSuccessorCli(prepared.submitArgs, dependencies)).to.be.rejectedWith(/local transaction signing failed/i); expect({ signs, broadcasts }).to.deep.equal({ signs: 1, broadcasts: 0 }); expect(JSON.parse(readFileSync(prepared.tracked.path, "utf8")).usdcFreshSuccessor.actions[0].status).to.equal("signed-simulated"); await expect(runUsdcFreshSuccessorCli(prepared.submitArgs, dependencies)).to.be.rejectedWith(/stopped|interrupted|durable outer hash/i); expect({ signs, broadcasts }).to.deep.equal({ signs: 1, broadcasts: 0 }); } finally { prepared.cleanup(); }
  });

  it("submit refuses one durable pending hash while resume reaches only the keyless context", async function () {
    const prepared = await prepare();
    try {
      await expect(runUsdcFreshSuccessorCli(prepared.submitArgs, { environment: { LIVE_SUBMIT: "YES" }, providers: prepared.providers, now: prepared.providers.now, publicPreflight: async () => undefined, createExecutionContext: async () => { throw new Error("ATTACHED"); } })).to.be.rejectedWith("ATTACHED");
      const journal = JSON.parse(readFileSync(prepared.tracked.path, "utf8")), action = prepared.proposal.actions[0]!, transactionHash = h("c"), intentHash = h("d"), facts = { proposalHash: prepared.proposal.proposalHash, actionCommitment: action.commitment, outerNonce: 870, gas: action.gasLimitCap, gasEstimate: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", pinnedBlockNumber: freshSnapshot.number.toString(), pinnedBlockHash: freshSnapshot.hash, approvedContinuationReservationWei: prepared.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: prepared.proposal.reservation.successorMaximumReservationWei };
      journal.usdcFreshSuccessor.actions[0] = { id: action.id, commitment: action.commitment, status: "outer-pending", materializationHash: h("1"), finalOuterMaterialization: { hash: sha256(facts), ...facts }, prestateHash: h("2"), outerNonce: 870, gas: action.gasLimitCap, maxFeePerGas: "1", maxPriorityFeePerGas: "1", requestHash: action.commitment, signatureBundleHash: null, signedCalldataHash: h("3"), simulationEvidenceHash: h("4"), intentHash, transactionHash, outerTo: journal.funder, outerValue: "0", outerDataHash: h("5"), funderNativeBefore: (10n ** 18n).toString() };
      journal.liveJournal.entries.push({ id: action.id, intentHash, transactionHash, nonce: 870, reserved: "1", status: "pending" }); writeFileSync(prepared.tracked.path, `${JSON.stringify(journal)}\n`);
      let contexts = 0;
      await expect(runUsdcFreshSuccessorCli(prepared.submitArgs, { environment: { LIVE_SUBMIT: "YES" }, providers: prepared.providers, now: prepared.providers.now, publicPreflight: async () => undefined, createExecutionContext: async () => { contexts++; throw new Error("must not reach submit context"); } })).to.be.rejectedWith(/refuses a pending action/i); expect(contexts).to.equal(0);
      const mempoolProviders = { ...prepared.providers, fresh: (source: typeof prepared.source) => freshProviders(source, { latestNonce: 870, pendingNonce: 871 }, { latestNonce: 870, pendingNonce: 871 }) };
      await expect(runUsdcFreshSuccessorCli(prepared.resumeArgs, { environment: {}, providers: mempoolProviders, now: prepared.providers.now, createExecutionContext: async mode => { contexts++; expect(mode).to.equal("resume-one"); throw new Error("KEYLESS_CONTEXT"); } })).to.be.rejectedWith("KEYLESS_CONTEXT"); expect(contexts).to.equal(1);
      const resolvedProgress = { ...prepared.providers, fresh: (source: typeof prepared.source) => freshProviders(source, { latestNonce: 872, pendingNonce: 872 }, { latestNonce: 872, pendingNonce: 872 }) };
      await expect(runUsdcFreshSuccessorCli(prepared.resumeArgs, { environment: {}, providers: resolvedProgress, now: prepared.providers.now, createExecutionContext: async () => { contexts++; throw new Error("KEYLESS_RESOLVED_PROGRESS"); } })).to.be.rejectedWith("KEYLESS_RESOLVED_PROGRESS"); expect(contexts).to.equal(2);
      const unrelatedPending = { ...prepared.providers, fresh: (source: typeof prepared.source) => freshProviders(source, { latestNonce: 870, pendingNonce: 872 }, { latestNonce: 870, pendingNonce: 872 }) };
      await expect(runUsdcFreshSuccessorCli(prepared.resumeArgs, { environment: {}, providers: unrelatedPending, now: prepared.providers.now, createExecutionContext: async () => { contexts++; throw new Error("must not reach unrelated pending context"); } })).to.be.rejectedWith(/unresolved pending activity/i); expect(contexts).to.equal(2);
    } finally { prepared.cleanup(); }
  });

  it("production seams select only the fresh row and preserve exact observer bounds", async function () {
    const prepared = await prepare(); let selected = "", reads = 0;
    try { const inputs = await loadUsdcFreshSuccessorPublicInputs(parseUsdcFreshSuccessorCliArguments(prepared.submitArgs), prepared.providers); const fakeHarness = { current: {}, archive: {}, createLiveContext: async () => ({}), loadClosedPasskey: async () => { throw new Error("lazy"); }, loadClosedProofSigner: async () => { throw new Error("lazy"); } } as never; const deps = createUsdcFreshSuccessorProductionDependencies("/public/repository", prepared.submitArgs, { createHarness: () => fakeHarness, createStateReader: (() => async (action: any) => { reads++; selected = action.id; return { blockTimestamp: BigInt(inputs.certificate.snapshot.timestamp) } as never; }) as never, createExecutionContext: ((options: any) => { expect(options.receiverReadyAt).to.equal(new Date(Number(BigInt(inputs.successor.observer.readyAt)) * 1000).toISOString()); expect(options.receiverExpiresAt).to.equal(new Date(Number(BigInt(inputs.successor.observer.expiresAt)) * 1000).toISOString()); return {} as never; }) as never, now: prepared.providers.now }); await deps.publicPreflight!("submit-one", inputs); expect({ reads, selected }).to.deep.equal({ reads: 1, selected: "usdc-fresh-successor-prefund-all" }); await deps.createExecutionContext!("submit-one", inputs, () => inputs.source.prior.journal); } finally { prepared.cleanup(); }
  });
});
