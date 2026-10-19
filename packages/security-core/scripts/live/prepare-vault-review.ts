import type { Address, Hex } from "viem";
import { isReviewedVaultDeploymentPlan, type VaultDeploymentPlan } from "../../src/topology/build";
import { PHASE_OUTLAY_LIMIT } from "./submission";
import type { VaultDeploymentReviewEvidence } from "../package-sepolia-rehearsal";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export type VaultReviewClient = Readonly<{
  getBlockNumber(): Promise<bigint>;
  getTransactionCount(args: { address: Address }): Promise<number | bigint>;
  getBalance(args: { address: Address }): Promise<bigint>;
  estimateGas(args: { account: Address; to?: Address; data: Hex; value: bigint; nonce: number }): Promise<bigint>;
  call(args: { account: Address; to?: Address; data: Hex; value: bigint; nonce: number; gas: bigint }): Promise<unknown>;
}>;

export type VaultReviewLimits = Readonly<{
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  safeCreationGasLimit: bigint;
  runtimeChecks: VaultDeploymentReviewEvidence["runtimeChecks"];
  assetChecks: VaultDeploymentReviewEvidence["assetChecks"];
}>;

const prerequisiteSteps = (plan: VaultDeploymentPlan) => [
  { id: "vault-setup-helper" as const, transaction: plan.prerequisites.setupHelper },
  { id: "vault-guard" as const, transaction: plan.prerequisites.guard },
  { id: "vault-delay" as const, transaction: plan.prerequisites.delay },
  { id: "vault-maintenance" as const, transaction: plan.prerequisites.maintenance },
];

function reviewedGasLimit(estimate: bigint): bigint {
  return (estimate * 120n + 99n) / 100n;
}

/** Performs only public reads and eth_estimateGas calls. It cannot sign or broadcast. */
export async function collectVaultDeploymentReviewEvidence(
  plan: VaultDeploymentPlan,
  client: VaultReviewClient,
  limits: VaultReviewLimits,
): Promise<VaultDeploymentReviewEvidence> {
  if (!isReviewedVaultDeploymentPlan(plan)) throw new Error("fail closed: vault deployment plan was not produced by the reviewed planner");
  if (limits.maxFeePerGas <= 0n || limits.maxPriorityFeePerGas < 0n || limits.maxPriorityFeePerGas > limits.maxFeePerGas || limits.safeCreationGasLimit <= 0n) {
    throw new Error("invalid reviewed deployment fee limits");
  }
  const observedNonceRaw = await client.getTransactionCount({ address: plan.deployer });
  const observedDeployerNonce = typeof observedNonceRaw === "bigint" ? observedNonceRaw : BigInt(observedNonceRaw);
  if (observedDeployerNonce !== plan.startingNonce) throw new Error(`deployer nonce changed: expected ${plan.startingNonce}, observed ${observedDeployerNonce}`);

  const [snapshotBlockNumber, funderBalance] = await Promise.all([
    client.getBlockNumber(),
    client.getBalance({ address: plan.deployer }),
  ]);
  const transactions: VaultDeploymentReviewEvidence["transactions"][number][] = [];
  for (const { id, transaction } of prerequisiteSteps(plan)) {
    const estimatedGas = await client.estimateGas({
      account: plan.deployer,
      ...(transaction.to.toLowerCase() === ZERO ? {} : { to: transaction.to }),
      data: transaction.data,
      value: transaction.value,
      nonce: Number(transaction.nonce),
    });
    const proposedGasLimit = reviewedGasLimit(estimatedGas);
    await client.call({
      account: plan.deployer,
      ...(transaction.to.toLowerCase() === ZERO ? {} : { to: transaction.to }),
      data: transaction.data,
      value: transaction.value,
      nonce: Number(transaction.nonce),
      gas: proposedGasLimit,
    });
    transactions.push({
      id,
      nonce: transaction.nonce,
      estimateStatus: "estimated",
      estimatedGas,
      reviewedGasLimit: proposedGasLimit,
      limitSimulationStatus: "eth_call-succeeded",
      maxFeePerGas: limits.maxFeePerGas,
      maxPriorityFeePerGas: limits.maxPriorityFeePerGas,
    });
  }
  transactions.push({
    id: "vault-safe",
    nonce: plan.safeProxyDeployment.nonce,
    estimateStatus: "deferred-until-prerequisites",
    reviewedGasLimit: limits.safeCreationGasLimit,
    maxFeePerGas: limits.maxFeePerGas,
    maxPriorityFeePerGas: limits.maxPriorityFeePerGas,
  });
  const maximumReservedOutlay = transactions.reduce((total, transaction) => total + transaction.reviewedGasLimit * transaction.maxFeePerGas, 0n);
  if (maximumReservedOutlay > PHASE_OUTLAY_LIMIT) {
    const limits = transactions.map((transaction) => `${transaction.id}=${transaction.reviewedGasLimit}`).join(", ");
    throw new Error(`reviewed deployment exceeds phase outlay ceiling: reserved ${maximumReservedOutlay}, ceiling ${PHASE_OUTLAY_LIMIT}; gas limits ${limits}`);
  }
  if (funderBalance < maximumReservedOutlay) throw new Error("funder balance is below maximum reviewed deployment outlay");

  return Object.freeze({
    snapshotBlockNumber,
    observedDeployerNonce,
    funderBalance,
    phaseOutlayCeiling: PHASE_OUTLAY_LIMIT,
    maximumReservedOutlay,
    transactions: Object.freeze(transactions),
    runtimeChecks: Object.freeze([...limits.runtimeChecks]),
    assetChecks: Object.freeze([...limits.assetChecks]),
  });
}
