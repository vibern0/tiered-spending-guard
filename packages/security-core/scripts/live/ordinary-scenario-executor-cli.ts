import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { assertOrdinaryScenarioReviewCliEnvironment } from "./ordinary-scenario-review-cli";
import { createOrdinaryScenarioJournal, createOrdinaryScenarioProposal, createOrdinaryScenarioStore, executeOrdinaryScenarioAction, loadOrdinaryScenarioApproval, type OrdinaryScenarioExecutionContext, type OrdinaryScenarioExecutionResult } from "./ordinary-scenario-executor";
import { createFrozenSafeSignerProvider, createOrdinaryScenarioExecutionContext, createOrdinaryScenarioStateReader, readAgreedCurrentFunderNonce, requireSixConfirmationReceipts } from "./ordinary-scenario-adapter";
import { PUBLIC_ARCHIVE_RPC, PUBLIC_CURRENT_RPC, reconstructReviewedPlan } from "./ordinary-scenario-review-cli";
import { createPasskeySignerCore } from "../../src/signers/passkey-core";
import { createEip1193SecondarySigner } from "../../src/signers/eip1193";
import type { LiveContext, LiveIntent } from "./submission";
import type { VaultSigner } from "../../src/signers/types";
import { runOperationalCliEntryPoint, type OperationalCliOutput } from "./operational-cli-entrypoint";

export type OrdinaryScenarioCliOptions = Readonly<{ mode: "review" | "submit-one" | "resume-one"; reportPath: string; expectedPackageHash: Hex; expectedArtifactBytesHash: Hex; expectedProposalHash: Hex; approvalPath?: string; expectedApprovalHash?: Hex; journalPath?: string; observerLedgerPath?: string; receiverAcknowledgementPath?: string }>;
export type OrdinaryScenarioCliDependencies = Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  publicPreflight(proposal: ReturnType<typeof createOrdinaryScenarioProposal>): Promise<Readonly<{ ready: boolean; detail: string }>>;
  createContext(mode: "submit-one" | "resume-one", proposal: ReturnType<typeof createOrdinaryScenarioProposal>, journal: () => ReturnType<ReturnType<typeof createOrdinaryScenarioStore>["load"]>): Promise<OrdinaryScenarioExecutionContext>;
}>;

const PRIVATE_ENV = ["LIVE_FUNDING_KEY_FILE", "LIVE_PRIMARY_CREDENTIAL_FILE", "LIVE_SECONDARY_CREDENTIAL_FILE", "LIVE_ECDSA_KEY_FILE", "PRIVATE_KEY", "VAULT_FUNDING_KEY_PATH"] as const;
export function assertOrdinaryScenarioExecutorEnvironment(mode: OrdinaryScenarioCliOptions["mode"], environment: Readonly<Record<string, string | undefined>>): void {
  if (mode === "review") { assertOrdinaryScenarioReviewCliEnvironment(environment); for (const key of PRIVATE_ENV) if (environment[key] !== undefined) throw new Error(`ordinary scenario review CLI rejects authority input: ${key}`); return; }
  const forbiddenOverride = ["SEPOLIA_RPC_URL", "SEPOLIA_ARCHIVE_RPC_URL", "ORDINARY_SCENARIO_OBSERVER"] as const;
  for (const key of forbiddenOverride) if (environment[key] !== undefined) throw new Error(`${mode} rejects public authority override: ${key}`);
  const allowedLive = new Set(mode === "submit-one" ? ["LIVE_SUBMIT", "LIVE_FUNDING_KEY_FILE", "LIVE_PRIMARY_CREDENTIAL_FILE", "LIVE_SECONDARY_CREDENTIAL_FILE", "LIVE_ECDSA_KEY_FILE"] : []);
  for (const key of Object.keys(environment)) if ((key.startsWith("LIVE_") || key === "PRIVATE_KEY" || key.startsWith("VAULT_")) && !allowedLive.has(key)) throw new Error(`${mode} rejects unsupported authority input: ${key}`);
  if (mode === "resume-one") { for (const key of PRIVATE_ENV) if (environment[key] !== undefined) throw new Error(`resume-one rejects private input: ${key}`); return; }
}

function readPublicText(path: string, label: string): string { try { return readFileSync(path, "utf8"); } catch { throw new Error(`ordinary scenario ${label} is unavailable`); } }

export async function runOrdinaryScenarioExecutorCli(options: OrdinaryScenarioCliOptions, dependencies: OrdinaryScenarioCliDependencies): Promise<Readonly<Record<string, unknown>>> {
  assertOrdinaryScenarioExecutorEnvironment(options.mode, dependencies.environment);
  const serialized = readPublicText(options.reportPath, "review report");
  const proposal = createOrdinaryScenarioProposal(serialized, { expectedPackageHash: options.expectedPackageHash, expectedArtifactBytesHash: options.expectedArtifactBytesHash });
  if (options.expectedProposalHash.toLowerCase() !== proposal.proposalHash.toLowerCase()) throw new Error("ordinary scenario exact proposal hash mismatch");
  if (options.mode === "review") {
    const preflight = await dependencies.publicPreflight(proposal);
    return Object.freeze({ mode: "review", proposalHash: proposal.proposalHash, nextAction: proposal.actions[0]?.id ?? null, caps: proposal.actions[0] ? { gas: proposal.actions[0].gasLimitCap.toString(), maxFeePerGas: proposal.actions[0].maxFeePerGasCap.toString(), maxPriorityFeePerGas: proposal.actions[0].maxPriorityFeePerGasCap.toString() } : null, publicPreflight: preflight, journal: options.journalPath && existsSync(options.journalPath) ? "present" : "absent", gasProven: false, broadcast: false });
  }
  if (!options.approvalPath || !options.expectedApprovalHash || !options.journalPath) throw new Error("ordinary scenario execution requires exact proposal, approval, and journal inputs");
  const approval = loadOrdinaryScenarioApproval(proposal, readPublicText(options.approvalPath, "approval"), { expectedProposalHash: options.expectedProposalHash, expectedPackageHash: options.expectedPackageHash, expectedApprovalHash: options.expectedApprovalHash });
  const preflight = await dependencies.publicPreflight(proposal);
  if (!preflight.ready) throw new Error(`ordinary scenario public preflight failed: ${preflight.detail}`);
  if (options.mode === "submit-one" && dependencies.environment.LIVE_SUBMIT !== "YES") throw new Error("submit-one requires LIVE_SUBMIT=YES");
  const store = createOrdinaryScenarioStore(options.journalPath, { proposalHash: proposal.proposalHash, approvalHash: approval.approvalHash, funder: proposal.funder }, () => createOrdinaryScenarioJournal(proposal, approval, proposal.funder));
  try {
    const journal = store.load();
    if (options.mode === "resume-one" && !journal.actions.some((entry) => entry.status === "outer-pending")) throw new Error("resume-one requires one existing outer-pending action");
    const context = await dependencies.createContext(options.mode, proposal, () => store.load());
    return await executeOrdinaryScenarioAction(proposal, approval, store, context) as OrdinaryScenarioExecutionResult;
  } finally { store.close?.(); }
}

export const sha256FileBytes = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;

function requiredEnvironment(environment: Readonly<Record<string, string | undefined>>, key: string): string { const value = environment[key]; if (!value) throw new Error(`submit-one requires ${key}`); return value; }
const FACTORY_ABI = parseAbi(["function getSigner(uint256,uint256,uint176) view returns (address)"]);
const ENDPOINT_HASH = "0x8a3e2db19f160da76a08385670e22e08a293ee5b09276b90e74cd2dc65029ae0" as Hex;

function validateObserverStartup(repository: string, observerEvidenceHash: Hex): Readonly<{ ready: boolean; evidenceHash: Hex }> {
  try {
    const proof = JSON.parse(readFileSync(join(repository, ".superpowers/sdd/2026-10-19-native-safe-4337/observer-startup-after-compat-2026-10-27/startup-proof.json"), "utf8")) as Record<string, unknown>;
    const channel = JSON.parse(readFileSync(join(repository, ".superpowers/sdd/2026-10-19-native-safe-4337/observer-test-channel-proof.json"), "utf8")) as Record<string, unknown>;
    if (proof.scope !== "LIVE_READ_ONLY_STARTUP_NOT_ACTIVITY_EVIDENCE" || proof.exitStatus !== 0 || proof.receiverBinding !== "MATCH_SHA256" || proof.canonicalChain !== 11155111 || proof.pendingAlerts !== 0 || proof.liveActivityEvidence !== "NOT_RUN" || proof.broadcast !== false || proof.signing !== false) throw new Error("mismatch");
    if (channel.schemaVersion !== 1 || channel.scope !== "test-channel-probe-not-activity-evidence" || channel.endpointHash !== ENDPOINT_HASH || channel.actualActivityAlerts !== "NOT_RUN" || channel.hasSigningAuthority !== false || typeof channel.expiresAt !== "string" || !Number.isFinite(Date.parse(`${channel.expiresAt}Z`)) || Date.now() > Date.parse(`${channel.expiresAt}Z`)) throw new Error("mismatch");
    return { ready: true, evidenceHash: observerEvidenceHash };
  } catch { throw new Error("ordinary scenario observer startup evidence is invalid"); }
}

export type OrdinaryScenarioProductionHarness = Readonly<{
  current: ReturnType<typeof createPublicClient>;
  archive: ReturnType<typeof createPublicClient>;
  reconstructedProfile(): ReturnType<typeof reconstructReviewedPlan>;
  observerReadiness(observerEvidenceHash: Hex): Promise<Readonly<{ ready: boolean; evidenceHash: Hex }>>;
  loadClosedPasskey(role: "primary" | "original-secondary" | "repair-secondary", expectedAddress: Address): Promise<VaultSigner>;
  loadClosedProofSigner(role: "repair-secondary", expectedAddress: Address): Promise<Readonly<{ signDigest(digest: Hex): Promise<Hex> }>>;
  createLiveContext(mode: "submit-one" | "resume-one", funder: Address, persist: (journal: Parameters<LiveContext["persist"]>[0]) => Promise<void>): Promise<Omit<LiveContext, "verify">>;
}>;

/** Fixed Sepolia mechanics shared by the original CLI and the closed repair CLI. Construction is public and non-authorizing; every secret loader is lazy. */
export function createOrdinaryScenarioProductionHarness(repository: string): OrdinaryScenarioProductionHarness {
  const current = createPublicClient({ chain: sepolia, transport: http(PUBLIC_CURRENT_RPC) });
  const archive = createPublicClient({ chain: sepolia, transport: http(PUBLIC_ARCHIVE_RPC) });
  let reconstruction: Awaited<ReturnType<typeof reconstructReviewedPlan>> | undefined;
  const reconstructedProfile = async () => reconstruction ??= await reconstructReviewedPlan(repository, archive);
  const repair = { x: 10342510752483659319190807637330965811978365685423845568184481734592673940696n, y: 83007955684183101275699917860538633816962061613045139387258186696967867907135n, verifiers: 1111636484949241205398856388087597953580887526884n, address: "0xCc3C12cFB2508E5E9E4EB9b21CC44A9dEEFf0908" as Address };
  const passkeyProvider = (address: Address) => ({ request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "eth_call") { const call = params?.[0] as { to: Address; data: Hex }; return (await current.call({ to: call.to, data: call.data })).data ?? "0x"; }
    throw new Error("unsupported passkey verifier provider method");
  } });
  const loadRepairCredential = async (expectedAddress: Address) => {
    const reviewed = await reconstructedProfile(); const { loadCredential } = await import("./secrets"); const credential = loadCredential(requiredEnvironment(process.env, "LIVE_REPAIR_SECONDARY_CREDENTIAL_FILE"), repository);
    if (expectedAddress.toLowerCase() !== repair.address.toLowerCase() || credential.x !== repair.x || credential.y !== repair.y) throw new Error("repair-secondary credential does not match fixed public coordinates");
    const address = await current.readContract({ address: reviewed.bindings.factory, abi: FACTORY_ABI, functionName: "getSigner", args: [credential.x, credential.y, repair.verifiers] });
    if (address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error("repair-secondary credential factory binding mismatch");
    const runtime = await current.getCode({ address }); if (!runtime || runtime === "0x") throw new Error("repair-secondary signer runtime is unavailable");
    return credential;
  };
  return {
    current, archive, reconstructedProfile,
    observerReadiness: async observerEvidenceHash => validateObserverStartup(repository, observerEvidenceHash),
    loadClosedProofSigner: async (_role, expectedAddress) => { const credential = await loadRepairCredential(expectedAddress); const { signWebAuthn } = await import("./webauthn"); return Object.freeze({ signDigest: (digest: Hex) => Promise.resolve(signWebAuthn(credential, digest)) }); },
    loadClosedPasskey: async (role, expectedAddress) => {
      const reviewed = await reconstructedProfile(); const { loadCredential } = await import("./secrets"); const { signWebAuthn } = await import("./webauthn");
      const key = role === "primary" ? "LIVE_PRIMARY_CREDENTIAL_FILE" : role === "original-secondary" ? "LIVE_SECONDARY_CREDENTIAL_FILE" : "LIVE_REPAIR_SECONDARY_CREDENTIAL_FILE";
      const expected = role === "primary" ? reviewed.primaryBinding : role === "original-secondary" ? reviewed.secondaryBinding : repair;
      if (role === "repair-secondary" && expectedAddress.toLowerCase() !== repair.address.toLowerCase()) throw new Error("repair passkey identity mismatch");
      const credential = role === "repair-secondary" ? await loadRepairCredential(expectedAddress) : loadCredential(requiredEnvironment(process.env, key), repository);
      if (credential.x !== expected.x || credential.y !== expected.y) throw new Error(`${role} credential does not match reviewed public coordinates`);
      const factoryAddress = reviewed.bindings.factory;
      const address = await current.readContract({ address: factoryAddress, abi: FACTORY_ABI, functionName: "getSigner", args: [credential.x, credential.y, expected.verifiers] });
      if (address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error(`${role} credential factory binding mismatch`);
      const runtime = await current.getCode({ address }); if (!runtime || runtime === "0x") throw new Error(`${role} signer runtime is unavailable`);
      return createPasskeySignerCore({ address: expectedAddress, verifierAddress: expectedAddress, chainId: 11155111, role: role === "primary" ? "primary" : "secondary", provider: passkeyProvider(expectedAddress), sign: async request => signWebAuthn(credential, request.safeTxHash) });
    },
    createLiveContext: async (mode, funder, persist) => {
      let fundingAccount: ReturnType<typeof privateKeyToAccount> | undefined;
      const account = async () => { if (mode !== "submit-one") throw new Error("resume-one signing capability is disabled"); if (!fundingAccount) { const { loadFundingKey } = await import("./secrets"); fundingAccount = privateKeyToAccount(loadFundingKey(requiredEnvironment(process.env, "LIVE_FUNDING_KEY_FILE"), repository)); if (fundingAccount.address.toLowerCase() !== funder.toLowerCase()) throw new Error("funding key does not match reviewed funder"); } return fundingAccount; };
      const base = { funder, chainId: () => current.getChainId(), nonce: () => readAgreedCurrentFunderNonce(current, funder), balance: () => current.getBalance({ address: funder }), sign: async (intent: LiveIntent) => (await account()).signTransaction({ chainId: 11155111, type: "eip1559", to: intent.to, data: intent.data, value: intent.value, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }), broadcast: async (raw: Hex) => { if (mode !== "submit-one") throw new Error("resume-one broadcast capability is disabled"); return current.sendRawTransaction({ serializedTransaction: raw }); }, receipt: async (hash: Hex) => { try { const receipt = await current.getTransactionReceipt({ hash }); return { transactionHash: receipt.transactionHash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }; } catch { return undefined; } } };
      return { ...requireSixConfirmationReceipts(base, { blockNumber: current.getBlockNumber, blockHash: async number => { const block = await current.getBlock({ blockNumber: number }); if (!block.hash) throw new Error("canonical block hash unavailable"); return block.hash; } }), persist };
    },
  };
}

/** Shared lazy signer factory for the fixed ordinary Safe identities. No credential is read until materialization requests its exact role. */
export function createOrdinaryScenarioClosedSignerLoader(repository: string, harness: OrdinaryScenarioProductionHarness, proposal: ReturnType<typeof createOrdinaryScenarioProposal>) {
  return async (action: Parameters<OrdinaryScenarioExecutionContext["materialize"]>[0]) => {
    const primary = await harness.loadClosedPasskey("primary", proposal.primarySigner);
    if (action.signerRoles.includes("safe-contract-secondary")) return { primary, secondary: await harness.loadClosedPasskey("original-secondary", proposal.safeContractSecondary) };
    if (action.signerRoles.includes("legacy-ecdsa-secondary")) {
      const { loadFundingKey } = await import("./secrets");
      const key = loadFundingKey(requiredEnvironment(process.env, "LIVE_ECDSA_KEY_FILE"), repository); const account = privateKeyToAccount(key);
      if (account.address.toLowerCase() !== proposal.ecdsaSecondary.toLowerCase()) throw new Error("ECDSA credential does not match reviewed public identity");
      const tx = action.safeTransaction;
      if (!tx) throw new Error("ECDSA action lacks reviewed Safe request");
      const frozenRequest = { chainId: 11155111, safe: proposal.safe, safeTxHash: tx.safeTxHash, typedData: { domain: { chainId: 11155111, verifyingContract: proposal.safe }, types: { SafeTx: (await import("../../src/signers/types")).SAFE_TX_TYPES }, primaryType: "SafeTx" as const, message: { to: tx.to, value: tx.value, data: tx.data, operation: tx.operation as 0 | 1, safeTxGas: tx.safeTxGas, baseGas: tx.baseGas, gasPrice: tx.gasPrice, gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: tx.safeNonce } } };
      const provider = createFrozenSafeSignerProvider({ account: account.address, request: frozenRequest, signTypedData: request => account.signTypedData(request.typedData as never) });
      return { primary, secondary: createEip1193SecondarySigner({ provider, account: account.address }) };
    }
    return { primary };
  };
}

function createDefaultDependencies(options: OrdinaryScenarioCliOptions, repository: string): OrdinaryScenarioCliDependencies {
  const harness = createOrdinaryScenarioProductionHarness(repository); const { current, archive } = harness;
  const readiness = (proposal: ReturnType<typeof createOrdinaryScenarioProposal>) => async () => harness.observerReadiness(proposal.observerEvidenceHash);
  return {
    environment: process.env,
    publicPreflight: async proposal => {
      const journal = { schemaVersion: 1 as const, chainId: 11155111 as const, reviewPackageHash: proposal.reviewPackageHash, proposalHash: proposal.proposalHash, approvalHash: `0x${"00".repeat(32)}` as Hex, funder: proposal.funder, liveJournal: { chainId: 11155111, funder: proposal.funder, entries: [] }, actions: [] };
      const reader = createOrdinaryScenarioStateReader({ repository, proposal, journal: () => journal, currentClient: current, archiveClient: archive, observerReadiness: readiness(proposal) });
      await reader(proposal.actions[0]!, "pre-private");
      return { ready: true, detail: "canonical public topology/state verified; signed gas proof remains NOT_RUN" };
    },
    createContext: async (mode, proposal, journal) => {
      const loadSigners = createOrdinaryScenarioClosedSignerLoader(repository, harness, proposal);
      const live = await harness.createLiveContext(mode, proposal.funder, async () => {});
      return createOrdinaryScenarioExecutionContext({ repository, proposal, journal, currentClient: current, archiveClient: archive, observerReadiness: readiness(proposal), live, loadSigners, observerLedgerPath: options.observerLedgerPath, receiverAcknowledgementPath: options.receiverAcknowledgementPath, observerEndpointHash: ENDPOINT_HASH });
    },
  };
}

function parseCli(argv: readonly string[]): OrdinaryScenarioCliOptions {
  const args = [...argv]; const first = args[0]; const mode = first === "submit-one" || first === "resume-one" || first === "review" ? args.shift() as OrdinaryScenarioCliOptions["mode"] : "review";
  const values = new Map<string, string>();
  while (args.length) { const key = args.shift()!; const value = args.shift(); if (!key.startsWith("--") || !value || values.has(key)) throw new Error("ordinary scenario CLI arguments are malformed"); values.set(key, value); }
  const required = (key: string) => { const value = values.get(key); if (!value) throw new Error(`ordinary scenario CLI requires ${key}`); return value; };
  const known = new Set(["--report", "--artifact-hash", "--package-hash", "--proposal-hash", "--approval", "--approval-hash", "--journal", "--observer-ledger", "--receiver-ack"]); for (const key of values.keys()) if (!known.has(key)) throw new Error(`ordinary scenario CLI rejects unknown flag ${key}`);
  return { mode, reportPath: required("--report"), expectedArtifactBytesHash: required("--artifact-hash") as Hex, expectedPackageHash: required("--package-hash") as Hex, expectedProposalHash: required("--proposal-hash") as Hex, approvalPath: values.get("--approval"), expectedApprovalHash: values.get("--approval-hash") as Hex | undefined, journalPath: values.get("--journal"), observerLedgerPath: values.get("--observer-ledger"), receiverAcknowledgementPath: values.get("--receiver-ack") };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCli(argv); const repository = process.cwd().replace(/\/packages\/security-core$/, "");
  const result = await runOrdinaryScenarioExecutorCli(options, createDefaultDependencies(options, repository));
  process.stdout.write(`${JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value)}\n`);
}

export const runOrdinaryScenarioExecutorEntryPoint = (task: Promise<void>, output?: OperationalCliOutput): Promise<void> => runOperationalCliEntryPoint(task, "ordinary-scenario-executor", output);

if (require.main === module) void runOrdinaryScenarioExecutorEntryPoint(main());
