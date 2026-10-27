import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, keccak256, parseAbi, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { resolveVerifiedDeploymentInfrastructure } from "../../src/config/deployments";
import { ZODIAC_DELAY_V1_1_1 } from "../../src/config/zodiac-delay";
import { deriveComponentAddresses } from "../../src/topology/addressing";
import { buildVaultPlan, deriveVaultSafeProxyAddress, verifyVaultPrerequisites } from "../../src/topology/build";
import { passkeySignerBindingHash, verifyPasskeySignerComponent } from "../../src/topology/evidence";
import { resolveReviewedVaultArtifacts } from "../../src/topology/reviewed-artifacts";
import { buildOrdinaryReviewPolicyDraft, ORDINARY_REVIEW_SIGNER_SOURCE, readOrdinaryReviewConfig } from "./ordinary-review-profile";
import { bindSafeCreationPrerequisitePackage, createPinnedSafeReviewClient } from "./safe-creation-adapter";
import {
  collectOrdinaryScenarioReview,
  verifyOrdinaryScenarioTopology,
  type IndependentObserverDescriptor,
  type OrdinaryBaselineProof,
  type OrdinaryRepairDescriptor,
  type OrdinaryScenarioReviewClient,
  type OrdinaryScenarioReviewResult,
} from "./ordinary-scenario-review";

const PACKAGE_HASH = "0x8e1139e816a322db4611fe35eb62f4f93a33bacec039a1e2a6c63166af4208b3" as Hex;
const STARTING_NONCE = 673n;
const SAFE_ABI = parseAbi(["function nonce() view returns (uint256)"]);
const DELAY_ABI = parseAbi(["function txNonce() view returns (uint256)", "function queueNonce() view returns (uint256)"]);
const GUARD_ABI = parseAbi(["function spendState(address) view returns (uint256,uint256,uint256)"]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)", "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const FACTORY_ABI = parseAbi(["function getSigner(uint256,uint256,uint176) view returns (address)"]);
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const decimal = (value: string, label: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a canonical decimal string`);
  return BigInt(value);
};
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

export function writeOrdinaryScenarioReviewPackage(result: OrdinaryScenarioReviewResult, directory: string): Readonly<{ directory: string; files: readonly string[]; packageHash: Hex }> {
  if (existsSync(directory)) throw new Error("ordinary scenario review output directory must not already exist");
  const report = JSON.parse(result.rendered) as Record<string, unknown>;
  if (report.status !== "BLOCKED" && report.status !== "READY_FOR_HUMAN_REVIEW") throw new Error("ordinary scenario review report status is invalid");
  const files = ["ordinary-scenario-review.json", "public-manifest.json"] as const;
  const manifest = {
    formatVersion: 1,
    status: result.report.status,
    authorization: "NONE",
    packageHash: result.packageHash,
    reportFile: files[0],
    signed: false,
    broadcast: false,
    liveEstimated: false,
    reviewBoundary: "Read-only conditional artifact. Every future action requires fresh state, signed estimation, exact human review, and separate authorization.",
  };
  mkdirSync(directory, { recursive: false, mode: 0o755 });
  writeFileSync(join(directory, files[0]), result.rendered, { encoding: "utf8", mode: 0o644, flag: "wx" });
  writeFileSync(join(directory, files[1]), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
  return Object.freeze({ directory, files: Object.freeze([...files]), packageHash: result.packageHash });
}

function createScenarioClient(client: ReturnType<typeof createPublicClient>, receiptClient: ReturnType<typeof createPublicClient>, block: Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>): OrdinaryScenarioReviewClient {
  const read = (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args, blockNumber: block.number } as never) as Promise<unknown>;
  return Object.freeze({
    chainId: () => client.getChainId(),
    block: async () => block,
    blockHash: async (blockNumber) => {
      const value = await client.getBlock({ blockNumber });
      if (!value.hash) throw new Error("canonical scenario block hash is unavailable");
      return value.hash;
    },
    safeNonce: async (safe) => BigInt(await read(safe, SAFE_ABI, "nonce") as bigint),
    funderNonce: async (funder) => BigInt(await client.getTransactionCount({ address: funder, blockNumber: block.number })),
    delayNonce: async (delay) => {
      const [txNonce, queueNonce] = await Promise.all([read(delay, DELAY_ABI, "txNonce"), read(delay, DELAY_ABI, "queueNonce")]);
      if (BigInt(txNonce as bigint) !== BigInt(queueNonce as bigint)) throw new Error("ordinary scenario requires equal fresh Delay transaction and queue nonces");
      return BigInt(queueNonce as bigint);
    },
    spendState: async (guard, token) => {
      const state = await read(guard, GUARD_ABI, "spendState", [token]) as readonly bigint[];
      return { window: state[0]!, baseSpent: state[1]!, instantSpent: state[2]! };
    },
    nativeBalance: (account) => client.getBalance({ address: account, blockNumber: block.number }),
    tokenBalance: async (token, account) => BigInt(await read(token, ERC20_ABI, "balanceOf", [account]) as bigint),
    tokenMetadata: async (token) => {
      const [name, symbol, decimals] = await Promise.all([read(token, ERC20_ABI, "name"), read(token, ERC20_ABI, "symbol"), read(token, ERC20_ABI, "decimals")]);
      return { name: String(name), symbol: String(symbol), decimals: Number(decimals) };
    },
    runtimeCode: async (account) => (await client.getBytecode({ address: account, blockNumber: block.number })) ?? "0x",
    passkeySignerAddress: async (factory, x, y, verifiers) => await read(factory, FACTORY_ABI, "getSigner", [x, y, verifiers]) as Address,
    canonicalReceipt: async (transactionHash) => {
      try {
        const receipt = await receiptClient.getTransactionReceipt({ hash: transactionHash });
        return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice };
      } catch { return undefined; }
    },
  });
}

async function reconstructReviewedPlan(repository: string, client: ReturnType<typeof createPublicClient>) {
  const packageDirectory = join(repository, ".superpowers/sdd/2026-10-19-native-safe-4337/task-0-package-2026-10-24-nonce-673");
  const config = readOrdinaryReviewConfig(join(repository, "packages/security-core/config/sepolia.ordinary-review.json"));
  const bindings = json<{ formatVersion: 1; factory: Address; verifiers: string; primary: { address: Address; x: string; y: string }; secondary: { address: Address; x: string; y: string } }>(join(repository, ".superpowers/sdd/2026-10-19-native-safe-4337/safe-creation-2026-10-27/public-passkey-bindings.json"));
  const decoded = json<{ estimates: { runtimeChecks: readonly { name: string; bindingHash?: Hex }[] } }>(join(packageDirectory, "decoded-review.json"));
  const manifest = json<{ snapshotBlockNumber: string }>(join(packageDirectory, "public-manifest.json"));
  const primaryHash = decoded.estimates.runtimeChecks.find((entry) => entry.name === "primaryPasskey")?.bindingHash;
  const secondaryHash = decoded.estimates.runtimeChecks.find((entry) => entry.name === "safeContractSecondary")?.bindingHash;
  if (bindings.formatVersion !== 1 || !primaryHash || !secondaryHash || !same(bindings.primary.address, config.primaryPasskey) || !same(bindings.secondary.address, config.safeContractSecondary)) throw new Error("public signer bindings do not match the frozen review package");
  const verifier = decimal(bindings.verifiers, "public verifier bitmap");
  const primaryBinding = { x: decimal(bindings.primary.x, "primary x"), y: decimal(bindings.primary.y, "primary y"), verifiers: verifier };
  const secondaryBinding = { x: decimal(bindings.secondary.x, "secondary x"), y: decimal(bindings.secondary.y, "secondary y"), verifiers: verifier };
  if (!same(passkeySignerBindingHash({ factory: bindings.factory, ...primaryBinding }), primaryHash) || !same(passkeySignerBindingHash({ factory: bindings.factory, ...secondaryBinding }), secondaryHash)) throw new Error("public signer coordinates do not match frozen binding hashes");
  const historical = createPinnedSafeReviewClient(client as never, decimal(manifest.snapshotBlockNumber, "historical block"));
  const [primaryRuntime, secondaryRuntime] = await Promise.all([historical.getBytecode({ address: config.primaryPasskey }), historical.getBytecode({ address: config.safeContractSecondary })]);
  if (!primaryRuntime || !secondaryRuntime) throw new Error("historical signer runtime is unavailable");
  const deployments = await resolveVerifiedDeploymentInfrastructure(historical, { chainId: sepolia.id, deployer: config.funder, expectedDeployerNonce: STARTING_NONCE, passkeySigner: { address: config.primaryPasskey, runtimeCodeHash: keccak256(primaryRuntime), bindingHash: primaryHash, source: ORDINARY_REVIEW_SIGNER_SOURCE, binding: primaryBinding } });
  await verifyPasskeySignerComponent(historical, { address: config.safeContractSecondary, runtimeCodeHash: keccak256(secondaryRuntime), bindingHash: secondaryHash, factory: bindings.factory, source: ORDINARY_REVIEW_SIGNER_SOURCE, binding: secondaryBinding });
  const proxyCode = await historical.readContract({ address: deployments.safeProxyFactory.address, abi: [{ name: "proxyCreationCode", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] }] as const, functionName: "proxyCreationCode" }) as Hex;
  const components = deriveComponentAddresses({ deployer: config.funder, startingNonce: STARTING_NONCE });
  const draft = buildOrdinaryReviewPolicyDraft(config, STARTING_NONCE);
  const safe = deriveVaultSafeProxyAddress({ policy: draft, deployer: config.funder, startingNonce: STARTING_NONCE, safeProxySaltNonce: config.safeProxySaltNonce, safeProxyCreationCode: proxyCode, deployments });
  const response = await fetch(ZODIAC_DELAY_V1_1_1.sourceUrl);
  if (!response.ok) throw new Error("pinned Delay artifact fetch failed");
  const artifacts = await resolveReviewedVaultArtifacts({ client: historical, deployments, safe, primaryPasskey: config.primaryPasskey, ecdsaSecondary: config.ecdsaSecondary, delay: components.delay, maintenance: components.maintenance, periodAnchor: config.periodAnchor, cooldownSeconds: 120n, expirationSeconds: 600n, delayArtifactSource: await response.text() });
  const policy = { ...draft, safe };
  const plan = buildVaultPlan({ policy, deployer: config.funder, startingNonce: STARTING_NONCE, safeProxySaltNonce: config.safeProxySaltNonce, artifacts, deployments });
  bindSafeCreationPrerequisitePackage(plan, packageDirectory, PACKAGE_HASH);
  return { config, bindings, primaryBinding, secondaryBinding, plan, policy, components };
}

export async function main(): Promise<void> {
  if (process.env.LIVE_SUBMIT !== undefined || process.env.PRIVATE_KEY !== undefined || process.env.VAULT_FUNDING_KEY_PATH !== undefined) throw new Error("ordinary scenario review CLI rejects signing and submission inputs");
  const repository = process.cwd().replace(/\/packages\/security-core$/, "");
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com") });
  const historicalClient = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_ARCHIVE_RPC_URL ?? "https://sepolia.gateway.tenderly.co") });
  const reconstructed = await reconstructReviewedPlan(repository, historicalClient);
  const latest = await client.getBlock();
  if (latest.number === null || !latest.hash) throw new Error("latest canonical scenario block is unavailable");
  const block = Object.freeze({ number: latest.number, hash: latest.hash, timestamp: latest.timestamp });
  const pinned = createPinnedSafeReviewClient(client as never, block.number);
  const topologyClient = Object.freeze({ ...pinned, getStorageAt: ({ address, slot }: { address: Address; slot: Hex }) => client.getStorageAt({ address, slot, blockNumber: block.number }) });
  const currentFunderNonce = BigInt(await pinned.getTransactionCount({ address: reconstructed.config.funder }));
  const [primaryRuntime, secondaryRuntime] = await Promise.all([pinned.getBytecode({ address: reconstructed.config.primaryPasskey }), pinned.getBytecode({ address: reconstructed.config.safeContractSecondary })]);
  if (!primaryRuntime || !secondaryRuntime) throw new Error("current signer runtime is unavailable");
  const currentDeployments = await resolveVerifiedDeploymentInfrastructure(pinned, { chainId: sepolia.id, deployer: reconstructed.config.funder, expectedDeployerNonce: currentFunderNonce, passkeySigner: { address: reconstructed.config.primaryPasskey, runtimeCodeHash: keccak256(primaryRuntime), bindingHash: passkeySignerBindingHash({ factory: reconstructed.bindings.factory, ...reconstructed.primaryBinding }), source: ORDINARY_REVIEW_SIGNER_SOURCE, binding: reconstructed.primaryBinding } });
  await verifyPasskeySignerComponent(pinned, { address: reconstructed.config.safeContractSecondary, runtimeCodeHash: keccak256(secondaryRuntime), bindingHash: passkeySignerBindingHash({ factory: reconstructed.bindings.factory, ...reconstructed.secondaryBinding }), factory: reconstructed.bindings.factory, source: ORDINARY_REVIEW_SIGNER_SOURCE, binding: reconstructed.secondaryBinding });
  const prerequisites = await verifyVaultPrerequisites(pinned, reconstructed.plan, "after-setup");
  const topology = await verifyOrdinaryScenarioTopology(reconstructed.plan, { chainId: sepolia.id, policy: reconstructed.policy, safe: reconstructed.plan.safeProxyDeployment.expectedCreatedAddress, guard: reconstructed.components.guard, delay: reconstructed.components.delay, deployments: currentDeployments, prerequisites, client: topologyClient });
  if (!topology.ok) throw new Error(`ordinary scenario topology failed: ${topology.failures.join(", ")}`);
  const observerPath = process.env.ORDINARY_SCENARIO_OBSERVER ?? join(repository, ".superpowers/sdd/2026-10-19-native-safe-4337/observer-test-public.json");
  const observer = json<IndependentObserverDescriptor>(observerPath);
  const repair = json<OrdinaryRepairDescriptor>(join(repository, ".superpowers/sdd/2026-10-19-native-safe-4337/repair-secondary-public.json"));
  const repairQuote = json<{ scope: string; chainId: number; blockNumber: string; blockHash: Hex; factory: Address; predictedSigner: Address; calldata: Hex; dataHash: Hex; value: string; estimatedGas: string; proposedGasCap: string; maxFeePerGasCap: string; maximumGasReservationWei: string; exactCapCallPassed: boolean; signed: boolean; broadcast: boolean }>(join(repository, ".superpowers/sdd/2026-10-19-native-safe-4337/repair-secondary-creation-quote.json"));
  const quoteGas = decimal(repairQuote.proposedGasCap, "replacement signer proposed gas cap");
  const quoteMaxFee = decimal(repairQuote.maxFeePerGasCap, "replacement signer max fee cap");
  const quoteBlock = await client.getBlock({ blockNumber: decimal(repairQuote.blockNumber, "replacement signer quote block") });
  if (repairQuote.scope !== "unsigned-replacement-signer-proposal" || repairQuote.chainId !== sepolia.id || !quoteBlock.hash || quoteBlock.hash.toLowerCase() !== repairQuote.blockHash.toLowerCase() || !same(repairQuote.factory, repair.factory) || !same(repairQuote.predictedSigner, repair.address) || repairQuote.dataHash.toLowerCase() !== keccak256(repairQuote.calldata).toLowerCase() || repairQuote.value !== "0" || quoteGas < decimal(repairQuote.estimatedGas, "replacement signer estimate") || quoteMaxFee !== reconstructed.config.maxFeePerGas || decimal(repairQuote.maximumGasReservationWei, "replacement signer maximum reservation") !== quoteGas * quoteMaxFee || repairQuote.exactCapCallPassed !== true || repairQuote.signed !== false || repairQuote.broadcast !== false) throw new Error("replacement signer public creation quote mismatch");
  const baselineSource = json<OrdinaryBaselineProof>(join(repository, "packages/security-core/docs/evidence/2026-10-27-ordinary-safe-baseline.json"));
  const baseline: OrdinaryBaselineProof = Object.freeze({ schemaVersion: baselineSource.schemaVersion, result: baselineSource.result, chainId: baselineSource.chainId, planHash: baselineSource.planHash, safe: baselineSource.safe, transactions: Object.freeze([...baselineSource.transactions]), prerequisiteActualCostWei: baselineSource.prerequisiteActualCostWei, safeCreationActualCostWei: baselineSource.safeCreationActualCostWei, combinedActualCostWei: baselineSource.combinedActualCostWei });
  const result = await collectOrdinaryScenarioReview({
    plan: reconstructed.plan,
    topology,
    baseline,
    signers: {
      primary: { address: reconstructed.config.primaryPasskey, kind: "safe-contract", available: true, source: "public factory-bound passkey descriptor" },
      safeContractSecondary: { address: reconstructed.config.safeContractSecondary, kind: "safe-contract", available: true, source: "public factory-bound passkey descriptor" },
      ecdsaSecondary: { address: reconstructed.config.ecdsaSecondary, kind: "ecdsa-extension", available: true, source: "approved non-WalletConnect public capability descriptor" },
    },
    observer,
    repair,
    proposedCaps: { maxFeePerGas: reconstructed.config.maxFeePerGas, maxPriorityFeePerGas: reconstructed.config.maxPriorityFeePerGas, fundingGasLimit: quoteGas, safeExecutionGasLimit: 500_000n, publicDelayGasLimit: 300_000n },
  }, createScenarioClient(client, historicalClient, block));
  const repairCreate = result.report.actions.find((action) => action.id === "repair-signer-create");
  if (repairCreate?.publicTransaction?.data !== repairQuote.calldata || repairCreate.proposedGasAndFee.gasLimit !== repairQuote.proposedGasCap || repairCreate.proposedGasAndFee.maxFeePerGas !== repairQuote.maxFeePerGasCap) throw new Error("replacement signer action does not match the public creation quote");
  const output = process.env.ORDINARY_SCENARIO_OUTPUT ?? "/tmp/native-safe-2026-10-27-ordinary-scenario-review-v2";
  const written = writeOrdinaryScenarioReviewPackage(result, output);
  process.stdout.write(`${JSON.stringify({ status: result.report.status, packageHash: written.packageHash, blockNumber: block.number.toString(), blockHash: block.hash, blockers: result.report.blockers, output: written.directory })}\n`);
}

if (require.main === module) void main();
