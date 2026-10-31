import { readFileSync } from "node:fs";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import * as pwaNamespace from "@recent-tx-safe-guard/security-core/pwa";
import type {
  PwaProvisioningExecutionContext,
  PwaProvisioningPlan,
  PwaProvisioningResult,
} from "@recent-tx-safe-guard/security-core/pwa";
import type { StoredCredential } from "./webauthn";
import type { BackendConfig } from "./config";

// Hardhat keeps security-core CommonJS; Node ESM exposes it under default while Vitest exposes named exports.
const pwaRuntime = (pwaNamespace as unknown as { default?: typeof pwaNamespace }).default ?? pwaNamespace;

const {
  createPwaProvisioningRuntime,
  executeApprovedPwaProvisioning,
  loadCommittedPwaPhaseOneProfile,
  pwaProvisioningApprovalHash,
  provisioningPackageHash,
  resolvePwaProvisioningPlan,
  writePwaProvisioningReview,
} = pwaRuntime;

export type PwaProvisioningSummary = Readonly<{
  packageHash: Hex;
  planHash: Hex;
  safe: Address;
  guard: Address;
  delay: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  usdc: Address;
}>;

export type BackendPwaProvisioningResult = Readonly<{
  chainId: 11155111;
  safe: Address;
  guard: Address;
  delay: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  usdc: Address;
  evidence: Readonly<{ setupTransactionHash: Hex; verificationReportHash: Hex; deploymentsHash: Hex; policyHash: Hex }>;
}>;

export type BackendPwaProvisioningCompletion = Readonly<{
  response: BackendPwaProvisioningResult;
  verified: PwaProvisioningResult;
}>;

export type ReviewedPwaProvisioner = Readonly<{
  plan(input: Readonly<{ primary: StoredCredential; secondary: StoredCredential }>): Promise<PwaProvisioningSummary>;
  execute(input: Readonly<{ packageHash: Hex }>): Promise<BackendPwaProvisioningCompletion>;
}>;

export type ReviewedPwaProvisionerOptions = Readonly<{
  reviewDirectory: string;
  approvalPath: string;
  approvalHashPath: string;
  createPlan(input: Readonly<{ primary: StoredCredential; secondary: StoredCredential }>): Promise<PwaProvisioningPlan>;
  executionContext(plan: PwaProvisioningPlan): Promise<Readonly<{ context: PwaProvisioningExecutionContext; close(): void }>> | Readonly<{ context: PwaProvisioningExecutionContext; close(): void }>;
}>;

function hash(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be a bytes32 hash`);
  return value as Hex;
}

function result(value: PwaProvisioningResult): BackendPwaProvisioningResult {
  return Object.freeze({
    chainId: value.chainId,
    safe: value.safe,
    guard: value.guard,
    delay: value.delay,
    primaryPasskey: value.primaryPasskey,
    secondaryPasskey: value.secondaryPasskey,
    usdc: value.usdc,
    evidence: Object.freeze({ setupTransactionHash: value.setupReceipt.transactionHash, verificationReportHash: value.topologyReportHash, deploymentsHash: value.deploymentsHash, policyHash: value.policyHash }),
  });
}

/** Keeps one reviewed plan in memory and loads approval bytes only from the configured local path. */
export function createReviewedPwaProvisioner(options: ReviewedPwaProvisionerOptions): ReviewedPwaProvisioner {
  let pending: Readonly<{ plan: PwaProvisioningPlan; packageHash: Hex }> | undefined;
  return Object.freeze({
    async plan(credentials) {
      if (pending) throw new Error("a PWA provisioning review is already pending");
      const plan = await options.createPlan(credentials);
      const review = writePwaProvisioningReview(plan, options.reviewDirectory);
      pending = Object.freeze({ plan, packageHash: review.packageHash });
      return Object.freeze({ packageHash: review.packageHash, planHash: plan.planHash, safe: plan.safe, guard: plan.guard, delay: plan.delay, primaryPasskey: plan.primaryPasskey, secondaryPasskey: plan.secondaryPasskey, usdc: plan.usdc });
    },
    async execute(input) {
      if (!pending) throw new Error("no reviewed PWA provisioning plan is pending");
      const packageHash = hash(input.packageHash, "packageHash");
      if (packageHash.toLowerCase() !== pending.packageHash.toLowerCase() || provisioningPackageHash(pending.plan).toLowerCase() !== packageHash.toLowerCase()) throw new Error("packageHash does not match the pending reviewed plan");
      let approval: unknown;
      try { approval = JSON.parse(readFileSync(options.approvalPath, "utf8")); }
      catch { throw new Error("local provisioning approval could not be loaded safely"); }
      let reviewedApprovalHash: Hex;
      try { reviewedApprovalHash = hash(readFileSync(options.approvalHashPath, "utf8").trim(), "reviewed approval hash"); }
      catch { throw new Error("independently reviewed provisioning approval hash could not be loaded safely"); }
      if (pwaProvisioningApprovalHash(pending.plan, approval).toLowerCase() !== reviewedApprovalHash.toLowerCase()) throw new Error("local provisioning approval digest does not match the independently reviewed hash");
      const lease = await options.executionContext(pending.plan);
      try {
        const completed = await executeApprovedPwaProvisioning(pending.plan, approval, lease.context);
        pending = undefined;
        return Object.freeze({ response: result(completed), verified: completed });
      } finally {
        lease.close();
      }
    },
  });
}

/** Concrete Sepolia-only composition used by the supported backend entrypoint. */
export function createConfiguredReviewedPwaProvisioner(config: BackendConfig): ReviewedPwaProvisioner {
  const profile = loadCommittedPwaPhaseOneProfile();
  const account = privateKeyToAccount(config.relayPrivateKey);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
  const client = {
    getBytecode: ({ address }: { address: Address }) => publicClient.getCode({ address }),
    getTransactionCount: ({ address }: { address: Address }) => publicClient.getTransactionCount({ address }),
    readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => publicClient.readContract(args as never),
    call: (args: { data: Hex }) => publicClient.call(args),
    getStorageAt: (args: { address: Address; slot: Hex }) => publicClient.getStorageAt(args),
    getChainId: () => publicClient.getChainId(),
    getBalance: ({ address }: { address: Address }) => publicClient.getBalance({ address }),
    sendRawTransaction: ({ serializedTransaction }: { serializedTransaction: Hex }) => publicClient.sendRawTransaction({ serializedTransaction }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      return { transactionHash: receipt.transactionHash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    },
  };
  return createReviewedPwaProvisioner({
    reviewDirectory: config.provisioningReviewDirectory,
    approvalPath: config.provisioningApprovalPath,
    approvalHashPath: config.provisioningApprovalHashPath,
    async createPlan({ primary, secondary }) {
      const expectedDeployerNonce = BigInt(await client.getTransactionCount({ address: account.address }));
      return resolvePwaProvisioningPlan({ profile, deployer: account.address, expectedDeployerNonce, safeProxySaltNonce: 0n, primaryCredential: { x: primary.x, y: primary.y }, secondaryCredential: { x: secondary.x, y: secondary.y }, client });
    },
    executionContext: (plan) => createPwaProvisioningRuntime({ plan, journalPath: config.provisioningJournalPath, account, client }),
  });
}
