import { readFileSync } from "node:fs";
import { createPublicClient, http, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { resolveVerifiedDeploymentInfrastructure } from "../../src/config/deployments";
import { ZODIAC_DELAY_V1_1_1 } from "../../src/config/zodiac-delay";
import { deriveComponentAddresses } from "../../src/topology/addressing";
import { buildVaultPlan, deriveVaultSafeProxyAddress, verifyVaultPrerequisites } from "../../src/topology/build";
import { passkeySignerBindingHash, verifyPasskeySignerComponent } from "../../src/topology/evidence";
import { resolveReviewedVaultArtifacts } from "../../src/topology/reviewed-artifacts";
import { verifyTopology } from "../../src/topology/verify";
import { buildOrdinaryReviewPolicyDraft, ORDINARY_REVIEW_SIGNER_SOURCE, readOrdinaryReviewConfig, selectApprovedFees } from "./ordinary-review-profile";
import { createSepoliaLiveContext, readLiveJournal, withLiveJournalStore } from "./runtime";
import { loadFundingKey } from "./secrets";
import { collectSafeCreationQuote, executeSafeCreation, loadSafeCreationApproval, writeSafeCreationReviewPackage, type PublicPrerequisiteVerification } from "./safe-creation-runner";

const decimalEnv = (name: string): bigint => {
  const value = process.env[name];
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} public decimal input is required`);
  return BigInt(value);
};
const decimal = (value: string, label: string): bigint => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a decimal string`);
  return BigInt(value);
};
const hexEnv = (name: string): Hex => {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a 32-byte hash`);
  return value as Hex;
};
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

async function main(): Promise<void> {
  const repository = process.cwd().replace(/\/packages\/security-core$/, "");
  const config = readOrdinaryReviewConfig(process.env.VAULT_REVIEW_CONFIG ?? `${repository}/packages/security-core/config/sepolia.ordinary-review.json`);
  const startingNonce = decimalEnv("VAULT_PREREQUISITE_START_NONCE");
  const currentNonce = decimalEnv("VAULT_SAFE_CURRENT_NONCE");
  if (startingNonce !== 673n || currentNonce < startingNonce + 4n) throw new Error("Safe stage requires immutable prerequisite CREATE nonces 673-676 and a current nonce at least 677");
  const packageDirectory = process.env.VAULT_REVIEW_PACKAGE_DIR;
  const proofPath = process.env.VAULT_PREREQUISITE_VERIFICATION;
  const journalPath = process.env.VAULT_DEPLOYMENT_JOURNAL;
  const outputDirectory = process.env.VAULT_SAFE_REVIEW_OUTPUT;
  if (!packageDirectory || !proofPath || !journalPath || !outputDirectory) throw new Error("review package, public verification, journal, and Safe review output paths are required");
  const prerequisitePackageHash = hexEnv("VAULT_REVIEW_PACKAGE_HASH");
  const bindingsPath = process.env.VAULT_PUBLIC_PASSKEY_BINDINGS;
  if (!bindingsPath) throw new Error("VAULT_PUBLIC_PASSKEY_BINDINGS public profile path is required");
  const bindings = json<{ formatVersion: number; factory: Address; verifiers: string; primary: { address: Address; x: string; y: string }; secondary: { address: Address; x: string; y: string } }>(bindingsPath);
  const decoded = json<{ estimates: { runtimeChecks: readonly { name: string; address: Address; bindingHash?: Hex }[] } }>(`${packageDirectory}/decoded-review.json`);
  const primaryCheck = decoded.estimates.runtimeChecks.find(check => check.name === "primaryPasskey");
  const secondaryCheck = decoded.estimates.runtimeChecks.find(check => check.name === "safeContractSecondary");
  if (bindings.formatVersion !== 1 || !primaryCheck?.bindingHash || !secondaryCheck?.bindingHash || !same(bindings.primary.address, config.primaryPasskey) || !same(bindings.secondary.address, config.safeContractSecondary)) throw new Error("public passkey profile does not match reviewed package signers");
  const primaryBindingHash = primaryCheck.bindingHash;
  const secondaryBindingHash = secondaryCheck.bindingHash;
  const verifier = decimal(bindings.verifiers, "public verifier");
  const primary = { x: decimal(bindings.primary.x, "public primary x"), y: decimal(bindings.primary.y, "public primary y"), verifiers: verifier };
  const secondary = { x: decimal(bindings.secondary.x, "public secondary x"), y: decimal(bindings.secondary.y, "public secondary y"), verifiers: verifier };
  const rpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const client = createPublicClient({ chain: sepolia, transport: http(rpc) });
  const factory = bindings.factory;
  if (!same(passkeySignerBindingHash({ factory, ...primary }), primaryBindingHash) || !same(passkeySignerBindingHash({ factory, ...secondary }), secondaryBindingHash)) throw new Error("public signer coordinates do not match reviewed binding hashes");
  const primaryRuntime = await client.getBytecode({ address: config.primaryPasskey });
  const secondaryRuntime = await client.getBytecode({ address: config.safeContractSecondary });
  if (!primaryRuntime || !secondaryRuntime) throw new Error("reviewed public signer runtime is absent");
  const deployments = await resolveVerifiedDeploymentInfrastructure(client, { chainId: sepolia.id, deployer: config.funder, expectedDeployerNonce: currentNonce, passkeySigner: { address: config.primaryPasskey, runtimeCodeHash: keccak256(primaryRuntime), bindingHash: primaryBindingHash, source: ORDINARY_REVIEW_SIGNER_SOURCE, binding: primary } });
  await verifyPasskeySignerComponent(client, { name: "safeContractSecondary", address: config.safeContractSecondary, runtimeCodeHash: keccak256(secondaryRuntime), bindingHash: secondaryBindingHash, factory, source: ORDINARY_REVIEW_SIGNER_SOURCE, binding: secondary });
  const proxyCode = await client.readContract({ address: deployments.safeProxyFactory.address, abi: [{ name: "proxyCreationCode", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] }] as const, functionName: "proxyCreationCode" });
  const components = deriveComponentAddresses({ deployer: config.funder, startingNonce });
  const draft = buildOrdinaryReviewPolicyDraft(config, startingNonce);
  const safe = deriveVaultSafeProxyAddress({ policy: draft, deployer: config.funder, startingNonce, safeProxySaltNonce: config.safeProxySaltNonce, safeProxyCreationCode: proxyCode, deployments });
  const response = await fetch(ZODIAC_DELAY_V1_1_1.sourceUrl); if (!response.ok) throw new Error("pinned Delay artifact fetch failed");
  const artifacts = await resolveReviewedVaultArtifacts({ client, deployments, safe, primaryPasskey: config.primaryPasskey, ecdsaSecondary: config.ecdsaSecondary, delay: components.delay, maintenance: components.maintenance, periodAnchor: config.periodAnchor, cooldownSeconds: 120n, expirationSeconds: 600n, delayArtifactSource: await response.text() });
  const policy = { ...draft, safe };
  const plan = buildVaultPlan({ policy, deployer: config.funder, startingNonce, safeProxySaltNonce: config.safeProxySaltNonce, artifacts, deployments, completedPrerequisites: 4 });
  const proof = json<PublicPrerequisiteVerification>(proofPath);
  if (!same(proof.packageHash, prerequisitePackageHash)) throw new Error("public prerequisite proof does not match frozen reviewed package hash");
  const journal = readLiveJournal(journalPath, config.funder);

  if (process.env.LIVE_SUBMIT === undefined) {
    const quote = await collectSafeCreationQuote(plan, proof, journal, {
      chainId: () => client.getChainId(), block: async () => { const block = await client.getBlock(); if (block.number === null || !block.hash) throw new Error("latest canonical block unavailable"); return { number: block.number, hash: block.hash }; }, blockHash: async number => { const block = await client.getBlock({ blockNumber: number }); if (!block.hash) throw new Error("canonical block unavailable"); return block.hash; },
      latestNonce: async () => Number(await client.getTransactionCount({ address: config.funder, blockTag: "latest" })), pendingNonce: async () => Number(await client.getTransactionCount({ address: config.funder, blockTag: "pending" })), balance: () => client.getBalance({ address: config.funder }), code: address => client.getBytecode({ address }),
      transaction: async hash => { const tx = await client.getTransaction({ hash }); if (tx.type !== "eip1559") throw new Error("canonical prerequisite is not EIP-1559"); return { hash: tx.hash, from: tx.from, to: tx.to ?? undefined, nonce: tx.nonce, chainId: tx.chainId!, type: "eip1559", value: tx.value, input: tx.input }; },
      receipt: async hash => { try { const receipt = await client.getTransactionReceipt({ hash }); return { transactionHash: receipt.transactionHash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }; } catch { return undefined; } },
      estimateGas: args => client.estimateGas(args), call: args => client.call(args), fees: async () => { const suggested = await client.estimateFeesPerGas(); const block = await client.getBlock(); if (block.baseFeePerGas === null) throw new Error("base fee unavailable"); return { ...selectApprovedFees(suggested, block.baseFeePerGas, config), baseFeePerGas: block.baseFeePerGas }; },
    }, { gasLimit: decimalEnv("VAULT_SAFE_GAS_LIMIT_CAP"), maxFeePerGas: decimalEnv("VAULT_SAFE_MAX_FEE_CAP"), maxPriorityFeePerGas: decimalEnv("VAULT_SAFE_PRIORITY_FEE_CAP") });
    const written = writeSafeCreationReviewPackage(quote, outputDirectory);
    console.log(JSON.stringify({ ...quote.report, packageHash: written.packageHash, path: written.path }));
    return;
  }
  if (process.env.LIVE_SUBMIT !== "YES") throw new Error("Safe creation requires exact LIVE_SUBMIT=YES");
  const approvedHash = hexEnv("VAULT_SAFE_REVIEW_PACKAGE_HASH");
  const approval = loadSafeCreationApproval(plan, proof, journal, outputDirectory, approvedHash);
  const account = privateKeyToAccount(loadFundingKey(process.env.VAULT_FUNDING_KEY_PATH ?? "", repository));
  if (!same(account.address, config.funder)) throw new Error("funding key does not match reviewed funder");
  await withLiveJournalStore(journalPath, config.funder, async store => {
    const locked = store.load();
    const live = createSepoliaLiveContext({ account, client, verify: async () => { if (await client.getChainId() !== sepolia.id) throw new Error("wrong chain"); }, persist: async value => store.save(value) });
    const currentFees = async () => { const suggested = await client.estimateFeesPerGas(); const block = await client.getBlock(); if (block.baseFeePerGas === null) throw new Error("base fee unavailable"); return { ...selectApprovedFees(suggested, block.baseFeePerGas, config), baseFeePerGas: block.baseFeePerGas }; };
    const result = await executeSafeCreation(plan, approval, { live, journal: locked, latestNonce: async () => Number(await client.getTransactionCount({ address: config.funder, blockTag: "latest" })), pendingNonce: async () => Number(await client.getTransactionCount({ address: config.funder, blockTag: "pending" })), currentBalance: () => client.getBalance({ address: config.funder }), safeCode: () => client.getBytecode({ address: safe }), currentFees, estimateGas: () => client.estimateGas({ account, to: plan.safeProxyDeployment.to, data: plan.safeProxyDeployment.data, value: 0n }), exactCall: async () => { await client.call({ account, to: plan.safeProxyDeployment.to, data: plan.safeProxyDeployment.data, value: 0n, gas: decimalEnv("VAULT_SAFE_GAS_LIMIT_CAP") }); }, canonicalBlockHash: async number => (await client.getBlock({ blockNumber: number })).hash!, verifyBeforeSetup: () => verifyVaultPrerequisites(client, plan, "before-setup"), waitForReceipt: async hash => { await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 }); }, verifyAfterSetup: () => verifyVaultPrerequisites(client, plan, "after-setup"), verifyTopology: async () => verifyTopology({ chainId: sepolia.id, policy, safe, guard: components.guard, delay: components.delay, deployments, prerequisites: await verifyVaultPrerequisites(client, plan, "after-setup"), client }) });
    console.log(JSON.stringify({ status: result.status, safe, transactionHash: result.receipt.transactionHash }));
  });
}

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
void main();
