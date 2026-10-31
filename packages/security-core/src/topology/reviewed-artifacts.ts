import { concatHex, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { parseZodiacDelayArtifact } from "../config/zodiac-delay";
import { buildVaultPrerequisiteCreationCodes } from "../live/vault-deployment";
import type { PwaPlanningInfrastructure, VerifiedDeploymentInfrastructure } from "../config/deployments";

export type ReviewedVaultArtifacts = Readonly<{
  safeProxyCreationCode: Hex;
  setupHelperCreationCode: Hex;
  guardCreationCode: Hex;
  delayCreationCode: Hex;
  maintenanceCreationCode: Hex;
  prerequisiteRuntimeCodeHashes: Readonly<{ setupHelper: Hex; guard: Hex; delay: Hex; maintenance: Hex }>;
  safeProxyRuntimeCodeHash: Hex;
}>;

export type ArtifactResolutionClient = Readonly<{
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string }): Promise<unknown>;
  call(args: { data: Hex }): Promise<{ data?: Hex }>;
}>;

const SAFE_PROXY_FACTORY_ABI = [{ name: "proxyCreationCode", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] }] as const;
const reviewedVaultArtifacts = new WeakSet<object>();

export function isReviewedVaultArtifacts(value: unknown): value is ReviewedVaultArtifacts {
  return typeof value === "object" && value !== null && reviewedVaultArtifacts.has(value);
}

function creationRuntimeHash(client: ArtifactResolutionClient, creationCode: Hex, label: string): Promise<Hex> {
  return client.call({ data: creationCode }).then((result) => {
    if (!result.data || !/^0x(?:[0-9a-fA-F]{2})+$/.test(result.data)) {
      throw new Error(`fail closed: ${label} constructor simulation returned no runtime code`);
    }
    return keccak256(result.data);
  });
}

/**
 * Produces the only artifact evidence accepted by a production vault plan.
 * Every constructor payload is derived locally; every resulting runtime hash
 * comes from a no-state-change EVM creation simulation.
 */
export async function resolveReviewedVaultArtifacts(input: Readonly<{
  client: ArtifactResolutionClient;
  deployments: VerifiedDeploymentInfrastructure | PwaPlanningInfrastructure;
  safe: Address;
  primaryPasskey: Address;
  ecdsaSecondary: Address;
  delay: Address;
  maintenance: Address;
  periodAnchor: bigint;
  cooldownSeconds: bigint;
  expirationSeconds: bigint;
  delayArtifactSource: string;
}>): Promise<ReviewedVaultArtifacts> {
  const proxyCreationCode = await input.client.readContract({
    address: input.deployments.safeProxyFactory.address,
    abi: SAFE_PROXY_FACTORY_ABI,
    functionName: "proxyCreationCode",
  });
  if (typeof proxyCreationCode !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(proxyCreationCode)) {
    throw new Error("fail closed: Safe proxy factory returned invalid creation code");
  }
  const safeProxyCreationCode = proxyCreationCode as Hex;
  const delayArtifact = parseZodiacDelayArtifact(input.delayArtifactSource);
  const prerequisites = buildVaultPrerequisiteCreationCodes({
    safe: input.safe,
    primaryPasskey: input.primaryPasskey,
    ecdsaSecondary: input.ecdsaSecondary,
    delay: input.delay,
    maintenance: input.maintenance,
    periodAnchor: input.periodAnchor,
    cooldownSeconds: input.cooldownSeconds,
    expirationSeconds: input.expirationSeconds,
    delayArtifact,
  });
  const safeProxyDeployment = concatHex([
    safeProxyCreationCode,
    encodeAbiParameters([{ type: "address" }], [input.deployments.safeSingleton.address]),
  ]);
  const [setupHelper, guard, delay, maintenance, safeProxyRuntimeCodeHash] = await Promise.all([
    creationRuntimeHash(input.client, prerequisites.setupHelper, "SafeAtomicSetupHelper"),
    creationRuntimeHash(input.client, prerequisites.guard, "TieredSpendingGuard"),
    creationRuntimeHash(input.client, prerequisites.delay, "Zodiac Delay"),
    creationRuntimeHash(input.client, prerequisites.maintenance, "GuardReplacementMaintenance"),
    creationRuntimeHash(input.client, safeProxyDeployment, "Safe proxy"),
  ]);
  const result = Object.freeze({
    safeProxyCreationCode,
    setupHelperCreationCode: prerequisites.setupHelper,
    guardCreationCode: prerequisites.guard,
    delayCreationCode: prerequisites.delay,
    maintenanceCreationCode: prerequisites.maintenance,
    prerequisiteRuntimeCodeHashes: Object.freeze({ setupHelper, guard, delay, maintenance }),
    safeProxyRuntimeCodeHash,
  });
  reviewedVaultArtifacts.add(result);
  return result;
}

/** Test fixture escape hatch; production artifacts must use the resolver above. */
export function brandReviewedVaultArtifactsForTestsOnly(value: ReviewedVaultArtifacts): ReviewedVaultArtifacts {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") {
    throw new Error("test-only vault artifact branding is disabled outside tests");
  }
  reviewedVaultArtifacts.add(value);
  return value;
}
