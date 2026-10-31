import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  isPwaPlanningInfrastructure,
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
  buildVaultPlan,
  deriveVaultSafeProxyAddress,
  planHash as vaultPlanHash,
  type PlannedDeploymentTransaction,
  type VaultDeploymentPlan,
} from "../topology/build";
import { deriveComponentAddresses } from "../topology/addressing";
import { isReviewedVaultArtifacts, type ReviewedVaultArtifacts } from "../topology/reviewed-artifacts";
import { submitLiveIntent, type LiveContext, type LiveJournal } from "../../scripts/live/submission";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const FACTORY_ABI = [
  { name: "getSigner", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] },
  { name: "createSigner", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] },
] as const;

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
  planHash: Hex;
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

export function createDurablePwaProvisioningExecutionContext(input: Readonly<{
  journal: LiveJournal;
  liveContext: LiveContext;
  verifyFinalTopology(plan: PwaProvisioningPlan): Promise<Hex>;
}>): PwaProvisioningExecutionContext {
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
      let entry = await submitLiveIntent(intent, input.journal, input.liveContext);
      if (entry.status === "pending") entry = await submitLiveIntent(intent, input.journal, input.liveContext);
      if (!entry.receipt || entry.status !== "success") throw new Error(`fail closed: ${transaction.id} lacks a canonical successful receipt`);
      return Object.freeze({ transactionHash: entry.transactionHash, receipt: Object.freeze({ status: "success" as const, blockNumber: entry.receipt.blockNumber }) });
    },
    verifyFinalTopology: input.verifyFinalTopology,
  });
  reviewedExecutionContexts.add(context);
  return context;
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
  setupReceipt: Readonly<{ transactionHash: Hex; blockNumber: bigint }>;
  topologyReportHash: Hex;
}>;

type ProvisioningClient = Pick<ReadOnlyDeploymentClient, "getBytecode" | "readContract">;

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
  if (profile.delay.cooldownSeconds !== 120 || profile.delay.expirationSeconds !== 600 || !isAddressEqual(profile.recipient, PWA_RECIPIENT)) throw new Error("PWA provisioning requires canonical recipient and Z delay");
}

function signerTransaction(id: "primary-signer" | "secondary-signer", nonce: bigint, credential: PwaCredentialCoordinates, address: Address, infrastructure: PwaPlanningInfrastructure): PwaProvisioningTransaction {
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
    expectedCreatedAddress: address,
    creationCodeHash: keccak256(data),
    expectedRuntimeCodeHash: infrastructure.primaryPasskeySigner.expectedRuntimeCodeHash,
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
  if (primaryBinding.x !== input.primaryCredential.x || primaryBinding.y !== input.primaryCredential.y || primaryBinding.verifiers !== BigInt(input.infrastructure.passkeySignerVerifier.address)) throw new Error("fail closed: primary credential coordinates do not match reviewed planning evidence");
  const primaryPasskey = await predictedSigner(input.client, input.infrastructure, input.primaryCredential);
  const secondaryPasskey = await predictedSigner(input.client, input.infrastructure, input.secondaryCredential);
  if (!isAddressEqual(primaryPasskey, input.infrastructure.primaryPasskeySigner.address)) throw new Error("fail closed: primary credential does not match reviewed factory prediction");
  if (isAddressEqual(primaryPasskey, secondaryPasskey)) throw new Error("fail closed: primary and secondary credentials must be distinct");

  const prerequisiteNonce = input.expectedDeployerNonce + 2n;
  const components = deriveComponentAddresses({ deployer: input.deployer, startingNonce: prerequisiteNonce });
  const policyBase: VaultPolicy = {
    chainId: SEPOLIA_CHAIN_ID,
    safe: ZERO,
    passkey: primaryPasskey,
    primary: primaryPasskey,
    ecdsaSecondary: ZERO,
    secondaries: [{ address: secondaryPasskey, role: "secondary", kind: "safe-contract", enabled: true }],
    secondaryProfile: "contract-only",
    delay: components.delay,
    periodSeconds: 86400,
    periodAnchor: input.profile.periodAnchor,
    cooldownSeconds: input.profile.delay.cooldownSeconds,
    expirationSeconds: input.profile.delay.expirationSeconds,
    assets: [{
      token: SEPOLIA_USDC_ADDRESS,
      basePerTransaction: input.profile.limits.basePerTransaction,
      stepUpPerTransaction: input.profile.limits.stepUpPerTransaction,
      baseDailyLimit: input.profile.limits.baseDailyLimit,
      instantDailyLimit: input.profile.limits.instantDailyLimit,
      recipients: [PWA_RECIPIENT],
    }],
  };
  const safe = deriveVaultSafeProxyAddress({ policy: policyBase, deployer: input.deployer, startingNonce: prerequisiteNonce, safeProxySaltNonce: input.safeProxySaltNonce, safeProxyCreationCode: input.artifacts.safeProxyCreationCode, deployments: input.infrastructure });
  const policy = Object.freeze({ ...policyBase, safe });
  const vaultPlan = buildVaultPlan({ policy, deployer: input.deployer, startingNonce: prerequisiteNonce, safeProxySaltNonce: input.safeProxySaltNonce, artifacts: input.artifacts, deployments: input.infrastructure, plannedPrefixTransactionCount: 2 });
  const signerTransactions = [
    signerTransaction("primary-signer", input.expectedDeployerNonce, input.primaryCredential, primaryPasskey, input.infrastructure),
    signerTransaction("secondary-signer", input.expectedDeployerNonce + 1n, input.secondaryCredential, secondaryPasskey, input.infrastructure),
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
  return Object.freeze({ formatVersion: 1, chainId: SEPOLIA_CHAIN_ID, deployer: input.deployer, primaryPasskey, secondaryPasskey, safe, guard: components.guard, delay: components.delay, usdc: SEPOLIA_USDC_ADDRESS, planHash, infrastructure: input.infrastructure, transactions, vaultPlan });
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
  const cwd = resolve(process.cwd());
  const marker = `${join("packages", "security-core")}`;
  const index = cwd.lastIndexOf(marker);
  return index >= 0 ? cwd.slice(0, Math.max(0, index - 1)) : cwd;
}

export function writePwaProvisioningReview(plan: PwaProvisioningPlan, outputDirectory: string): { packageHash: Hex; path: string } {
  if (!isAbsolute(outputDirectory)) throw new Error("review output directory must be absolute and outside the repository");
  const output = resolve(outputDirectory);
  const repository = repositoryRoot();
  const relativePath = relative(repository, output);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) throw new Error("review output directory must be outside the repository");
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

export async function executeApprovedPwaProvisioning(plan: PwaProvisioningPlan, approvalValue: unknown, context: PwaProvisioningExecutionContext): Promise<PwaProvisioningResult> {
  if (!reviewedExecutionContexts.has(context)) throw new Error("fail closed: durable reviewed provisioning execution context is required");
  const approval = assertPwaProvisioningApproval(plan, approvalValue);
  const currentNonce = await context.currentDeployerNonce();
  if (currentNonce !== plan.transactions[0]!.nonce) throw new Error("fail closed: deployer nonce changed after review");
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
  return Object.freeze({ chainId: SEPOLIA_CHAIN_ID, safe: plan.safe, guard: plan.guard, delay: plan.delay, primaryPasskey: plan.primaryPasskey, secondaryPasskey: plan.secondaryPasskey, usdc: plan.usdc, setupReceipt, topologyReportHash });
}
