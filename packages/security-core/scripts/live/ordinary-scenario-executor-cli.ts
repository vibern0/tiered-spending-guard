import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { assertOrdinaryScenarioReviewCliEnvironment } from "./ordinary-scenario-review-cli";
import { createOrdinaryScenarioJournal, createOrdinaryScenarioProposal, createOrdinaryScenarioStore, executeOrdinaryScenarioAction, loadOrdinaryScenarioApproval, type OrdinaryScenarioExecutionContext, type OrdinaryScenarioExecutionResult } from "./ordinary-scenario-executor";
import { createFrozenSafeSignerProvider, createOrdinaryScenarioExecutionContext, createOrdinaryScenarioStateReader, requireSixConfirmationReceipts } from "./ordinary-scenario-adapter";
import { PUBLIC_ARCHIVE_RPC, PUBLIC_CURRENT_RPC, reconstructReviewedPlan } from "./ordinary-scenario-review-cli";
import { createPasskeySignerCore } from "../../src/signers/passkey-core";
import { createEip1193SecondarySigner } from "../../src/signers/eip1193";
import type { LiveIntent } from "./submission";

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

function createDefaultDependencies(options: OrdinaryScenarioCliOptions, repository: string): OrdinaryScenarioCliDependencies {
  const current = createPublicClient({ chain: sepolia, transport: http(PUBLIC_CURRENT_RPC) });
  const archive = createPublicClient({ chain: sepolia, transport: http(PUBLIC_ARCHIVE_RPC) });
  let reconstruction: Awaited<ReturnType<typeof reconstructReviewedPlan>> | undefined;
  const profile = async () => reconstruction ??= await reconstructReviewedPlan(repository, archive);
  const readiness = (proposal: ReturnType<typeof createOrdinaryScenarioProposal>) => async () => validateObserverStartup(repository, proposal.observerEvidenceHash);
  return {
    environment: process.env,
    publicPreflight: async proposal => {
      const journal = { schemaVersion: 1 as const, chainId: 11155111 as const, reviewPackageHash: proposal.reviewPackageHash, proposalHash: proposal.proposalHash, approvalHash: `0x${"00".repeat(32)}` as Hex, funder: proposal.funder, liveJournal: { chainId: 11155111, funder: proposal.funder, entries: [] }, actions: [] };
      const reader = createOrdinaryScenarioStateReader({ repository, proposal, journal: () => journal, currentClient: current, archiveClient: archive, observerReadiness: readiness(proposal) });
      await reader(proposal.actions[0]!, "pre-private");
      return { ready: true, detail: "canonical public topology/state verified; signed gas proof remains NOT_RUN" };
    },
    createContext: async (mode, proposal, journal) => {
      const passkeyProvider = (address: Address) => ({ request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
        if (method === "eth_chainId") return "0xaa36a7";
        if (method === "eth_call") { const call = params?.[0] as { to: Address; data: Hex }; return (await current.call({ to: call.to, data: call.data })).data ?? "0x"; }
        throw new Error("unsupported passkey verifier provider method");
      } });
      const loadSigners = async (action: Parameters<OrdinaryScenarioExecutionContext["materialize"]>[0]) => {
        const reviewed = await profile();
        const { loadCredential, loadFundingKey } = await import("./secrets");
        const { signWebAuthn } = await import("./webauthn");
        const primaryCredential = loadCredential(requiredEnvironment(process.env, "LIVE_PRIMARY_CREDENTIAL_FILE"), repository);
        if (primaryCredential.x !== reviewed.primaryBinding.x || primaryCredential.y !== reviewed.primaryBinding.y) throw new Error("primary credential does not match reviewed public coordinates");
        const primaryAddress = await current.readContract({ address: reviewed.bindings.factory, abi: FACTORY_ABI, functionName: "getSigner", args: [primaryCredential.x, primaryCredential.y, reviewed.primaryBinding.verifiers] });
        if (primaryAddress.toLowerCase() !== proposal.primarySigner.toLowerCase()) throw new Error("primary credential factory binding mismatch");
        const primary = createPasskeySignerCore({ address: proposal.primarySigner, verifierAddress: proposal.primarySigner, chainId: 11155111, role: "primary", provider: passkeyProvider(proposal.primarySigner), sign: async request => signWebAuthn(primaryCredential, request.safeTxHash) });
        if (action.signerRoles.includes("safe-contract-secondary")) {
          const credential = loadCredential(requiredEnvironment(process.env, "LIVE_SECONDARY_CREDENTIAL_FILE"), repository);
          if (credential.x !== reviewed.secondaryBinding.x || credential.y !== reviewed.secondaryBinding.y) throw new Error("secondary credential does not match reviewed public coordinates");
          const address = await current.readContract({ address: reviewed.bindings.factory, abi: FACTORY_ABI, functionName: "getSigner", args: [credential.x, credential.y, reviewed.secondaryBinding.verifiers] });
          if (address.toLowerCase() !== proposal.safeContractSecondary.toLowerCase()) throw new Error("secondary credential factory binding mismatch");
          return { primary, secondary: createPasskeySignerCore({ address: proposal.safeContractSecondary, verifierAddress: proposal.safeContractSecondary, chainId: 11155111, role: "secondary", provider: passkeyProvider(proposal.safeContractSecondary), sign: async request => signWebAuthn(credential, request.safeTxHash) }) };
        }
        if (action.signerRoles.includes("legacy-ecdsa-secondary")) {
          const key = loadFundingKey(requiredEnvironment(process.env, "LIVE_ECDSA_KEY_FILE"), repository); const account = privateKeyToAccount(key);
          if (account.address.toLowerCase() !== proposal.ecdsaSecondary.toLowerCase()) throw new Error("ECDSA credential does not match reviewed public identity");
          const tx = action.safeTransaction;
          const frozenRequest = tx && { chainId: 11155111, safe: proposal.safe, safeTxHash: tx.safeTxHash, typedData: { domain: { chainId: 11155111, verifyingContract: proposal.safe }, types: { SafeTx: (await import("../../src/signers/types")).SAFE_TX_TYPES }, primaryType: "SafeTx" as const, message: { to: tx.to, value: tx.value, data: tx.data, operation: tx.operation as 0 | 1, safeTxGas: tx.safeTxGas, baseGas: tx.baseGas, gasPrice: tx.gasPrice, gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: tx.safeNonce } } };
          if (!frozenRequest) throw new Error("ECDSA action lacks reviewed Safe request");
          const provider = createFrozenSafeSignerProvider({ account: account.address, request: frozenRequest, signTypedData: request => account.signTypedData(request.typedData as never) });
          return { primary, secondary: createEip1193SecondarySigner({ provider, account: account.address }) };
        }
        return { primary };
      };
      let fundingAccount: ReturnType<typeof privateKeyToAccount> | undefined;
      const account = async () => {
        if (mode !== "submit-one") throw new Error("resume-one signing capability is disabled");
        if (!fundingAccount) { const { loadFundingKey } = await import("./secrets"); fundingAccount = privateKeyToAccount(loadFundingKey(requiredEnvironment(process.env, "LIVE_FUNDING_KEY_FILE"), repository)); if (fundingAccount.address.toLowerCase() !== proposal.funder.toLowerCase()) throw new Error("funding key does not match reviewed funder"); }
        return fundingAccount;
      };
      const baseLive = { funder: proposal.funder, chainId: () => current.getChainId(), nonce: async () => Number(await current.getTransactionCount({ address: proposal.funder })), balance: () => current.getBalance({ address: proposal.funder }), sign: async (intent: LiveIntent) => (await account()).signTransaction({ chainId: 11155111, type: "eip1559", to: intent.to, data: intent.data, value: intent.value, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }), broadcast: async (raw: Hex) => { if (mode !== "submit-one") throw new Error("resume-one broadcast capability is disabled"); return current.sendRawTransaction({ serializedTransaction: raw }); }, receipt: async (hash: Hex) => { try { const receipt = await current.getTransactionReceipt({ hash }); return { transactionHash: receipt.transactionHash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }; } catch { return undefined; } } };
      const live = requireSixConfirmationReceipts(baseLive, { blockNumber: current.getBlockNumber, blockHash: async number => { const block = await current.getBlock({ blockNumber: number }); if (!block.hash) throw new Error("canonical block hash unavailable"); return block.hash; } });
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

if (require.main === module) void main().catch(error => { process.stderr.write(`ordinary scenario executor failed: ${error instanceof Error ? error.message : "unknown error"}\n`); process.exitCode = 1; });
