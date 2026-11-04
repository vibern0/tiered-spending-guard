import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
  type Address,
  type Account,
  type Hex,
} from "viem";
import {
  isPwaPlanningInfrastructure,
  resolvePwaPlanningInfrastructure,
  resolveVerifiedDeploymentInfrastructure,
  type PlannedPasskeySigner,
  type PwaPlanningInfrastructure,
  type ReadOnlyDeploymentClient,
} from "../config/deployments";
import type { VaultPolicy } from "../config/policy";
import {
  PWA_RECIPIENT,
  REVIEWED_USDC_RUNTIME_CODE_HASH,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_USDC_ADDRESS,
  type PwaPhaseOneProfile,
} from "./profile";
import {
  assertSafeCreationReady,
  buildVaultPlan,
  deriveVaultSafeProxyAddress,
  planHash as vaultPlanHash,
  type PlannedDeploymentTransaction,
  type VaultDeploymentPlan,
  verifyVaultPrerequisites,
} from "../topology/build";
import { deriveComponentAddresses } from "../topology/addressing";
import { isReviewedVaultArtifacts, resolveReviewedVaultArtifacts, type ArtifactResolutionClient, type ReviewedVaultArtifacts } from "../topology/reviewed-artifacts";
import { submitLiveIntent, type LiveContext, type LiveJournal } from "../../scripts/live/submission";
import { verifyTopology } from "../topology/verify";
import { createLiveJournalStore, createSepoliaLiveContext, type SepoliaRpc } from "../../scripts/live/runtime";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const FACTORY_ABI = [
  { name: "getSigner", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] },
  { name: "createSigner", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] },
] as const;
const SAFE_PROXY_FACTORY_ABI = [{ name: "proxyCreationCode", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] }] as const;

export type PwaCredentialCoordinates = Readonly<{ x: bigint; y: bigint }>;
export type PwaProvisioningTransactionId = "primary-signer" | "secondary-signer" | "setup-helper" | "guard" | "delay" | "maintenance" | "safe-proxy";
export type PwaProvisioningTransaction = PlannedDeploymentTransaction & Readonly<{ id: PwaProvisioningTransactionId }>;

export type PwaProvisioningPlan = Readonly<{
  formatVersion: 1;
  chainId: typeof SEPOLIA_CHAIN_ID;
  deployer: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  safe: Address;
  guard: Address;
  delay: Address;
  usdc: Address;
  deploymentsHash: Hex;
  policyHash: Hex;
  planHash: Hex;
  policy: VaultPolicy;
  infrastructure: PwaPlanningInfrastructure;
  transactions: readonly PwaProvisioningTransaction[];
  vaultPlan: VaultDeploymentPlan;
}>;

export type PwaProvisioningApproval = Readonly<{
  formatVersion: 1;
  scope: "sepolia-pwa-provisioning";
  packageHash: Hex;
  planHash: Hex;
  transactions: readonly Readonly<{
    id: PwaProvisioningTransactionId;
    nonce: string;
    gasLimit: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  }>[];
}>;

export type PwaProvisioningReceipt = Readonly<{ status: "success"; blockNumber: bigint }>;
export type ApprovedPwaProvisioningTransaction = PwaProvisioningTransaction & Readonly<{
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}>;
export type PwaProvisioningExecutionContext = Readonly<{
  currentDeployerNonce(): Promise<bigint>;
  submit(transaction: ApprovedPwaProvisioningTransaction): Promise<Readonly<{ transactionHash: Hex; receipt: PwaProvisioningReceipt }>>;
  verifyFinalTopology(plan: PwaProvisioningPlan): Promise<Hex>;
}>;
const reviewedExecutionContexts = new WeakSet<object>();

type PwaExecutionClient = ReadOnlyDeploymentClient & Readonly<{
  getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined>;
}>;

export function createDurablePwaProvisioningExecutionContext(input: Readonly<{
  plan: PwaProvisioningPlan;
  journal: LiveJournal;
  liveContext: LiveContext;
  client: PwaExecutionClient;
}>): PwaProvisioningExecutionContext {
  const verifyProgress = async (transaction: PwaProvisioningTransaction): Promise<void> => {
    const index = input.plan.transactions.findIndex((candidate) => candidate.id === transaction.id);
    if (index < 0) throw new Error("fail closed: provisioning transaction is not in the reviewed plan");
    const observedNonceRaw = await input.client.getTransactionCount?.({ address: input.plan.deployer });
    if (observedNonceRaw === undefined || BigInt(observedNonceRaw) !== transaction.nonce) throw new Error("fail closed: deployer nonce drift before provisioning transaction");
    for (const [candidateIndex, candidate] of input.plan.transactions.entries()) {
      const code = await input.client.getBytecode({ address: candidate.expectedCreatedAddress });
      if (candidateIndex < index) {
        if (!code || code === "0x" || keccak256(code).toLowerCase() !== candidate.expectedRuntimeCodeHash.toLowerCase()) throw new Error(`fail closed: ${candidate.id} runtime evidence missing before ${transaction.id}`);
      } else if (code && code !== "0x") {
        throw new Error(`fail closed: ${candidate.id} address already has code before its reviewed transaction`);
      }
    }
    if (transaction.id === "safe-proxy") {
      const prerequisites = await verifyVaultPrerequisites(input.client, input.plan.vaultPlan, "before-setup");
      assertSafeCreationReady(input.plan.vaultPlan, prerequisites, transaction.nonce);
    }
  };

  const verifyFinalTopology = async (): Promise<Hex> => {
    const finalNonce = input.plan.transactions.at(-1)!.nonce + 1n;
    const primary = input.plan.infrastructure.primaryPasskeySigner;
    const secondary = input.plan.infrastructure.secondaryPasskeySigner;
    const secondaryRuntime = await input.client.getBytecode({ address: secondary.address });
    if (!secondaryRuntime || secondaryRuntime === "0x" || keccak256(secondaryRuntime).toLowerCase() !== secondary.expectedRuntimeCodeHash.toLowerCase()) throw new Error("fail closed: secondary passkey signer runtime changed before final topology verification");
    const deployments = await resolveVerifiedDeploymentInfrastructure(input.client, {
      chainId: SEPOLIA_CHAIN_ID,
      deployer: input.plan.deployer,
      expectedDeployerNonce: finalNonce,
      passkeySigner: { address: primary.address, runtimeCodeHash: primary.expectedRuntimeCodeHash, bindingHash: primary.bindingHash, source: primary.source, binding: primary.binding },
    });
    const prerequisites = await verifyVaultPrerequisites(input.client, input.plan.vaultPlan, "after-setup");
    const report = await verifyTopology({ chainId: SEPOLIA_CHAIN_ID, policy: input.plan.policy, safe: input.plan.safe, guard: input.plan.guard, delay: input.plan.delay, deployments, prerequisites, client: input.client });
    if (!report.ok) throw new Error(`fail closed: final topology verification failed: ${report.failures.join(", ")}`);
    return keccak256(stringToHex(canonical(report)));
  };

  const context: PwaProvisioningExecutionContext = Object.freeze({
    currentDeployerNonce: async () => BigInt(await input.liveContext.nonce()),
    async submit(transaction) {
      const intent = {
        id: `pwa-${transaction.id}`,
        ...(isAddressEqual(transaction.to, ZERO) ? {} : { to: transaction.to }),
        data: transaction.data,
        value: transaction.value,
        nonce: Number(transaction.nonce),
        gas: transaction.gasLimit,
        maxFeePerGas: transaction.maxFeePerGas,
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
      } as const;
      if (!input.journal.entries.some((entry) => entry.id === intent.id)) await verifyProgress(transaction);
      let entry = await submitLiveIntent(intent, input.journal, input.liveContext);
      if (entry.status === "pending") entry = await submitLiveIntent(intent, input.journal, input.liveContext);
      if (!entry.receipt || entry.status !== "success") throw new Error(`fail closed: ${transaction.id} lacks a canonical successful receipt`);
      return Object.freeze({ transactionHash: entry.transactionHash, receipt: Object.freeze({ status: "success" as const, blockNumber: entry.receipt.blockNumber }) });
    },
    verifyFinalTopology,
  });
  reviewedExecutionContexts.add(context);
  return context;
}

export function createPwaProvisioningRuntime(input: Readonly<{
  plan: PwaProvisioningPlan;
  journalPath: string;
  account: Account;
  client: PwaExecutionClient & SepoliaRpc;
}>): Readonly<{ context: PwaProvisioningExecutionContext; close(): void }> {
  if (!isAddressEqual(input.account.address, input.plan.deployer)) throw new Error("fail closed: provisioning account does not match reviewed deployer");
  const store = createLiveJournalStore(input.journalPath, input.account.address);
  const journal = store.load();
  const liveContext = createSepoliaLiveContext({
    account: input.account,
    client: input.client,
    verify: async () => { if (await input.client.getChainId() !== SEPOLIA_CHAIN_ID) throw new Error("fail closed: provisioning chain changed"); },
    persist: async (value) => { store.save(value); },
  });
  try {
    const context = createDurablePwaProvisioningExecutionContext({ plan: input.plan, journal, liveContext, client: input.client });
    return Object.freeze({ context, close: store.close });
  } catch (error) {
    store.close();
    throw error;
  }
}

export function brandPwaProvisioningExecutionContextForTestsOnly(context: PwaProvisioningExecutionContext): PwaProvisioningExecutionContext {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") throw new Error("test-only PWA execution context branding is disabled outside tests");
  reviewedExecutionContexts.add(context);
  return context;
}

export type PwaProvisioningResult = Readonly<{
  chainId: typeof SEPOLIA_CHAIN_ID;
  safe: Address;
  guard: Address;
  delay: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  usdc: Address;
  deploymentsHash: Hex;
  policyHash: Hex;
  setupReceipt: Readonly<{ transactionHash: Hex; blockNumber: bigint }>;
  topologyReportHash: Hex;
}>;
const verifiedProvisioningResults = new WeakSet<object>();

export function isVerifiedPwaProvisioningResult(value: unknown): value is PwaProvisioningResult {
  return typeof value === "object" && value !== null && verifiedProvisioningResults.has(value);
}

export function brandPwaProvisioningResultForTestsOnly(value: PwaProvisioningResult): PwaProvisioningResult {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") throw new Error("test-only PWA provisioning result branding is disabled outside tests");
  verifiedProvisioningResults.add(value);
  return value;
}

type ProvisioningClient = Pick<ReadOnlyDeploymentClient, "getBytecode" | "readContract">;
type PwaPlanResolutionClient = ReadOnlyDeploymentClient & ArtifactResolutionClient;

export type CreatePwaProvisioningPlanInput = Readonly<{
  profile: PwaPhaseOneProfile;
  deployer: Address;
  expectedDeployerNonce: bigint;
  safeProxySaltNonce: bigint;
  primaryCredential: PwaCredentialCoordinates;
  secondaryCredential: PwaCredentialCoordinates;
  infrastructure: PwaPlanningInfrastructure;
  artifacts: ReviewedVaultArtifacts;
  client: ProvisioningClient;
}>;

export type ResolvePwaProvisioningPlanInput = Readonly<{
  profile: PwaPhaseOneProfile;
  deployer: Address;
  expectedDeployerNonce: bigint;
  safeProxySaltNonce: bigint;
  primaryCredential: PwaCredentialCoordinates;
  secondaryCredential: PwaCredentialCoordinates;
  client: PwaPlanResolutionClient;
}>;

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field ${key}`);
  for (const key of expected) if (!(key in value)) throw new Error(`${label} is missing field ${key}`);
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertCanonicalProfile(profile: PwaPhaseOneProfile): void {
  if (profile.chainId !== SEPOLIA_CHAIN_ID || !isAddressEqual(profile.token, SEPOLIA_USDC_ADDRESS) || profile.runtimeCodeHash.toLowerCase() !== REVIEWED_USDC_RUNTIME_CODE_HASH || profile.name !== "USDC" || profile.symbol !== "USDC" || profile.decimals !== 6) throw new Error("PWA provisioning requires the reviewed Sepolia USDC profile");
  if (profile.secondaryProfile !== "contract-only" || profile.periodSeconds !== 86400 || profile.periodAnchor !== 0n) throw new Error("PWA provisioning requires the fixed contract-only daily profile");
  if (profile.limits.basePerTransaction !== 1_000_000n || profile.limits.baseDailyLimit !== 1_000_000n || profile.limits.stepUpPerTransaction !== 3_000_000n || profile.limits.instantDailyLimit !== 3_000_000n) throw new Error("PWA provisioning requires canonical X/Y limits");
  if (profile.delay.cooldownSeconds !== 120 || profile.delay.expirationSeconds !== 600 || profile.baseRecipientMode !== "any-valid-address" || profile.elevatedRecipients.length !== 1 || !isAddressEqual(profile.elevatedRecipients[0]!, PWA_RECIPIENT)) throw new Error("PWA provisioning requires canonical recipient policy and Z delay");
}

function fixedPolicy(input: Readonly<{ profile: PwaPhaseOneProfile; safe: Address; primaryPasskey: Address; secondaryPasskey: Address; delay: Address }>): VaultPolicy {
  return Object.freeze({
    chainId: SEPOLIA_CHAIN_ID,
    safe: input.safe,
    passkey: input.primaryPasskey,
    primary: input.primaryPasskey,
    ecdsaSecondary: ZERO,
    secondaries: [{ address: input.secondaryPasskey, role: "secondary", kind: "safe-contract", enabled: true }],
    secondaryProfile: "contract-only",
    delay: input.delay,
    periodSeconds: 86400,
    periodAnchor: input.profile.periodAnchor,
    cooldownSeconds: input.profile.delay.cooldownSeconds,
    expirationSeconds: input.profile.delay.expirationSeconds,
    assets: [{ token: SEPOLIA_USDC_ADDRESS, basePerTransaction: input.profile.limits.basePerTransaction, stepUpPerTransaction: input.profile.limits.stepUpPerTransaction, baseDailyLimit: input.profile.limits.baseDailyLimit, instantDailyLimit: input.profile.limits.instantDailyLimit, baseRecipientMode: input.profile.baseRecipientMode, recipients: [...input.profile.elevatedRecipients] }],
  });
}

function infrastructureHash(infrastructure: PwaPlanningInfrastructure): Hex {
  return keccak256(stringToHex(canonical({
    chainId: infrastructure.chainId,
    deployer: infrastructure.deployer,
    dependencies: infrastructure.dependencies,
    primaryPasskeySigner: infrastructure.primaryPasskeySigner,
    secondaryPasskeySigner: infrastructure.secondaryPasskeySigner,
  })));
}

function signerTransaction(id: "primary-signer" | "secondary-signer", nonce: bigint, credential: PwaCredentialCoordinates, signer: PlannedPasskeySigner, infrastructure: PwaPlanningInfrastructure): PwaProvisioningTransaction {
  const verifiers = BigInt(infrastructure.passkeySignerVerifier.address);
  const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "createSigner", args: [credential.x, credential.y, verifiers] });
  return Object.freeze({
    id,
    nonce,
    description: `create ${id === "primary-signer" ? "primary" : "secondary"} Safe WebAuthn signer`,
    to: infrastructure.passkeySignerFactory.address,
    value: 0n,
    operation: 0,
    data,
    expectedCreatedAddress: signer.address,
    creationCodeHash: keccak256(data),
    expectedRuntimeCodeHash: signer.expectedRuntimeCodeHash,
  });
}

async function predictedSigner(client: ProvisioningClient, infrastructure: PwaPlanningInfrastructure, credential: PwaCredentialCoordinates): Promise<Address> {
  if (typeof client.readContract !== "function") throw new Error("fail closed: signer factory reader is required");
  const value = await client.readContract({ address: infrastructure.passkeySignerFactory.address, abi: FACTORY_ABI, functionName: "getSigner", args: [credential.x, credential.y, BigInt(infrastructure.passkeySignerVerifier.address)] });
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("fail closed: signer factory prediction is invalid");
  const signer = getAddress(value);
  const bytecode = await client.getBytecode({ address: signer });
  if (bytecode && bytecode !== "0x") throw new Error("fail closed: credential-specific signer already exists");
  return signer;
}

export async function createPwaProvisioningPlan(input: CreatePwaProvisioningPlanInput): Promise<PwaProvisioningPlan> {
  assertCanonicalProfile(input.profile);
  if (!isPwaPlanningInfrastructure(input.infrastructure)) throw new Error("fail closed: PWA planning infrastructure must come from the reviewed resolver");
  if (!isReviewedVaultArtifacts(input.artifacts)) throw new Error("fail closed: reviewed PWA vault artifacts are required");
  if (input.infrastructure.chainId !== SEPOLIA_CHAIN_ID || !isAddressEqual(input.infrastructure.deployer, input.deployer)) throw new Error("fail closed: planning infrastructure identity mismatch");
  if (input.infrastructure.observedDeployerNonce !== input.expectedDeployerNonce) throw new Error("fail closed: deployer nonce does not match reviewed planning state");
  if (input.safeProxySaltNonce < 0n) throw new Error("fail closed: Safe proxy salt must not be negative");
  const primaryBinding = input.infrastructure.primaryPasskeySigner.binding;
  const secondaryBinding = input.infrastructure.secondaryPasskeySigner.binding;
  if (primaryBinding.x !== input.primaryCredential.x || primaryBinding.y !== input.primaryCredential.y || primaryBinding.verifiers !== BigInt(input.infrastructure.passkeySignerVerifier.address)) throw new Error("fail closed: primary credential coordinates do not match reviewed planning evidence");
  if (secondaryBinding.x !== input.secondaryCredential.x || secondaryBinding.y !== input.secondaryCredential.y || secondaryBinding.verifiers !== BigInt(input.infrastructure.passkeySignerVerifier.address)) throw new Error("fail closed: secondary credential coordinates do not match reviewed planning evidence");
  const primaryPasskey = await predictedSigner(input.client, input.infrastructure, input.primaryCredential);
  const secondaryPasskey = await predictedSigner(input.client, input.infrastructure, input.secondaryCredential);
  if (!isAddressEqual(primaryPasskey, input.infrastructure.primaryPasskeySigner.address)) throw new Error("fail closed: primary credential does not match reviewed factory prediction");
  if (!isAddressEqual(secondaryPasskey, input.infrastructure.secondaryPasskeySigner.address)) throw new Error("fail closed: secondary credential does not match reviewed factory prediction");
  if (isAddressEqual(primaryPasskey, secondaryPasskey)) throw new Error("fail closed: primary and secondary credentials must be distinct");

  const prerequisiteNonce = input.expectedDeployerNonce + 2n;
  const components = deriveComponentAddresses({ deployer: input.deployer, startingNonce: prerequisiteNonce });
  const policyBase = fixedPolicy({ profile: input.profile, safe: ZERO, primaryPasskey, secondaryPasskey, delay: components.delay });
  const safe = deriveVaultSafeProxyAddress({ policy: policyBase, deployer: input.deployer, startingNonce: prerequisiteNonce, safeProxySaltNonce: input.safeProxySaltNonce, safeProxyCreationCode: input.artifacts.safeProxyCreationCode, deployments: input.infrastructure });
  const policy = Object.freeze({ ...policyBase, safe });
  const vaultPlan = buildVaultPlan({ policy, deployer: input.deployer, startingNonce: prerequisiteNonce, safeProxySaltNonce: input.safeProxySaltNonce, artifacts: input.artifacts, deployments: input.infrastructure, plannedPrefixTransactionCount: 2 });
  const signerTransactions = [
    signerTransaction("primary-signer", input.expectedDeployerNonce, input.primaryCredential, input.infrastructure.primaryPasskeySigner, input.infrastructure),
    signerTransaction("secondary-signer", input.expectedDeployerNonce + 1n, input.secondaryCredential, input.infrastructure.secondaryPasskeySigner, input.infrastructure),
  ] as const;
  const transactions = Object.freeze([
    ...signerTransactions,
    Object.freeze({ id: "setup-helper" as const, ...vaultPlan.prerequisites.setupHelper }),
    Object.freeze({ id: "guard" as const, ...vaultPlan.prerequisites.guard }),
    Object.freeze({ id: "delay" as const, ...vaultPlan.prerequisites.delay }),
    Object.freeze({ id: "maintenance" as const, ...vaultPlan.prerequisites.maintenance }),
    Object.freeze({ id: "safe-proxy" as const, ...vaultPlan.safeProxyDeployment }),
  ]);
  const planHash = keccak256(stringToHex(canonical({ signerTransactions, vaultPlanHash: vaultPlanHash(vaultPlan) })));
  return Object.freeze({ formatVersion: 1, chainId: SEPOLIA_CHAIN_ID, deployer: input.deployer, primaryPasskey, secondaryPasskey, safe, guard: components.guard, delay: components.delay, usdc: SEPOLIA_USDC_ADDRESS, deploymentsHash: infrastructureHash(input.infrastructure), policyHash: vaultPlan.review.policyHash, planHash, policy, infrastructure: input.infrastructure, transactions, vaultPlan });
}

export async function resolvePwaProvisioningPlan(input: ResolvePwaProvisioningPlanInput): Promise<PwaProvisioningPlan> {
  assertCanonicalProfile(input.profile);
  const infrastructure = await resolvePwaPlanningInfrastructure(input.client, {
    chainId: SEPOLIA_CHAIN_ID,
    deployer: input.deployer,
    expectedDeployerNonce: input.expectedDeployerNonce,
    primaryCredential: input.primaryCredential,
    secondaryCredential: input.secondaryCredential,
  });
  const secondaryPasskey = await predictedSigner(input.client, infrastructure, input.secondaryCredential);
  const prerequisiteNonce = input.expectedDeployerNonce + 2n;
  const components = deriveComponentAddresses({ deployer: input.deployer, startingNonce: prerequisiteNonce });
  const proxyCreationCode = await input.client.readContract({ address: infrastructure.safeProxyFactory.address, abi: SAFE_PROXY_FACTORY_ABI, functionName: "proxyCreationCode" });
  if (typeof proxyCreationCode !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(proxyCreationCode)) throw new Error("fail closed: Safe proxy factory returned invalid creation code");
  const preliminary = fixedPolicy({ profile: input.profile, safe: ZERO, primaryPasskey: infrastructure.primaryPasskeySigner.address, secondaryPasskey, delay: components.delay });
  const safe = deriveVaultSafeProxyAddress({ policy: preliminary, deployer: input.deployer, startingNonce: prerequisiteNonce, safeProxySaltNonce: input.safeProxySaltNonce, safeProxyCreationCode: proxyCreationCode as Hex, deployments: infrastructure });
  const artifacts = await resolveReviewedVaultArtifacts({ client: input.client, deployments: infrastructure, safe, primaryPasskey: infrastructure.primaryPasskeySigner.address, ecdsaSecondary: ZERO, delay: components.delay, maintenance: components.maintenance, periodAnchor: input.profile.periodAnchor, cooldownSeconds: BigInt(input.profile.delay.cooldownSeconds), expirationSeconds: BigInt(input.profile.delay.expirationSeconds) });
  return createPwaProvisioningPlan({ ...input, infrastructure, artifacts });
}

function reviewPayload(plan: PwaProvisioningPlan): unknown {
  return {
    formatVersion: plan.formatVersion,
    scope: "sepolia-pwa-provisioning-review",
    chainId: plan.chainId,
    deployer: plan.deployer,
    planHash: plan.planHash,
    addresses: { safe: plan.safe, guard: plan.guard, delay: plan.delay, primaryPasskey: plan.primaryPasskey, secondaryPasskey: plan.secondaryPasskey, usdc: plan.usdc },
    policy: plan.vaultPlan.review,
    transactions: plan.transactions,
  };
}

export function provisioningPackageHash(plan: PwaProvisioningPlan): Hex {
  return keccak256(stringToHex(canonical(reviewPayload(plan))));
}

function repositoryRoot(): string {
  const root = realpathSync(resolve(__dirname, "../../../.."));
  const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces?: unknown };
  if (!Array.isArray(value.workspaces) || !value.workspaces.includes("packages/*") || !value.workspaces.includes("apps/*")) throw new Error("repository root could not be resolved safely");
  return root;
}

function resolveExternalPath(value: string, label: string): string {
  const parts: string[] = [];
  let existing = resolve(value);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    parts.unshift(basename(existing));
    existing = parent;
  }
  const output = resolve(realpathSync(existing), ...parts);
  const relativePath = relative(repositoryRoot(), output);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) throw new Error(`${label} must be outside the repository`);
  return output;
}

export function writePwaProvisioningReview(plan: PwaProvisioningPlan, outputDirectory: string): { packageHash: Hex; path: string } {
  if (!isAbsolute(outputDirectory)) throw new Error("review output directory must be absolute and outside the repository");
  const output = resolveExternalPath(outputDirectory, "review output directory");
  const packageHash = provisioningPackageHash(plan);
  const path = join(output, `${packageHash.slice(2)}.pwa-provisioning-review.json`);
  const document = `${canonical({ packageHash, review: reviewPayload(plan) })}\n`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (readFileSync(path, "utf8") === document) return { packageHash, path };
    throw new Error("review package path already contains different bytes");
  } catch (error) {
    if (error instanceof Error && error.message === "review package path already contains different bytes") throw error;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, document, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  return { packageHash, path };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function assertPwaProvisioningApproval(plan: PwaProvisioningPlan, value: unknown): PwaProvisioningApproval {
  const approval = record(value, "provisioning approval");
  exactKeys(approval, ["formatVersion", "scope", "packageHash", "planHash", "transactions"], "provisioning approval");
  if (approval.formatVersion !== 1 || approval.scope !== "sepolia-pwa-provisioning") throw new Error("unsupported provisioning approval");
  if (approval.packageHash !== provisioningPackageHash(plan) || approval.planHash !== plan.planHash) throw new Error("provisioning approval hash mismatch");
  if (!Array.isArray(approval.transactions) || approval.transactions.length !== plan.transactions.length) throw new Error("provisioning approval transaction count mismatch");
  const transactions = approval.transactions.map((item, index) => {
    const transaction = record(item, `provisioning approval transaction ${index}`);
    exactKeys(transaction, ["id", "nonce", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas"], `provisioning approval transaction ${index}`);
    const planned = plan.transactions[index]!;
    if (transaction.id !== planned.id || transaction.nonce !== planned.nonce.toString()) throw new Error("provisioning approval transaction identity mismatch");
    for (const field of ["nonce", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas"] as const) if (typeof transaction[field] !== "string" || !DECIMAL.test(transaction[field] as string)) throw new Error(`provisioning approval ${field} is not canonical`);
    if (BigInt(transaction.gasLimit as string) === 0n || BigInt(transaction.maxFeePerGas as string) === 0n || BigInt(transaction.maxPriorityFeePerGas as string) > BigInt(transaction.maxFeePerGas as string)) throw new Error("provisioning approval fee fields are invalid");
    return Object.freeze(transaction) as PwaProvisioningApproval["transactions"][number];
  });
  return Object.freeze({ formatVersion: 1, scope: "sepolia-pwa-provisioning", packageHash: approval.packageHash as Hex, planHash: approval.planHash as Hex, transactions: Object.freeze(transactions) });
}

export function pwaProvisioningApprovalHash(plan: PwaProvisioningPlan, value: unknown): Hex {
  return keccak256(stringToHex(canonical(assertPwaProvisioningApproval(plan, value))));
}

export async function executeApprovedPwaProvisioning(plan: PwaProvisioningPlan, approvalValue: unknown, context: PwaProvisioningExecutionContext): Promise<PwaProvisioningResult> {
  if (!reviewedExecutionContexts.has(context)) throw new Error("fail closed: durable reviewed provisioning execution context is required");
  const approval = assertPwaProvisioningApproval(plan, approvalValue);
  const currentNonce = await context.currentDeployerNonce();
  const firstNonce = plan.transactions[0]!.nonce;
  const afterLastNonce = plan.transactions.at(-1)!.nonce + 1n;
  if (currentNonce < firstNonce || currentNonce > afterLastNonce) throw new Error("fail closed: deployer nonce is outside the reviewed provisioning range");
  let setupReceipt: PwaProvisioningResult["setupReceipt"] | undefined;
  for (const [index, transaction] of plan.transactions.entries()) {
    const approved = approval.transactions[index]!;
    const result = await context.submit(Object.freeze({
      ...transaction,
      gasLimit: BigInt(approved.gasLimit),
      maxFeePerGas: BigInt(approved.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(approved.maxPriorityFeePerGas),
    }));
    if (result.receipt.status !== "success" || !HASH.test(result.transactionHash)) throw new Error(`fail closed: ${transaction.id} did not confirm successfully`);
    if (transaction.id === "safe-proxy") setupReceipt = Object.freeze({ transactionHash: result.transactionHash, blockNumber: result.receipt.blockNumber });
  }
  if (!setupReceipt) throw new Error("fail closed: Safe setup receipt is missing");
  const topologyReportHash = await context.verifyFinalTopology(plan);
  if (!HASH.test(topologyReportHash)) throw new Error("fail closed: topology report hash is invalid");
  const result = Object.freeze({ chainId: SEPOLIA_CHAIN_ID, safe: plan.safe, guard: plan.guard, delay: plan.delay, primaryPasskey: plan.primaryPasskey, secondaryPasskey: plan.secondaryPasskey, usdc: plan.usdc, deploymentsHash: plan.deploymentsHash, policyHash: plan.policyHash, setupReceipt, topologyReportHash });
  verifiedProvisioningResults.add(result);
  return result;
}
