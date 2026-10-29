import { expect } from "chai";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, parseTransaction, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sha256 } from "../../../scripts/plan-deployment";
import { liveIntentHash } from "../../../scripts/live/submission";
import { createOrdinaryScenarioStore, createUsdcSuccessorExecutionView } from "../../../scripts/live/ordinary-scenario-executor";
import { createUsdcSuccessorProposal } from "../../../scripts/live/ordinary-scenario-usdc-successor-proposal";
import { serializeUsdcSuccessorCertificate } from "../../../scripts/live/ordinary-scenario-usdc-successor-certificate";
import {
  USDC_SUCCESSOR_COMMANDS,
  createUsdcSuccessorEvidenceProvider,
  createUsdcSuccessorProductionDependencies,
  createUsdcSuccessorObserverBinding,
  loadUsdcSuccessorPublicInputs,
  main,
  parseUsdcSuccessorCliArguments,
  runUsdcSuccessorCli,
  runUsdcSuccessorEntryPoint,
} from "../../../scripts/live/ordinary-scenario-usdc-successor-cli";
import {
  createUsdcSuccessorFixture,
  oldUsdcRecoveryProvider,
  usdcSuccessorFixture,
  usdcSuccessorProvider,
} from "../../support/usdc-successor-fixture";

const originalPackageHash = "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571";
const originalArtifactHash = "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831";
const originalProposalHash = "0x22770c7944ee289543c10090b3483bdcd87f0d2c193887df4f32916c5782e45f";
const recoveryCertificateHash = "0x43742e96deb6855d1b2e86b268080892c700f453ffd36da4284de3ec2d252efc";
const recoveryApprovalHash = "0x644bf0b6e9cd4710683717511db665684ff31a86107198282d2364c9816dee26";
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;

function approvalDocument(proposal: ReturnType<typeof createUsdcSuccessorProposal>) {
  return { schemaVersion: 1, scope: "ordinary-usdc-period-successor-v1", authorization: "STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION", authorityEvidenceHash: proposal.authorityEvidenceHash, proposalHash: proposal.proposalHash, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, snapshot: proposal.snapshot, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, observer: proposal.observer, schedule: proposal.schedule, groups: proposal.groups, caps: proposal.caps, reservation: proposal.reservation, maxBroadcastAttempts: 1, approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
}

function observerProofs(directory: string) {
  const endpointHash = `0x${"11".repeat(32)}`;
  const startupPath = join(directory, "observer-startup.json");
  const probePath = join(directory, "observer-probe.json");
  const startup = `${JSON.stringify({ schemaVersion: 1, scope: "USDC_SUCCESSOR_OBSERVER_STARTUP_V1", publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startedAt: "2026-10-29T00:00:00Z", expiresAt: "2026-10-30T00:00:00Z", signing: false, broadcast: false })}\n`;
  writeFileSync(startupPath, startup);
  const startupEvidenceHash = `0x${createHash("sha256").update(startup).digest("hex")}`;
  writeFileSync(probePath, `${JSON.stringify({ schemaVersion: 1, scope: "USDC_SUCCESSOR_OBSERVER_PROBE_V1", publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startupEvidenceHash, probedAt: "2026-10-29T00:00:50Z", expiresAt: "2026-10-30T00:00:00Z", delivery: "DELIVERED", acknowledgement: "ACKNOWLEDGED", signing: false, broadcast: false })}\n`);
  return { startupPath, probePath };
}

async function prepare() {
  const fixture = await createUsdcSuccessorFixture();
  const directory = mkdtempSync(join(tmpdir(), "usdc-successor-cli-"));
  const write = (name: string, value: string) => { const path = join(directory, name); writeFileSync(path, value); return path; };
  const sourceJournal = write("journal.json", usdcSuccessorFixture.sourceJournal);
  const originalReport = join(__dirname, "../../fixtures/ordinary-scenario-review.public.json");
  const recoveryCertificate = write("recovery-certificate.json", usdcSuccessorFixture.recoveryCertificate);
  const recoveryProposal = write("recovery-proposal.json", usdcSuccessorFixture.recoveryProposal);
  const recoveryApproval = write("recovery-approval.json", usdcSuccessorFixture.recoveryApproval);
  const primaryManifest = write("manifest.json", usdcSuccessorFixture.primary.manifest);
  write("ledger-source-native-item2.json", usdcSuccessorFixture.primary.ledgerSourceNativeItem2);
  write("ledger-replacement-native-item3.json", usdcSuccessorFixture.primary.ledgerReplacementNativeItem3);
  write("ack-native-queue-ready-hashless-skip.json", usdcSuccessorFixture.primary.ackNativeQueueReadyHashlessSkip);
  write("ack-native-queue-ready-replacement.json", usdcSuccessorFixture.primary.ackNativeQueueReadyReplacement);
  write("ack-native-queue-ready-replacement-execute.json", usdcSuccessorFixture.primary.ackNativeQueueReadyReplacementExecute);
  const proofs = observerProofs(directory);
  const observer = createUsdcSuccessorObserverBinding(readFileSync(proofs.startupPath, "utf8"), readFileSync(proofs.probePath, "utf8"), new Date("2026-10-29T00:00:50Z"));
  const proposal = createUsdcSuccessorProposal({ source: fixture.source, certificate: fixture.certificate, observer, caps });
  const proposalPath = write("successor-proposal.json", `${JSON.stringify(proposal)}\n`);
  const approval = approvalDocument(proposal); const approvalHash = sha256(approval) as Hex;
  const approvalPath = write("successor-approval.json", `${JSON.stringify(approval)}\n`);
  const certificatePath = write("successor-certificate.json", serializeUsdcSuccessorCertificate(fixture.certificate));
  const common = ["--source-journal", sourceJournal, "--original-report", originalReport, "--original-package-hash", originalPackageHash, "--original-artifact-hash", originalArtifactHash, "--original-proposal-hash", originalProposalHash, "--recovery-certificate", recoveryCertificate, "--recovery-certificate-hash", recoveryCertificateHash, "--recovery-proposal", recoveryProposal, "--recovery-approval", recoveryApproval, "--recovery-approval-hash", recoveryApprovalHash, "--primary-bundle-manifest", primaryManifest];
  const reviewArgs = ["review", ...common, "--observer-startup", proofs.startupPath, "--observer-probe", proofs.probePath];
  const execution = [...common, "--successor-certificate", certificatePath, "--successor-certificate-hash", fixture.certificate.certificateHash, "--successor-proposal", proposalPath, "--successor-approval", approvalPath, "--successor-approval-hash", approvalHash, "--journal", sourceJournal];
  const providers = { recovery: [oldUsdcRecoveryProvider(), oldUsdcRecoveryProvider()] as const, successor: (source: typeof fixture.source) => [usdcSuccessorProvider(0, source), usdcSuccessorProvider(1, source)] as const, now: () => new Date("2026-10-29T00:00:50Z") };
  return { fixture, directory, sourceJournal, proposal, providers, reviewArgs, submitArgs: ["submit-one", ...execution], resumeArgs: ["resume-one", ...execution], cleanup: () => { fixture.cleanup(); rmSync(directory, { recursive: true, force: true }); } };
}

describe("ordinary USDC successor CLI", function () {
  it("has one closed command and flag parser plus the actual 11640-second observer schedule", function () {
    expect(USDC_SUCCESSOR_COMMANDS).to.deep.equal(["review", "submit-one", "resume-one"]);
    expect(() => parseUsdcSuccessorCliArguments(["review", "--rpc", "https://private.invalid"])).to.throw(/unknown|malformed|flag/i);
    const directory = mkdtempSync(join(tmpdir(), "usdc-observer-"));
    try {
      const proof = observerProofs(directory);
      const binding = createUsdcSuccessorObserverBinding(readFileSync(proof.startupPath, "utf8"), readFileSync(proof.probePath, "utf8"), new Date("2026-10-29T00:00:50Z"));
      expect(binding.workflowScheduleSeconds).to.deep.equal({ review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" });
      expect(BigInt(binding.requiredThrough) - BigInt(binding.readyAt)).to.equal(11_640n);
      expect(binding.readyAt).not.to.equal(""); expect(binding.expiresAt).not.to.equal("");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reconstructs exact public lineage and emits a reproducible unsigned 19-action review", async function () {
    const prepared = await prepare(); let privateLoads = 0;
    try {
      const args = parseUsdcSuccessorCliArguments(prepared.reviewArgs);
      const inputs = await loadUsdcSuccessorPublicInputs(args, prepared.providers);
      expect(inputs.successor.actions).to.have.length(19); expect(inputs.approval).to.equal(undefined);
      const result = await runUsdcSuccessorCli(prepared.reviewArgs, { environment: {}, providers: prepared.providers, now: () => new Date("2026-10-29T00:00:50Z"), createExecutionContext: async () => { privateLoads++; throw new Error("private"); } });
      expect(result).to.include({ scope: "ORDINARY_USDC_SUCCESSOR_UNSIGNED_REVIEW_V1", authorization: "NONE", actionCount: 19, signing: false, broadcast: false });
      expect(JSON.stringify(result)).not.to.match(/https:\/\/|credential|private/i); expect(privateLoads).to.equal(0);
    } finally { prepared.cleanup(); }
  });

  it("reconstructs canonical legacy and type-2 senders instead of trusting RPC from", async function () {
    const prepared = await prepare();
    try {
      const legacyFixture = JSON.parse(readFileSync(join(__dirname, "../../fixtures/ordinary-hashless/canonical-public-legacy-nonce809.json"), "utf8")).transaction;
      const legacy = { type: "legacy" as const, chainId: Number(BigInt(legacyFixture.chainId)), nonce: Number(BigInt(legacyFixture.nonce)), gasPrice: BigInt(legacyFixture.gasPrice), gas: BigInt(legacyFixture.gas), to: legacyFixture.to as Address, value: BigInt(legacyFixture.value), input: legacyFixture.input as Hex, r: legacyFixture.r as Hex, s: legacyFixture.s as Hex, v: BigInt(legacyFixture.v), hash: legacyFixture.hash as Hex, blockHash: legacyFixture.blockHash as Hex, blockNumber: BigInt(legacyFixture.blockNumber), transactionIndex: Number(BigInt(legacyFixture.transactionIndex)) };
      const account = privateKeyToAccount(`0x${"12".repeat(32)}`);
      const raw = await account.signTransaction({ type: "eip1559", chainId: 11_155_111, nonce: 9, gas: 21_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 500_000n, to: prepared.fixture.source.original.recipient, value: 7n, data: "0x" });
      const parsed = parseTransaction(raw); const type2Hash = keccak256(raw);
      const type2 = { ...parsed, input: parsed.data ?? "0x", accessList: parsed.accessList ?? [], hash: type2Hash, blockHash: `0x${"ab".repeat(32)}` as Hex, blockNumber: 99n, transactionIndex: 0, from: account.address };
      const client = { getTransaction: async ({ hash }: { hash: Hex }) => hash === legacy.hash ? legacy : hash === type2Hash ? type2 : (() => { throw new Error("missing"); })() } as never;
      const provider = createUsdcSuccessorEvidenceProvider(client, prepared.fixture.source, { reconstructed: async () => { throw new Error("transaction reads must not require topology"); } });
      const recoveredLegacy = await provider.readTransaction(legacy.hash); expect(recoveredLegacy).to.include({ type: "legacy", from: prepared.fixture.source.original.funder, v: BigInt(legacyFixture.v) });
      const recoveredType2 = await provider.readTransaction(type2Hash); expect(recoveredType2).to.include({ type: "eip1559", from: account.address, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 500_000n });
      const poisoned = createUsdcSuccessorEvidenceProvider({ getTransaction: async () => ({ ...type2, from: prepared.fixture.source.original.recipient }) } as never, prepared.fixture.source, { reconstructed: async () => { throw new Error("unused"); } });
      expect(await poisoned.readTransaction(type2Hash)).to.equal(undefined);
    } finally { prepared.cleanup(); }
  });

  it("verifies the reconstructed topology at the pinned block and restores only the source-owned historical queue", async function () {
    const prepared = await prepare();
    try {
      const record = prepared.fixture.source.journal.hashlessContinuation!.actions[1] as any; const action = prepared.fixture.source.recovery.actions[1]!; const queue = action.queue!; const blockNumber = BigInt(record.receipt.blockNumber); const block = { number: blockNumber, hash: record.receipt.blockHash as Hex, timestamp: BigInt(record.queueCreatedAt) };
      let topologyChecks = 0; let blockReads = 0;
      const client = {
        getBlock: async () => { blockReads++; return block; }, getChainId: async () => 11_155_111, getBalance: async () => 1n,
        readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
          const original = prepared.fixture.source.original;
          if (address.toLowerCase() === original.safe.toLowerCase() && functionName === "nonce") return 8n;
          if (address.toLowerCase() === original.delay.toLowerCase() && functionName === "txNonce") return 3n;
          if (address.toLowerCase() === original.delay.toLowerCase() && functionName === "queueNonce") return 4n;
          if (address.toLowerCase() === original.delay.toLowerCase() && functionName === "getTxHash") return queue.fingerprint;
          if (address.toLowerCase() === original.delay.toLowerCase() && functionName === "getTxCreatedAt") return block.timestamp;
          if (address.toLowerCase() === original.usdc.toLowerCase() && functionName === "balanceOf") return String(args?.[0]).toLowerCase() === original.safe.toLowerCase() ? 20_000_000n : 0n;
          if (address.toLowerCase() === original.guard.toLowerCase() && functionName === "spendState") return String(args?.[0]) === "0x0000000000000000000000000000000000000000" ? [1_793_145_600n, 10_000_000_000_000n, 30_000_000_000_000n] : [0n, 0n, 0n];
          throw new Error(`unexpected controlled read ${functionName}`);
        },
      } as never;
      const provider = createUsdcSuccessorEvidenceProvider(client, prepared.fixture.source, { reconstructed: async () => ({}) as never, verifyAtBlock: async (_reconstructed, _client, selected) => { topologyChecks++; expect(selected).to.equal(blockNumber); return {} as never; } });
      const state = await provider.readControlledState(blockNumber);
      expect(topologyChecks).to.equal(1); expect(blockReads).to.equal(2); expect(state).to.include({ safeNonce: 8n, delayTxNonce: 3n, delayQueueNonce: 4n });
      expect(state.queue).to.deep.equal({ queueNonce: 3n, fingerprint: queue.fingerprint, createdAt: block.timestamp, to: queue.to, value: BigInt(queue.value), data: queue.data, operation: queue.operation });
      expect(state.nativeSpend).to.deep.equal({ window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n });
    } finally { prepared.cleanup(); }
  });

  it("holds the real store lease across an awaited deferred read and attaches before context", async function () {
    const prepared = await prepare(); let release!: () => void; let started!: () => void;
    const readStarted = new Promise<void>(resolve => { started = resolve; }); const deferred = new Promise<void>(resolve => { release = resolve; });
    try {
      const execution = runUsdcSuccessorCli(prepared.submitArgs, { environment: { LIVE_SUBMIT: "YES" }, providers: prepared.providers, now: () => new Date("2026-10-29T00:00:50Z"), publicPreflight: async () => undefined, createExecutionContext: async (_mode, inputs, journal) => {
        expect(journal().usdcSuccessor?.proposalHash).to.equal(inputs.successor.proposalHash);
        return {
          readState: async action => {
            started(); await deferred;
            const dependencies = action.dependsOn.map(id => {
              const record = [...journal().actions, ...journal().hashlessContinuation.actions].find(entry => entry.id === id && entry.status === "confirmed") as any;
              if (!record?.evidenceHash) throw new Error(`missing confirmed dependency ${id}`);
              return { actionId: id, transactionHash: record.transactionHash, blockHash: record.receipt?.blockHash, evidenceHash: record.evidenceHash };
            });
            const reviewed = action.before.queueFingerprint === null ? undefined : createUsdcSuccessorExecutionView(inputs.source, inputs.successor, inputs.approval).proposal.actions.find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce.toString() === action.before.queueNonce && candidate.queue.fingerprint === action.before.queueFingerprint);
            const queueRecord = reviewed && journal().hashlessContinuation.actions.find(entry => entry.id === reviewed.id && entry.status === "confirmed") as any;
            const queue = reviewed?.queue ? { queueNonce: reviewed.queue.queueNonce, fingerprint: reviewed.queue.fingerprint, createdAt: BigInt(queueRecord.queueCreatedAt), status: action.before.queueStatus === "EXECUTED_CONDITIONAL" ? "executed" as const : action.before.queueStatus === "EXPIRED_CONDITIONAL" ? "expired" as const : "queued" as const, to: reviewed.queue.to, value: reviewed.queue.value, data: reviewed.queue.data, operation: reviewed.queue.operation } : undefined;
            return { chainId: 11_155_111, blockNumber: BigInt(inputs.successor.snapshot.blockNumber), blockHash: inputs.successor.snapshot.blockHash, blockTimestamp: BigInt(inputs.successor.snapshot.timestamp), evidenceBasis: { kind: "current-head" as const }, planHash: inputs.source.original.planHash, topologyEvidenceHash: inputs.source.original.topologyEvidenceHash, publicIdentitiesHash: inputs.source.original.publicIdentitiesHash, observerReady: true, observerEvidenceHash: inputs.successor.observer.probeEvidenceHash, outerNonce: 900, funderNativeBalance: 10n ** 18n, safeNativeBalance: BigInt(action.before.safeNativeBalance), funderUsdcBalance: BigInt(action.before.funderUsdcBalance), safeUsdcBalance: BigInt(action.before.safeUsdcBalance), safeNonce: BigInt(action.before.safeNonce), delayQueueNonce: BigInt(action.before.delayQueueNonce), delayTxNonce: BigInt(action.before.delayTxNonce), nativeSpend: { window: 1_793_145_600n, baseSpent: BigInt(action.before.nativeBaseSpent), instantSpent: BigInt(action.before.nativeInstantSpent) }, usdcSpend: { window: 0n, baseSpent: BigInt(action.before.usdcBaseSpent), instantSpent: BigInt(action.before.usdcInstantSpent) }, queue, dependencies, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } };
          },
          materialize: async () => { throw new Error("LEASE_HELD_THROUGH_FIRST_MATERIALIZATION"); },
        } as never;
      } });
      await Promise.race([readStarted, execution.then(() => { throw new Error("execution settled before deferred read"); })]);
      const disk = JSON.parse(readFileSync(prepared.sourceJournal, "utf8"));
      expect(() => createOrdinaryScenarioStore(prepared.sourceJournal, { proposalHash: disk.proposalHash, approvalHash: disk.approvalHash, funder: disk.funder }, () => { throw new Error("existing journal required"); })).to.throw(/writer lock unavailable/);
      release(); await expect(execution).to.be.rejectedWith("LEASE_HELD_THROUGH_FIRST_MATERIALIZATION");
      const persisted = JSON.parse(readFileSync(prepared.sourceJournal, "utf8"));
      expect(persisted.usdcSuccessor.proposalHash).to.equal(prepared.proposal.proposalHash);
      expect(persisted.usdcSuccessor.actions[0].status).to.equal("materialized");
    } finally { release?.(); prepared.cleanup(); }
  });

  it("restores pinned public capabilities in a fresh process after its own legitimate attachment", async function () {
    const prepared = await prepare(); let contexts = 0;
    const dependencies = () => ({ environment: { LIVE_SUBMIT: "YES" }, providers: prepared.providers, now: () => new Date("2026-10-29T00:00:50Z"), publicPreflight: async () => undefined, createExecutionContext: async (_mode: unknown, inputs: any, journal: () => any) => { contexts++; expect(journal().usdcSuccessor.proposalHash).to.equal(inputs.successor.proposalHash); return { readState: async () => { throw new Error(`FRESH_PROCESS_CONTEXT_${contexts}`); } } as never; } });
    try {
      await expect(runUsdcSuccessorCli(prepared.submitArgs, dependencies())).to.be.rejectedWith("FRESH_PROCESS_CONTEXT_1");
      await expect(runUsdcSuccessorCli(prepared.submitArgs, dependencies())).to.be.rejectedWith("FRESH_PROCESS_CONTEXT_2");
      expect(contexts).to.equal(2);
    } finally { prepared.cleanup(); }
  });

  it("production composition forwards the explicit observer bounds and retains receipt poststate inspection", async function () {
    const prepared = await prepare(); let captured: any;
    try {
      const args = parseUsdcSuccessorCliArguments(prepared.submitArgs); const inputs = await loadUsdcSuccessorPublicInputs(args, prepared.providers);
      const inspectReceiptPostState = async () => ({}) as never;
      const fakeHarness = { current: {}, archive: {}, reconstructedProfile: async () => ({}), observerReadiness: async () => ({ ready: true, evidenceHash: inputs.successor.observer.probeEvidenceHash }), loadClosedPasskey: async () => { throw new Error("lazy signer must remain unloaded"); }, loadClosedProofSigner: async () => { throw new Error("unused"); }, createLiveContext: async () => ({}) } as never;
      const dependencies = createUsdcSuccessorProductionDependencies("/public/repository", prepared.submitArgs, { createHarness: () => fakeHarness, createExecutionContext: input => { captured = input; return { inspectReceiptPostState } as never; } });
      const context = await dependencies.createExecutionContext!("submit-one", inputs, () => inputs.source.journal);
      expect(context.inspectReceiptPostState).to.equal(inspectReceiptPostState);
      expect(captured.receiverReadyAt).to.equal(new Date(Number(BigInt(inputs.successor.observer.readyAt)) * 1000).toISOString());
      expect(captured.receiverExpiresAt).to.equal(new Date(Number(BigInt(inputs.successor.observer.expiresAt)) * 1000).toISOString());
      expect(captured.observerEndpointHash).to.equal(inputs.successor.observer.endpointHash);
    } finally { prepared.cleanup(); }
  });

  it("stops a fresh pending-nonce disagreement before action persistence or any private callback", async function () {
    const prepared = await prepare(); let materializations = 0, privateLoads = 0, signs = 0, broadcasts = 0;
    try {
      await expect(runUsdcSuccessorCli(prepared.submitArgs, {
        environment: { LIVE_SUBMIT: "YES" }, providers: prepared.providers, now: () => new Date("2026-10-29T00:00:50Z"), publicPreflight: async () => undefined,
        createExecutionContext: async () => ({
          readState: async () => { throw new Error("current funder latest/pending nonce disagreement"); },
          materialize: async () => { materializations++; privateLoads++; throw new Error("must not materialize"); },
          live: { funder: prepared.fixture.source.original.funder, chainId: async () => 11_155_111, nonce: async () => 901, balance: async () => 10n ** 18n, sign: async () => { signs++; throw new Error("must not sign"); }, broadcast: async () => { broadcasts++; throw new Error("must not broadcast"); }, receipt: async () => undefined },
        } as never),
      })).to.be.rejectedWith("latest/pending nonce disagreement");
      const persisted = JSON.parse(readFileSync(prepared.sourceJournal, "utf8"));
      expect(persisted.usdcSuccessor.actions[0].status).to.equal("approved");
      expect({ materializations, privateLoads, signs, broadcasts }).to.deep.equal({ materializations: 0, privateLoads: 0, signs: 0, broadcasts: 0 });
    } finally { prepared.cleanup(); }
  });

  it("resume-one rejects private environment and the entrypoint emits only a static failure", async function () {
    const prepared = await prepare(); const canary = "UPSTREAM_SECRET_https://secret.invalid/private-key"; let stderr = ""; let stdout = ""; let exitCode = 0;
    try {
      await expect(runUsdcSuccessorCli(prepared.resumeArgs, { environment: { LIVE_PRIMARY_CREDENTIAL_FILE: "/private" }, providers: prepared.providers })).to.be.rejectedWith(/private|authority/i);
      const task = main(prepared.submitArgs, { dependencies: { environment: { LIVE_SUBMIT: "YES" }, providers: prepared.providers, now: () => new Date("2026-10-29T00:00:50Z"), publicPreflight: async () => { throw new Error(canary); } }, writeStdout: value => { stdout += value; } });
      await runUsdcSuccessorEntryPoint(task, { writeStderr: value => { stderr += value; }, setExitCode: value => { exitCode = value; } });
      expect(exitCode).to.equal(1); expect(stdout).to.equal(""); expect(stderr).to.equal("[ORDINARY_USDC_SUCCESSOR_FAILED] ordinary USDC successor failed\n"); expect(`${stdout}${stderr}${readFileSync(prepared.sourceJournal, "utf8")}`).not.to.include(canary);
    } finally { prepared.cleanup(); }
  });

  it("resume-one restores exactly one known hash keylessly after expiry without public submission gates", async function () {
    const prepared = await prepare();
    try {
      await expect(runUsdcSuccessorCli(prepared.submitArgs, { environment: { LIVE_SUBMIT: "YES" }, providers: prepared.providers, now: () => new Date("2026-10-29T00:00:50Z"), publicPreflight: async () => undefined, createExecutionContext: async () => { throw new Error("ATTACHED_FOR_RESUME"); } })).to.be.rejectedWith("ATTACHED_FOR_RESUME");
      const disk = JSON.parse(readFileSync(prepared.sourceJournal, "utf8")); const action = prepared.proposal.actions[0]!; const transactionHash = `0x${"44".repeat(32)}` as Hex;
      const intent = { id: action.id, to: prepared.fixture.source.original.safe, value: 0n, data: "0x1234" as Hex, nonce: 831, gas: 2_000_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n };
      const facts = { proposalHash: prepared.proposal.proposalHash, actionCommitment: action.commitment, outerNonce: intent.nonce, gas: intent.gas.toString(), gasEstimate: "1", maxFeePerGas: intent.maxFeePerGas.toString(), maxPriorityFeePerGas: intent.maxPriorityFeePerGas.toString(), pinnedBlockNumber: prepared.fixture.certificate.snapshot.block.number.toString(), pinnedBlockHash: prepared.fixture.certificate.snapshot.block.hash, approvedContinuationReservationWei: prepared.proposal.reservation.successorMaximumReservationWei, remainingReservationWei: prepared.proposal.reservation.successorMaximumReservationWei };
      disk.usdcSuccessor.actions[0] = { id: action.id, commitment: action.commitment, status: "outer-pending", materializationHash: `0x${"99".repeat(32)}`, finalOuterMaterialization: { hash: sha256(facts), ...facts }, prestateHash: `0x${"88".repeat(32)}`, outerNonce: intent.nonce, gas: intent.gas.toString(), maxFeePerGas: intent.maxFeePerGas.toString(), maxPriorityFeePerGas: intent.maxPriorityFeePerGas.toString(), requestHash: action.commitment, signatureBundleHash: `0x${"66".repeat(32)}`, signedCalldataHash: keccak256(intent.data), simulationEvidenceHash: `0x${"77".repeat(32)}`, intentHash: liveIntentHash(intent, disk.funder), transactionHash, outerTo: intent.to, outerValue: "0", outerDataHash: keccak256(intent.data), funderNativeBefore: (10n ** 18n).toString() };
      disk.liveJournal.entries.push({ id: action.id, intentHash: liveIntentHash(intent, disk.funder), transactionHash, nonce: intent.nonce, reserved: (intent.gas * intent.maxFeePerGas).toString(), status: "pending" }); writeFileSync(prepared.sourceJournal, `${JSON.stringify(disk)}\n`);
      let contexts = 0;
      await expect(runUsdcSuccessorCli(prepared.resumeArgs, { environment: {}, providers: prepared.providers, now: () => new Date(Number((BigInt(prepared.proposal.deadline) + 10n) * 1000n)), publicPreflight: async () => { throw new Error("resume must not run fresh submission preflight"); }, createExecutionContext: async (mode, _inputs, journal) => { contexts++; expect(mode).to.equal("resume-one"); expect(journal().usdcSuccessor!.actions.filter(entry => entry.status === "outer-pending")).to.have.length(1); throw new Error("KEYLESS_KNOWN_HASH_CONTEXT"); } })).to.be.rejectedWith("KEYLESS_KNOWN_HASH_CONTEXT");
      expect(contexts).to.equal(1);
    } finally { prepared.cleanup(); }
  });
});
