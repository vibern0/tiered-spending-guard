import { expect } from "chai";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, custom, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
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
import { buildOrdinaryReviewPolicyDraft, readOrdinaryReviewConfig } from "../../../scripts/live/ordinary-review-profile";
import { policyHash } from "../../../src/topology/build";
import { createRepairProductionAdapter } from "../../../scripts/live/ordinary-scenario-repair-adapter";
import { createRepairCommandRuntime, runRepairCommand } from "../../../scripts/live/ordinary-scenario-repair-session";
import { PRODUCTION_REPAIR_EXECUTION_DOMAIN } from "../../../scripts/live/ordinary-scenario-repair";
import { createOrdinaryScenarioStore, PRODUCTION_ORDINARY_SCENARIO_DOMAIN } from "../../../scripts/live/ordinary-scenario-executor";
import { reconstructReviewedPlan } from "../../../scripts/live/ordinary-scenario-review-cli";
import { successorReceiptInclusion } from "../../support/usdc-successor-fixture";
import { attachUsdcRecycleContinuation } from "../../../scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal";

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

function createDefaultCompositionHarness(prepared: Awaited<ReturnType<typeof preparePublicCli>>, counters: { codeFailures: number; signs: number; broadcasts: number; simulations: number }, simulatePinnedFailure = true, repairState?: { rotated: boolean }) {
  const runtimes = (JSON.parse(readFileSync(join(fixtureDirectory, "ordinary-usdc-recycle-continuation-runtimes.public.json"), "utf8")) as { runtimes: Record<string, { bytecode: Hex }> }).runtimes;
  const runtime = (address: Address) => runtimes[address.toLowerCase()]?.bytecode;
  const original = prepared.authorized.source.prior.original, action = prepared.authorized.proposal.actions[0]!, before = action.before;
  const config = readOrdinaryReviewConfig(join(__dirname, "../../../config/sepolia.ordinary-review.json"));
  const reviewedPolicy = { ...buildOrdinaryReviewPolicyDraft(config, 673n), safe: original.safe };
  const bindings = JSON.parse(readFileSync(join(__dirname, "../../../../../.superpowers/sdd/2026-10-19-native-safe-4337/safe-creation-2026-10-27/public-passkey-bindings.json"), "utf8"));
  const safeProxyArtifact = JSON.parse(readFileSync(join(__dirname, "../../../node_modules/@safe-global/safe-smart-account/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json"), "utf8"));
  const maintenance = "0x3d20c6c361bdb1970827c9450beec0e3cd78e654" as Address, safeSingleton = "0xff51a5898e281db6dfc7855790607438df2ca44b" as Address;
  const zero = "0x0000000000000000000000000000000000000000" as Address, sentinel = "0x0000000000000000000000000000000000000001" as Address;
  const queueAction = prepared.authorized.source.prior.recovery.actions.find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.fingerprint === before.queueFingerprint)!;
  const queueRecord = prepared.authorized.source.prior.journal.hashlessContinuation!.actions.find(candidate => candidate.id === queueAction.id)! as any;
  const blocks = new Map<bigint, Hex>([[BigInt(prepared.authorized.certificate.snapshot.blockNumber), prepared.authorized.certificate.snapshot.blockHash]]);
  for (const section of [prepared.authorized.source.prior.journal.hashlessContinuation!.actions, prepared.authorized.source.prior.journal.usdcSuccessor!.actions]) for (const row of section as any[]) if (row.receipt) blocks.set(BigInt(row.receipt.blockNumber), row.receipt.blockHash);
  const dependencyReceipt = (prepared.authorized.source.prior.journal.usdcSuccessor!.actions.find(candidate => candidate.id === action.dependsOn[0]) as any).receipt;
  const makeClient = () => {
    const terminalRepairState = repairState !== undefined;
    let failPinned = true, creationCalls = 0;
    const client: any = {
      getBytecode: async ({ address, blockNumber }: { address: Address; blockNumber?: bigint }) => { if (simulatePinnedFailure && blockNumber !== undefined && failPinned) { failPinned = false; counters.codeFailures++; throw Object.assign(new Error("historical state unavailable"), { code: -32001 }); } return repairState?.rotated && address.toLowerCase() === PRODUCTION_REPAIR_EXECUTION_DOMAIN.candidate.toLowerCase() ? runtime(original.primarySigner) : runtime(address); },
      getCode: async ({ address, blockNumber }: { address: Address; blockNumber?: bigint }) => { if (simulatePinnedFailure && blockNumber !== undefined && failPinned) { failPinned = false; counters.codeFailures++; throw Object.assign(new Error("historical state unavailable"), { code: -32001 }); } return repairState?.rotated && address.toLowerCase() === PRODUCTION_REPAIR_EXECUTION_DOMAIN.candidate.toLowerCase() ? runtime(original.primarySigner) : runtime(address); },
      getChainId: async () => sepolia.id,
      getTransactionCount: async ({ blockNumber }: { blockNumber?: bigint }) => blockNumber !== undefined && blockNumber <= 11_986_637n ? 673 : prepared.authorized.proposal.minimumOuterNonce,
      getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => { const number = blockNumber === undefined ? BigInt(prepared.authorized.certificate.snapshot.blockNumber) : BigInt(blockNumber); const hash = number === BigInt(dependencyReceipt.blockNumber) ? dependencyReceipt.blockHash : blocks.get(number) ?? prepared.authorized.certificate.snapshot.blockHash; return { number, hash, timestamp: BigInt(prepared.authorized.certificate.snapshot.timestamp), baseFeePerGas: 0n }; },
      getBalance: async ({ address }: { address: Address }) => address.toLowerCase() === original.safe.toLowerCase() ? (terminalRepairState ? 0n : BigInt(before.safeNativeBalance)) : 10n ** 18n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      estimateGas: async () => 100_000n,
      getStorageAt: async ({ slot }: { slot: Hex }) => slot.toLowerCase() === "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" ? `0x${"0".repeat(64)}` : `0x${"0".repeat(24)}${original.guard.slice(2).toLowerCase()}`,
      call: async (input: { to?: Address }) => { if (!input.to) { const addresses = ["0xc3ba1567fb0e5961e9e4fd72f88b2ac3318360a3", original.guard, original.delay, maintenance, original.safe] as Address[]; return { data: runtime(addresses[creationCalls++ % 5]!) }; } counters.simulations++; return { data: encodeAbiParameters([{ type: "bool" }], [true]) }; },
      readContract: async ({ address, functionName, args = [] }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        const lower = address.toLowerCase(), token = String(args[0] ?? "").toLowerCase();
        if (functionName === "getSigner") return BigInt(String(args[0])) === 10342510752483659319190807637330965811978365685423845568184481734592673940696n ? PRODUCTION_REPAIR_EXECUTION_DOMAIN.candidate : BigInt(String(args[0])) === BigInt(bindings.primary.x) ? original.primarySigner : original.safeContractSecondary;
        if (functionName === "proxyCreationCode") return safeProxyArtifact.bytecode as Hex;
        if (functionName === "config") return [original.safe, original.primarySigner, original.ecdsaSecondary, original.delay, 86_400n, 0n];
        if (functionName === "safeContractSecondary") return [repairState?.rotated ? PRODUCTION_REPAIR_EXECUTION_DOMAIN.candidate : original.safeContractSecondary, 0, true];
        if (functionName === "ecdsaSecondary") return [original.ecdsaSecondary, 1, true];
        if (functionName === "maintenance") return maintenance;
        if (functionName === "maintenanceAddress") return maintenance;
        if (functionName === "safe") return original.safe;
        if (functionName === "delay") return original.delay;
        if (["owner", "avatar", "target"].includes(functionName)) return original.safe;
        if (functionName === "txCooldown") return 120n;
        if (functionName === "txExpiration") return 600n;
        if (functionName === "masterCopy") return safeSingleton;
        if (functionName === "VERSION") return "1.5.0";
        if (functionName === "getOwners") return [original.primarySigner];
        if (functionName === "getThreshold") return 1n;
        if (functionName === "getModulesPaginated") return [[lower === original.safe.toLowerCase() ? original.delay : original.safe], sentinel];
        if (functionName === "policyHash") return repairState?.rotated ? PRODUCTION_REPAIR_EXECUTION_DOMAIN.afterPolicyHash : policyHash(reviewedPolicy);
        if (functionName === "getConfiguredTokens") return [zero, original.usdc];
        if (functionName === "assetPolicy") return token === zero ? [10_000_000_000_000n, 30_000_000_000_000n, 10_000_000_000_000n, 30_000_000_000_000n] : [10_000_000n, 30_000_000n, 10_000_000n, 30_000_000n];
        if (functionName === "getPolicyRecipients") return [original.funder];
        if (functionName === "spendState") return token === zero ? [1_793_145_600n, 10_000_000_000_000n, 30_000_000_000_000n] : [BigInt(prepared.authorized.proposal.effectivePeriod), 10_000_000n, terminalRepairState ? 20_000_000n : BigInt(before.usdcInstantSpent)];
        if (functionName === "balanceOf") return token === original.safe.toLowerCase() ? (terminalRepairState ? 20_000_000n : BigInt(before.safeUsdcBalance)) : BigInt(before.funderUsdcBalance);
        if (functionName === "nonce") return repairState?.rotated ? 16n : terminalRepairState ? 15n : BigInt(before.safeNonce);
        if (functionName === "queueNonce") return repairState?.rotated ? 8n : terminalRepairState ? 7n : BigInt(before.delayQueueNonce);
        if (functionName === "txNonce") return repairState?.rotated ? 8n : terminalRepairState ? 7n : BigInt(before.delayTxNonce);
        if (functionName === "frozen") return false;
        if (functionName === "getTxHash") return before.queueFingerprint;
        if (functionName === "getTxCreatedAt") return BigInt(queueRecord.queueCreatedAt);
        throw new Error(`unhandled read ${functionName} at ${address}`);
      },
      getTransaction: async () => { throw new Error("no pending hash exists at the controlled signing boundary"); },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const journal = JSON.parse(readFileSync(prepared.tracked.path, "utf8"));
        const rows = [...journal.actions, ...journal.hashlessContinuation.actions, ...journal.usdcSuccessor.actions, ...(journal.usdcRecycleContinuation?.actions ?? [])];
        const row = rows.find((candidate: any) => candidate.transactionHash === hash);
        if (!row?.receipt) throw new Error("controlled public receipt is unavailable");
        return { ...row.receipt, gasUsed: BigInt(row.receipt.gasUsed), effectiveGasPrice: BigInt(row.receipt.effectiveGasPrice), blockNumber: BigInt(row.receipt.blockNumber) };
      },
    };
    return client;
  };
  const current = makeClient(), archive = makeClient();
  return { current, archive, reconstructedProfile: async () => { throw new Error("unused harness reconstruction"); }, observerReadiness: async () => ({ ready: true, evidenceHash: prepared.authorized.proposal.observer.probeEvidenceHash }), loadClosedPasskey: async () => { throw new Error("funding action does not load a passkey"); }, loadClosedProofSigner: async () => { throw new Error("funding action does not load a proof signer"); }, createLiveContext: async () => ({ funder: original.funder, chainId: async () => sepolia.id, nonce: async () => prepared.authorized.proposal.minimumOuterNonce, balance: async () => 10n ** 18n, sign: async () => { counters.signs++; throw new Error("controlled fixture has no Sepolia funder key"); }, broadcast: async () => { counters.broadcasts++; throw new Error("must not broadcast without the reviewed funder signature"); }, receipt: async (hash: Hex) => { const prior = prepared.authorized.source.prior.journal.liveJournal.entries.find(entry => entry.transactionHash === hash)?.receipt; return prior && { ...prior, gasUsed: BigInt(prior.gasUsed), effectiveGasPrice: BigInt(prior.effectiveGasPrice), blockNumber: BigInt(prior.blockNumber) }; } }) } as any;
}

describe("ordinary USDC recycle continuation CLI", function () {
  this.timeout(30_000);
  it("exposes only review, submit-one, and resume-one with a closed parser", function () {
    expect(USDC_RECYCLE_CONTINUATION_COMMANDS).to.deep.equal(["review", "submit-one", "resume-one"]);
    expect(parseUsdcRecycleContinuationCliArguments(["review", "--source-journal", "/public/source"])).to.include({ command: "review" });
    expect(() => parseUsdcRecycleContinuationCliArguments(["review", "--rpc", "https://override.invalid"])).to.throw(/malformed|flag/i);
  });

  it("pins the vetted public runtime fixture without credential-shaped content", function () {
    const raw = readFileSync(join(fixtureDirectory, "ordinary-usdc-recycle-continuation-runtimes.public.json"), "utf8");
    expect(createHash("sha256").update(raw).digest("hex")).to.equal("d7862bf4affbda4baa0848b999b5d6770a965acc08b6c383e71ed7e1104ab115");
    const fixture = JSON.parse(raw) as { runtimes: Record<string, { runtimeHash: Hex; bytecode: Hex }> };
    expect(Object.keys(fixture.runtimes)).to.have.length(12);
    for (const entry of Object.values(fixture.runtimes)) expect(entry.runtimeHash).to.equal(keccak256(entry.bytecode));
    expect(raw).not.to.match(/private[_ -]?key|mnemonic|seed phrase|secret[_ -]?key/i);
  });

  it("pins the vetted Zodiac Delay source bytes without credential-shaped content", function () {
    const raw = readFileSync(join(fixtureDirectory, "ordinary-usdc-recycle-continuation-delay-mastercopies.public.json"), "utf8");
    expect(createHash("sha256").update(raw).digest("hex")).to.equal("ad367f67b4c8b691d93417ecd740eeefc9abfff50a789469ba5899c0b5aa9201");
    expect(raw).not.to.match(/private[_ -]?key|mnemonic|seed phrase|secret[_ -]?key/i);
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

  it("applies the same single eth_getCode budget to viem's wrapped custom-RPC failure", async function () {
    const calls: Array<{ method: string; params?: unknown }> = []; const waits: number[] = [];
    const publicClient = createPublicClient({ chain: sepolia, transport: custom({ request: async request => { calls.push(request); if (calls.length === 1) throw { code: -32001, message: "historical state unavailable" }; return "0x6000"; } }) });
    const client = withOnePinnedGetCodeRetry(publicClient, async milliseconds => { waits.push(milliseconds); });
    expect(await client.getBytecode({ address: "0x0000000000000000000000000000000000000001", blockNumber: 99n })).to.equal("0x6000");
    expect(calls).to.have.length(2); expect(calls[0]).to.deep.equal(calls[1]); expect(calls[0]?.method).to.equal("eth_getCode"); expect(waits).to.deep.equal([250]);
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
      writeFileSync(prepared.tracked.path, `${JSON.stringify(mutated)}\n`);
      expect(() => adoptHashlessSourceJournalReadOnlySnapshot(prepared.tracked.path, mutated)).to.throw(/shape mismatch/);
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

  it("runs the actual default reader and context to one fail-closed funder-signing boundary", async function () {
    const prepared = await preparePublicCli();
    const counters = { codeFailures: 0, signs: 0, broadcasts: 0, simulations: 0 };
    const delaySource = readFileSync(join(fixtureDirectory, "ordinary-usdc-recycle-continuation-delay-mastercopies.public.json"), "utf8"), savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(delaySource, { status: 200 })) as typeof fetch;
    const dependencies = (argv: readonly string[], environment: Record<string, string>) => {
      const harness = createDefaultCompositionHarness(prepared, counters);
      const production = createUsdcRecycleContinuationProductionDependencies(join(__dirname, "../../../../.."), argv, { createHarness: () => harness, wait: async () => undefined, now: prepared.providers.now });
      return { ...production, environment, providers: prepared.providers, now: prepared.providers.now };
    };
    try {
      await expect(runUsdcRecycleContinuationCli(prepared.submitArgs, dependencies(prepared.submitArgs, { LIVE_SUBMIT: "YES" }))).to.be.rejectedWith("local transaction signing failed");
      expect(counters).to.deep.equal({ codeFailures: 2, signs: 1, broadcasts: 0, simulations: 1 });
      const after = JSON.parse(readFileSync(prepared.tracked.path, "utf8"));
      expect(after.usdcRecycleContinuation.actions[0].status).to.equal("signed-simulated"); expect(after.usdcRecycleContinuation.actions[0].finalOuterMaterialization).to.be.an("object");
      expect(after.usdcSuccessor.actions[2].status).to.equal("signed-simulated"); expect(after.liveJournal.entries).to.have.length(15);
    } finally { globalThis.fetch = savedFetch; prepared.cleanup(); }
  });

  it("composes the actual recycle loader, production repair adapter, and atomic store", async function () {
    const prepared = await preparePublicCli();
    const counters = { codeFailures: 0, signs: 0, broadcasts: 0, simulations: 0 };
    const delaySource = readFileSync(join(fixtureDirectory, "ordinary-usdc-recycle-continuation-delay-mastercopies.public.json"), "utf8"), savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(delaySource, { status: 200 })) as typeof fetch;
    try {
      const inputs = await loadUsdcRecycleContinuationPublicInputs(parseUsdcRecycleContinuationCliArguments(prepared.submitArgs), prepared.providers);
      if (!inputs.approval) throw new Error("approved recycle fixture required");
      const journal = structuredClone(attachUsdcRecycleContinuation(inputs.source.prior.journal, inputs.continuation, inputs.approval)) as any;
      const records = inputs.continuation.actions.map((action, index) => {
        const confirmed = action.expectedOutcome === "success", transactionHash = `0x${(0x500 + index).toString(16).padStart(64, "0")}` as Hex;
        const receipt = { transactionHash, status: "success" as const, gasUsed: 20n + BigInt(index), effectiveGasPrice: 11n, blockNumber: 12_019_500n + BigInt(index), blockHash: `0x${(0x600 + index).toString(16).padStart(64, "0")}` as Hex };
        return { id: action.id, commitment: action.commitment, status: confirmed ? "confirmed" as const : "rejection-proved" as const, evidenceHash: `0x${(0x700 + index).toString(16).padStart(64, "0")}` as Hex, ...(confirmed ? { intentHash: `0x${(0x800 + index).toString(16).padStart(64, "0")}` as Hex, transactionHash, receipt, receiptInclusion: successorReceiptInclusion(receipt, inputs.continuation.effectivePeriod, 120n + BigInt(index)), outerValue: "0", ourReceiptGasCost: (receipt.gasUsed * receipt.effectiveGasPrice).toString(), ourPrincipalDelta: "0" } : {}) };
      });
      journal.usdcRecycleContinuation.actions.splice(0, records.length, ...records);
      journal.liveJournal.entries.push(...records.filter(record => record.status === "confirmed").map((record: any, index) => ({ id: record.id, intentHash: record.intentHash, transactionHash: record.transactionHash, nonce: 900 + index, reserved: BigInt(record.ourReceiptGasCost), status: "success", receipt: record.receipt })));
      writeFileSync(prepared.tracked.path, `${JSON.stringify(journal, (_key, value) => typeof value === "bigint" ? value.toString() : value)}\n`);

      const repository = join(__dirname, "../../../../..");
      const repairState = { rotated: false };
      const harness = createDefaultCompositionHarness(prepared, counters, false, repairState);
      let reconstruction: Awaited<ReturnType<typeof reconstructReviewedPlan>> | undefined;
      const productionHarness = { ...harness, reconstructedProfile: async () => reconstruction ??= await reconstructReviewedPlan(repository, harness.archive) } as any;
      const flagValue = (flag: string) => { const index = prepared.submitArgs.indexOf(flag as any); if (index < 0) throw new Error(`missing ${flag}`); return prepared.submitArgs[index + 1]!; };
      const lineageFlags = ["--recovery-certificate", "--recovery-certificate-hash", "--recovery-proposal", "--recovery-approval", "--recovery-approval-hash", "--primary-bundle-manifest", "--successor-certificate", "--successor-certificate-hash", "--successor-proposal", "--successor-approval", "--successor-approval-hash", "--source-manifest", "--source-step-up-ledger", "--source-step-up-ack", "--recycle-certificate", "--recycle-certificate-hash", "--recycle-proposal", "--recycle-approval", "--recycle-approval-hash"].flatMap(flag => [flag, flagValue(flag)]);
      const args = ["--report", flagValue("--original-report"), "--artifact-hash", flagValue("--original-artifact-hash"), "--package-hash", flagValue("--original-package-hash"), "--proposal-hash", flagValue("--original-proposal-hash"), "--original-approval-hash", journal.approvalHash, "--journal", prepared.tracked.path, ...lineageFlags];
      const quote = { chainId: 11155111, factory: PRODUCTION_REPAIR_EXECUTION_DOMAIN.factory, candidate: PRODUCTION_REPAIR_EXECUTION_DOMAIN.candidate, x: 10342510752483659319190807637330965811978365685423845568184481734592673940696n, y: 83007955684183101275699917860538633816962061613045139387258186696967867907135n, verifiers: 1111636484949241205398856388087597953580887526884n, calldata: "0x0d2f048916dda754f7752e800b62ed684f89fb19d607485fbb8b9b77f5d877e4903904d8b784d685cc3013eab599b6d9696b06414ca74554ec8de222b6cdc43de410bc3f000000000000000000000000c2b78104907f722dabac4c69f826a522b2754de4" as Hex, calldataHash: "0x0ed506887dea4406bb68a77a9d4c54b2454946b80b9205772900008859a92c7b" as Hex, gasLimitCap: 740292n, maxFeePerGasCap: 1000000n, maxPriorityFeePerGasCap: 1000000n };
      let adapter: ReturnType<typeof createRepairProductionAdapter> | undefined;
      const runtime = createRepairCommandRuntime({ environment: {}, domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN, ordinaryDomain: PRODUCTION_ORDINARY_SCENARIO_DOMAIN, repository: () => repository, createHarness: () => productionHarness, createAdapter: input => adapter = createRepairProductionAdapter(input), loadCreationQuote: () => quote, submit: async () => { throw new Error("read-only composition must not submit"); }, now: prepared.providers.now, awaitApprovalHandoff: async () => { throw new Error("read-only composition must not await authority"); }, loadUsdcRecycleContinuationLineage: argv => loadUsdcRecycleContinuationPublicInputs(parseUsdcRecycleContinuationCliArguments(argv), prepared.providers) });
      const creation = await runRepairCommand(["creation-review", ...args], runtime) as any;
      expect(creation.predecessor).to.include({ kind: "usdc-recycle-continuation-v1", actionCount: 41 });
      expect(creation.baseline).to.include({ safeNonce: "15", delayQueueNonce: "7", delayTxNonce: "7" });
      const reopened = JSON.parse(readFileSync(prepared.tracked.path, "utf8"));
      expect(reopened.repairContinuation.predecessor.kind).to.equal("usdc-recycle-continuation-v1");
      expect(reopened.repairContinuation.actions).to.deep.equal([{ id: "repair-signer-create", commitment: creation.action.commitment, status: "proposed" }]);
      expect(reopened.usdcSuccessor.actions[2].status).to.equal("signed-simulated");
      expect(reopened.liveJournal.entries).to.have.length(24);
      repairState.rotated = true;
      const post = await adapter!.readStateAt("post-rotation", inputs.continuation.observer.probeEvidenceHash, BigInt(creation.preRotationBlockNumber), creation.preRotationBlockHash);
      expect(post).to.include({ safeNonce: 16n, delayQueueNonce: 8n, delayTxNonce: 8n, safeContractSecondary: PRODUCTION_REPAIR_EXECUTION_DOMAIN.candidate });
      let expiredRepositoryCalls = 0;
      const expiredRuntime = createRepairCommandRuntime({ environment: {}, domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN, ordinaryDomain: PRODUCTION_ORDINARY_SCENARIO_DOMAIN, repository: () => { expiredRepositoryCalls++; throw new Error("expired admission reached repository"); }, createHarness: () => { throw new Error("expired admission reached harness"); }, createAdapter: input => createRepairProductionAdapter(input), loadCreationQuote: () => quote, submit: async () => { throw new Error("expired admission reached submit"); }, now: () => new Date((Number(BigInt(inputs.continuation.observer.expiresAt)) + 1) * 1000), awaitApprovalHandoff: async () => { throw new Error("expired admission reached authority"); }, loadUsdcRecycleContinuationLineage: argv => loadUsdcRecycleContinuationPublicInputs(parseUsdcRecycleContinuationCliArguments(argv), prepared.providers) });
      await expect(runRepairCommand(["creation-review", ...args], expiredRuntime)).to.be.rejectedWith(/observer.*schedule|freshness|no longer/i);
      expect(expiredRepositoryCalls).to.equal(0);

      repairState.rotated = false;
      const pendingHash = `0x${"e1".padStart(64, "0")}` as Hex;
      const identity = { proposalHash: inputs.source.prior.original.proposalHash, approvalHash: journal.approvalHash, funder: inputs.source.prior.original.funder };
      const pendingStore = createOrdinaryScenarioStore(prepared.tracked.path, identity, () => { throw new Error("attached repair journal required"); });
      const pendingJournal = pendingStore.load();
      (pendingJournal.repairContinuation!.actions[0] as any).status = "pending"; (pendingJournal.repairContinuation!.actions[0] as any).transactionHash = pendingHash;
      pendingJournal.liveJournal.entries.push({ id: "repair-signer-create", intentHash: `0x${"e2".padStart(64, "0")}`, transactionHash: pendingHash, nonce: 930, reserved: 740_292_000_000n, status: "pending" });
      pendingStore.save(pendingJournal); pendingStore.close?.();
      const creationPath = join(prepared.directory, "repair-creation.json"); writeFileSync(creationPath, `${JSON.stringify(creation)}\n`);
      let recovered = 0, liveContexts = 0, financialCallbacks = 0;
      const resumeHarness = { ...productionHarness, current: { ...harness.current, getTransaction: async ({ hash }: { hash: Hex }) => { recovered++; expect(hash).to.equal(pendingHash); return { hash, from: creation.funder, to: creation.factory, value: 0n, input: creation.creationCalldata, nonce: 930, gas: 740_292n, type: "eip1559", chainId: 11_155_111, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n }; } }, createLiveContext: async () => { liveContexts++; return { funder: creation.funder, chainId: async () => 11_155_111, nonce: async () => 930, balance: async () => 0n, sign: async () => { financialCallbacks++; throw new Error("historical resume must not sign"); }, broadcast: async () => { financialCallbacks++; throw new Error("historical resume must not broadcast"); }, receipt: async () => undefined, persist: async () => undefined }; } } as any;
      const resumeRuntime = createRepairCommandRuntime({ environment: {}, domain: PRODUCTION_REPAIR_EXECUTION_DOMAIN, ordinaryDomain: PRODUCTION_ORDINARY_SCENARIO_DOMAIN, repository: () => repository, createHarness: () => resumeHarness, createAdapter: input => createRepairProductionAdapter(input), loadCreationQuote: () => quote, submit: async (_intent, liveJournal) => liveJournal.entries.find(entry => entry.transactionHash === pendingHash)!, now: () => new Date((Number(BigInt(inputs.continuation.observer.expiresAt)) + 100) * 1000), awaitApprovalHandoff: async () => { throw new Error("historical resume must not await authority"); }, loadUsdcRecycleContinuationLineage: argv => loadUsdcRecycleContinuationPublicInputs(parseUsdcRecycleContinuationCliArguments(argv), prepared.providers) });
      const resumeArgs = ["--creation", creationPath, "--creation-hash", creation.proposalHash, ...args, "--group", join(prepared.directory, "unused-group.json"), "--group-hash", `0x${"e3".padStart(64, "0")}`, "--observer-ledger", join(prepared.directory, "unused-ledger.json"), "--receiver-ack", join(prepared.directory, "unused-ack.json")];
      expect(await runRepairCommand(["tail-resume-one", ...resumeArgs], resumeRuntime)).to.deep.equal({ status: "PENDING", actionId: "repair-signer-create" });
      expect({ recovered, liveContexts, financialCallbacks }).to.deep.equal({ recovered: 1, liveContexts: 1, financialCallbacks: 0 });
      expect(counters).to.deep.equal({ codeFailures: 0, signs: 0, broadcasts: 0, simulations: 0 });
    } finally { globalThis.fetch = savedFetch; prepared.cleanup(); }
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
      const dependencies = createUsdcRecycleContinuationProductionDependencies("/public/repository", prepared.submitArgs, { createHarness: () => fakeHarness, createStateReader: (() => async (action: any) => { reads++; selected.push(action.id); return { blockTimestamp: BigInt(inputs.certificate.snapshot.timestamp) } as never; }) as never, now: prepared.providers.now });
      await dependencies.publicPreflight!("submit-one", inputs); await dependencies.publicPreflight!("submit-one", inputs);
      expect(reads).to.equal(2); expect(selected).to.deep.equal([inputs.continuation.actions[0]!.id, inputs.continuation.actions[0]!.id]); expect(selected[0]).not.to.equal(inputs.source.priorProposal.actions[2]!.id);
      const context = await dependencies.createExecutionContext!("submit-one", inputs, () => inputs.source.prior.journal);
      expect(context.inspectReceiptPostState).to.be.a("function"); expect(context.now).to.equal(prepared.providers.now);
    } finally { prepared.cleanup(); }
  });
});
