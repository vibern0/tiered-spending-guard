import { readFileSync } from "node:fs";
import { buildDeploymentPlan, sha256, type PublicDeploymentConfig } from "./plan-deployment";
import { address as canonicalAddress, exactKeys, hash as canonicalHash, record } from "./deployment-validation";

export type VerificationReport = Readonly<{ ok: boolean; failures: string[]; reportHash: `0x${string}` }>;

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

const object = record;
const exact = exactKeys;
function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}
function address(value: unknown, path: string): string {
  const result = string(value, path);
  return canonicalAddress(result, path);
}
function hash(value: unknown, path: string): string {
  const result = string(value, path);
  return canonicalHash(result, path);
}
function decimal(value: unknown, path: string): string {
  const result = string(value, path);
  if (!DECIMAL.test(result)) throw new Error(`${path} must be a canonical decimal string`);
  return result;
}
function bigintValue(value: unknown, path: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && DECIMAL.test(value)) return BigInt(value);
  throw new Error(`${path} must be a non-negative decimal integer`);
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a, (_key, value) => typeof value === "bigint" ? value.toString() : value) === JSON.stringify(b, (_key, value) => typeof value === "bigint" ? value.toString() : value);
}
function objectArray(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => object(entry, `${path}[${index}]`));
}
function addresses(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => address(entry, `${path}[${index}]`));
}
function hashes(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => hash(entry, `${path}[${index}]`));
}
function numberLike(value: unknown, expected: bigint, path: string): void {
  if (bigintValue(value, path) !== expected) throw new Error(`${path} mismatch`);
}
function assertUnique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${path} tokens must be unique`);
}

function validateSnapshot(value: unknown, plan: ReturnType<typeof buildDeploymentPlan>, config: PublicDeploymentConfig): void {
  const snapshot = object(value, "observed snapshot");
  exact(snapshot, ["chainId", "policyHash", "dependencies", "safe", "guard", "delay", "queueFingerprints", "setupTransactionHashes", "notifications"], "snapshot");
  if (snapshot.chainId !== 11155111) throw new Error("chain ID mismatch");
  if (hash(snapshot.policyHash, "snapshot.policyHash") !== plan.policyHash) throw new Error("policy hash mismatch");
  if (config.policyHash !== undefined && hash(config.policyHash, "config.policyHash") !== plan.policyHash) throw new Error("config policy hash mismatch");

  const dependencies = object(snapshot.dependencies, "snapshot.dependencies");
  exact(dependencies, ["safeSingleton", "delay"], "snapshot.dependencies");
  const singleton = object(dependencies.safeSingleton, "snapshot.dependencies.safeSingleton");
  exact(singleton, ["address", "runtimeCodeHash"], "snapshot.dependencies.safeSingleton");
  const delayDependency = object(dependencies.delay, "snapshot.dependencies.delay");
  exact(delayDependency, ["address", "runtimeCodeHash"], "snapshot.dependencies.delay");
  if (address(singleton.address, "snapshot.dependencies.safeSingleton.address") !== plan.dependencies.safeSingleton.address) throw new Error("Safe singleton address mismatch");
  if (hash(singleton.runtimeCodeHash, "snapshot.dependencies.safeSingleton.runtimeCodeHash") !== plan.dependencies.safeSingleton.runtimeCodeHash) throw new Error("Safe singleton bytecode hash mismatch");
  if (address(delayDependency.address, "snapshot.dependencies.delay.address") !== plan.dependencies.delay.address) throw new Error("Delay dependency address mismatch");
  if (hash(delayDependency.runtimeCodeHash, "snapshot.dependencies.delay.runtimeCodeHash") !== plan.dependencies.delay.runtimeCodeHash) throw new Error("Delay bytecode hash mismatch");

  const safe = object(snapshot.safe, "snapshot.safe");
  exact(safe, ["address", "singletonAddress", "owners", "threshold", "fallbackHandler", "transactionGuard", "moduleGuard", "enabledModules"], "snapshot.safe");
  if (address(safe.address, "snapshot.safe.address") !== plan.deployments.safe) throw new Error("Safe address mismatch");
  if (address(safe.singletonAddress, "snapshot.safe.singletonAddress") !== address(singleton.address, "snapshot.dependencies.safeSingleton.address")) throw new Error("Safe singleton topology binding mismatch");
  const expectedOwners = [plan.deployments.passkey];
  if (!equal(addresses(safe.owners, "snapshot.safe.owners"), expectedOwners)) throw new Error("owners mismatch");
  if (safe.threshold !== 1) throw new Error("threshold mismatch");
  if (address(safe.fallbackHandler, "snapshot.safe.fallbackHandler") !== ZERO_ADDRESS) throw new Error("fallback handler mismatch");
  if (address(safe.transactionGuard, "snapshot.safe.transactionGuard") !== plan.deployments.guard) throw new Error("transaction guard mismatch");
  if (address(safe.moduleGuard, "snapshot.safe.moduleGuard") !== plan.deployments.guard) throw new Error("module guard mismatch");
  if (!equal(addresses(safe.enabledModules, "snapshot.safe.enabledModules"), [plan.deployments.delay])) throw new Error("Safe module mismatch");

  const policy = object(config.policy, "config.policy");
  const guard = object(snapshot.guard, "snapshot.guard");
  exact(guard, ["address", "runtimeCodeHash", "config", "safeContractSecondary", "ecdsaSecondary", "assets", "counters"], "snapshot.guard");
  if (address(guard.address, "snapshot.guard.address") !== plan.deployments.guard) throw new Error("guard address mismatch");
  if (hash(guard.runtimeCodeHash, "snapshot.guard.runtimeCodeHash") !== plan.dependencies.guardRuntimeCodeHash) throw new Error("guard bytecode hash mismatch");
  const guardConfig = object(guard.config, "snapshot.guard.config");
  exact(guardConfig, ["safe", "passkey", "ecdsaSecondary", "delay", "periodSeconds", "periodAnchor"], "snapshot.guard.config");
  for (const key of ["safe", "passkey", "ecdsaSecondary", "delay"] as const) if (address(guardConfig[key], `snapshot.guard.config.${key}`) !== plan.deployments[key]) throw new Error(`guard ${key} mismatch`);
  numberLike(guardConfig.periodSeconds, bigintValue(policy.periodSeconds, "config.policy.periodSeconds"), "guard periodSeconds");
  numberLike(guardConfig.periodAnchor, bigintValue(policy.periodAnchor, "config.policy.periodAnchor"), "guard periodAnchor");
  const safeContractSecondary = object(guard.safeContractSecondary, "snapshot.guard.safeContractSecondary");
  exact(safeContractSecondary, ["signer", "kind", "enabled"], "snapshot.guard.safeContractSecondary");
  if (address(safeContractSecondary.signer, "snapshot.guard.safeContractSecondary.signer") !== plan.deployments.safeContractSecondary || safeContractSecondary.kind !== "safe-contract" || safeContractSecondary.enabled !== true) throw new Error("safe-contract secondary mismatch");
  const ecdsaSecondary = object(guard.ecdsaSecondary, "snapshot.guard.ecdsaSecondary");
  exact(ecdsaSecondary, ["signer", "kind", "enabled"], "snapshot.guard.ecdsaSecondary");
  if (address(ecdsaSecondary.signer, "snapshot.guard.ecdsaSecondary.signer") !== plan.deployments.ecdsaSecondary || ecdsaSecondary.kind !== "ecdsa-extension" || ecdsaSecondary.enabled !== true) throw new Error("ECDSA secondary mismatch");

  const configuredAssets = objectArray(policy.assets, "config.policy.assets");
  const expectedAssets = configuredAssets.map((asset, index) => ({
    token: address(asset.token, `config.policy.assets[${index}].token`),
    basePerTransaction: bigintValue(asset.basePerTransaction, `config.policy.assets[${index}].basePerTransaction`),
    stepUpPerTransaction: bigintValue(asset.stepUpPerTransaction, `config.policy.assets[${index}].stepUpPerTransaction`),
    baseDailyLimit: bigintValue(asset.baseDailyLimit, `config.policy.assets[${index}].baseDailyLimit`),
    instantDailyLimit: bigintValue(asset.instantDailyLimit, `config.policy.assets[${index}].instantDailyLimit`),
    recipients: addresses(asset.recipients, `config.policy.assets[${index}].recipients`),
  }));
  assertUnique(expectedAssets.map((asset) => asset.token), "config.policy.assets");
  const observedAssets = objectArray(guard.assets, "snapshot.guard.assets").map((asset, index) => {
    exact(asset, ["token", "basePerTransaction", "stepUpPerTransaction", "baseDailyLimit", "instantDailyLimit", "recipients"], `snapshot.guard.assets[${index}]`);
    return {
      token: address(asset.token, `snapshot.guard.assets[${index}].token`),
      basePerTransaction: BigInt(decimal(asset.basePerTransaction, `snapshot.guard.assets[${index}].basePerTransaction`)),
      stepUpPerTransaction: BigInt(decimal(asset.stepUpPerTransaction, `snapshot.guard.assets[${index}].stepUpPerTransaction`)),
      baseDailyLimit: BigInt(decimal(asset.baseDailyLimit, `snapshot.guard.assets[${index}].baseDailyLimit`)),
      instantDailyLimit: BigInt(decimal(asset.instantDailyLimit, `snapshot.guard.assets[${index}].instantDailyLimit`)),
      recipients: addresses(asset.recipients, `snapshot.guard.assets[${index}].recipients`),
    };
  });
  if (!equal(observedAssets, expectedAssets)) throw new Error("X/Y policy or recipients mismatch");

  const counters = objectArray(guard.counters, "snapshot.guard.counters").map((counter, index) => {
    exact(counter, ["token", "window", "baseSpent", "instantSpent"], `snapshot.guard.counters[${index}]`);
    return {
      token: address(counter.token, `snapshot.guard.counters[${index}].token`),
      window: BigInt(decimal(counter.window, `snapshot.guard.counters[${index}].window`)),
      baseSpent: BigInt(decimal(counter.baseSpent, `snapshot.guard.counters[${index}].baseSpent`)),
      instantSpent: BigInt(decimal(counter.instantSpent, `snapshot.guard.counters[${index}].instantSpent`)),
    };
  });
  assertUnique(counters.map((counter) => counter.token), "snapshot.guard.counters");
  if (counters.length !== expectedAssets.length || !counters.every((counter) => expectedAssets.some((asset) => asset.token === counter.token))) throw new Error("counter token coverage mismatch");
  for (const counter of counters) {
    const asset = expectedAssets.find((asset) => asset.token === counter.token)!;
    if (counter.baseSpent > asset.baseDailyLimit || counter.instantSpent > asset.instantDailyLimit) throw new Error("counter value is not bounded by policy limits");
  }

  const expectedCounters = objectArray(config.expectedCounters, "config.expectedCounters").map((counter, index) => {
    exact(counter, ["token", "window", "baseSpent", "instantSpent"], `config.expectedCounters[${index}]`);
    return {
      token: address(counter.token, `config.expectedCounters[${index}].token`),
      window: bigintValue(counter.window, `config.expectedCounters[${index}].window`),
      baseSpent: bigintValue(counter.baseSpent, `config.expectedCounters[${index}].baseSpent`),
      instantSpent: bigintValue(counter.instantSpent, `config.expectedCounters[${index}].instantSpent`),
    };
  });
  assertUnique(expectedCounters.map((counter) => counter.token), "config.expectedCounters");
  if (!equal(counters, expectedCounters)) throw new Error("X/Y counter mismatch");

  const delay = object(snapshot.delay, "snapshot.delay");
  exact(delay, ["address", "dependencyAddress", "runtimeCodeHash", "owner", "avatar", "target", "enabledUpstreamModules", "cooldownSeconds", "expirationSeconds"], "snapshot.delay");
  if (address(delay.address, "snapshot.delay.address") !== plan.deployments.delay) throw new Error("Delay address mismatch");
  if (address(delay.dependencyAddress, "snapshot.delay.dependencyAddress") !== address(delayDependency.address, "snapshot.dependencies.delay.address")) throw new Error("Delay dependency topology binding mismatch");
  if (hash(delay.runtimeCodeHash, "snapshot.delay.runtimeCodeHash") !== plan.dependencies.delay.runtimeCodeHash) throw new Error("Delay bytecode hash mismatch");
  for (const key of ["owner", "avatar", "target"] as const) if (address(delay[key], `snapshot.delay.${key}`) !== plan.deployments.safe) throw new Error(`Delay ${key} mismatch`);
  if (!equal(addresses(delay.enabledUpstreamModules, "snapshot.delay.enabledUpstreamModules"), [plan.deployments.safe])) throw new Error("Delay upstream module mismatch");
  numberLike(delay.cooldownSeconds, bigintValue(policy.cooldownSeconds, "config.policy.cooldownSeconds"), "cooldown");
  numberLike(delay.expirationSeconds, bigintValue(policy.expirationSeconds, "config.policy.expirationSeconds"), "expiration");

  if (!equal(hashes(snapshot.queueFingerprints, "snapshot.queueFingerprints"), plan.queueFingerprints) || !equal(hashes(snapshot.setupTransactionHashes, "snapshot.setupTransactionHashes"), plan.setupTransactionHashes)) throw new Error("deployment evidence mismatch");
  const notifications = object(snapshot.notifications, "snapshot.notifications");
  exact(notifications, ["stepUp", "delayedLifecycle"], "snapshot.notifications");
  if (notifications.stepUp !== true || notifications.delayedLifecycle !== true) throw new Error("notification mismatch");
}

export function verifyDeployment(config: PublicDeploymentConfig, observed: unknown): VerificationReport {
  const failures: string[] = [];
  try { validateSnapshot(observed, buildDeploymentPlan(config), config); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  const report = { ok: failures.length === 0, failures };
  return { ...report, reportHash: sha256(report) };
}

function main(): void {
  const manifestPath = process.argv[2] ?? "config/sepolia.example.json";
  const snapshotPath = process.argv[3];
  if (!snapshotPath) throw new Error("verification is read-only: provide a public observed snapshot path");
  const report = verifyDeployment(JSON.parse(readFileSync(manifestPath, "utf8")), JSON.parse(readFileSync(snapshotPath, "utf8")));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}
if (require.main === module) main();
