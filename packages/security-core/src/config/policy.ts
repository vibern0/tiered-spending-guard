import { isAddress, type Address } from "viem";

export type AssetPolicy = Readonly<{
  token: Address;
  basePerTransaction: bigint;
  stepUpPerTransaction: bigint;
  baseDailyLimit: bigint;
  instantDailyLimit: bigint;
  recipients: readonly Address[];
}>;

export type SignerRole = "primary" | "secondary";
export type SignerKind = "safe-contract" | "ecdsa-extension";
export type SecondaryProfile = "dual" | "contract-only";

export type ConfiguredSigner = Readonly<{
  address: Address;
  role: SignerRole;
  kind: SignerKind;
  enabled: boolean;
}>;

export type VaultPolicy = Readonly<{
  chainId: number;
  safe: Address;
  primary?: Address;
  secondaries?: readonly ConfiguredSigner[];
  secondaryProfile?: SecondaryProfile;
  /** @deprecated use primary */
  passkey: Address;
  /** @deprecated use secondaries */
  ecdsaSecondary: Address;
  delay: Address;
  periodSeconds: 86400;
  periodAnchor: bigint;
  cooldownSeconds: number;
  expirationSeconds: number;
  assets: readonly AssetPolicy[];
}>;

export type AssetSpendState = Readonly<{
  window: bigint;
  baseSpent: bigint;
  instantSpent: bigint;
}>;

const ZERO = "0x0000000000000000000000000000000000000000";
const POLICY_REQUIRED_KEYS = ["chainId", "safe", "passkey", "ecdsaSecondary", "delay", "periodSeconds", "periodAnchor", "cooldownSeconds", "expirationSeconds", "assets"] as const;
const POLICY_KEYS = [...POLICY_REQUIRED_KEYS, "primary", "secondaries", "secondaryProfile"] as const;
const ASSET_KEYS = ["token", "basePerTransaction", "stepUpPerTransaction", "baseDailyLimit", "instantDailyLimit", "recipients"] as const;
const SIGNER_KEYS = ["address", "role", "kind", "enabled"] as const;

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, required: readonly string[] = allowed): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) throw new Error(`${path}.${key} is not allowed`);
  for (const key of required) if (!(key in value)) throw new Error(`${path}.${key} is required`);
}

function assertAddress(name: string, value: Address): void {
  if (!isAddress(value)) throw new Error(`${name} must be an address`);
}

function assertNonNegative(name: string, value: bigint): void {
  if (value < 0n) throw new Error(`${name} must not be negative`);
}

export function assertValidVaultPolicy(policy: VaultPolicy): void {
  assertExactKeys(policy as unknown as Record<string, unknown>, POLICY_KEYS, "policy", POLICY_REQUIRED_KEYS);
  if (!Number.isSafeInteger(policy.chainId) || policy.chainId <= 0) throw new Error("invalid chainId");
  if (policy.periodSeconds !== 86400) throw new Error("periodSeconds must be 86400");
  if (policy.periodAnchor % BigInt(policy.periodSeconds) !== 0n) throw new Error("periodAnchor is not aligned");
  if (!Number.isSafeInteger(policy.cooldownSeconds) || policy.cooldownSeconds <= 0) throw new Error("invalid cooldownSeconds");
  if (!Number.isSafeInteger(policy.expirationSeconds) || policy.expirationSeconds <= 0) throw new Error("invalid expirationSeconds");
  assertAddress("safe", policy.safe);
  assertAddress("passkey", policy.passkey);
  assertAddress("ecdsaSecondary", policy.ecdsaSecondary);
  assertAddress("delay", policy.delay);
  const secondaryProfile = policy.secondaryProfile ?? "dual";
  if (secondaryProfile !== "dual" && secondaryProfile !== "contract-only") throw new Error("secondaryProfile is unsupported");
  if (secondaryProfile === "dual" && policy.ecdsaSecondary.toLowerCase() === ZERO) throw new Error("dual profile requires a nonzero ECDSA secondary");
  if (secondaryProfile === "contract-only" && policy.ecdsaSecondary.toLowerCase() !== ZERO) throw new Error("contract-only profile requires zero ECDSA secondary");
  const primary = policy.primary ?? policy.passkey;
  assertAddress("primary", primary);
  if (primary.toLowerCase() !== policy.passkey.toLowerCase()) throw new Error("primary must match passkey compatibility signer");
  const secondaries = policy.secondaries ?? (secondaryProfile === "dual"
    ? [{ address: policy.ecdsaSecondary, role: "secondary", kind: "ecdsa-extension", enabled: true } satisfies ConfiguredSigner]
    : []);
  if (!Array.isArray(secondaries) || secondaries.length === 0) throw new Error("at least one secondary signer is required");
  const signers = [primary.toLowerCase()];
  let hasEcdsaSecondary = false;
  let safeContractSecondaryCount = 0;
  for (const [index, signer] of secondaries.entries()) {
    assertExactKeys(signer as unknown as Record<string, unknown>, SIGNER_KEYS, `secondaries[${index}]`);
    assertAddress(`secondaries[${index}].address`, signer.address);
    if (signer.role !== "secondary") throw new Error("secondary signer role must be secondary");
    if (signer.kind !== "safe-contract" && signer.kind !== "ecdsa-extension") throw new Error("secondary signer kind is unsupported");
    if (signer.enabled !== true) throw new Error("secondary signer must be enabled for this prototype");
    if (signer.address.toLowerCase() === ZERO) throw new Error("secondary signer must be nonzero");
    if (signer.kind === "safe-contract") safeContractSecondaryCount += 1;
    if (secondaryProfile === "contract-only" && signer.kind !== "safe-contract") throw new Error("contract-only profile permits only a Safe-contract secondary");
    if (signer.address.toLowerCase() === policy.ecdsaSecondary.toLowerCase()) {
      if (signer.kind !== "ecdsa-extension") throw new Error("ecdsaSecondary secondary must use ecdsa-extension");
      hasEcdsaSecondary = true;
    }
    signers.push(signer.address.toLowerCase());
  }
  if (new Set(signers).size !== signers.length) throw new Error("signers must be distinct");
  if (secondaryProfile === "dual" && !hasEcdsaSecondary) throw new Error("ecdsaSecondary compatibility signer must be a configured secondary");
  if (secondaryProfile === "contract-only" && (secondaries.length !== 1 || safeContractSecondaryCount !== 1)) throw new Error("contract-only profile requires exactly one Safe-contract secondary");
  if (policy.assets.length === 0) throw new Error("at least one asset is required");

  const tokens = new Set<string>();
  for (const [index, asset] of policy.assets.entries()) {
    assertExactKeys(asset as unknown as Record<string, unknown>, ASSET_KEYS, `assets[${index}]`);
    assertAddress(`assets[${index}].token`, asset.token);
    const token = asset.token.toLowerCase();
    if (tokens.has(token)) throw new Error("asset tokens must be distinct");
    tokens.add(token);
    for (const [name, value] of Object.entries(asset)) {
      if (name !== "token" && name !== "recipients") assertNonNegative(`assets[${index}].${name}`, value as bigint);
    }
    if (asset.basePerTransaction <= 0n || asset.stepUpPerTransaction <= 0n) throw new Error("transaction caps must be positive");
    if (asset.baseDailyLimit <= 0n || asset.instantDailyLimit <= asset.baseDailyLimit) throw new Error("must satisfy 0 < X < Y");
    if (asset.basePerTransaction > asset.baseDailyLimit || asset.stepUpPerTransaction > asset.instantDailyLimit) throw new Error("transaction cap exceeds daily limit");
    if (asset.recipients.length === 0) throw new Error("asset recipients must not be empty");
    const recipients = new Set<string>();
    for (const recipient of asset.recipients) {
      assertAddress("recipient", recipient);
      if (recipient.toLowerCase() === ZERO) throw new Error("zero recipient is not allowed");
      if (recipients.has(recipient.toLowerCase())) throw new Error("recipients must be distinct");
      recipients.add(recipient.toLowerCase());
    }
  }
}

export const validateVaultPolicy = assertValidVaultPolicy;
