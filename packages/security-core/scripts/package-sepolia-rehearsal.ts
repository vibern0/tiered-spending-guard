import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { buildDeploymentPlan, sha256, type PublicDeploymentConfig } from "./plan-deployment";
import {
  isReviewedVaultDeploymentPlan,
  planHash,
  type PlannedDeploymentTransaction,
  type VaultDeploymentPlan,
} from "../src/topology/build";

const FORBIDDEN_KEY = /(?:signature|signatures|privateKey|private_key|secret|seed|mnemonic|rpcUrl|rpc_url|pin|recovery)/i;
const FORBIDDEN_VALUE = /(?:https?:\/\/|wss?:\/\/|PRIVATE KEY|MNEMONIC|BURNER PIN|broadcast this|cast send|safe-cli|recovery owner)/i;

type PackageResult = Readonly<{
  outputDir: string;
  files: readonly string[];
  packageHash: `0x${string}`;
}>;

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

function publicArtifact(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(publicArtifact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicArtifact(child)]));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function assertPublicArtifact(value: unknown, path = "artifact"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPublicArtifact(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && FORBIDDEN_VALUE.test(value)) throw new Error(`${path} contains forbidden private or broadcast material`);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`${path}.${key} is forbidden in public rehearsal packages`);
    if (key === "broadcast" && child !== false) throw new Error(`${path}.broadcast must be false`);
    assertPublicArtifact(child, `${path}.${key}`);
  }
}

function writeArtifact(outputDir: string, name: string, value: unknown): string {
  const publicValue = publicArtifact(value);
  assertPublicArtifact(publicValue, name);
  const path = join(outputDir, name);
  writeFileSync(path, `${JSON.stringify(publicValue, null, 2)}\n`, "utf8");
  return path;
}

function prepareEmptyOutputDirectory(outputDir: string): void {
  if (existsSync(outputDir) && readdirSync(outputDir).length !== 0) {
    throw new Error("output directory must be empty before creating a public rehearsal package");
  }
  mkdirSync(outputDir, { recursive: true });
}

export function buildSepoliaRehearsalPackage(configPath: string, outputDir: string): PackageResult {
  const config = readJson(configPath) as PublicDeploymentConfig;
  const plan = buildDeploymentPlan(config);
  prepareEmptyOutputDirectory(outputDir);

  const decodedReview = {
    formatVersion: 1,
    network: plan.network,
    chainId: plan.chainId,
    safe: plan.deployments.safe,
    safeOwners: [plan.deployments.passkey],
    threshold: 1,
    fallbackHandler: `0x${"0".repeat(40)}`,
    guards: { transactionGuard: plan.deployments.guard, moduleGuard: plan.deployments.guard },
    onlySafeModule: plan.deployments.delay,
    delay: plan.deployments.delay,
    setupCallReview: plan.setupCalls.map((call, index) => ({
      index,
      description: call.description,
      to: call.to,
      value: call.value,
      dataHash: sha256(call.data),
    })),
    requiredHumanGates: ["review unsigned plan", "collect live Sepolia evidence", "run read-only verifier before funding"],
    liveSepoliaRehearsal: "outstanding",
  };

  const publicManifest = {
    formatVersion: 1,
    status: "EXAMPLE_NOT_DEPLOYED",
    network: plan.network,
    chainId: plan.chainId,
    deployments: plan.deployments,
    dependencies: plan.dependencies,
    policyHash: plan.policyHash,
    expectedCounters: plan.expectedCounters,
    setupTransactionHashes: plan.setupTransactionHashes,
    queueFingerprints: plan.queueFingerprints,
    sourceConfigHash: sha256(config),
    unsignedPlanHash: sha256(plan),
    decodedReviewHash: sha256(decodedReview),
    packageScope: "public unsigned Sepolia rehearsal artifacts only",
    liveSepoliaRehearsal: "outstanding until separately executed with low-value test assets",
  };

  const expectedEvidenceHashes = {
    formatVersion: 1,
    policyHash: plan.policyHash,
    setupTransactionHashes: plan.setupTransactionHashes,
    queueFingerprints: plan.queueFingerprints,
    expectedCountersHash: sha256(plan.expectedCounters),
    unsignedPlanHash: sha256(plan),
    decodedReviewHash: sha256(decodedReview),
    publicManifestHash: sha256(publicManifest),
  };

  const files = [
    writeArtifact(outputDir, "unsigned-plan.json", plan),
    writeArtifact(outputDir, "decoded-review.json", decodedReview),
    writeArtifact(outputDir, "public-manifest.json", publicManifest),
    writeArtifact(outputDir, "expected-evidence-hashes.json", expectedEvidenceHashes),
  ];

  return { outputDir, files, packageHash: sha256(files.map((file) => readFileSync(file, "utf8"))) };
}

const REVIEW_STEP_IDS = ["vault-setup-helper", "vault-guard", "vault-delay", "vault-maintenance", "vault-safe"] as const;

function planTransactions(plan: VaultDeploymentPlan): readonly Readonly<{ id: VaultDeploymentEstimate["id"]; transaction: PlannedDeploymentTransaction }>[] {
  return [
    { id: "vault-setup-helper", transaction: plan.prerequisites.setupHelper },
    { id: "vault-guard", transaction: plan.prerequisites.guard },
    { id: "vault-delay", transaction: plan.prerequisites.delay },
    { id: "vault-maintenance", transaction: plan.prerequisites.maintenance },
    { id: "vault-safe", transaction: plan.safeProxyDeployment },
  ];
}

function assertReviewedEvidence(plan: VaultDeploymentPlan, evidence: VaultDeploymentReviewEvidence): void {
  if (evidence.snapshotBlockNumber <= 0n) throw new Error("review snapshot block number is required");
  if (evidence.observedDeployerNonce !== plan.startingNonce) throw new Error("review deployer nonce does not match plan");
  if (evidence.phaseOutlayCeiling <= 0n || evidence.maximumReservedOutlay < 0n || evidence.maximumReservedOutlay > evidence.phaseOutlayCeiling) {
    throw new Error("reviewed deployment exceeds phase outlay ceiling");
  }
  if (evidence.funderBalance < evidence.maximumReservedOutlay) throw new Error("funder balance is below maximum reviewed deployment outlay");
  if (evidence.transactions.length !== REVIEW_STEP_IDS.length) throw new Error("review estimates must cover every deployment transaction");
  let recomputed = 0n;
  const planned = planTransactions(plan);
  for (const [index, id] of REVIEW_STEP_IDS.entries()) {
    const estimate = evidence.transactions[index];
    const transaction = planned[index]!.transaction;
    if (!estimate || estimate.id !== id || estimate.nonce !== transaction.nonce) throw new Error(`review estimate mismatch for ${id}`);
    if (estimate.reviewedGasLimit <= 0n || estimate.maxFeePerGas <= 0n || estimate.maxPriorityFeePerGas < 0n || estimate.maxPriorityFeePerGas > estimate.maxFeePerGas) throw new Error(`invalid reviewed fee bounds for ${id}`);
    if (id === "vault-safe") {
      if (estimate.estimateStatus !== "deferred-until-prerequisites" || estimate.estimatedGas !== undefined) throw new Error("Safe creation estimate must remain deferred until prerequisites exist");
    } else if (estimate.estimateStatus !== "estimated" || estimate.estimatedGas === undefined || estimate.estimatedGas <= 0n || estimate.estimatedGas > estimate.reviewedGasLimit || estimate.limitSimulationStatus !== "eth_call-succeeded") {
      throw new Error(`read-only gas estimate is required within the reviewed cap for ${id}`);
    }
    recomputed += transaction.value + estimate.reviewedGasLimit * estimate.maxFeePerGas;
  }
  if (recomputed !== evidence.maximumReservedOutlay) throw new Error("maximum reviewed deployment outlay does not match transaction caps");
  if (evidence.runtimeChecks.length === 0) throw new Error("runtime checks are required for reviewed deployment package");
  if (evidence.assetChecks.length === 0) throw new Error("asset checks are required for reviewed deployment package");
}

/** Writes a concrete package only from the opaque production planner result. */
export function writeReviewedVaultDeploymentPackage(plan: VaultDeploymentPlan, evidence: VaultDeploymentReviewEvidence, outputDir: string): PackageResult {
  if (!isReviewedVaultDeploymentPlan(plan)) throw new Error("fail closed: vault deployment plan was not produced by the reviewed planner");
  assertReviewedEvidence(plan, evidence);
  prepareEmptyOutputDirectory(outputDir);

  const publicPlan = publicArtifact(plan);
  const decodedTransactions = planTransactions(plan).map(({ id, transaction }) => ({
    id,
    description: transaction.description,
    nonce: transaction.nonce,
    to: transaction.to,
    value: transaction.value,
    operation: transaction.operation,
    data: transaction.data,
    dataHash: sha256(transaction.data),
    expectedCreatedAddress: transaction.expectedCreatedAddress,
    creationCodeHash: transaction.creationCodeHash,
    expectedRuntimeCodeHash: transaction.expectedRuntimeCodeHash,
  }));
  const decodedReview = publicArtifact({
    formatVersion: 2,
    network: "sepolia",
    chainId: plan.chainId,
    planHash: planHash(plan),
    topology: plan.review,
    safeInitializer: plan.safeInitializer,
    setupHelperCalldata: plan.setupHelperCalldata,
    transactions: decodedTransactions,
    estimates: evidence,
    requiredFollowUp: "After the four prerequisites are confirmed, re-estimate the exact Safe factory call and require it to fit the reviewed vault-safe gas and fee caps before signing.",
  });
  const publicManifest = publicArtifact({
    formatVersion: 2,
    status: "AWAITING_HUMAN_REVIEW",
    network: "sepolia",
    chainId: plan.chainId,
    planHash: planHash(plan),
    deployer: plan.deployer,
    startingNonce: plan.startingNonce,
    safe: plan.safeProxyDeployment.expectedCreatedAddress,
    guard: plan.review.transactionGuard,
    delay: plan.review.modules[0],
    policyHash: plan.review.policyHash,
    snapshotBlockNumber: evidence.snapshotBlockNumber,
    phaseOutlayCeiling: evidence.phaseOutlayCeiling,
    maximumReservedOutlay: evidence.maximumReservedOutlay,
    unsignedPlanHash: sha256(publicPlan),
    decodedReviewHash: sha256(decodedReview),
    reviewBoundary: "No signing or broadcast is authorized. Human review of this decoded package is required first; Safe creation remains subject to exact post-prerequisite re-estimation under the recorded cap.",
  });
  const expectedEvidenceHashes = publicArtifact({
    formatVersion: 2,
    planHash: planHash(plan),
    policyHash: plan.review.policyHash,
    unsignedPlanHash: sha256(publicPlan),
    decodedReviewHash: sha256(decodedReview),
    publicManifestHash: sha256(publicManifest),
    runtimeChecksHash: sha256(publicArtifact(evidence.runtimeChecks)),
    assetChecksHash: sha256(publicArtifact(evidence.assetChecks)),
  });
  const files = [
    writeArtifact(outputDir, "unsigned-plan.json", publicPlan),
    writeArtifact(outputDir, "decoded-review.json", decodedReview),
    writeArtifact(outputDir, "public-manifest.json", publicManifest),
    writeArtifact(outputDir, "expected-evidence-hashes.json", expectedEvidenceHashes),
  ];
  return { outputDir, files, packageHash: sha256(files.map((file) => readFileSync(file, "utf8"))) };
}

function main(): void {
  const configPath = process.argv[2];
  const outputDir = process.argv[3];
  if (!configPath || !outputDir) throw new Error("usage: npm run package:sepolia-rehearsal -- <public-config> <output-dir>");
  const result = buildSepoliaRehearsalPackage(configPath, outputDir);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) main();
