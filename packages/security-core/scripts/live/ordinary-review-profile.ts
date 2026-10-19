import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import { sepolia } from "viem/chains";
import type { VaultPolicy } from "../../src/config/policy";
import { deriveComponentAddresses } from "../../src/topology/addressing";
import type { VaultDeploymentPlan } from "../../src/topology/build";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const ORDINARY_REVIEW_SIGNER_SOURCE = "approved local automated credential";

export type OrdinaryReviewConfig = Readonly<{
  formatVersion: 1;
  chainId: 11155111;
  funder: Address;
  primaryPasskey: Address;
  safeContractSecondary: Address;
  ecdsaSecondary: Address;
  erc20: Address;
  erc20Name: string;
  erc20Symbol: string;
  erc20Decimals: number;
  recipient: Address;
  safeProxySaltNonce: bigint;
  periodAnchor: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  safeCreationGasLimit: bigint;
}>;

function decimal(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be a canonical decimal string`);
  return BigInt(value);
}

export function readOrdinaryReviewConfig(path: string): OrdinaryReviewConfig {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const expected = ["chainId", "ecdsaSecondary", "erc20", "erc20Decimals", "erc20Name", "erc20Symbol", "formatVersion", "funder", "maxFeePerGas", "maxPriorityFeePerGas", "periodAnchor", "primaryPasskey", "recipient", "safeContractSecondary", "safeCreationGasLimit", "safeProxySaltNonce"];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("review config has unexpected or missing fields");
  if (value.formatVersion !== 1 || value.chainId !== sepolia.id) throw new Error("review config must target Sepolia format version 1");
  for (const key of ["funder", "primaryPasskey", "safeContractSecondary", "ecdsaSecondary", "erc20", "recipient"] as const) {
    if (!isAddress(value[key])) throw new Error(`${key} must be an address`);
  }
  const result = Object.freeze({
    formatVersion: 1 as const,
    chainId: sepolia.id,
    funder: getAddress(value.funder as string),
    primaryPasskey: getAddress(value.primaryPasskey as string),
    safeContractSecondary: getAddress(value.safeContractSecondary as string),
    ecdsaSecondary: getAddress(value.ecdsaSecondary as string),
    erc20: getAddress(value.erc20 as string),
    erc20Name: String(value.erc20Name),
    erc20Symbol: String(value.erc20Symbol),
    erc20Decimals: value.erc20Decimals as number,
    recipient: getAddress(value.recipient as string),
    safeProxySaltNonce: decimal(value.safeProxySaltNonce, "safeProxySaltNonce"),
    periodAnchor: decimal(value.periodAnchor, "periodAnchor"),
    maxFeePerGas: decimal(value.maxFeePerGas, "maxFeePerGas"),
    maxPriorityFeePerGas: decimal(value.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
    safeCreationGasLimit: decimal(value.safeCreationGasLimit, "safeCreationGasLimit"),
  });
  if (!/^[ -~]{1,64}$/.test(result.erc20Name) || !/^[A-Z0-9]{1,16}$/.test(result.erc20Symbol) || !Number.isInteger(result.erc20Decimals) || result.erc20Decimals < 0 || result.erc20Decimals > 36) throw new Error("reviewed ERC-20 metadata is invalid");
  if (result.maxFeePerGas <= 0n || result.maxPriorityFeePerGas < 0n || result.maxPriorityFeePerGas > result.maxFeePerGas || result.safeCreationGasLimit <= 0n) throw new Error("reviewed fee limits are invalid");
  if (new Set([result.primaryPasskey.toLowerCase(), result.safeContractSecondary.toLowerCase(), result.ecdsaSecondary.toLowerCase()]).size !== 3) throw new Error("review signers must be distinct");
  return result;
}

export function buildOrdinaryReviewPolicyDraft(config: OrdinaryReviewConfig, startingNonce: bigint): VaultPolicy {
  const components = deriveComponentAddresses({ deployer: config.funder, startingNonce });
  return Object.freeze({
    chainId: config.chainId,
    safe: ZERO,
    primary: config.primaryPasskey,
    passkey: config.primaryPasskey,
    ecdsaSecondary: config.ecdsaSecondary,
    secondaries: Object.freeze([
      Object.freeze({ address: config.safeContractSecondary, role: "secondary" as const, kind: "safe-contract" as const, enabled: true }),
      Object.freeze({ address: config.ecdsaSecondary, role: "secondary" as const, kind: "ecdsa-extension" as const, enabled: true }),
    ]),
    delay: components.delay,
    periodSeconds: 86400 as const,
    periodAnchor: config.periodAnchor,
    cooldownSeconds: 120,
    expirationSeconds: 600,
    assets: Object.freeze([
      Object.freeze({ token: ZERO, basePerTransaction: 10_000_000_000_000n, stepUpPerTransaction: 30_000_000_000_000n, baseDailyLimit: 10_000_000_000_000n, instantDailyLimit: 30_000_000_000_000n, recipients: Object.freeze([config.recipient]) }),
      Object.freeze({ token: config.erc20, basePerTransaction: 10_000_000n, stepUpPerTransaction: 30_000_000n, baseDailyLimit: 10_000_000n, instantDailyLimit: 30_000_000n, recipients: Object.freeze([config.recipient]) }),
    ]),
  });
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** Confirms the execution adapter rebuilt the exact public profile before package approval. */
export function assertOrdinaryReviewPlan(config: OrdinaryReviewConfig, plan: VaultDeploymentPlan): void {
  const expected = buildOrdinaryReviewPolicyDraft(config, plan.startingNonce);
  const components = deriveComponentAddresses({ deployer: config.funder, startingNonce: plan.startingNonce });
  if (plan.chainId !== config.chainId || !same(plan.deployer, config.funder) || plan.safeProxySaltNonce !== config.safeProxySaltNonce) throw new Error("ordinary review plan identity does not match public config");
  if (!same(plan.review.owners[0], config.primaryPasskey) || !same(plan.review.safeContractSecondary, config.safeContractSecondary) || !same(plan.review.ecdsaSecondary, config.ecdsaSecondary) || !same(plan.review.modules[0], components.delay)) throw new Error("ordinary review plan signers or Delay do not match public config");
  if (plan.review.assets.length !== expected.assets.length) throw new Error("ordinary review plan asset list does not match public config");
  for (const [index, asset] of expected.assets.entries()) {
    const actual = plan.review.assets[index];
    if (!actual || !same(actual.token, asset.token) || actual.basePerTransaction !== asset.basePerTransaction || actual.stepUpPerTransaction !== asset.stepUpPerTransaction || actual.baseDailyLimit !== asset.baseDailyLimit || actual.instantDailyLimit !== asset.instantDailyLimit || actual.recipients.length !== asset.recipients.length || actual.recipients.some((recipient, recipientIndex) => !same(recipient, asset.recipients[recipientIndex]!))) throw new Error(`ordinary review plan asset ${index} does not match public config`);
  }
}

export function selectApprovedFees(
  suggested: Readonly<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>,
  baseFeePerGas: bigint,
  approved: Readonly<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>,
): Readonly<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  if (baseFeePerGas < 0n || approved.maxFeePerGas <= 0n || approved.maxPriorityFeePerGas < 0n || approved.maxPriorityFeePerGas > approved.maxFeePerGas) throw new Error("approved fee caps are invalid");
  if (baseFeePerGas > approved.maxFeePerGas) throw new Error("current base fee exceeds the approved max fee cap");
  const suggestedMax = suggested.maxFeePerGas ?? approved.maxFeePerGas;
  const maxFeePerGas = suggestedMax < approved.maxFeePerGas ? suggestedMax : approved.maxFeePerGas;
  if (maxFeePerGas < baseFeePerGas) throw new Error("provider max fee is below the current base fee");
  const priorityRoom = maxFeePerGas - baseFeePerGas;
  const suggestedPriority = suggested.maxPriorityFeePerGas ?? approved.maxPriorityFeePerGas;
  const maxPriorityFeePerGas = [suggestedPriority, approved.maxPriorityFeePerGas, priorityRoom].reduce((lowest, value) => value < lowest ? value : lowest);
  return Object.freeze({ maxFeePerGas, maxPriorityFeePerGas });
}
