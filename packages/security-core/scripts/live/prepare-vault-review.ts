import type { Address, Hex } from "viem";
import { OFFICIAL_DEPLOYMENT_REGISTRY } from "../../src/config/deployments";
import { isReviewedVaultDeploymentPlan, type VaultDeploymentPlan } from "../../src/topology/build";
import { PHASE_OUTLAY_LIMIT } from "./submission";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export type VaultDeploymentEstimate = Readonly<{
  id: "vault-setup-helper" | "vault-guard" | "vault-delay" | "vault-maintenance" | "vault-safe";
  nonce: bigint;
  estimateStatus: "estimated" | "deferred-until-prerequisites";
  estimatedGas?: bigint;
  reviewedGasLimit: bigint;
  limitSimulationStatus?: "eth_call-succeeded";
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}>;

export type VaultDeploymentReviewEvidence = Readonly<{
  snapshotBlockNumber: bigint;
  observedDeployerNonce: bigint;
  funderBalance: bigint;
  phaseOutlayCeiling: bigint;
  maximumReservedOutlay: bigint;
  transactions: readonly VaultDeploymentEstimate[];
  runtimeChecks: readonly Readonly<{ name: string; address: Address; runtimeCodeHash: Hex; bindingHash?: Hex }>[];
  assetChecks: readonly Readonly<{ token: Address; kind: "native" | "erc20"; symbol: string; decimals: number; runtimeCodeHash?: Hex }>[];
}>;

const collectedEvidence = new WeakMap<object, VaultDeploymentPlan>();

export function isCollectedVaultDeploymentReviewEvidence(plan: VaultDeploymentPlan, evidence: unknown): evidence is VaultDeploymentReviewEvidence {
  return typeof evidence === "object" && evidence !== null && collectedEvidence.get(evidence) === plan;
}

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

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

function assertExactReviewChecks(plan: VaultDeploymentPlan, limits: VaultReviewLimits): void {
  const registry = OFFICIAL_DEPLOYMENT_REGISTRY[plan.chainId];
  if (!registry) throw new Error("review plan chain has no pinned deployment registry");
  const pinned = Object.values(registry).map((record) => ({ name: record.name, address: record.address, runtimeCodeHash: record.runtimeCodeHash }));
  const expected = [
    ...pinned,
    { name: "primaryPasskey", address: plan.review.owners[0], requiresBinding: true },
    { name: "safeContractSecondary", address: plan.review.safeContractSecondary, requiresBinding: true },
    { name: "plannedSetupHelper", address: plan.prerequisites.setupHelper.expectedCreatedAddress, runtimeCodeHash: plan.prerequisites.setupHelper.expectedRuntimeCodeHash, bindingHash: plan.prerequisites.setupHelper.creationCodeHash },
    { name: "plannedGuard", address: plan.prerequisites.guard.expectedCreatedAddress, runtimeCodeHash: plan.prerequisites.guard.expectedRuntimeCodeHash, bindingHash: plan.prerequisites.guard.creationCodeHash },
    { name: "plannedDelay", address: plan.prerequisites.delay.expectedCreatedAddress, runtimeCodeHash: plan.prerequisites.delay.expectedRuntimeCodeHash, bindingHash: plan.prerequisites.delay.creationCodeHash },
    { name: "plannedMaintenance", address: plan.prerequisites.maintenance.expectedCreatedAddress, runtimeCodeHash: plan.prerequisites.maintenance.expectedRuntimeCodeHash, bindingHash: plan.prerequisites.maintenance.creationCodeHash },
    { name: "plannedSafeProxy", address: plan.safeProxyDeployment.expectedCreatedAddress, runtimeCodeHash: plan.safeProxyDeployment.expectedRuntimeCodeHash },
  ];
  if (limits.runtimeChecks.length !== expected.length) throw new Error("review runtime checklist is incomplete");
  for (const [index, wanted] of expected.entries()) {
    const actual = limits.runtimeChecks[index];
    if (!actual || actual.name !== wanted.name || !wanted.address || !same(actual.address, wanted.address)) throw new Error(`review runtime checklist mismatch for ${wanted.name}`);
    if ("runtimeCodeHash" in wanted && wanted.runtimeCodeHash && !same(actual.runtimeCodeHash, wanted.runtimeCodeHash)) throw new Error(`review runtime hash mismatch for ${wanted.name}`);
    if ("bindingHash" in wanted && wanted.bindingHash && (!actual.bindingHash || !same(actual.bindingHash, wanted.bindingHash))) throw new Error(`review binding mismatch for ${wanted.name}`);
    if ("requiresBinding" in wanted && wanted.requiresBinding && !actual.bindingHash) throw new Error(`review binding is required for ${wanted.name}`);
  }
  if (limits.assetChecks.length !== plan.review.assets.length) throw new Error("review asset checklist is incomplete");
  for (const [index, asset] of plan.review.assets.entries()) {
    const actual = limits.assetChecks[index];
    if (!actual || !same(actual.token, asset.token)) throw new Error(`review asset checklist mismatch at ${index}`);
    const native = same(asset.token, ZERO);
    if (native && (actual.kind !== "native" || actual.symbol !== "ETH" || actual.decimals !== 18 || actual.runtimeCodeHash !== undefined)) throw new Error("review native asset metadata mismatch");
    if (!native && (actual.kind !== "erc20" || !actual.symbol || !Number.isInteger(actual.decimals) || actual.decimals < 0 || actual.decimals > 36 || !actual.runtimeCodeHash)) throw new Error(`review ERC-20 metadata is incomplete at ${index}`);
  }
}

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
  assertExactReviewChecks(plan, limits);
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

  const result = Object.freeze({
    snapshotBlockNumber,
    observedDeployerNonce,
    funderBalance,
    phaseOutlayCeiling: PHASE_OUTLAY_LIMIT,
    maximumReservedOutlay,
    transactions: Object.freeze(transactions.map((transaction) => Object.freeze(transaction))),
    runtimeChecks: Object.freeze(limits.runtimeChecks.map((check) => Object.freeze({ ...check }))),
    assetChecks: Object.freeze(limits.assetChecks.map((check) => Object.freeze({ ...check }))),
  });
  collectedEvidence.set(result, plan);
  return result;
}
