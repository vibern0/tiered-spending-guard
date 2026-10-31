import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { assertValidVaultPolicy, type VaultPolicy } from "../config/policy";
import {
  isOfficialVerifiedDeployments,
  type ReadOnlyDeploymentClient,
  type VerifiedDeploymentInfrastructure,
} from "../config/deployments";
import { deriveComponentAddresses, deriveSafeProxyAddress } from "./addressing";
import { type VerifiedComponent } from "./evidence";
import { type UnsignedSetupCall } from "./multisend";
import { isReviewedVaultArtifacts, type ReviewedVaultArtifacts } from "./reviewed-artifacts";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SIGNER_ROLE = { primary: 0, secondary: 1 } as const;
const SIGNER_KIND = { "safe-contract": 0, "ecdsa-extension": 1 } as const;

const SAFE_ABI = [
  { name: "setup", type: "function", stateMutability: "nonpayable", inputs: [{ name: "owners", type: "address[]" }, { name: "threshold", type: "uint256" }, { name: "to", type: "address" }, { name: "data", type: "bytes" }, { name: "fallbackHandler", type: "address" }, { name: "paymentToken", type: "address" }, { name: "payment", type: "uint256" }, { name: "paymentReceiver", type: "address" }], outputs: [] },
  { name: "setGuard", type: "function", stateMutability: "nonpayable", inputs: [{ name: "guard", type: "address" }], outputs: [] },
  { name: "setModuleGuard", type: "function", stateMutability: "nonpayable", inputs: [{ name: "guard", type: "address" }], outputs: [] },
  { name: "enableModule", type: "function", stateMutability: "nonpayable", inputs: [{ name: "module", type: "address" }], outputs: [] },
] as const;
const FACTORY_ABI = [{ name: "createProxyWithNonce", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_singleton", type: "address" }, { name: "initializer", type: "bytes" }, { name: "saltNonce", type: "uint256" }], outputs: [{ name: "proxy", type: "address" }] }] as const;
const HELPER_ABI = [{ name: "setup", type: "function", stateMutability: "nonpayable", inputs: [{ name: "params", type: "tuple", components: [{ name: "guard", type: "address" }, { name: "delay", type: "address" }, { name: "maintenance", type: "address" }, { name: "passkey", type: "address" }, { name: "safeContractSecondary", type: "address" }, { name: "ecdsaSecondary", type: "address" }, { name: "periodSeconds", type: "uint64" }, { name: "periodAnchor", type: "uint64" }, { name: "assets", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" }, { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" }] }] }], outputs: [] }] as const;
const GUARD_ABI = [
  { name: "config", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "safe", type: "address" }, { name: "passkey", type: "address" }, { name: "ecdsaSecondary", type: "address" }, { name: "delay", type: "address" }, { name: "periodSeconds", type: "uint64" }, { name: "periodAnchor", type: "uint64" }] },
  { name: "safeContractSecondary", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "signer", type: "address" }, { name: "kind", type: "uint8" }, { name: "enabled", type: "bool" }] },
  { name: "ecdsaSecondary", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "signer", type: "address" }, { name: "kind", type: "uint8" }, { name: "enabled", type: "bool" }] },
  { name: "maintenance", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const DELAY_ABI = [
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "avatar", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "target", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "txCooldown", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "txExpiration", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const MAINTENANCE_ABI = [
  { name: "safe", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "delay", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "maintenanceAddress", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export type VaultPlanInput = Readonly<{
  policy: VaultPolicy;
  deployer: Address;
  startingNonce: bigint;
  safeProxySaltNonce: bigint;
  artifacts: ReviewedVaultArtifacts;
  deployments: VerifiedDeploymentInfrastructure;
  /** Number of consecutively journaled prerequisite deployments being resumed. */
  completedPrerequisites?: 0 | 1 | 2 | 3 | 4;
}>;

export type { ReviewedVaultArtifacts } from "./reviewed-artifacts";

export type PlannedDeploymentTransaction = UnsignedSetupCall & Readonly<{
  nonce: bigint;
  description: string;
  expectedCreatedAddress: Address;
  creationCodeHash: Hex;
  expectedRuntimeCodeHash: Hex;
}>;

export type VaultDeploymentPlan = Readonly<{
  unsigned: true;
  broadcast: false;
  chainId: number;
  deployer: Address;
  startingNonce: bigint;
  safeProxySaltNonce: bigint;
  prerequisites: Readonly<{
    setupHelper: PlannedDeploymentTransaction;
    guard: PlannedDeploymentTransaction;
    delay: PlannedDeploymentTransaction;
    maintenance: PlannedDeploymentTransaction;
  }>;
  safeProxyDeployment: PlannedDeploymentTransaction;
  safeInitializer: Hex;
  setupHelperCalldata: Hex;
  review: Readonly<{
    owners: readonly [Address];
    threshold: 1;
    fallbackHandler: Address;
    paymentToken: Address;
    payment: 0n;
    paymentReceiver: Address;
    transactionGuard: Address;
    moduleGuard: Address;
    modules: readonly [Address];
    safeContractSecondary: Address;
    ecdsaSecondary: Address;
    assets: VaultPolicy["assets"];
    delay: Readonly<{ owner: Address; avatar: Address; target: Address; upstreamModules: readonly [Address]; cooldownSeconds: number; expirationSeconds: number }>;
    periodAnchor: bigint;
    policyHash: Hex;
    creationCodeHashes: Readonly<{ setupHelper: Hex; guard: Hex; delay: Hex; maintenance: Hex }>;
    runtimeCodeHashes: Readonly<{ setupHelper: Hex; guard: Hex; delay: Hex; maintenance: Hex }>;
  }>;
}>;

const plannedVaultDeployments = new WeakSet<object>();

export function isReviewedVaultDeploymentPlan(value: unknown): value is VaultDeploymentPlan {
  return typeof value === "object" && value !== null && plannedVaultDeployments.has(value);
}

export function brandVaultDeploymentPlanForTestsOnly(value: VaultDeploymentPlan): VaultDeploymentPlan {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") {
    throw new Error("test-only vault deployment plan branding is disabled outside tests");
  }
  plannedVaultDeployments.add(value);
  return value;
}

export type VerifiedVaultPrerequisites = Readonly<{
  stage: "before-setup" | "after-setup";
  planHash: Hex;
  safeProxyRuntimeCodeHash: Hex;
  setupHelper: VerifiedComponent;
  guard: VerifiedComponent;
  delay: VerifiedComponent;
  maintenance: VerifiedComponent;
}>;

const prerequisiteEvidence = new WeakSet<object>();

export function isVerifiedVaultPrerequisites(value: unknown): value is VerifiedVaultPrerequisites {
  return typeof value === "object" && value !== null && prerequisiteEvidence.has(value);
}

export function brandVerifiedVaultPrerequisitesForTestsOnly(value: VerifiedVaultPrerequisites): VerifiedVaultPrerequisites {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") {
    throw new Error("test-only prerequisite evidence branding is disabled outside tests");
  }
  prerequisiteEvidence.add(value);
  return value;
}

export function policyHash(policy: VaultPolicy): Hex {
  const assets = policy.assets.map((asset) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address[]" }], [asset.token, asset.basePerTransaction, asset.stepUpPerTransaction, asset.baseDailyLimit, asset.instantDailyLimit, [...asset.recipients]])));
  const contractOnly = policy.secondaryProfile === "contract-only";
  const secondaries = policy.secondaries ?? (contractOnly ? [] : [{ address: policy.ecdsaSecondary, role: "secondary" as const, kind: "ecdsa-extension" as const, enabled: true }]);
  const safeContractSecondary = secondaries.find((signer) => signer.kind === "safe-contract") ?? { address: ZERO, role: "secondary" as const, kind: "safe-contract" as const, enabled: false };
  const ecdsaSecondary = secondaries.find((signer) => signer.kind === "ecdsa-extension") ?? { address: policy.ecdsaSecondary, role: "secondary" as const, kind: "ecdsa-extension" as const, enabled: !contractOnly };
  return keccak256(encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "address" },
      { type: "tuple", components: [{ type: "address" }, { type: "uint8" }, { type: "uint8" }, { type: "bool" }] },
      { type: "tuple", components: [{ type: "address" }, { type: "uint8" }, { type: "bool" }] },
      { type: "tuple", components: [{ type: "address" }, { type: "uint8" }, { type: "bool" }] },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32[]" },
    ],
    [
      BigInt(policy.chainId),
      policy.safe,
      [policy.primary ?? policy.passkey, SIGNER_ROLE.primary, SIGNER_KIND["safe-contract"], true],
      [safeContractSecondary.address, SIGNER_KIND[safeContractSecondary.kind], safeContractSecondary.enabled],
      [ecdsaSecondary.address, SIGNER_KIND[ecdsaSecondary.kind], ecdsaSecondary.enabled],
      policy.delay,
      BigInt(policy.periodSeconds),
      policy.periodAnchor,
      BigInt(policy.cooldownSeconds),
      BigInt(policy.expirationSeconds),
      assets,
    ],
  ));
}

export function planHash(plan: VaultDeploymentPlan): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    [
      BigInt(plan.chainId),
      plan.deployer,
      plan.startingNonce,
      plan.safeProxySaltNonce,
      plan.prerequisites.setupHelper.expectedCreatedAddress,
      plan.prerequisites.setupHelper.creationCodeHash,
      plan.prerequisites.setupHelper.expectedRuntimeCodeHash,
      plan.prerequisites.guard.expectedCreatedAddress,
      plan.prerequisites.guard.creationCodeHash,
      plan.prerequisites.guard.expectedRuntimeCodeHash,
      plan.prerequisites.delay.expectedCreatedAddress,
      plan.prerequisites.delay.creationCodeHash,
      plan.prerequisites.delay.expectedRuntimeCodeHash,
      plan.prerequisites.maintenance.expectedCreatedAddress,
      plan.prerequisites.maintenance.creationCodeHash,
      plan.prerequisites.maintenance.expectedRuntimeCodeHash,
      plan.safeProxyDeployment.expectedCreatedAddress,
      keccak256(plan.safeInitializer),
      plan.review.policyHash,
    ],
  ));
}

function assertCreationCode(value: Hex, label: string): void {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error(`${label} creation code is required`);
}

function assertRuntimeHash(value: Hex, label: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} runtime code hash is required`);
}

function same(left: Address, right: Address): boolean {
  return isAddressEqual(left, right);
}

function plannedSetupSigners(plan: VaultDeploymentPlan): { passkey: Address; safeContractSecondary: Address; ecdsaSecondary: Address } {
  const decoded = decodeFunctionData({ abi: HELPER_ABI, data: plan.setupHelperCalldata });
  if (decoded.functionName !== "setup") throw new Error("fail closed: setup helper calldata mismatch");
  const params = decoded.args[0];
  return { passkey: params.passkey, safeContractSecondary: params.safeContractSecondary, ecdsaSecondary: params.ecdsaSecondary };
}

function configuredOptionBSecondaries(policy: VaultPolicy): { safeContractSecondary: Address; ecdsaSecondary: Address } {
  const safeContractSecondary = policy.secondaries?.find((signer) => signer.role === "secondary" && signer.kind === "safe-contract" && signer.enabled)?.address;
  const ecdsaSecondary = policy.secondaries?.find((signer) => signer.role === "secondary" && signer.kind === "ecdsa-extension" && signer.enabled && same(signer.address, policy.ecdsaSecondary))?.address;
  if (!safeContractSecondary) throw new Error("fail closed: Option B requires an enabled Safe-contract secondary");
  if (policy.secondaryProfile === "contract-only") return { safeContractSecondary, ecdsaSecondary: ZERO };
  if (!ecdsaSecondary) throw new Error("fail closed: Option B requires an enabled ECDSA secondary");
  return { safeContractSecondary, ecdsaSecondary };
}

function deployTransaction(description: string, deployer: Address, nonce: bigint, creationCode: Hex, expectedRuntimeCodeHash: Hex, expectedCreatedAddress: Address): PlannedDeploymentTransaction {
  return Object.freeze({
    description,
    nonce,
    to: ZERO,
    value: 0n,
    operation: 0,
    data: creationCode,
    expectedCreatedAddress,
    creationCodeHash: keccak256(creationCode),
    expectedRuntimeCodeHash,
  });
}

/** Derives the Safe address from setup data before constructors bind prerequisites to it. */
export function deriveVaultSafeProxyAddress(input: Readonly<{ policy: VaultPolicy; deployer: Address; startingNonce: bigint; safeProxySaltNonce: bigint; safeProxyCreationCode: Hex; deployments: VerifiedDeploymentInfrastructure }>): Address {
  const components = deriveComponentAddresses({ deployer: input.deployer, startingNonce: input.startingNonce });
  const optionB = configuredOptionBSecondaries(input.policy);
  const setupHelperCalldata = encodeFunctionData({
    abi: HELPER_ABI,
    functionName: "setup",
    args: [{
      guard: components.guard,
      delay: components.delay,
      maintenance: components.maintenance,
      passkey: input.policy.passkey,
      safeContractSecondary: optionB.safeContractSecondary,
      ecdsaSecondary: optionB.ecdsaSecondary,
      periodSeconds: BigInt(input.policy.periodSeconds),
      periodAnchor: input.policy.periodAnchor,
      assets: input.policy.assets.map((asset) => ({ ...asset, recipients: [...asset.recipients] })),
    }],
  });
  const safeInitializer = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "setup",
    args: [[input.policy.passkey], 1n, components.setupHelper, setupHelperCalldata, ZERO, ZERO, 0n, ZERO],
  });
  return deriveSafeProxyAddress({
    factory: input.deployments.safeProxyFactory.address,
    singleton: input.deployments.safeSingleton.address,
    proxyCreationCode: input.safeProxyCreationCode,
    initializer: safeInitializer,
    saltNonce: input.safeProxySaltNonce,
  });
}

export function buildVaultPlan(input: VaultPlanInput): VaultDeploymentPlan {
  assertValidVaultPolicy(input.policy);
  if (!isOfficialVerifiedDeployments(input.deployments)) throw new Error("fail closed: deployments must come from a verified resolver");
  if (!same(input.deployments.deployer, input.deployer)) throw new Error("fail closed: deployer does not match verified deployment infrastructure");
  const completedPrerequisites = input.completedPrerequisites ?? 0;
  if (input.deployments.observedDeployerNonce !== input.startingNonce + BigInt(completedPrerequisites)) {
    throw new Error("fail closed: deployer resume nonce does not match journaled prerequisites");
  }
  if (input.deployments.chainId !== input.policy.chainId) throw new Error("fail closed: policy chain does not match verified deployment infrastructure");
  if (!same(input.deployments.passkeySigner.address, input.policy.passkey)) throw new Error("fail closed: policy passkey does not match verified passkey signer");
  if (!input.deployments.safeSingleton.supportsModuleGuards) throw new Error("fail closed: Safe singleton lacks module guards");
  if (!isReviewedVaultArtifacts(input.artifacts)) throw new Error("fail closed: vault artifacts must come from the reviewed resolver");
  for (const [label, code] of Object.entries({
    setupHelper: input.artifacts.setupHelperCreationCode,
    guard: input.artifacts.guardCreationCode,
    delay: input.artifacts.delayCreationCode,
    maintenance: input.artifacts.maintenanceCreationCode,
  })) assertCreationCode(code as Hex, label);
  assertCreationCode(input.artifacts.safeProxyCreationCode, "Safe proxy");
  for (const [label, runtimeHash] of Object.entries(input.artifacts.prerequisiteRuntimeCodeHashes)) assertRuntimeHash(runtimeHash as Hex, label);
  assertRuntimeHash(input.artifacts.safeProxyRuntimeCodeHash, "Safe proxy");

  const components = deriveComponentAddresses({ deployer: input.deployer, startingNonce: input.startingNonce });
  if (!same(input.policy.delay, components.delay)) throw new Error("fail closed: policy Delay address does not match deterministic prerequisite address");
  const optionB = configuredOptionBSecondaries(input.policy);
  const owners = [input.policy.passkey] as const;

  const setupHelperCalldata = encodeFunctionData({
    abi: HELPER_ABI,
    functionName: "setup",
    args: [{
      guard: components.guard,
      delay: components.delay,
      maintenance: components.maintenance,
      passkey: input.policy.passkey,
      safeContractSecondary: optionB.safeContractSecondary,
      ecdsaSecondary: optionB.ecdsaSecondary,
      periodSeconds: BigInt(input.policy.periodSeconds),
      periodAnchor: input.policy.periodAnchor,
      assets: input.policy.assets.map((asset) => ({ ...asset, recipients: [...asset.recipients] })),
    }],
  });
  const safeInitializer = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: "setup",
    args: [owners, 1n, components.setupHelper, setupHelperCalldata, ZERO, ZERO, 0n, ZERO],
  });
  const factoryCall = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "createProxyWithNonce",
    args: [input.deployments.safeSingleton.address, safeInitializer, input.safeProxySaltNonce],
  });
  const derivedSafeProxy = deriveVaultSafeProxyAddress({ ...input, safeProxyCreationCode: input.artifacts.safeProxyCreationCode });
  if (!same(input.policy.safe, derivedSafeProxy)) throw new Error("fail closed: policy Safe does not match derived Safe proxy address");

  const plan = Object.freeze({
    unsigned: true,
    broadcast: false,
    chainId: input.policy.chainId,
    deployer: input.deployer,
    startingNonce: input.startingNonce,
    safeProxySaltNonce: input.safeProxySaltNonce,
    prerequisites: {
      setupHelper: deployTransaction("deploy SafeAtomicSetupHelper", input.deployer, input.startingNonce, input.artifacts.setupHelperCreationCode, input.artifacts.prerequisiteRuntimeCodeHashes.setupHelper, components.setupHelper),
      guard: deployTransaction("deploy TieredSpendingGuard", input.deployer, input.startingNonce + 1n, input.artifacts.guardCreationCode, input.artifacts.prerequisiteRuntimeCodeHashes.guard, components.guard),
      delay: deployTransaction("deploy Zodiac Delay", input.deployer, input.startingNonce + 2n, input.artifacts.delayCreationCode, input.artifacts.prerequisiteRuntimeCodeHashes.delay, components.delay),
      maintenance: deployTransaction("deploy GuardReplacementMaintenance", input.deployer, input.startingNonce + 3n, input.artifacts.maintenanceCreationCode, input.artifacts.prerequisiteRuntimeCodeHashes.maintenance, components.maintenance),
    },
    safeProxyDeployment: {
      description: "create Vault Safe proxy with atomic helper initializer",
      nonce: input.startingNonce + 4n,
      to: input.deployments.safeProxyFactory.address,
      value: 0n,
      operation: 0,
      data: factoryCall,
      expectedCreatedAddress: derivedSafeProxy,
      creationCodeHash: keccak256(factoryCall),
      expectedRuntimeCodeHash: input.artifacts.safeProxyRuntimeCodeHash,
    },
    safeInitializer,
    setupHelperCalldata,
    review: {
      owners,
      threshold: 1,
      fallbackHandler: ZERO,
      paymentToken: ZERO,
      payment: 0n,
      paymentReceiver: ZERO,
      transactionGuard: components.guard,
      moduleGuard: components.guard,
      modules: [components.delay],
      safeContractSecondary: optionB.safeContractSecondary,
      ecdsaSecondary: optionB.ecdsaSecondary,
      assets: input.policy.assets.map((asset) => Object.freeze({ ...asset, recipients: Object.freeze([...asset.recipients]) })),
      delay: { owner: input.policy.safe, avatar: input.policy.safe, target: input.policy.safe, upstreamModules: [input.policy.safe], cooldownSeconds: input.policy.cooldownSeconds, expirationSeconds: input.policy.expirationSeconds },
      periodAnchor: input.policy.periodAnchor,
      policyHash: policyHash(input.policy),
      creationCodeHashes: {
        setupHelper: keccak256(input.artifacts.setupHelperCreationCode),
        guard: keccak256(input.artifacts.guardCreationCode),
        delay: keccak256(input.artifacts.delayCreationCode),
        maintenance: keccak256(input.artifacts.maintenanceCreationCode),
      },
      runtimeCodeHashes: input.artifacts.prerequisiteRuntimeCodeHashes,
    },
  });
  plannedVaultDeployments.add(plan);
  return plan;
}

async function verifyCode(client: ReadOnlyDeploymentClient, name: VerifiedComponent["name"], address: Address, creationCodeHash: Hex, expectedRuntimeCodeHash: Hex): Promise<VerifiedComponent> {
  const runtimeCode = await client.getBytecode({ address });
  if (!runtimeCode || runtimeCode === "0x") throw new Error(`fail closed: ${name} is not deployed at planned address`);
  const runtimeCodeHash = keccak256(runtimeCode);
  if (runtimeCodeHash.toLowerCase() !== expectedRuntimeCodeHash.toLowerCase()) throw new Error(`fail closed: ${name} runtime code hash mismatch`);
  return Object.freeze({
    name,
    address,
    runtimeCodeHash,
    bindingHash: creationCodeHash,
    source: "planned prerequisite",
  });
}

async function readAddress(client: ReadOnlyDeploymentClient, address: Address, abi: readonly unknown[], functionName: string): Promise<Address> {
  if (typeof client.readContract !== "function") throw new Error("fail closed: prerequisite binding reader is required");
  const result = await client.readContract({ address, abi, functionName });
  if (typeof result !== "string") throw new Error(`fail closed: ${functionName} did not return an address`);
  return result as Address;
}

async function readBigInt(client: ReadOnlyDeploymentClient, address: Address, abi: readonly unknown[], functionName: string): Promise<bigint> {
  if (typeof client.readContract !== "function") throw new Error("fail closed: prerequisite binding reader is required");
  const result = await client.readContract({ address, abi, functionName });
  if (typeof result !== "bigint") throw new Error(`fail closed: ${functionName} did not return a uint`);
  return result;
}

export async function verifyVaultPrerequisites(client: ReadOnlyDeploymentClient, plan: VaultDeploymentPlan, stage: "before-setup" | "after-setup" = "before-setup"): Promise<VerifiedVaultPrerequisites> {
  if (stage !== "before-setup" && stage !== "after-setup") throw new Error("fail closed: invalid prerequisite stage");
  const setupHelper = await verifyCode(client, "setupHelper", plan.prerequisites.setupHelper.expectedCreatedAddress, plan.prerequisites.setupHelper.creationCodeHash, plan.prerequisites.setupHelper.expectedRuntimeCodeHash);
  const guard = await verifyCode(client, "guard", plan.prerequisites.guard.expectedCreatedAddress, plan.prerequisites.guard.creationCodeHash, plan.prerequisites.guard.expectedRuntimeCodeHash);
  const delay = await verifyCode(client, "delay", plan.prerequisites.delay.expectedCreatedAddress, plan.prerequisites.delay.creationCodeHash, plan.prerequisites.delay.expectedRuntimeCodeHash);
  const maintenance = await verifyCode(client, "maintenance", plan.prerequisites.maintenance.expectedCreatedAddress, plan.prerequisites.maintenance.creationCodeHash, plan.prerequisites.maintenance.expectedRuntimeCodeHash);

  if (typeof client.readContract !== "function") throw new Error("fail closed: prerequisite binding reader is required");
  const plannedSigners = plannedSetupSigners(plan);
  const guardConfig = await client.readContract({ address: guard.address, abi: GUARD_ABI, functionName: "config" });
  if (!Array.isArray(guardConfig) || guardConfig.length !== 6) throw new Error("fail closed: guard config evidence malformed");
  const [safe, passkey, configuredEcdsaSecondary, configuredDelay, periodSeconds, periodAnchor] = guardConfig as [Address, Address, Address, Address, bigint, bigint];
  if (!same(safe, plan.safeProxyDeployment.expectedCreatedAddress) || !same(passkey, plannedSigners.passkey) || !same(configuredEcdsaSecondary, plannedSigners.ecdsaSecondary) || !same(configuredDelay, delay.address) || periodSeconds !== 86400n || periodAnchor !== plan.review.periodAnchor) {
    if (periodSeconds !== 86400n || periodAnchor !== plan.review.periodAnchor) throw new Error("fail closed: guard period binding mismatch");
    throw new Error("fail closed: guard binding mismatch");
  }
  const safeContractSecondaryConfig = await client.readContract({ address: guard.address, abi: GUARD_ABI, functionName: "safeContractSecondary" });
  const ecdsaSecondaryConfig = await client.readContract({ address: guard.address, abi: GUARD_ABI, functionName: "ecdsaSecondary" });
  const initialized = stage === "after-setup";
  if (!Array.isArray(safeContractSecondaryConfig) || safeContractSecondaryConfig.length !== 3 || !same(safeContractSecondaryConfig[0] as Address, initialized ? plannedSigners.safeContractSecondary : ZERO) || safeContractSecondaryConfig[1] !== 0 || safeContractSecondaryConfig[2] !== initialized) throw new Error("fail closed: Safe-contract secondary binding mismatch");
  const ecdsaExpectedEnabled = !same(configuredEcdsaSecondary, ZERO);
  if (!Array.isArray(ecdsaSecondaryConfig) || ecdsaSecondaryConfig.length !== 3 || !same(ecdsaSecondaryConfig[0] as Address, configuredEcdsaSecondary) || ecdsaSecondaryConfig[1] !== 1 || ecdsaSecondaryConfig[2] !== ecdsaExpectedEnabled) throw new Error("fail closed: ECDSA secondary binding mismatch");
  if (!same(await readAddress(client, guard.address, GUARD_ABI, "maintenance"), initialized ? maintenance.address : ZERO)) throw new Error("fail closed: guard maintenance mismatch");
  if (!same(await readAddress(client, delay.address, DELAY_ABI, "owner"), plan.safeProxyDeployment.expectedCreatedAddress)) throw new Error("fail closed: Delay owner mismatch");
  if (!same(await readAddress(client, delay.address, DELAY_ABI, "avatar"), plan.safeProxyDeployment.expectedCreatedAddress)) throw new Error("fail closed: Delay avatar mismatch");
  if (!same(await readAddress(client, delay.address, DELAY_ABI, "target"), plan.safeProxyDeployment.expectedCreatedAddress)) throw new Error("fail closed: Delay target mismatch");
  if (await readBigInt(client, delay.address, DELAY_ABI, "txCooldown") !== BigInt(plan.review.delay.cooldownSeconds)) throw new Error("fail closed: Delay cooldown mismatch");
  if (await readBigInt(client, delay.address, DELAY_ABI, "txExpiration") !== BigInt(plan.review.delay.expirationSeconds)) throw new Error("fail closed: Delay expiration mismatch");
  if (!same(await readAddress(client, maintenance.address, MAINTENANCE_ABI, "safe"), plan.safeProxyDeployment.expectedCreatedAddress)) throw new Error("fail closed: maintenance Safe mismatch");
  if (!same(await readAddress(client, maintenance.address, MAINTENANCE_ABI, "delay"), delay.address)) throw new Error("fail closed: maintenance Delay mismatch");
  if (!same(await readAddress(client, maintenance.address, MAINTENANCE_ABI, "maintenanceAddress"), maintenance.address)) throw new Error("fail closed: maintenance self mismatch");

  const result = Object.freeze({ stage, planHash: planHash(plan), safeProxyRuntimeCodeHash: plan.safeProxyDeployment.expectedRuntimeCodeHash, setupHelper, guard, delay, maintenance });
  prerequisiteEvidence.add(result);
  return result;
}

export function assertSafeCreationReady(plan: VaultDeploymentPlan, prerequisites: VerifiedVaultPrerequisites, observedDeployerNonce: bigint): void {
  if (!prerequisiteEvidence.has(prerequisites)) throw new Error("fail closed: prerequisite evidence was not produced by verifier");
  if (prerequisites.stage !== "before-setup") throw new Error("fail closed: Safe creation requires pre-setup evidence");
  if (prerequisites.planHash !== planHash(plan)) throw new Error("fail closed: prerequisite evidence belongs to a different plan");
  const expected = plan.startingNonce + 4n;
  if (observedDeployerNonce !== expected) throw new Error(`fail closed: deployer nonce drift before Safe creation: expected ${expected}, observed ${observedDeployerNonce}`);
}

export function decodeSafeFactoryCall(plan: VaultDeploymentPlan): { singleton: Address; initializer: Hex; saltNonce: bigint } {
  const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: plan.safeProxyDeployment.data });
  if (decoded.functionName !== "createProxyWithNonce") throw new Error("not a Safe factory call");
  return { singleton: decoded.args[0], initializer: decoded.args[1], saltNonce: decoded.args[2] };
}
