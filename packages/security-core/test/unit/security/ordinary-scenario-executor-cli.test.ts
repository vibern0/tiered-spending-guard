import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { keccak256, type Hex } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import { runOrdinaryScenarioExecutorCli } from "../../../scripts/live/ordinary-scenario-executor-cli";
import { createOrdinaryScenarioJournal, createOrdinaryScenarioProposal, loadOrdinaryScenarioApproval, type CanonicalOrdinaryScenarioState, type OrdinaryScenarioExecutionContext } from "../../../scripts/live/ordinary-scenario-executor";
import { liveIntentHash, type LiveIntent } from "../../../scripts/live/submission";

const repository = join(__dirname, "../../../../..");
const reportPath = join(repository, ".superpowers/sdd/2026-10-19-native-safe-4337/scenario-review-2m-2026-10-27/ordinary-scenario-review.json");
const serialized = readFileSync(reportPath, "utf8");
const expectedPackageHash = sha256(JSON.parse(serialized)) as Hex;
const expectedArtifactBytesHash = `0x${createHash("sha256").update(serialized).digest("hex")}` as Hex;
const proposal = createOrdinaryScenarioProposal(serialized, { expectedPackageHash, expectedArtifactBytesHash });
const approvalDocument = { schemaVersion: 1, scope: "bounded-ordinary-matrix-v1", authorization: "EXPLICIT_GROUP_APPROVAL", chainId: 11155111, proposalHash: proposal.proposalHash, reviewPackageHash: proposal.reviewPackageHash, reviewArtifactBytesHash: proposal.reviewArtifactBytesHash, planHash: proposal.planHash, approvedActions: proposal.actions.slice(0, 1).map(({ id, commitment }) => ({ id, commitment })), derivations: { outerEoaNonce: "CURRENT_ONLY", fees: "AT_OR_BELOW_ACTION_CAPS", gas: "SIGNED_SIMULATION_AT_OR_BELOW_ACTION_CAP", queueTiming: "CANONICAL_RECEIPT_CREATED_AT_ONLY", safeNonce: "FIXED", delayQueueNonce: "FIXED", delayTxNonce: "FIXED" }, phaseLimitWei: "50000000000000000", maxBroadcastAttempts: 1 };
const approvalSerialized = `${JSON.stringify(approvalDocument)}\n`;
const approvalHash = sha256(approvalDocument) as Hex;
const approval = loadOrdinaryScenarioApproval(proposal, approvalSerialized, { expectedProposalHash: proposal.proposalHash, expectedPackageHash, expectedApprovalHash: approvalHash });

const state: CanonicalOrdinaryScenarioState = { chainId: 11155111, blockNumber: 1n, blockHash: keccak256("0x11"), blockTimestamp: 1n, evidenceBasis: { kind: "current-head" }, planHash: proposal.planHash, topologyEvidenceHash: proposal.topologyEvidenceHash, publicIdentitiesHash: proposal.publicIdentitiesHash, observerReady: true, observerEvidenceHash: proposal.observerEvidenceHash, outerNonce: 743, funderNativeBalance: 50_000_000_000_000_000n, safeNativeBalance: 0n, funderUsdcBalance: 20_000_000n, safeUsdcBalance: 0n, safeNonce: 0n, delayQueueNonce: 0n, delayTxNonce: 0n, nativeSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n }, usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n }, dependencies: [], fees: { maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n } };
const intent: LiveIntent = { id: "native-funding", to: proposal.safe, data: "0x", value: 30_000_000_000_001n, nonce: 743, gas: proposal.actions[0]!.gasLimitCap, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n };
const resumeContext = (counts: { sign: number; broadcast: number }): OrdinaryScenarioExecutionContext => ({ readState: async () => state, materialize: async () => { throw new Error("no materialize"); }, simulate: async () => { throw new Error("no simulate"); }, proveRejection: async () => { throw new Error("no reject"); }, recoverPending: async () => intent, recoverReplay: async () => { throw new Error("no replay"); }, verifyContractSignature: async () => "0x1626ba7e", confirm: async () => { throw new Error("no confirmation without receipt"); }, live: { funder: proposal.funder, chainId: async () => 11155111, nonce: async () => 743, balance: async () => state.funderNativeBalance, sign: async () => { counts.sign++; throw new Error("resume sign disabled"); }, broadcast: async () => { counts.broadcast++; throw new Error("resume broadcast disabled"); }, receipt: async () => undefined } });

describe("ordinary scenario one-action CLI", () => {
  it("reviews the exact 2m proposal without constructing private or broadcast capabilities", async () => {
    let contexts = 0;
    const result = await runOrdinaryScenarioExecutorCli({ mode: "review", reportPath, expectedPackageHash, expectedArtifactBytesHash, expectedProposalHash: proposal.proposalHash }, { environment: {}, publicPreflight: async () => ({ ready: true, detail: "public-only" }), createContext: async () => { contexts++; throw new Error("must not construct"); } });
    expect(result).to.include({ mode: "review", nextAction: "native-funding", broadcast: false, gasProven: false });
    expect(contexts).to.equal(0);
  });

  it("rejects authority environment and approval identity mismatches before capabilities", async () => {
    let contexts = 0;
    const dependencies = { environment: { LIVE_SUBMIT: "YES" }, publicPreflight: async () => ({ ready: true, detail: "public-only" }), createContext: async () => { contexts++; throw new Error("must not construct"); } };
    await expect(runOrdinaryScenarioExecutorCli({ mode: "review", reportPath, expectedPackageHash, expectedArtifactBytesHash, expectedProposalHash: proposal.proposalHash }, dependencies)).to.be.rejectedWith("LIVE_SUBMIT");
    await expect(runOrdinaryScenarioExecutorCli({ mode: "submit-one", reportPath, expectedPackageHash, expectedArtifactBytesHash, expectedProposalHash: `0x${"00".repeat(32)}` as Hex }, dependencies)).to.be.rejectedWith("exact proposal");
    await expect(runOrdinaryScenarioExecutorCli({ mode: "review", reportPath, expectedPackageHash, expectedArtifactBytesHash, expectedProposalHash: proposal.proposalHash }, { ...dependencies, environment: { LIVE_ECDSA_KEY_FILE: "/private" } })).to.be.rejectedWith("LIVE_ECDSA_KEY_FILE");
    await expect(runOrdinaryScenarioExecutorCli({ mode: "resume-one", reportPath, expectedPackageHash, expectedArtifactBytesHash, expectedProposalHash: proposal.proposalHash }, { ...dependencies, environment: { LIVE_PRIMARY_CREDENTIAL_FILE: "/private" } })).to.be.rejectedWith("LIVE_PRIMARY_CREDENTIAL_FILE");
    await expect(runOrdinaryScenarioExecutorCli({ mode: "submit-one", reportPath, expectedPackageHash, expectedArtifactBytesHash, expectedProposalHash: proposal.proposalHash }, { ...dependencies, environment: { LIVE_SUBMIT: "YES", LIVE_UNKNOWN_AUTHORITY: "yes" } })).to.be.rejectedWith("LIVE_UNKNOWN_AUTHORITY");
    await expect(runOrdinaryScenarioExecutorCli({ mode: "resume-one", reportPath, expectedPackageHash, expectedArtifactBytesHash, expectedProposalHash: proposal.proposalHash }, { ...dependencies, environment: { SEPOLIA_RPC_URL: "https://override.invalid" } })).to.be.rejectedWith("SEPOLIA_RPC_URL");
    expect(contexts).to.equal(0);
  });

  it("cannot bind the previous 500k package hash to the regenerated 2m report", async () => {
    const oldManifest = JSON.parse(readFileSync(join(repository, ".superpowers/sdd/2026-10-19-native-safe-4337/scenario-review-v4-2026-10-27/public-manifest.json"), "utf8")) as { packageHash: Hex };
    await expect(runOrdinaryScenarioExecutorCli({ mode: "review", reportPath, expectedPackageHash: oldManifest.packageHash, expectedArtifactBytesHash, expectedProposalHash: proposal.proposalHash }, { environment: {}, publicPreflight: async () => ({ ready: true, detail: "public-only" }), createContext: async () => { throw new Error("must not construct"); } })).to.be.rejectedWith("package hash mismatch");
  });

  it("resume-one requires one pending record and cannot sign or broadcast", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ordinary-cli-")); const approvalPath = join(directory, "approval.json"); const journalPath = join(directory, "journal.json");
    writeFileSync(approvalPath, approvalSerialized);
    const counts = { sign: 0, broadcast: 0 };
    const options = { mode: "resume-one" as const, reportPath, expectedPackageHash, expectedArtifactBytesHash, expectedProposalHash: proposal.proposalHash, approvalPath, expectedApprovalHash: approvalHash, journalPath };
    try {
      await expect(runOrdinaryScenarioExecutorCli(options, { environment: {}, publicPreflight: async () => ({ ready: true, detail: "ok" }), createContext: async () => resumeContext(counts) })).to.be.rejectedWith("outer-pending");
      const journal = createOrdinaryScenarioJournal(proposal, approval, proposal.funder); const transactionHash = keccak256("0x99"); const intentHash = liveIntentHash(intent, proposal.funder);
      journal.liveJournal.entries.push({ id: intent.id, intentHash, transactionHash, nonce: intent.nonce, reserved: intent.value + intent.gas * intent.maxFeePerGas, status: "pending" });
      journal.actions.push({ id: intent.id, commitment: proposal.actions[0]!.commitment, status: "outer-pending", intentHash, transactionHash, outerNonce: intent.nonce, gas: intent.gas.toString(), maxFeePerGas: intent.maxFeePerGas.toString(), maxPriorityFeePerGas: intent.maxPriorityFeePerGas.toString(), outerTo: intent.to, outerValue: intent.value.toString(), outerDataHash: keccak256(intent.data) });
      writeFileSync(journalPath, `${JSON.stringify(journal, (_, value) => typeof value === "bigint" ? value.toString() : value)}\n`);
      expect(await runOrdinaryScenarioExecutorCli(options, { environment: {}, publicPreflight: async () => ({ ready: true, detail: "ok" }), createContext: async () => resumeContext(counts) })).to.deep.include({ status: "PENDING", actionId: "native-funding" });
      expect(counts).to.deep.equal({ sign: 0, broadcast: 0 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("submit-one invokes one action attempt and stops after its outer signing failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ordinary-submit-")); const approvalPath = join(directory, "approval.json"); const journalPath = join(directory, "journal.json"); writeFileSync(approvalPath, approvalSerialized);
    const counts = { materialize: 0, simulate: 0, sign: 0 };
    const context: OrdinaryScenarioExecutionContext = { ...resumeContext({ sign: 0, broadcast: 0 }), readState: async () => state, materialize: async action => { counts.materialize++; return { liveIntent: intent, requestHash: action.commitment, signerRolesHash: sha256(action.signerRoles) as Hex, signedCalldataHash: keccak256(intent.data), signatureBundleHash: null, transientSignedCalldata: intent.data }; }, simulate: async () => { counts.simulate++; return { blockNumber: state.blockNumber, blockHash: state.blockHash, success: true, gasEstimate: intent.gas, resultHash: keccak256("0x01") }; }, live: { ...resumeContext({ sign: 0, broadcast: 0 }).live, sign: async () => { counts.sign++; throw new Error("ephemeral test stop"); } } };
    try {
      await expect(runOrdinaryScenarioExecutorCli({ mode: "submit-one", reportPath, expectedPackageHash, expectedArtifactBytesHash, expectedProposalHash: proposal.proposalHash, approvalPath, expectedApprovalHash: approvalHash, journalPath }, { environment: { LIVE_SUBMIT: "YES" }, publicPreflight: async () => ({ ready: true, detail: "ok" }), createContext: async () => context })).to.be.rejectedWith("local transaction signing failed");
      expect(counts).to.deep.equal({ materialize: 1, simulate: 1, sign: 1 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
