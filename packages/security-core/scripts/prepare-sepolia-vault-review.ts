import { readFileSync } from "node:fs";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";
import { resolveVerifiedDeploymentInfrastructure } from "../src/config/deployments";
import { ZODIAC_DELAY_V1_1_1 } from "../src/config/zodiac-delay";
import { deriveComponentAddresses } from "../src/topology/addressing";
import { buildVaultPlan, deriveVaultSafeProxyAddress, planHash } from "../src/topology/build";
import { passkeySignerBindingHash, verifyPasskeySignerComponent } from "../src/topology/evidence";
import { resolveReviewedVaultArtifacts } from "../src/topology/reviewed-artifacts";
import { loadCredential } from "./live/secrets";
import { captureVaultReviewSnapshot, collectVaultDeploymentReviewEvidence } from "./live/prepare-vault-review";
import { writeReviewedVaultDeploymentPackage } from "./package-sepolia-rehearsal";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const VERIFIER = BigInt("0xc2b78104907F722DABAc4C69f826a522B2754De4");
const PASSKEY_FACTORY = "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf" as Address;
const ERC20_ABI = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

type ReviewConfig = Readonly<{
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

function readConfig(path: string): ReviewConfig {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const expected = ["chainId", "ecdsaSecondary", "erc20", "erc20Decimals", "erc20Name", "erc20Symbol", "formatVersion", "funder", "maxFeePerGas", "maxPriorityFeePerGas", "periodAnchor", "primaryPasskey", "recipient", "safeContractSecondary", "safeCreationGasLimit", "safeProxySaltNonce"];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("review config has unexpected or missing fields");
  if (value.formatVersion !== 1 || value.chainId !== sepolia.id) throw new Error("review config must target Sepolia format version 1");
  for (const key of ["funder", "primaryPasskey", "safeContractSecondary", "ecdsaSecondary", "erc20", "recipient"] as const) {
    if (!isAddress(value[key])) throw new Error(`${key} must be an address`);
  }
  const result = {
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
  };
  if (!/^[ -~]{1,64}$/.test(result.erc20Name) || !/^[A-Z0-9]{1,16}$/.test(result.erc20Symbol) || !Number.isInteger(result.erc20Decimals) || result.erc20Decimals < 0 || result.erc20Decimals > 36) throw new Error("reviewed ERC-20 metadata is invalid");
  if (new Set([result.primaryPasskey.toLowerCase(), result.safeContractSecondary.toLowerCase(), result.ecdsaSecondary.toLowerCase()]).size !== 3) throw new Error("review signers must be distinct");
  return Object.freeze(result);
}

async function main(): Promise<void> {
  const [configPath, primaryCredentialPath, secondaryCredentialPath, outputDir] = process.argv.slice(2);
  if (!configPath || !primaryCredentialPath || !secondaryCredentialPath || !outputDir) {
    throw new Error("usage: npm run prepare:sepolia-vault-review -- <public-config> <primary-credential> <secondary-credential> <empty-output-dir>");
  }
  const config = readConfig(configPath);
  const repository = process.cwd().replace(/\/packages\/security-core$/, "");
  // The approved loader validates private external files. Only public x/y values
  // are retained below; no private field is printed, packaged, signed or sent.
  const primaryLoaded = loadCredential(primaryCredentialPath, repository);
  const secondaryLoaded = loadCredential(secondaryCredentialPath, repository);
  const primary = { x: primaryLoaded.x, y: primaryLoaded.y };
  const secondary = { x: secondaryLoaded.x, y: secondaryLoaded.y };
  const client = createPublicClient({ chain: sepolia, transport: http(PUBLIC_RPC) });
  if (await client.getChainId() !== sepolia.id) throw new Error("public RPC returned the wrong chain");
  const snapshot = await captureVaultReviewSnapshot(client);
  const snapshotClient = {
    getBytecode: ({ address }: { address: Address }) => client.getBytecode({ address, blockNumber: snapshot.blockNumber }),
    getTransactionCount: ({ address }: { address: Address }) => client.getTransactionCount({ address, blockNumber: snapshot.blockNumber }),
    readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => client.readContract({ ...args, blockNumber: snapshot.blockNumber } as never),
    call: ({ data }: { data: Hex }) => client.call({ data, blockNumber: snapshot.blockNumber }),
  };
  const startingNonce = BigInt(await snapshotClient.getTransactionCount({ address: config.funder }));
  const primaryRuntime = await snapshotClient.getBytecode({ address: config.primaryPasskey });
  if (!primaryRuntime) throw new Error("primary passkey signer is absent");
  const deployments = await resolveVerifiedDeploymentInfrastructure(snapshotClient, {
    chainId: config.chainId,
    deployer: config.funder,
    expectedDeployerNonce: startingNonce,
    passkeySigner: {
      address: config.primaryPasskey,
      runtimeCodeHash: keccak256(primaryRuntime),
      bindingHash: passkeySignerBindingHash({ factory: PASSKEY_FACTORY, x: primary.x, y: primary.y, verifiers: VERIFIER }),
      source: "approved local automated primary credential",
      binding: { x: primary.x, y: primary.y, verifiers: VERIFIER },
    },
  });
  const secondaryRuntime = await snapshotClient.getBytecode({ address: config.safeContractSecondary });
  if (!secondaryRuntime) throw new Error("Safe-contract secondary signer is absent");
  const verifiedSecondary = await verifyPasskeySignerComponent(snapshotClient, {
    name: "safeContractSecondary",
    address: config.safeContractSecondary,
    runtimeCodeHash: keccak256(secondaryRuntime),
    bindingHash: passkeySignerBindingHash({ factory: PASSKEY_FACTORY, x: secondary.x, y: secondary.y, verifiers: VERIFIER }),
    factory: PASSKEY_FACTORY,
    source: "approved local automated secondary credential",
    binding: { x: secondary.x, y: secondary.y, verifiers: VERIFIER },
  });
  const ecdsaCode = await snapshotClient.getBytecode({ address: config.ecdsaSecondary });
  if (ecdsaCode && ecdsaCode !== "0x") throw new Error("ECDSA secondary must remain an EOA in the ordinary baseline profile");

  const proxyCreationCode = await snapshotClient.readContract({
    address: deployments.safeProxyFactory.address,
    abi: [{ name: "proxyCreationCode", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] }] as const,
    functionName: "proxyCreationCode",
  });
  const components = deriveComponentAddresses({ deployer: config.funder, startingNonce });
  const assets = [
    { token: ZERO, basePerTransaction: 10_000_000_000_000n, stepUpPerTransaction: 30_000_000_000_000n, baseDailyLimit: 10_000_000_000_000n, instantDailyLimit: 30_000_000_000_000n, recipients: [config.recipient] },
    { token: config.erc20, basePerTransaction: 10_000_000n, stepUpPerTransaction: 30_000_000n, baseDailyLimit: 10_000_000n, instantDailyLimit: 30_000_000n, recipients: [config.recipient] },
  ] as const;
  const draft = {
    chainId: config.chainId,
    safe: ZERO,
    primary: config.primaryPasskey,
    passkey: config.primaryPasskey,
    ecdsaSecondary: config.ecdsaSecondary,
    secondaries: [
      { address: config.safeContractSecondary, role: "secondary" as const, kind: "safe-contract" as const, enabled: true },
      { address: config.ecdsaSecondary, role: "secondary" as const, kind: "ecdsa-extension" as const, enabled: true },
    ],
    delay: components.delay,
    periodSeconds: 86400 as const,
    periodAnchor: config.periodAnchor,
    cooldownSeconds: 120,
    expirationSeconds: 600,
    assets,
  };
  const safe = deriveVaultSafeProxyAddress({ policy: draft, deployer: config.funder, startingNonce, safeProxySaltNonce: config.safeProxySaltNonce, safeProxyCreationCode: proxyCreationCode, deployments });
  const delayResponse = await fetch(ZODIAC_DELAY_V1_1_1.sourceUrl);
  if (!delayResponse.ok) throw new Error("pinned Delay artifact fetch failed");
  const artifacts = await resolveReviewedVaultArtifacts({
    client: snapshotClient,
    deployments,
    safe,
    primaryPasskey: config.primaryPasskey,
    ecdsaSecondary: config.ecdsaSecondary,
    delay: components.delay,
    maintenance: components.maintenance,
    periodAnchor: config.periodAnchor,
    cooldownSeconds: 120n,
    expirationSeconds: 600n,
    delayArtifactSource: await delayResponse.text(),
  });
  const plan = buildVaultPlan({ policy: { ...draft, safe }, deployer: config.funder, startingNonce, safeProxySaltNonce: config.safeProxySaltNonce, artifacts, deployments });
  const erc20Runtime = await snapshotClient.getBytecode({ address: config.erc20 });
  if (!erc20Runtime) throw new Error("selected ERC-20 has no runtime code");
  const [name, symbol, decimals] = await Promise.all([
    snapshotClient.readContract({ address: config.erc20, abi: ERC20_ABI, functionName: "name" }),
    snapshotClient.readContract({ address: config.erc20, abi: ERC20_ABI, functionName: "symbol" }),
    snapshotClient.readContract({ address: config.erc20, abi: ERC20_ABI, functionName: "decimals" }),
  ]);
  if (name !== config.erc20Name || symbol !== config.erc20Symbol || decimals !== config.erc20Decimals) throw new Error("selected ERC-20 metadata does not match the reviewed public profile");
  const runtimeChecks = [
    ...Object.values(deployments.dependencies).map((dependency) => ({ name: dependency.name, address: dependency.address, runtimeCodeHash: dependency.runtimeCodeHash })),
    { name: "primaryPasskey", address: deployments.passkeySigner.address, runtimeCodeHash: deployments.passkeySigner.runtimeCodeHash, bindingHash: deployments.passkeySigner.bindingHash },
    { name: "safeContractSecondary", address: verifiedSecondary.address, runtimeCodeHash: verifiedSecondary.runtimeCodeHash, bindingHash: verifiedSecondary.bindingHash },
    { name: "plannedSetupHelper", address: components.setupHelper, runtimeCodeHash: artifacts.prerequisiteRuntimeCodeHashes.setupHelper, bindingHash: keccak256(artifacts.setupHelperCreationCode) },
    { name: "plannedGuard", address: components.guard, runtimeCodeHash: artifacts.prerequisiteRuntimeCodeHashes.guard, bindingHash: keccak256(artifacts.guardCreationCode) },
    { name: "plannedDelay", address: components.delay, runtimeCodeHash: artifacts.prerequisiteRuntimeCodeHashes.delay, bindingHash: keccak256(artifacts.delayCreationCode) },
    { name: "plannedMaintenance", address: components.maintenance, runtimeCodeHash: artifacts.prerequisiteRuntimeCodeHashes.maintenance, bindingHash: keccak256(artifacts.maintenanceCreationCode) },
    { name: "plannedSafeProxy", address: safe, runtimeCodeHash: artifacts.safeProxyRuntimeCodeHash },
  ];
  const evidence = await collectVaultDeploymentReviewEvidence(plan, client, {
    maxFeePerGas: config.maxFeePerGas,
    maxPriorityFeePerGas: config.maxPriorityFeePerGas,
    safeCreationGasLimit: config.safeCreationGasLimit,
    snapshot,
    runtimeChecks,
    assetChecks: [
      { token: ZERO, kind: "native", symbol: "ETH", decimals: 18 },
      { token: config.erc20, kind: "erc20", symbol, decimals, runtimeCodeHash: keccak256(erc20Runtime) },
    ],
  });
  const result = writeReviewedVaultDeploymentPackage(plan, evidence, outputDir);
  process.stdout.write(`${JSON.stringify({ outputDir: result.outputDir, files: result.files, packageHash: result.packageHash, planHash: planHash(plan), status: "AWAITING_HUMAN_REVIEW", broadcast: false }, null, 2)}\n`);
}

void main();
