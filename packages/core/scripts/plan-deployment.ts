import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { address, exactKeys, hash, record } from "./deployment-validation";

export type PublicDeploymentConfig = Readonly<Record<string, unknown>>;

const SECRET_KEY = /(private|secret|seed|mnemonic|password|pin|credential|rpcurl|rpc_url|apikey|api_key)/i;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): `0x${string}` {
  return `0x${createHash("sha256").update(canonical(value)).digest("hex")}` as `0x${string}`;
}

function assertPublic(value: unknown, path = "config"): asserts value is PublicDeploymentConfig {
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      if (child && typeof child === "object") assertPublic(child, `${path}[${index}]`);
    });
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) throw new Error(`${path}.${key} is secret material; remove it`);
    if (child && typeof child === "object") assertPublic(child, `${path}.${key}`);
  }
}

function addressesEqual(left: unknown, right: unknown, leftPath: string, rightPath: string): boolean {
  return address(left, leftPath) === address(right, rightPath);
}


function unsignedInteger(value: unknown, path: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new Error(`${path} must be a non-negative decimal integer`);
}

function evidenceHashes(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an explicit array of hashes`);
  return value.map((entry, index) => hash(entry, `${path}[${index}]`));
}

function validatePolicy(value: unknown): asserts value is Record<string, unknown> {
  const policy = record(value, "policy");
  exactKeys(policy, ["periodSeconds", "periodAnchor", "cooldownSeconds", "expirationSeconds", "assets"], "policy");
  if (policy.periodSeconds !== 86400) throw new Error("policy.periodSeconds must be 86400");
  unsignedInteger(policy.periodAnchor, "policy.periodAnchor");
  unsignedInteger(policy.cooldownSeconds, "policy.cooldownSeconds");
  unsignedInteger(policy.expirationSeconds, "policy.expirationSeconds");
  if (unsignedInteger(policy.expirationSeconds, "policy.expirationSeconds") < unsignedInteger(policy.cooldownSeconds, "policy.cooldownSeconds")) throw new Error("policy.expirationSeconds must be at least cooldownSeconds");
  if (!Array.isArray(policy.assets) || policy.assets.length === 0) throw new Error("policy.assets must be a non-empty array");
  for (const [index, rawAsset] of policy.assets.entries()) {
    const path = `policy.assets[${index}]`;
    const asset = record(rawAsset, path);
    exactKeys(asset, ["token", "basePerTransaction", "stepUpPerTransaction", "baseDailyLimit", "instantDailyLimit", "recipients"], path);
    address(asset.token, `${path}.token`);
    const basePerTransaction = unsignedInteger(asset.basePerTransaction, `${path}.basePerTransaction`);
    const stepUpPerTransaction = unsignedInteger(asset.stepUpPerTransaction, `${path}.stepUpPerTransaction`);
    const baseDailyLimit = unsignedInteger(asset.baseDailyLimit, `${path}.baseDailyLimit`);
    const instantDailyLimit = unsignedInteger(asset.instantDailyLimit, `${path}.instantDailyLimit`);
    if (baseDailyLimit === 0n || baseDailyLimit >= instantDailyLimit) throw new Error(`${path}: 0 < baseDailyLimit < instantDailyLimit is required`);
    if (basePerTransaction === 0n || basePerTransaction > baseDailyLimit) throw new Error(`${path}.basePerTransaction must be positive and no greater than baseDailyLimit`);
    if (stepUpPerTransaction === 0n || stepUpPerTransaction > instantDailyLimit) throw new Error(`${path}.stepUpPerTransaction must be positive and no greater than instantDailyLimit`);
    if (!Array.isArray(asset.recipients) || asset.recipients.length === 0) throw new Error(`${path}.recipients must be a non-empty array`);
    asset.recipients.forEach((recipient, recipientIndex) => address(recipient, `${path}.recipients[${recipientIndex}]`));
  }
}

export function buildDeploymentPlan(config: PublicDeploymentConfig) {
  assertPublic(config);
  exactKeys(config, ["formatVersion", "network", "chainId", "safe", "guard", "delay", "passkey", "safeContractSecondary", "ecdsaSecondary", "safeSingleton", "delayDependency", "guardRuntimeCodeHash", "policy", "expectedQueueFingerprints", "setupTransactionHashes", "expectedCounters", "setupCalls"], "config", ["policyHash", "atomicSafeCreation"]);
  if (config.atomicSafeCreation === true) {
    throw new Error("atomic Safe creation requires buildVaultPlan prerequisite evidence, expected runtime hashes, Safe proxy creation code, verified prerequisites, and assertSafeCreationReady");
  }
  if (config.atomicSafeCreation !== undefined && config.atomicSafeCreation !== false) throw new Error("config.atomicSafeCreation must be true or false");
  if (config.formatVersion !== 1) throw new Error("config.formatVersion must be 1");
  if (config.network !== "sepolia" || config.chainId !== 11155111) throw new Error("planner is Sepolia-only");
  if (!Array.isArray(config.setupTransactionHashes) || !Array.isArray(config.expectedQueueFingerprints)) throw new Error("evidence arrays must be explicit");
  const setupTransactionHashes = evidenceHashes(config.setupTransactionHashes, "setupTransactionHashes");
  const queueFingerprints = evidenceHashes(config.expectedQueueFingerprints, "expectedQueueFingerprints");
  const deployments = {
    safe: address(config.safe, "safe"),
    guard: address(config.guard, "guard"),
    delay: address(config.delay, "delay"),
    passkey: address(config.passkey, "passkey"),
    safeContractSecondary: address(config.safeContractSecondary, "safeContractSecondary"),
    ecdsaSecondary: address(config.ecdsaSecondary, "ecdsaSecondary"),
  };
  const signerSet = new Set([deployments.passkey, deployments.safeContractSecondary, deployments.ecdsaSecondary]);
  if (signerSet.size !== 3) throw new Error("primary and secondary signers must be distinct");
  const singleton = record(config.safeSingleton, "safeSingleton");
  const delayDependency = record(config.delayDependency, "delayDependency");
  exactKeys(singleton, ["address", "runtimeCodeHash"], "safeSingleton");
  exactKeys(delayDependency, ["address", "runtimeCodeHash"], "delayDependency");
  if (config.policyHash !== undefined) hash(config.policyHash, "policyHash");
  const setupCalls = config.setupCalls;
  if (!Array.isArray(setupCalls)) throw new Error("setupCalls must be an array");
  const calls = setupCalls.map((call, index) => {
    const item = record(call, `setupCalls[${index}]`);
    exactKeys(item, ["description", "to", "value", "data"], `setupCalls[${index}]`);
    if ("signature" in item || "privateKey" in item) throw new Error(`setupCalls[${index}] must be unsigned`);
    if (typeof item.description !== "string") throw new Error(`setupCalls[${index}].description must be a string`);
    if (typeof item.value !== "string" || !/^(0|[1-9][0-9]*)$/.test(item.value)) throw new Error(`setupCalls[${index}].value must be a decimal string`);
    if (typeof item.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(item.data)) throw new Error(`setupCalls[${index}].data must be byte-aligned hex`);
    return { description: item.description, to: address(item.to, `setupCalls[${index}].to`), value: item.value, data: item.data.toLowerCase() };
  });
  const policy = config.policy;
  validatePolicy(policy);
  const policyAssets = (policy as Record<string, unknown>).assets as Record<string, unknown>[];
  if (!Array.isArray(config.expectedCounters) || config.expectedCounters.length !== policyAssets.length) throw new Error("expectedCounters must exactly cover policy assets");
  const counterTokens = new Set<string>();
  const expectedCounters = config.expectedCounters.map((raw, index) => {
    const counter = record(raw, `expectedCounters[${index}]`);
    exactKeys(counter, ["token", "window", "baseSpent", "instantSpent"], `expectedCounters[${index}]`);
    const token = address(counter.token, `expectedCounters[${index}].token`);
    if (counterTokens.has(token)) throw new Error("expectedCounters tokens must be unique");
    counterTokens.add(token);
    const asset = policyAssets.find((candidate) => addressesEqual(candidate.token, token, "policy asset token", `expectedCounters[${index}].token`));
    if (!asset) throw new Error("expectedCounters token coverage mismatch");
    const baseSpent = unsignedInteger(counter.baseSpent, `expectedCounters[${index}].baseSpent`);
    const instantSpent = unsignedInteger(counter.instantSpent, `expectedCounters[${index}].instantSpent`);
    if (baseSpent > unsignedInteger(asset.baseDailyLimit, "policy asset baseDailyLimit") || instantSpent > unsignedInteger(asset.instantDailyLimit, "policy asset instantDailyLimit")) throw new Error("expectedCounters values must be bounded by policy limits");
    return { token, window: unsignedInteger(counter.window, `expectedCounters[${index}].window`).toString(), baseSpent: baseSpent.toString(), instantSpent: instantSpent.toString() };
  });
  if (counterTokens.size !== policyAssets.length) throw new Error("expectedCounters token coverage mismatch");
  return {
    formatVersion: 1,
    network: "sepolia",
    chainId: 11155111,
    unsigned: true,
    broadcast: false,
    deployments,
    dependencies: {
      safeSingleton: { address: address(singleton.address, "safeSingleton.address"), runtimeCodeHash: hash(singleton.runtimeCodeHash, "safeSingleton.runtimeCodeHash") },
      delay: { address: address(delayDependency.address, "delayDependency.address"), runtimeCodeHash: hash(delayDependency.runtimeCodeHash, "delayDependency.runtimeCodeHash") },
      guardRuntimeCodeHash: hash(config.guardRuntimeCodeHash, "guardRuntimeCodeHash"),
    },
    policyHash: sha256(policy),
    expectedCounters,
    setupTransactionHashes,
    queueFingerprints,
    setupCalls: calls,
  };
}

function main(): void {
  const input = process.argv[2] ?? "config/sepolia.example.json";
  const output = process.argv[3];
  const plan = buildDeploymentPlan(JSON.parse(readFileSync(input, "utf8")) as PublicDeploymentConfig);
  const rendered = `${JSON.stringify(plan, null, 2)}\n`;
  if (output) writeFileSync(output, rendered, "utf8");
  else process.stdout.write(rendered);
}

if (require.main === module) main();
