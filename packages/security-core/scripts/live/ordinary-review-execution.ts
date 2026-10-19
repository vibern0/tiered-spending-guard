import type { Hex } from "viem";
import { planHash, type VaultDeploymentPlan } from "../../src/topology/build";
import { assertOrdinaryReviewPlan, type OrdinaryReviewConfig } from "./ordinary-review-profile";
import { loadReviewedVaultPrerequisiteApproval, type ReviewedVaultPrerequisiteApproval } from "./vault-runner";

export type OrdinaryReviewExecutionPreflight = Readonly<{
  approval: ReviewedVaultPrerequisiteApproval;
  report: Readonly<{
    status: "PREFLIGHT_ONLY";
    planHash: Hex;
    packageHash: Hex;
    startingNonce: string;
    prerequisites: readonly Readonly<{
      id: string;
      nonce: string;
      gasCap: string;
      maxFeePerGasCap: string;
      maxPriorityFeePerGasCap: string;
    }>[];
    maximumPrerequisiteReservedOutlay: string;
    signed: false;
    broadcast: false;
  }>;
}>;

export function prepareOrdinaryReviewExecutionPreflight(
  config: OrdinaryReviewConfig,
  plan: VaultDeploymentPlan,
  packageDirectory: string,
  expectedPackageHash: Hex,
): OrdinaryReviewExecutionPreflight {
  assertOrdinaryReviewPlan(config, plan);
  const approval = loadReviewedVaultPrerequisiteApproval(plan, packageDirectory, expectedPackageHash);
  const report = Object.freeze({
    status: "PREFLIGHT_ONLY" as const,
    planHash: planHash(plan),
    packageHash: approval.packageHash,
    startingNonce: plan.startingNonce.toString(),
    prerequisites: Object.freeze(approval.steps.map((step) => Object.freeze({
      id: step.id,
      nonce: step.nonce.toString(),
      gasCap: step.gas.toString(),
      maxFeePerGasCap: step.maxFeePerGas.toString(),
      maxPriorityFeePerGasCap: step.maxPriorityFeePerGas.toString(),
    }))),
    maximumPrerequisiteReservedOutlay: approval.maximumPrerequisiteReservedOutlay.toString(),
    signed: false as const,
    broadcast: false as const,
  });
  return Object.freeze({ approval, report });
}

export async function runOnlyWithLiveSubmitAuthorization<T>(
  liveSubmit: string | undefined,
  submit: () => Promise<T>,
): Promise<Readonly<{ status: "PREFLIGHT_ONLY" }> | Readonly<{ status: "LIVE_SUBMIT"; result: T }>> {
  if (liveSubmit === undefined) return Object.freeze({ status: "PREFLIGHT_ONLY" as const });
  if (liveSubmit !== "YES") throw new Error("live prerequisite execution requires exact LIVE_SUBMIT=YES");
  return Object.freeze({ status: "LIVE_SUBMIT" as const, result: await submit() });
}
