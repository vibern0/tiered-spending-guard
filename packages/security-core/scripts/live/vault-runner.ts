import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import {
  assertSafeCreationReady,
  isReviewedVaultDeploymentPlan,
  planHash,
  type VaultDeploymentPlan,
  type VerifiedVaultPrerequisites,
} from "../../src/topology/build";
import { sha256 } from "../plan-deployment";
import {
  PHASE_OUTLAY_LIMIT,
  submitLiveIntent,
  type JournalEntry,
  type LiveContext,
  type LiveIntent,
  type LiveJournal,
} from "./submission";

type PlannedStep = Readonly<{
  id: string;
  transaction: VaultDeploymentPlan["prerequisites"]["setupHelper"];
}>;

type ReviewedStepBounds = Readonly<{
  id: PlannedStep["id"];
  nonce: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}>;

export type ReviewedVaultPrerequisiteApproval = Readonly<{
  packageHash: Hex;
  maximumPrerequisiteReservedOutlay: bigint;
  steps: readonly ReviewedStepBounds[];
}>;

const reviewedApprovals = new WeakMap<object, VaultDeploymentPlan>();

export type VaultPrerequisiteExecution = Readonly<{
  journal: LiveJournal;
  prerequisiteEvidence: VerifiedVaultPrerequisites;
}>;

export type VaultDeploymentExecutionContext = Readonly<{
  live: LiveContext;
  journal: LiveJournal;
  feeFor(transaction: PlannedStep["transaction"]): Promise<Readonly<{ gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>>;
  waitForReceipt(transactionHash: JournalEntry["transactionHash"]): Promise<void>;
  verifyPrerequisites(plan: VaultDeploymentPlan, stage: "before-setup" | "after-setup"): Promise<VerifiedVaultPrerequisites>;
}>;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const PACKAGE_FILES = ["unsigned-plan.json", "decoded-review.json", "public-manifest.json", "expected-evidence-hashes.json"] as const;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const FORBIDDEN_PUBLIC_KEY = /(?:signature|privateKey|private_key|secret|seed|mnemonic|rpcUrl|rpc_url|password|credential|pin|recovery)/i;

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`reviewed package ${label} must be an object`);
  return value as Record<string, unknown>;
};

const decimal = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`reviewed package ${label} must be a decimal string`);
  return BigInt(value);
};

function assertPublicPackage(value: unknown, label: string): void {
  if (Array.isArray(value)) return value.forEach((child, index) => assertPublicPackage(child, `${label}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PUBLIC_KEY.test(key)) throw new Error(`reviewed package ${label}.${key} contains private material`);
    assertPublicPackage(child, `${label}.${key}`);
  }
}

function publicValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(publicValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)]));
}

function packageTransactions(plan: VaultDeploymentPlan): readonly PlannedStep[] {
  return [
    { id: "vault-setup-helper", transaction: plan.prerequisites.setupHelper },
    { id: "vault-guard", transaction: plan.prerequisites.guard },
    { id: "vault-delay", transaction: plan.prerequisites.delay },
    { id: "vault-maintenance", transaction: plan.prerequisites.maintenance },
    { id: "vault-safe", transaction: plan.safeProxyDeployment },
  ];
}

/** Loads only the four known public files and binds their reviewed hash and caps to the exact plan. */
export function loadReviewedVaultPrerequisiteApproval(plan: VaultDeploymentPlan, directory: string, expectedPackageHash: Hex): ReviewedVaultPrerequisiteApproval {
  if (!isReviewedVaultDeploymentPlan(plan)) throw new Error("fail closed: vault deployment plan was not produced by the reviewed planner");
  if (!HASH.test(expectedPackageHash)) throw new Error("reviewed package hash is invalid");
  const contents = PACKAGE_FILES.map((name) => readFileSync(join(directory, name), "utf8"));
  if (contents.some((content) => Buffer.byteLength(content, "utf8") > 2_000_000)) throw new Error("reviewed package public file is too large");
  const actualPackageHash = sha256(contents);
  if (actualPackageHash.toLowerCase() !== expectedPackageHash.toLowerCase()) throw new Error("reviewed package hash mismatch");
  const [unsignedPlan, decodedReview, publicManifest, expectedHashes] = contents.map((content, index) => {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new Error(`reviewed package ${PACKAGE_FILES[index]} is not JSON`); }
    assertPublicPackage(parsed, PACKAGE_FILES[index]!);
    return record(parsed, PACKAGE_FILES[index]!);
  });
  const expectedPlanHash = planHash(plan);
  for (const [label, value] of [["decoded review", decodedReview.planHash], ["public manifest", publicManifest.planHash], ["evidence hashes", expectedHashes.planHash]] as const) {
    if (typeof value !== "string" || value.toLowerCase() !== expectedPlanHash.toLowerCase()) throw new Error(`reviewed package ${label} does not match plan`);
  }
  if (publicManifest.status !== "AWAITING_HUMAN_REVIEW" || publicManifest.chainId !== plan.chainId || typeof publicManifest.deployer !== "string" || publicManifest.deployer.toLowerCase() !== plan.deployer.toLowerCase() || decimal(publicManifest.startingNonce, "startingNonce") !== plan.startingNonce) throw new Error("reviewed package manifest does not match plan");
  const unsignedPlanHash = sha256(unsignedPlan);
  const decodedReviewHash = sha256(decodedReview);
  if (unsignedPlanHash !== sha256(publicValue(plan))) throw new Error("reviewed package unsigned plan does not match canonical plan");
  if (publicManifest.unsignedPlanHash !== unsignedPlanHash || expectedHashes.unsignedPlanHash !== unsignedPlanHash || publicManifest.decodedReviewHash !== decodedReviewHash || expectedHashes.decodedReviewHash !== decodedReviewHash || expectedHashes.publicManifestHash !== sha256(publicManifest)) throw new Error("reviewed package internal hash mismatch");

  const decodedTransactions = decodedReview.transactions;
  const estimates = record(decodedReview.estimates, "decoded estimates");
  const estimateTransactions = estimates.transactions;
  const planned = packageTransactions(plan);
  if (!Array.isArray(decodedTransactions) || !Array.isArray(estimateTransactions) || decodedTransactions.length !== planned.length || estimateTransactions.length !== planned.length) throw new Error("reviewed package transaction list is incomplete");
  const bounds: ReviewedStepBounds[] = [];
  let recomputedMaximum = 0n;
  for (const [index, step] of planned.entries()) {
    const decoded = record(decodedTransactions[index], `transaction ${index}`);
    const estimate = record(estimateTransactions[index], `estimate ${index}`);
    const transaction = step.transaction;
    if (decoded.id !== step.id || estimate.id !== step.id || decimal(decoded.nonce, `${step.id} nonce`) !== transaction.nonce || decimal(estimate.nonce, `${step.id} estimate nonce`) !== transaction.nonce || typeof decoded.to !== "string" || decoded.to.toLowerCase() !== transaction.to.toLowerCase() || decoded.data !== transaction.data || decimal(decoded.value, `${step.id} value`) !== transaction.value || decoded.operation !== transaction.operation) throw new Error(`reviewed package transaction mismatch for ${step.id}`);
    const gas = decimal(estimate.reviewedGasLimit, `${step.id} gas cap`);
    const maxFeePerGas = decimal(estimate.maxFeePerGas, `${step.id} max fee cap`);
    const maxPriorityFeePerGas = decimal(estimate.maxPriorityFeePerGas, `${step.id} priority fee cap`);
    if (gas <= 0n || maxFeePerGas <= 0n || maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > maxFeePerGas) throw new Error(`reviewed package invalid caps for ${step.id}`);
    if (step.id === "vault-safe") {
      if (estimate.estimateStatus !== "deferred-until-prerequisites" || estimate.estimatedGas !== undefined) throw new Error("reviewed package Safe estimate must remain deferred");
    } else {
      const estimatedGas = decimal(estimate.estimatedGas, `${step.id} estimated gas`);
      if (estimate.estimateStatus !== "estimated" || estimate.limitSimulationStatus !== "eth_call-succeeded" || estimatedGas <= 0n || estimatedGas > gas) throw new Error(`reviewed package estimate exceeds cap for ${step.id}`);
      bounds.push(Object.freeze({ id: step.id, nonce: transaction.nonce, gas, maxFeePerGas, maxPriorityFeePerGas }));
    }
    recomputedMaximum += transaction.value + gas * maxFeePerGas;
  }
  const phaseOutlayCeiling = decimal(estimates.phaseOutlayCeiling, "phase outlay ceiling");
  if (phaseOutlayCeiling !== PHASE_OUTLAY_LIMIT || decimal(publicManifest.phaseOutlayCeiling, "manifest phase outlay ceiling") !== phaseOutlayCeiling || decimal(estimates.maximumReservedOutlay, "maximum reserved outlay") !== recomputedMaximum || decimal(publicManifest.maximumReservedOutlay, "manifest maximum reserved outlay") !== recomputedMaximum || recomputedMaximum > phaseOutlayCeiling) throw new Error("reviewed package aggregate outlay mismatch");
  const maximumPrerequisiteReservedOutlay = bounds.reduce((total, bound, index) => total + planned[index]!.transaction.value + bound.gas * bound.maxFeePerGas, 0n);
  const approval = Object.freeze({ packageHash: actualPackageHash as Hex, maximumPrerequisiteReservedOutlay, steps: Object.freeze(bounds) });
  reviewedApprovals.set(approval, plan);
  return approval;
}

async function liveIntent(step: PlannedStep, bounds: ReviewedStepBounds, context: VaultDeploymentExecutionContext): Promise<LiveIntent> {
  const fees = await context.feeFor(step.transaction);
  if (step.id !== bounds.id || step.transaction.nonce !== bounds.nonce) throw new Error(`reviewed nonce cap mismatch for ${step.id}`);
  if (fees.gas <= 0n || fees.gas > bounds.gas) throw new Error(`reviewed gas cap exceeded for ${step.id}`);
  if (fees.maxFeePerGas <= 0n || fees.maxFeePerGas > bounds.maxFeePerGas) throw new Error(`reviewed max fee cap exceeded for ${step.id}`);
  if (fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > bounds.maxPriorityFeePerGas || fees.maxPriorityFeePerGas > fees.maxFeePerGas) throw new Error(`reviewed priority fee cap exceeded for ${step.id}`);
  return Object.freeze({
    id: step.id,
    to: step.transaction.to.toLowerCase() === ZERO ? undefined : step.transaction.to,
    data: step.transaction.data,
    value: step.transaction.value,
    nonce: Number(step.transaction.nonce),
    gas: fees.gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
}

async function reconcileStep(step: PlannedStep, bounds: ReviewedStepBounds, context: VaultDeploymentExecutionContext): Promise<JournalEntry> {
  if (step.transaction.nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("fail closed: deployment nonce exceeds safe integer range");
  const intent = await liveIntent(step, bounds, context);
  let entry = await submitLiveIntent(intent, context.journal, context.live);
  if (entry.status === "pending") {
    await context.waitForReceipt(entry.transactionHash);
    entry = await submitLiveIntent(intent, context.journal, context.live);
  }
  if (entry.status === "pending") throw new Error(`deployment receipt pending for ${step.id}; reconcile before continuing`);
  if (entry.status !== "success") throw new Error(`deployment transaction reverted for ${step.id}`);
  return entry;
}

/**
 * Executes only the four reviewed prerequisite deployments. Safe creation is a
 * separate approval stage because its exact gas can only be estimated after
 * these receipts and runtime bindings exist.
 */
export async function executeVaultPrerequisites(plan: VaultDeploymentPlan, approval: ReviewedVaultPrerequisiteApproval, context: VaultDeploymentExecutionContext): Promise<VaultPrerequisiteExecution> {
  if (!isReviewedVaultDeploymentPlan(plan)) throw new Error("fail closed: vault deployment plan was not produced by the reviewed planner");
  if (reviewedApprovals.get(approval) !== plan) throw new Error("fail closed: prerequisite execution requires the exact reviewed package approval");
  const prerequisites: readonly PlannedStep[] = [
    { id: "vault-setup-helper", transaction: plan.prerequisites.setupHelper },
    { id: "vault-guard", transaction: plan.prerequisites.guard },
    { id: "vault-delay", transaction: plan.prerequisites.delay },
    { id: "vault-maintenance", transaction: plan.prerequisites.maintenance },
  ];
  if (approval.steps.length !== prerequisites.length || approval.maximumPrerequisiteReservedOutlay > PHASE_OUTLAY_LIMIT) throw new Error("fail closed: reviewed prerequisite aggregate outlay is invalid");
  for (const [index, step] of prerequisites.entries()) await reconcileStep(step, approval.steps[index]!, context);

  const beforeSetup = await context.verifyPrerequisites(plan, "before-setup");
  assertSafeCreationReady(plan, beforeSetup, BigInt(await context.live.nonce()));
  return Object.freeze({ journal: context.journal, prerequisiteEvidence: beforeSetup });
}
