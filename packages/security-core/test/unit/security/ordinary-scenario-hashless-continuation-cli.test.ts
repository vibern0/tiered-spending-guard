import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import { liveIntentHash } from "../../../scripts/live/submission";
import type { HashlessControlledState, HashlessEvidenceProvider } from "../../../scripts/live/ordinary-scenario-hashless-certificate";
import { createOrdinaryScenarioStore } from "../../../scripts/live/ordinary-scenario-executor";
import { sha256 } from "../../../scripts/plan-deployment";
import {
  assertContinuationObserverFresh,
  createContinuationObserverBinding,
  createHashlessEvidenceProvider,
  createHashlessContinuationProductionDependencies,
  HASHLESS_CONTINUATION_COMMANDS,
  loadHashlessContinuationPublicInputs,
  main,
  runExpiredHashlessContinuationCli,
  runHashlessContinuationEntryPoint,
} from "../../../scripts/live/ordinary-scenario-hashless-continuation-cli";

describe("ordinary scenario hashless continuation CLI", function () {
  it("reconstructs the exact public EIP-155 legacy nonce-809 transaction and recovers its sender", async function () {
    const fixture = readFileSync(join(__dirname, "../../fixtures/ordinary-hashless/canonical-public-legacy-nonce809.json"), "utf8"); expect(require("node:crypto").createHash("sha256").update(fixture).digest("hex")).to.equal("da9e3bf35bbcf29e0e56431a32981638642006d24c1b55a477f62b180a254b2b"); const raw = JSON.parse(fixture).transaction;
    const decoded = { type: "legacy" as const, chainId: Number(BigInt(raw.chainId)), nonce: Number(BigInt(raw.nonce)), gasPrice: BigInt(raw.gasPrice), gas: BigInt(raw.gas), to: raw.to as Address, value: BigInt(raw.value), input: raw.input as Hex, r: raw.r as Hex, s: raw.s as Hex, v: BigInt(raw.v), hash: raw.hash as Hex, blockHash: raw.blockHash as Hex, blockNumber: BigInt(raw.blockNumber), transactionIndex: Number(BigInt(raw.transactionIndex)), from: "0x0000000000000000000000000000000000000001" as Address };
    const read = async (overrides: Record<string, unknown> = {}) => createHashlessEvidenceProvider({ getTransaction: async () => ({ ...decoded, ...overrides }) } as never).readTransaction(decoded.hash);
    const canonical = await read(); expect(canonical).to.include({ type: "legacy", chainId: 11_155_111, gasPrice: 100_000n, v: 22_310_258n, recoveredSender: funder, hash: consumingHash, gas: 1_820_162n, to: "0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27", inputHash: "0x25491caa28455d896a7211a1c4532ab1e72412bdb15293292e2e37e5f9406c63" }); expect(canonical).not.to.have.property("maxFeePerGas");
    expect(await read({ chainId: 1 })).to.equal(undefined);
    expect(await read({ v: 27n })).to.equal(undefined);
    expect(await read({ hash: `0x${"00".repeat(32)}` })).to.equal(undefined);
    expect(await read({ r: `0x${"01".repeat(32)}` })).to.equal(undefined);
  });

  it("review_is_public_unsigned_and_fail_closed", async function () {
    expect(HASHLESS_CONTINUATION_COMMANDS).to.deep.equal(["review", "submit-one", "resume-one"]);
    let privateLoads = 0;
    let stderr = ""; let exitCode = 0;
    const task = runExpiredHashlessContinuationCli(["unknown"], {
      environment: {},
      createExecutionContext: async () => {
        privateLoads += 1;
        throw new Error("must not load private authority");
      },
    } as never).then(() => undefined);
    await runHashlessContinuationEntryPoint(task, { writeStderr: value => { stderr += value; }, setExitCode: value => { exitCode = value; } });
    expect(exitCode).to.equal(1);
    expect(stderr).to.equal("[ORDINARY_SCENARIO_HASHLESS_CONTINUATION_FAILED] ordinary scenario hashless continuation failed\n");
    expect(privateLoads).to.equal(0);
    await expect(runExpiredHashlessContinuationCli(["review", "--approval", "/tmp/irrelevant"], { environment: {} })).to.be.rejectedWith(/not valid/);
  });

  it("reviews the real source file into a reproducible unsigned 22-action artifact without private loading", async function () {
    const directory = mkdtempSync(join(tmpdir(), "hashless-cli-review-")); const sourceJournal = join(directory, "journal.json"); const startupPath = join(directory, "startup.json"); const probePath = join(directory, "probe.json");
    const fixtureRoot = join(__dirname, "../../fixtures/ordinary-hashless"); writeFileSync(sourceJournal, readFileSync(join(fixtureRoot, "first38-live-journal-2026-10-28.json")));
    const endpointHash = `0x${"11".repeat(32)}`; const startup = `${JSON.stringify({ schemaVersion: 1, scope: "HASHLESS_CONTINUATION_OBSERVER_STARTUP_V1", publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startedAt: "2026-10-28T20:00:00Z", expiresAt: "2026-10-28T22:00:00Z", signing: false, broadcast: false })}\n`; writeFileSync(startupPath, startup);
    const startupEvidenceHash = `0x${require("node:crypto").createHash("sha256").update(startup).digest("hex")}`; writeFileSync(probePath, `${JSON.stringify({ schemaVersion: 1, scope: "HASHLESS_CONTINUATION_OBSERVER_PROBE_V1", publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startupEvidenceHash, probedAt: "2026-10-28T20:01:00Z", expiresAt: "2026-10-28T22:00:00Z", delivery: "DELIVERED", acknowledgement: "ACKNOWLEDGED", signing: false, broadcast: false })}\n`);
    let privateLoads = 0;
    const args = ["review", "--source-journal", sourceJournal, "--source-artifact", join(fixtureRoot, "hashless-public-state-2026-10-28.json"), "--source-artifact-hash", "0xfc9c71e506c6941496501178fc2b826575ede10839fc61fbda838bb747a8f339", "--original-report", join(__dirname, "../../fixtures/ordinary-scenario-review.public.json"), "--original-package-hash", "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", "--original-artifact-hash", "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831", "--original-proposal-hash", "0x22770c7944ee289543c10090b3483bdcd87f0d2c193887df4f32916c5782e45f", "--observer-startup", startupPath, "--observer-probe", probePath];
    try {
      const first = await runExpiredHashlessContinuationCli(args, { environment: {}, providers: [evidenceProvider(), evidenceProvider()], now: () => new Date("2026-10-28T20:01:00Z"), createExecutionContext: async () => { privateLoads++; throw new Error("no private load"); } });
      const second = await runExpiredHashlessContinuationCli(args, { environment: {}, providers: [evidenceProvider(), evidenceProvider()], now: () => new Date("2026-10-28T20:01:00Z"), createExecutionContext: async () => { privateLoads++; throw new Error("no private load"); } });
      expect(first).to.deep.equal(second); expect(first).to.include({ authorization: "NONE", actionCount: 22, signing: false, broadcast: false }); expect(privateLoads).to.equal(0); expect(JSON.stringify(first)).not.to.match(/private|credential|https:\/\//i);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("attaches the real existing source file only after exact approval and public gates, then loads one action context", async function () {
    const prepared = await prepareReviewFiles(); let privateLoads = 0; let preflights = 0;
    const badArgs = [...prepared.submitArgs]; badArgs[badArgs.indexOf("--approval-hash") + 1] = `0x${"00".repeat(32)}`;
    await expect(runExpiredHashlessContinuationCli(badArgs, { environment: { LIVE_SUBMIT: "YES" }, providers: [evidenceProvider(), evidenceProvider()], now: () => new Date("2026-10-28T20:01:00Z"), publicPreflight: async () => { preflights++; }, createExecutionContext: async () => { privateLoads++; throw new Error("private"); } })).to.be.rejected;
    expect(privateLoads).to.equal(0); expect(preflights).to.equal(0); expect("hashlessContinuation" in JSON.parse(readFileSync(prepared.sourceJournal, "utf8"))).to.equal(false);
    await expect(runExpiredHashlessContinuationCli(prepared.submitArgs, { environment: { LIVE_SUBMIT: "YES" }, providers: [evidenceProvider(), evidenceProvider()], now: () => new Date("2026-10-28T20:01:00Z"), publicPreflight: async () => { preflights++; }, createExecutionContext: async () => { privateLoads++; throw new Error("PRIVATE_MARKER_AFTER_GATES"); } })).to.be.rejectedWith("PRIVATE_MARKER_AFTER_GATES");
    const attached = JSON.parse(readFileSync(prepared.sourceJournal, "utf8")); expect(attached.hashlessContinuation.actions).to.have.length(22); expect(privateLoads).to.equal(1); expect(preflights).to.equal(1);
    rmSync(prepared.directory, { recursive: true, force: true });
  });

  it("resume-one accepts only one durable pending record and reaches a keyless context without authority environment", async function () {
    const prepared = await prepareReviewFiles();
    await expect(runExpiredHashlessContinuationCli(prepared.submitArgs, { environment: { LIVE_SUBMIT: "YES" }, providers: [evidenceProvider(), evidenceProvider()], now: () => new Date("2026-10-28T20:01:00Z"), createExecutionContext: async () => { throw new Error("ATTACHED"); } })).to.be.rejectedWith("ATTACHED");
    const disk = JSON.parse(readFileSync(prepared.sourceJournal, "utf8")); const proposal = JSON.parse(readFileSync(prepared.proposalPath, "utf8")); const action = proposal.actions[0]; const intent = { id: action.id, to: action.transaction.to, value: 0n, data: action.transaction.data, nonce: 810, gas: 300_000n, maxFeePerGas: 28n, maxPriorityFeePerGas: 2n }; const facts = { proposalHash: proposal.proposalHash, actionCommitment: action.commitment, outerNonce: 810, gas: "300000", gasEstimate: "21000", maxFeePerGas: "28", maxPriorityFeePerGas: "2", pinnedBlockNumber: current.number.toString(), pinnedBlockHash: current.hash, approvedContinuationReservationWei: proposal.reservation.continuationMaximumReservationWei, remainingReservationWei: proposal.reservation.continuationMaximumReservationWei }; const transactionHash = `0x${"44".repeat(32)}` as Hex;
    disk.hashlessContinuation.actions[0] = { id: action.id, commitment: action.commitment, status: "outer-pending", materializationHash: `0x${"99".repeat(32)}`, finalOuterMaterialization: { hash: sha256(facts), ...facts }, prestateHash: `0x${"88".repeat(32)}`, outerNonce: 810, gas: "300000", maxFeePerGas: "28", maxPriorityFeePerGas: "2", requestHash: action.commitment, signatureBundleHash: null, signedCalldataHash: keccak256(action.transaction.data), simulationEvidenceHash: `0x${"77".repeat(32)}`, intentHash: liveIntentHash(intent, funder), transactionHash, outerTo: intent.to, outerValue: "0", outerDataHash: keccak256(intent.data), funderNativeBefore: (10n ** 18n).toString() };
    disk.liveJournal.entries.push({ id: action.id, intentHash: liveIntentHash(intent, funder), transactionHash, nonce: 810, reserved: (intent.gas * intent.maxFeePerGas).toString(), status: "pending" }); writeFileSync(prepared.sourceJournal, `${JSON.stringify(disk)}\n`);
    let contexts = 0; const resumeArgs = ["resume-one", ...prepared.submitArgs.slice(1)];
    await expect(runExpiredHashlessContinuationCli(resumeArgs, { environment: {}, providers: [evidenceProvider(), evidenceProvider()], now: () => new Date("2026-10-29T20:01:00Z"), createExecutionContext: async mode => { contexts++; expect(mode).to.equal("resume-one"); throw new Error("KEYLESS_CONTEXT_REACHED"); } })).to.be.rejectedWith("KEYLESS_CONTEXT_REACHED"); expect(contexts).to.equal(1);
    await expect(runExpiredHashlessContinuationCli(resumeArgs, { environment: { LIVE_PRIMARY_CREDENTIAL_FILE: "/private" }, providers: [evidenceProvider(), evidenceProvider()], createExecutionContext: async () => { throw new Error("must not reach"); } })).to.be.rejected; expect(contexts).to.equal(1);
    rmSync(prepared.directory, { recursive: true, force: true });
  });

  it("actual main stdout, entrypoint stderr, and journal remain public when a nested cause contains secrets", async function () {
    const prepared = await prepareReviewFiles(); const marker = "PRIVATE_CREDENTIAL_https://secret.invalid/0xabcdef"; let stdout = ""; let stderr = ""; let exitCode = 0;
    await main(prepared.reviewArgs, { dependencies: { environment: {}, providers: [evidenceProvider(), evidenceProvider()], now: () => new Date("2026-10-28T20:01:00Z") }, writeStdout: value => { stdout += value; } }); expect(stdout).to.include("FIRST38_HASHLESS_CONTINUATION_UNSIGNED_REVIEW_V1"); expect(stdout).not.to.include(marker); stdout = "";
    const task = main(prepared.submitArgs, { dependencies: { environment: { LIVE_SUBMIT: "YES" }, providers: [evidenceProvider(), evidenceProvider()], now: () => new Date("2026-10-28T20:01:00Z"), createExecutionContext: async () => { throw new Error(marker); } }, writeStdout: value => { stdout += value; } });
    await runHashlessContinuationEntryPoint(task, { writeStderr: value => { stderr += value; }, setExitCode: value => { exitCode = value; } });
    expect(exitCode).to.equal(1); expect(stdout).to.equal(""); expect(stderr).to.equal("[ORDINARY_SCENARIO_HASHLESS_CONTINUATION_FAILED] ordinary scenario hashless continuation failed\n"); expect(`${stdout}${stderr}${readFileSync(prepared.sourceJournal, "utf8")}`).not.to.include(marker);
    rmSync(prepared.directory, { recursive: true, force: true });
  });

  it("production preflight selects action 1 after exact terminal action 0 progress and closes other states", async function () {
    const prepared = await prepareReviewFiles();
    const args = (await import("../../../scripts/live/ordinary-scenario-hashless-continuation-cli")).parseHashlessContinuationCliArguments(prepared.submitArgs); const initialInputs = await loadHashlessContinuationPublicInputs(args, [evidenceProvider(), evidenceProvider()]); let selected = "";
    const dependencies = createHashlessContinuationProductionDependencies(process.cwd().replace(/\/packages\/security-core$/, ""), prepared.submitArgs, { createStateReader: input => async action => { selected = action.id; const proposalIndex = action.id === (input.proposal as any).proposal.actions[18].id ? 18 : 19; expect(action.before).to.deep.equal((input.proposal as any).proposal.actions[proposalIndex].before); return {} as never; } });
    await dependencies.publicPreflight!("submit-one", initialInputs); expect(selected).to.equal((initialInputs.continuation.actions[0]!).id);
    await expect(runExpiredHashlessContinuationCli(prepared.submitArgs, { environment: { LIVE_SUBMIT: "YES" }, providers: [evidenceProvider(), evidenceProvider()], now: () => new Date("2026-10-28T20:01:00Z"), createExecutionContext: async () => { throw new Error("ATTACHED"); } })).to.be.rejectedWith("ATTACHED");
    const disk = JSON.parse(readFileSync(prepared.sourceJournal, "utf8")); const proposal = JSON.parse(readFileSync(prepared.proposalPath, "utf8")); const first = proposal.actions[0];
    const facts = { proposalHash: proposal.proposalHash, actionCommitment: first.commitment, outerNonce: 810, gas: "1", gasEstimate: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", pinnedBlockNumber: current.number.toString(), pinnedBlockHash: current.hash, approvedContinuationReservationWei: proposal.reservation.continuationMaximumReservationWei, remainingReservationWei: proposal.reservation.continuationMaximumReservationWei };
    disk.hashlessContinuation.actions[0] = { id: first.id, commitment: first.commitment, status: "confirmed", materializationHash: `0x${"91".repeat(32)}`, finalOuterMaterialization: { hash: sha256(facts), ...facts }, outerNonce: 810, gas: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", evidenceHash: `0x${"92".repeat(32)}`, transactionHash: `0x${"93".repeat(32)}` }; writeFileSync(prepared.sourceJournal, `${JSON.stringify(disk)}\n`);
    const inputs = await loadHashlessContinuationPublicInputs(args, [evidenceProvider(), evidenceProvider()]); selected = "";
    await dependencies.publicPreflight!("submit-one", inputs); expect(selected).to.equal(proposal.actions[1].id);
    const blocked = JSON.parse(readFileSync(prepared.sourceJournal, "utf8")); const second = proposal.actions[1]; const secondFacts = { ...facts, actionCommitment: second.commitment, outerNonce: 811 };
    blocked.hashlessContinuation.actions[1] = { id: second.id, commitment: second.commitment, status: "outer-pending", outerNonce: 811, gas: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", finalOuterMaterialization: { ...secondFacts, hash: sha256(secondFacts) } }; writeFileSync(prepared.sourceJournal, `${JSON.stringify(blocked)}\n`); selected = "";
    const blockedInputs = await loadHashlessContinuationPublicInputs(args, [evidenceProvider(), evidenceProvider()]); await expect(dependencies.publicPreflight!("submit-one", blockedInputs)).to.be.rejectedWith(/fresh approved/); expect(selected).to.equal("");
    blocked.hashlessContinuation.actions[1].status = "stopped"; writeFileSync(prepared.sourceJournal, `${JSON.stringify(blocked)}\n`); const faultInputs = await loadHashlessContinuationPublicInputs(args, [evidenceProvider(), evidenceProvider()]); await expect(dependencies.publicPreflight!("submit-one", faultInputs)).to.be.rejectedWith(/fresh approved/); expect(selected).to.equal("");
    const allDone = JSON.parse(readFileSync(prepared.sourceJournal, "utf8")); allDone.hashlessContinuation.actions = proposal.actions.map((action: any, index: number) => ({ id: action.id, commitment: action.commitment, status: action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed", evidenceHash: `0x${(100 + index).toString(16).padStart(2, "0").repeat(32)}`, ...(action.expectedOutcome === "success" ? { transactionHash: `0x${(150 + index).toString(16).padStart(2, "0").repeat(32)}`, outerNonce: 810 + index, gas: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "1", finalOuterMaterialization: { ...facts, hash: sha256({ ...facts, actionCommitment: action.commitment, outerNonce: 810 + index }), actionCommitment: action.commitment, outerNonce: 810 + index } } : {}) })); writeFileSync(prepared.sourceJournal, `${JSON.stringify(allDone)}\n`);
    const completeInputs = await loadHashlessContinuationPublicInputs(args, [evidenceProvider(), evidenceProvider()]); await expect(dependencies.publicPreflight!("submit-one", completeInputs)).to.be.rejectedWith(/complete/);
    rmSync(prepared.directory, { recursive: true, force: true });
  });

  it("new_observer_requires_fresh_binding_and_sufficient_ttl", function () {
    const endpointHash = `0x${"11".repeat(32)}`;
    const startup = `${JSON.stringify({ schemaVersion: 1, scope: "HASHLESS_CONTINUATION_OBSERVER_STARTUP_V1", publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startedAt: "2026-10-28T20:00:00Z", expiresAt: "2026-10-28T22:00:00Z", signing: false, broadcast: false })}\n`;
    const startupEvidenceHash = `0x${require("node:crypto").createHash("sha256").update(startup).digest("hex")}`;
    const probe = `${JSON.stringify({ schemaVersion: 1, scope: "HASHLESS_CONTINUATION_OBSERVER_PROBE_V1", publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startupEvidenceHash, probedAt: "2026-10-28T20:01:00Z", expiresAt: "2026-10-28T22:00:00Z", delivery: "DELIVERED", acknowledgement: "ACKNOWLEDGED", signing: false, broadcast: false })}\n`;
    const binding = createContinuationObserverBinding(startup, probe, new Date("2026-10-28T20:01:00Z"));
    expect(binding).to.include({ endpointHash, startupEvidenceHash, readyAt: `${Date.parse("2026-10-28T20:01:00Z") / 1000}` });
    expect(JSON.stringify(binding)).not.to.include("https://");
    expect(() => createContinuationObserverBinding(startup.replace("22:00:00", "20:02:00"), probe, new Date("2026-10-28T20:01:00Z"))).to.throw();
    expect(() => createContinuationObserverBinding(startup, probe.replace("ACKNOWLEDGED", "PENDING"), new Date("2026-10-28T20:01:00Z"))).to.throw();
    expect(() => createContinuationObserverBinding(startup.replace('"signing":false', '"signing":true'), probe, new Date("2026-10-28T20:01:00Z"))).to.throw();
    expect(() => assertContinuationObserverFresh(binding, new Date("2026-10-28T21:01:01Z"))).to.throw(/remaining lifetime/);
  });

  it("preserves absence of continuation keys when decoding the real source file", function () {
    const directory = mkdtempSync(join(tmpdir(), "hashless-source-store-"));
    const path = join(directory, "journal.json");
    const fixture = join(__dirname, "../../fixtures/ordinary-hashless/first38-live-journal-2026-10-28.json");
    writeFileSync(path, readFileSync(fixture));
    const parsed = JSON.parse(readFileSync(fixture, "utf8"));
    const store = createOrdinaryScenarioStore(path, { proposalHash: parsed.proposalHash, approvalHash: parsed.approvalHash, funder: parsed.funder }, () => { throw new Error("existing source must load"); });
    try {
      const loaded = store.load();
      expect("hashlessContinuation" in loaded).to.equal(false);
      expect("repairContinuation" in loaded).to.equal(false);
    } finally {
      store.close?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("production default fixes two independent public providers and the existing harness without probing", function () {
    const dependencies = createHashlessContinuationProductionDependencies(process.cwd().replace(/\/packages\/security-core$/, ""), ["review"]);
    expect(dependencies.providers).to.have.length(2);
    expect(dependencies.providers![0]).not.to.equal(dependencies.providers![1]);
    expect(dependencies.publicPreflight).to.be.a("function");
    expect(dependencies.createExecutionContext).to.be.a("function");
  });

  it("forwards the approved continuation observer ready and expiry bounds into production confirmation", async function () {
    const prepared = await prepareReviewFiles();
    try {
      const parsed = (await import("../../../scripts/live/ordinary-scenario-hashless-continuation-cli")).parseHashlessContinuationCliArguments(prepared.submitArgs);
      const inputs = await loadHashlessContinuationPublicInputs(parsed, [evidenceProvider(), evidenceProvider()]);
      let executionInput: Record<string, unknown> | undefined;
      const dependencies = createHashlessContinuationProductionDependencies(process.cwd().replace(/\/packages\/security-core$/, ""), prepared.submitArgs, {
        createHarness: (() => ({ createLiveContext: async () => ({}) })) as never,
        createExecutionContext: ((input: any) => { executionInput = input as Record<string, unknown>; return {} as never; }) as never,
      });
      await dependencies.createExecutionContext!("resume-one", inputs, () => inputs.journal);
      expect(executionInput).to.include({
        receiverReadyAt: new Date(Number(BigInt(inputs.continuation.observer.readyAt)) * 1000).toISOString(),
        receiverExpiresAt: new Date(Number(BigInt(inputs.continuation.observer.expiresAt)) * 1000).toISOString(),
      });
    } finally { rmSync(prepared.directory, { recursive: true, force: true }); }
  });
});

async function prepareReviewFiles() {
  const directory = mkdtempSync(join(tmpdir(), "hashless-cli-flow-")); const sourceJournal = join(directory, "journal.json"), startupPath = join(directory, "startup.json"), probePath = join(directory, "probe.json"), certificatePath = join(directory, "certificate.json"), proposalPath = join(directory, "proposal.json"), approvalPath = join(directory, "approval.json");
  const fixtureRoot = join(__dirname, "../../fixtures/ordinary-hashless"); writeFileSync(sourceJournal, readFileSync(join(fixtureRoot, "first38-live-journal-2026-10-28.json")));
  const endpointHash = `0x${"11".repeat(32)}`; const startup = `${JSON.stringify({ schemaVersion: 1, scope: "HASHLESS_CONTINUATION_OBSERVER_STARTUP_V1", publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startedAt: "2026-10-28T20:00:00Z", expiresAt: "2026-10-28T22:00:00Z", signing: false, broadcast: false })}\n`; writeFileSync(startupPath, startup); const startupEvidenceHash = `0x${require("node:crypto").createHash("sha256").update(startup).digest("hex")}`; writeFileSync(probePath, `${JSON.stringify({ schemaVersion: 1, scope: "HASHLESS_CONTINUATION_OBSERVER_PROBE_V1", publicId: `temporary-test-receiver:${endpointHash}`, endpointHash, startupEvidenceHash, probedAt: "2026-10-28T20:01:00Z", expiresAt: "2026-10-28T22:00:00Z", delivery: "DELIVERED", acknowledgement: "ACKNOWLEDGED", signing: false, broadcast: false })}\n`);
  const common = ["--source-journal", sourceJournal, "--original-report", join(__dirname, "../../fixtures/ordinary-scenario-review.public.json"), "--original-package-hash", "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", "--original-artifact-hash", "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831", "--original-proposal-hash", "0x22770c7944ee289543c10090b3483bdcd87f0d2c193887df4f32916c5782e45f"];
  const reviewArgs = ["review", ...common, "--source-artifact", join(fixtureRoot, "hashless-public-state-2026-10-28.json"), "--source-artifact-hash", "0xfc9c71e506c6941496501178fc2b826575ede10839fc61fbda838bb747a8f339", "--observer-startup", startupPath, "--observer-probe", probePath]; const reviewed = await runExpiredHashlessContinuationCli(reviewArgs, { environment: {}, providers: [evidenceProvider(), evidenceProvider()], now: () => new Date("2026-10-28T20:01:00Z") });
  const certificate = reviewed.certificate as Record<string, unknown>, proposal = reviewed.continuation as any; writeFileSync(certificatePath, `${JSON.stringify(certificate)}\n`); writeFileSync(proposalPath, `${JSON.stringify(proposal)}\n`);
  const approval = { schemaVersion: 1, scope: "first38-native-ready-hashless-expired-v1", authorization: "EXPLICIT_GROUP_APPROVAL", proposalHash: proposal.proposalHash, certificateHash: proposal.certificateHash, observer: proposal.observer, caps: proposal.caps, reservation: proposal.reservation, derivations: proposal.derivations, maxBroadcastAttempts: 1, approvedActions: proposal.actions.map(({ id, commitment }: any) => ({ id, commitment })) }; const approvalHash = sha256(approval) as Hex; writeFileSync(approvalPath, `${JSON.stringify(approval)}\n`);
  return { directory, sourceJournal, proposalPath, reviewArgs, submitArgs: ["submit-one", ...common, "--certificate", certificatePath, "--certificate-hash", proposal.certificateHash, "--proposal", proposalPath, "--approval", approvalPath, "--approval-hash", approvalHash, "--journal", sourceJournal] };
}

const funder = "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address, safe = "0xd751a1479f49d63DC61E0081B0b4d8c60623D9a6" as Address, delay = "0xB8E143098CcCb9935228022173c2c987DF5FD53a" as Address, usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const selected = { number: 12_013_857n, hash: "0x197add23b0385bce509adab0a3f3234b58b71e63d0ebccad9aa2e99ba5f44e20" as Hex, timestamp: 1_793_209_056n }, certified = { number: 12_013_934n, hash: "0x05d0f3b8f503bfee60455adc88c717e330aa2bafaffb6badca3b5c8215f3948e" as Hex, timestamp: 1_793_209_980n }, current = { number: 12_013_940n, hash: `0x${"77".repeat(32)}` as Hex, timestamp: 1_793_210_052n }, latest = { number: 12_013_945n, hash: `0x${"88".repeat(32)}` as Hex, timestamp: 1_793_210_112n };
const consumingHash = "0x83923abf9c1224125296a3485f8cc0a910e7f729ea5d5a73d6f01bf1cdbfe1f5" as Hex;
const controlledState = (): HashlessControlledState => ({ chainId: 11_155_111, safe, delay, usdc, safeNonce: 7n, delayQueueNonce: 3n, delayTxNonce: 2n, queue: { queueNonce: 2n, to: funder, value: 1n, data: "0x", operation: 0, createdAt: 1_793_208_888n, expiresAt: 1_793_209_608n }, safeNativeBalance: 1n, safeUsdcBalance: 20_000_000n, funderUsdcBalance: 0n, effectiveGuardWindow: 1_793_145_600n, nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n } });
function evidenceProvider(): HashlessEvidenceProvider {
  const transaction = { type: "legacy" as const, chainId: 11_155_111, gasPrice: 100_000n, v: 22_310_258n, hash: consumingHash, recoveredSender: funder, nonce: 809, to: "0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27" as Address, value: 0n, inputHash: "0x25491caa28455d896a7211a1c4532ab1e72412bdb15293292e2e37e5f9406c63" as Hex, gas: 1_820_162n, blockNumber: 12_013_885n, blockHash: "0x1cd3daf4cef11721feb5d564c0768f42e88d1d14c6c909e64b7cd5532b6f158b" as Hex };
  return { readLatestBlock: async () => latest, readBlock: async number => number === selected.number ? selected : number === certified.number ? certified : number === current.number ? current : number === transaction.blockNumber ? { number, hash: transaction.blockHash, timestamp: 1_793_209_392n } : undefined, readTransaction: async hash => hash === consumingHash ? transaction : undefined, readReceipt: async hash => hash === consumingHash ? { transactionHash: consumingHash, status: "success", blockNumber: transaction.blockNumber, blockHash: transaction.blockHash } : undefined, readTransactionCount: async (_address, block) => block === selected.number ? 809 : 811, readControlledState: async () => structuredClone(controlledState()) };
}
