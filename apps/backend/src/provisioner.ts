import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import {
  executeApprovedPwaProvisioning,
  provisioningPackageHash,
  writePwaProvisioningReview,
  type PwaProvisioningExecutionContext,
  type PwaProvisioningPlan,
  type PwaProvisioningResult,
} from "@recent-tx-safe-guard/security-core/pwa";
import type { StoredCredential } from "./webauthn";

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
  evidence: Readonly<{ setupTransactionHash: Hex; verificationReportHash: Hex }>;
}>;

export type ReviewedPwaProvisioner = Readonly<{
  plan(input: Readonly<{ primary: StoredCredential; secondary: StoredCredential }>): Promise<PwaProvisioningSummary>;
  execute(input: Readonly<{ packageHash: Hex }>): Promise<BackendPwaProvisioningResult>;
}>;

export type ReviewedPwaProvisionerOptions = Readonly<{
  reviewDirectory: string;
  approvalPath: string;
  createPlan(input: Readonly<{ primary: StoredCredential; secondary: StoredCredential }>): Promise<PwaProvisioningPlan>;
  executionContext(plan: PwaProvisioningPlan): Promise<PwaProvisioningExecutionContext> | PwaProvisioningExecutionContext;
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
    evidence: Object.freeze({ setupTransactionHash: value.setupReceipt.transactionHash, verificationReportHash: value.topologyReportHash }),
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
      const completed = await executeApprovedPwaProvisioning(pending.plan, approval, await options.executionContext(pending.plan));
      pending = undefined;
      return result(completed);
    },
  });
}
