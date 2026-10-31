import { concatHex, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import Safe150 from "@safe-global/safe-deployments/src/assets/v1.5.0/safe.json";
import SafeProxyFactory150 from "@safe-global/safe-deployments/src/assets/v1.5.0/safe_proxy_factory.json";
import MultiSendCallOnly150 from "@safe-global/safe-deployments/src/assets/v1.5.0/multi_send_call_only.json";
import SafeWebAuthnSignerProxyArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerProxy.sol/SafeWebAuthnSignerProxy.json";
import { DEPENDENCIES, deploymentAddressError, deploymentReleaseError, validatedDeploymentAddress } from "./deployment-validation";
import { passkeySignerBindingHash, verifyPasskeySignerComponent, type VerifiedComponent } from "../topology/evidence";

export const SUPPORTED_CHAIN_IDS = [11155111] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

export type DependencyName =
  | "safeSingleton"
  | "safeProxyFactory"
  | "passkeySignerFactory"
  | "passkeySignerVerifier"
  | "multiSendCallOnly";

export type DeploymentRecord = {
  name: string;
  version: string;
  address?: Address;
  runtimeCodeHash?: Hex;
  supportsModuleGuards?: boolean;
  evidence?: "verified" | "absent";
  source: string;
};

export type ChainDeploymentInfrastructureRegistry = Record<DependencyName, DeploymentRecord>;
export type DeploymentInfrastructureRegistry = Partial<Record<number, ChainDeploymentInfrastructureRegistry>>;
export type ChainDeploymentRegistry = ChainDeploymentInfrastructureRegistry;
export type DeploymentRegistry = DeploymentInfrastructureRegistry;

export type ReadOnlyDeploymentClient = {
  getBytecode(args: { address: Address }): Promise<Hex | undefined>;
  getTransactionCount?(args: { address: Address }): Promise<number | bigint>;
  readContract?(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
};

export type VerifiedDependency = DeploymentRecord & {
  address: Address;
  runtimeCodeHash: Hex;
  evidence: "verified";
};

export type DeploymentInfrastructureInput = Readonly<{
  chainId: number;
  deployer: Address;
  expectedDeployerNonce: bigint;
  passkeySigner: Readonly<{
    address: Address;
    runtimeCodeHash: Hex;
    bindingHash: Hex;
    source: string;
    binding: Readonly<{ x: bigint; y: bigint; verifiers: bigint }>;
  }>;
}>;

type DependencyMap = Record<DependencyName, VerifiedDependency>;

export type DeploymentInfrastructure = Readonly<{
  chainId: number;
  deployer: Address;
  observedDeployerNonce: bigint;
  safeSingleton: VerifiedDependency;
  safeProxyFactory: VerifiedDependency;
  passkeySignerFactory: VerifiedDependency;
  passkeySignerVerifier: VerifiedDependency;
  multiSendCallOnly: VerifiedDependency;
  passkeySigner: VerifiedComponent;
  dependencies: DependencyMap;
}>;

export type VerifiedDeploymentInfrastructure = DeploymentInfrastructure;
export type VerifiedDeployments = VerifiedDeploymentInfrastructure;

export type PlannedPasskeySigner = Readonly<{
  name: "passkeySigner";
  address: Address;
  bindingHash: Hex;
  expectedRuntimeCodeHash: Hex;
  source: string;
  binding: Readonly<{ x: bigint; y: bigint; verifiers: bigint }>;
}>;

export type PwaPlanningInfrastructure = Readonly<{
  chainId: number;
  deployer: Address;
  observedDeployerNonce: bigint;
  safeSingleton: VerifiedDependency;
  safeProxyFactory: VerifiedDependency;
  passkeySignerFactory: VerifiedDependency;
  passkeySignerVerifier: VerifiedDependency;
  multiSendCallOnly: VerifiedDependency;
  primaryPasskeySigner: PlannedPasskeySigner;
  secondaryPasskeySigner: PlannedPasskeySigner;
  dependencies: DependencyMap;
}>;

const verifiedInfrastructure = new WeakSet<object>();
const pwaPlanningInfrastructure = new WeakSet<object>();

export function isVerifiedDeploymentInfrastructure(value: unknown): value is VerifiedDeploymentInfrastructure {
  return typeof value === "object" && value !== null && verifiedInfrastructure.has(value);
}

export const isOfficialVerifiedDeployments = isVerifiedDeploymentInfrastructure;

export function isPwaPlanningInfrastructure(value: unknown): value is PwaPlanningInfrastructure {
  return typeof value === "object" && value !== null && pwaPlanningInfrastructure.has(value);
}

const SAFE_DEPLOYMENTS_PACKAGE = "@safe-global/safe-deployments@1.37.63";
const SAFE_PASSKEY_DEPLOYMENTS = "https://github.com/safe-global/safe-modules-deployments/blob/main/src/assets/safe-passkey-module/v0.2.0";
export const SAFE_PASSKEY_SIGNER_PROXY_CREATION_CODE_HASH = "0x24eb5cf1cb02e3bc5ef6917bcd59e2cb1a7f02b257284dc89daeac1c37dada50" as Hex;

type SafePasskeySignerProxyArtifact = Readonly<{ contractName?: unknown; sourceName?: unknown; bytecode?: unknown }>;

export function assertReviewedSafePasskeySignerProxyArtifact(value: SafePasskeySignerProxyArtifact): Hex {
  if (value.contractName !== "SafeWebAuthnSignerProxy" || value.sourceName !== "contracts/SafeWebAuthnSignerProxy.sol") failClosed("Safe passkey signer proxy artifact identity mismatch");
  if (typeof value.bytecode !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value.bytecode)) failClosed("Safe passkey signer proxy creation code is invalid");
  if (!same(keccak256(value.bytecode as Hex), SAFE_PASSKEY_SIGNER_PROXY_CREATION_CODE_HASH)) failClosed("Safe passkey signer proxy creation code hash mismatch");
  return value.bytecode as Hex;
}

export async function resolvePasskeySignerRuntimeCodeHash(input: Readonly<{
  client: Readonly<{ call(args: { data: Hex }): Promise<{ data?: Hex }> }>;
  singleton: Address;
  credential: Readonly<{ x: bigint; y: bigint }>;
  verifiers: bigint;
}>): Promise<Hex> {
  const creationCode = concatHex([
    assertReviewedSafePasskeySignerProxyArtifact(SafeWebAuthnSignerProxyArtifact),
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint176" }],
      [input.singleton, input.credential.x, input.credential.y, input.verifiers],
    ),
  ]);
  const result = await input.client.call({ data: creationCode });
  if (!result.data || !/^0x(?:[0-9a-fA-F]{2})+$/.test(result.data)) failClosed("Safe passkey signer proxy constructor simulation returned no runtime code");
  return keccak256(result.data);
}

type SafeDeploymentAsset = Readonly<{
  contractName: string;
  version: string;
  deployments: { canonical?: { address: string; codeHash: string } };
}>;

const fromSafeDeploymentAsset = (asset: SafeDeploymentAsset, name: string, supportsModuleGuards = false): DeploymentRecord => ({
  name,
  version: asset.version,
  address: asset.deployments.canonical?.address as Address | undefined,
  runtimeCodeHash: asset.deployments.canonical?.codeHash as Hex | undefined,
  ...(supportsModuleGuards ? { supportsModuleGuards: true } : {}),
  source: `${SAFE_DEPLOYMENTS_PACKAGE} ${asset.contractName}`,
});

const OFFICIAL_DEPLOYMENT_REGISTRY_DATA: DeploymentInfrastructureRegistry = {
  11155111: {
    safeSingleton: fromSafeDeploymentAsset(Safe150 as SafeDeploymentAsset, "Safe singleton", true),
    safeProxyFactory: fromSafeDeploymentAsset(SafeProxyFactory150 as SafeDeploymentAsset, "Safe proxy factory"),
    passkeySignerFactory: {
      name: "Safe WebAuthn signer factory",
      version: "0.2.0",
      address: "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf",
      runtimeCodeHash: "0xbe9db61b4ee533cb4b1136ef244141db4ca3b7867b44d154db9faeb22f39d7bb",
      evidence: "verified",
      source: `${SAFE_PASSKEY_DEPLOYMENTS}/safe-webauthn-signer-factory.json`,
    },
    passkeySignerVerifier: {
      name: "Daimo P-256 verifier",
      version: "0.2.0",
      address: "0xc2b78104907F722DABAc4C69f826a522B2754De4",
      runtimeCodeHash: "0x3cd725b6ba67b40b7979190c41a015e82cf21e098eb61832ba623f8538bab7fc",
      evidence: "verified",
      source: `${SAFE_PASSKEY_DEPLOYMENTS}/daimo-p256-verifier.json`,
    },
    multiSendCallOnly: fromSafeDeploymentAsset(MultiSendCallOnly150 as SafeDeploymentAsset, "Safe MultiSendCallOnly"),
  },
};

const freezeRegistry = (registry: DeploymentInfrastructureRegistry): Readonly<DeploymentInfrastructureRegistry> => {
  for (const chain of Object.values(registry)) {
    if (!chain) continue;
    for (const record of Object.values(chain)) Object.freeze(record);
    Object.freeze(chain);
  }
  return Object.freeze(registry);
};

export const OFFICIAL_DEPLOYMENT_REGISTRY = freezeRegistry(OFFICIAL_DEPLOYMENT_REGISTRY_DATA);

const failClosed = (message: string): never => {
  throw new Error(`deployment verification failed closed: ${message}`);
};

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const requireAddress = (dependency: DependencyName, record: DeploymentRecord): Address => {
  const error = deploymentAddressError(dependency, record);
  if (error) failClosed(error);
  return validatedDeploymentAddress(dependency, record);
};

async function resolveInfrastructureDependencies(
  client: ReadOnlyDeploymentClient,
  chainId: number,
  registry: DeploymentInfrastructureRegistry | Readonly<DeploymentInfrastructureRegistry>,
  options: Readonly<{ requireEvidence?: boolean }> = {},
): Promise<DependencyMap> {
  if (!SUPPORTED_CHAIN_IDS.includes(chainId as SupportedChainId)) {
    failClosed(`unsupported chain ${chainId}`);
  }

  const selectedChain = registry[chainId];
  if (!selectedChain) failClosed(`no official registry entry for chain ${chainId}`);

  for (const dependency of DEPENDENCIES) {
    const record = selectedChain[dependency];
    if (!record) failClosed(`missing registry entry for ${dependency}`);
    if (options.requireEvidence !== false && record.evidence === "absent") {
      failClosed(`${dependency} has no official deployment evidence`);
    }
    const addressError = deploymentAddressError(dependency, record);
    if (options.requireEvidence !== false && addressError) failClosed(addressError);
  }

  const dependencies = {} as DependencyMap;
  for (const dependency of DEPENDENCIES) {
    const record = selectedChain[dependency];
    if (!record) failClosed(`missing registry entry for ${dependency}`);
    const releaseError = deploymentReleaseError(dependency, record);
    if (releaseError) failClosed(releaseError);

    const address = requireAddress(dependency, record);
    const runtimeCode = await client.getBytecode({ address });
    if (!runtimeCode || runtimeCode === "0x") {
      failClosed(`${dependency} at ${address} has no runtime bytecode`);
    }
    if (!record.runtimeCodeHash) failClosed(`${dependency} has no committed runtime code hash`);
    const runtimeCodeHash = keccak256(runtimeCode);
    if (!same(runtimeCodeHash, record.runtimeCodeHash)) failClosed(`${dependency} runtime code hash mismatch`);
    dependencies[dependency] = Object.freeze({ ...record, address, runtimeCodeHash: record.runtimeCodeHash, evidence: "verified" });
  }

  return Object.freeze(dependencies);
}

/** Verifies public, pinned dependencies before a credential-specific signer exists. */
export async function verifyOfficialDeploymentDependencies(
  client: Pick<ReadOnlyDeploymentClient, "getBytecode">,
  chainId: number,
  registry: DeploymentInfrastructureRegistry | Readonly<DeploymentInfrastructureRegistry> = OFFICIAL_DEPLOYMENT_REGISTRY,
): Promise<Readonly<DependencyMap>> {
  return resolveInfrastructureDependencies(client, chainId, registry, { requireEvidence: true });
}

const PASSKEY_FACTORY_ABI = [
  { name: "getSigner", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] },
  { name: "SINGLETON", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export async function resolvePwaPlanningInfrastructure(
  client: ReadOnlyDeploymentClient & Readonly<{ call(args: { data: Hex }): Promise<{ data?: Hex }> }>,
  input: Readonly<{
    chainId: number;
    deployer: Address;
    expectedDeployerNonce: bigint;
    primaryCredential: Readonly<{ x: bigint; y: bigint }>;
    secondaryCredential: Readonly<{ x: bigint; y: bigint }>;
  }>,
): Promise<PwaPlanningInfrastructure> {
  if (typeof client.getTransactionCount !== "function") failClosed("deployer nonce reader is required");
  if (typeof client.readContract !== "function") failClosed("passkey factory reader is required");
  const dependencies = await resolveInfrastructureDependencies(client, input.chainId, OFFICIAL_DEPLOYMENT_REGISTRY, { requireEvidence: true });
  const nonce = await client.getTransactionCount({ address: input.deployer });
  const observedDeployerNonce = typeof nonce === "bigint" ? nonce : BigInt(nonce);
  if (observedDeployerNonce !== input.expectedDeployerNonce) failClosed(`deployer nonce changed: expected ${input.expectedDeployerNonce}, observed ${observedDeployerNonce}`);
  const verifiers = BigInt(dependencies.passkeySignerVerifier.address);
  const predict = async (credential: Readonly<{ x: bigint; y: bigint }>, label: "primary" | "secondary"): Promise<Address> => {
    const predicted = await client.readContract!({ address: dependencies.passkeySignerFactory.address, abi: PASSKEY_FACTORY_ABI, functionName: "getSigner", args: [credential.x, credential.y, verifiers] });
    if (typeof predicted !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(predicted)) failClosed(`passkey factory returned an invalid ${label} signer address`);
    const existing = await client.getBytecode({ address: predicted as Address });
    if (existing && existing !== "0x") failClosed(`${label} passkey signer already exists`);
    return predicted as Address;
  };
  const singleton = await client.readContract({ address: dependencies.passkeySignerFactory.address, abi: PASSKEY_FACTORY_ABI, functionName: "SINGLETON" });
  if (typeof singleton !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(singleton)) failClosed("passkey factory returned an invalid singleton address");
  const [primaryAddress, secondaryAddress] = await Promise.all([predict(input.primaryCredential, "primary"), predict(input.secondaryCredential, "secondary")]);
  if (same(primaryAddress, secondaryAddress)) failClosed("primary and secondary passkey signers must be distinct");
  const [primaryRuntimeCodeHash, secondaryRuntimeCodeHash] = await Promise.all([
    resolvePasskeySignerRuntimeCodeHash({ client, singleton: singleton as Address, credential: input.primaryCredential, verifiers }),
    resolvePasskeySignerRuntimeCodeHash({ client, singleton: singleton as Address, credential: input.secondaryCredential, verifiers }),
  ]);
  const primaryBinding = Object.freeze({ ...input.primaryCredential, verifiers });
  const secondaryBinding = Object.freeze({ ...input.secondaryCredential, verifiers });
  const result = Object.freeze({
    chainId: input.chainId,
    deployer: input.deployer,
    observedDeployerNonce,
    safeSingleton: dependencies.safeSingleton,
    safeProxyFactory: dependencies.safeProxyFactory,
    passkeySignerFactory: dependencies.passkeySignerFactory,
    passkeySignerVerifier: dependencies.passkeySignerVerifier,
    multiSendCallOnly: dependencies.multiSendCallOnly,
    primaryPasskeySigner: Object.freeze({
      name: "passkeySigner" as const,
      address: primaryAddress,
      bindingHash: passkeySignerBindingHash({ factory: dependencies.passkeySignerFactory.address, ...primaryBinding }),
      expectedRuntimeCodeHash: primaryRuntimeCodeHash,
      source: "official Safe WebAuthn signer factory prediction",
      binding: primaryBinding,
    }),
    secondaryPasskeySigner: Object.freeze({
      name: "passkeySigner" as const,
      address: secondaryAddress,
      bindingHash: passkeySignerBindingHash({ factory: dependencies.passkeySignerFactory.address, ...secondaryBinding }),
      expectedRuntimeCodeHash: secondaryRuntimeCodeHash,
      source: "official Safe WebAuthn signer factory prediction",
      binding: secondaryBinding,
    }),
    dependencies,
  });
  pwaPlanningInfrastructure.add(result);
  return result;
}

export function brandPwaPlanningInfrastructureForTestsOnly(value: PwaPlanningInfrastructure): PwaPlanningInfrastructure {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") {
    throw new Error("test-only PWA planning infrastructure branding is disabled outside tests");
  }
  pwaPlanningInfrastructure.add(value);
  return value;
}

export async function resolveDeploymentInfrastructureRegistry(
  client: ReadOnlyDeploymentClient,
  input: DeploymentInfrastructureInput,
  registry: DeploymentInfrastructureRegistry | Readonly<DeploymentInfrastructureRegistry>,
  options: Readonly<{ requireEvidence?: boolean }> = {},
): Promise<DeploymentInfrastructure> {
  if (typeof client.getTransactionCount !== "function") failClosed("deployer nonce reader is required");
  if (typeof client.readContract !== "function") failClosed("passkey binding reader is required");

  const dependencies = await resolveInfrastructureDependencies(client, input.chainId, registry, options);
  const observedNonceRaw = await client.getTransactionCount({ address: input.deployer });
  const observedDeployerNonce = typeof observedNonceRaw === "bigint" ? observedNonceRaw : BigInt(observedNonceRaw);
  if (observedDeployerNonce !== input.expectedDeployerNonce) {
    failClosed(`deployer nonce changed: expected ${input.expectedDeployerNonce}, observed ${observedDeployerNonce}`);
  }

  const passkeySigner = await verifyPasskeySignerComponent(
    { getBytecode: client.getBytecode, readContract: client.readContract },
    {
      ...input.passkeySigner,
      factory: dependencies.passkeySignerFactory.address,
    },
  );

  const result = Object.freeze({
    chainId: input.chainId,
    deployer: input.deployer,
    observedDeployerNonce,
    safeSingleton: dependencies.safeSingleton,
    safeProxyFactory: dependencies.safeProxyFactory,
    passkeySignerFactory: dependencies.passkeySignerFactory,
    passkeySignerVerifier: dependencies.passkeySignerVerifier,
    multiSendCallOnly: dependencies.multiSendCallOnly,
    passkeySigner,
    dependencies,
  }) satisfies DeploymentInfrastructure;

  return result;
}

export function brandVerifiedDeploymentInfrastructureForTestsOnly(value: DeploymentInfrastructure): VerifiedDeploymentInfrastructure {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") {
    throw new Error("test-only deployment infrastructure branding is disabled outside tests");
  }
  verifiedInfrastructure.add(value);
  return value;
}

export async function resolveVerifiedDeploymentInfrastructure(
  client: ReadOnlyDeploymentClient,
  input: DeploymentInfrastructureInput,
): Promise<VerifiedDeploymentInfrastructure> {
  const result = await resolveDeploymentInfrastructureRegistry(client, input, OFFICIAL_DEPLOYMENT_REGISTRY, {
    requireEvidence: true,
  });
  verifiedInfrastructure.add(result);
  return result;
}

export async function resolveVerifiedDeployments(
  client: ReadOnlyDeploymentClient,
  chainId: number,
): Promise<VerifiedDeploymentInfrastructure> {
  return resolveVerifiedDeploymentInfrastructure(client, {
    chainId,
    deployer: "0x0000000000000000000000000000000000000000",
    expectedDeployerNonce: 0n,
    passkeySigner: {
      address: "0x0000000000000000000000000000000000000000",
      runtimeCodeHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      bindingHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      source: "legacy resolver placeholder",
      binding: { x: 0n, y: 0n, verifiers: 0n },
    },
  });
}
