import { createPublicClient, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { loadCredential, loadFundingKey } from "./secrets";
import { createLiveJournalStore, createSepoliaLiveContext } from "./runtime";
import { resolveVerifiedDeploymentInfrastructure } from "../../src/config/deployments";
import { passkeySignerBindingHash } from "../../src/topology/evidence";
import { deriveComponentAddresses } from "../../src/topology/addressing";
import { buildVaultPlan, deriveVaultSafeProxyAddress, verifyVaultPrerequisites } from "../../src/topology/build";
import { resolveReviewedVaultArtifacts } from "../../src/topology/reviewed-artifacts";
import { ZODIAC_DELAY_V1_1_1 } from "../../src/config/zodiac-delay";
import { executeVaultPrerequisites } from "./vault-runner";

const directory = "/Users/bernardo/.local/share/recent-tx-safe-guard/sepolia";
const primary = "0x6F9c2f4f8526A17f38c9409a8cBF605b34Fa146c" as const;
const secondary = "0xF94b0fbDCa0eF0Bf7Bd142aF832Bab17108C0D42" as const;
const ecdsa = "0xe789E36f46E2445d807D726E4a064c8048e19980" as const;
const zero = "0x0000000000000000000000000000000000000000" as const;

async function main(): Promise<void> {
  const repository = process.cwd().replace(/\/packages\/security-core$/, "");
  const account = privateKeyToAccount(loadFundingKey(`${directory}/funding-key`, repository));
  const credential = loadCredential(`${directory}/primary-passkey.json`, repository);
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com") });
  const observedNonce = BigInt(await client.getTransactionCount({ address: account.address }));
  const startingNonce = process.env.VAULT_DEPLOYMENT_START_NONCE === undefined ? observedNonce : BigInt(process.env.VAULT_DEPLOYMENT_START_NONCE);
  const journal = createLiveJournalStore(`${directory}/vault-deploy-${startingNonce}.json`, account.address);
  const loadedJournal = journal.load();
  const prerequisiteIds = ["vault-setup-helper", "vault-guard", "vault-delay", "vault-maintenance"] as const;
  const incomplete = prerequisiteIds.findIndex((id) => loadedJournal.entries.find((entry) => entry.id === id)?.status !== "success");
  const completed = (incomplete === -1 ? prerequisiteIds.length : incomplete) as 0 | 1 | 2 | 3 | 4;
  if (loadedJournal.entries.length !== completed || observedNonce !== startingNonce + BigInt(completed)) {
    journal.close();
    throw new Error("deployment journal and on-chain nonce do not describe one contiguous resumable plan");
  }
  const primaryRuntime = await client.getBytecode({ address: primary });
  if (!primaryRuntime) throw new Error("primary passkey signer is absent");
  const verifier = BigInt("0xc2b78104907F722DABAc4C69f826a522B2754De4");
  const deployments = await resolveVerifiedDeploymentInfrastructure(client, {
    chainId: sepolia.id, deployer: account.address, expectedDeployerNonce: observedNonce,
    passkeySigner: { address: primary, runtimeCodeHash: keccak256(primaryRuntime), bindingHash: passkeySignerBindingHash({ factory: "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf", x: credential.x, y: credential.y, verifiers: verifier }), source: "local automated credential", binding: { x: credential.x, y: credential.y, verifiers: verifier } },
  });
  const proxyCode = await client.readContract({ address: deployments.safeProxyFactory.address, abi: [{ name: "proxyCreationCode", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] }] as const, functionName: "proxyCreationCode" });
  const components = deriveComponentAddresses({ deployer: account.address, startingNonce });
  const draft = { chainId: sepolia.id, safe: zero, primary, passkey: primary, ecdsaSecondary: ecdsa, secondaries: [{ address: secondary, role: "secondary" as const, kind: "safe-contract" as const, enabled: true }, { address: ecdsa, role: "secondary" as const, kind: "ecdsa-extension" as const, enabled: true }], delay: components.delay, periodSeconds: 86400 as const, periodAnchor: 0n, cooldownSeconds: 120, expirationSeconds: 600, assets: [{ token: zero, basePerTransaction: 10_000_000_000_000n, stepUpPerTransaction: 30_000_000_000_000n, baseDailyLimit: 10_000_000_000_000n, instantDailyLimit: 30_000_000_000_000n, recipients: [account.address] }] };
  const safe = deriveVaultSafeProxyAddress({ policy: draft, deployer: account.address, startingNonce, safeProxySaltNonce: 0n, safeProxyCreationCode: proxyCode, deployments });
  const response = await fetch(ZODIAC_DELAY_V1_1_1.sourceUrl); if (!response.ok) throw new Error("pinned Delay artifact fetch failed");
  const artifacts = await resolveReviewedVaultArtifacts({ client, deployments, safe, primaryPasskey: primary, ecdsaSecondary: ecdsa, delay: components.delay, maintenance: components.maintenance, periodAnchor: 0n, cooldownSeconds: 120n, expirationSeconds: 600n, delayArtifactSource: await response.text() });
  const plan = buildVaultPlan({ policy: { ...draft, safe }, deployer: account.address, startingNonce, safeProxySaltNonce: 0n, artifacts, deployments, completedPrerequisites: completed });
  try {
    const live = createSepoliaLiveContext({ account, client, verify: async () => { if (await client.getChainId() !== sepolia.id) throw new Error("wrong chain"); }, persist: async journalValue => journal.save(journalValue) });
    const result = await executeVaultPrerequisites(plan, { live, journal: loadedJournal, feeFor: async tx => {
      const existing = loadedJournal.entries.find((entry) => entry.nonce === Number(tx.nonce));
      if (existing) {
        const original = await client.getTransaction({ hash: existing.transactionHash });
        const originalTo = original.to ?? zero;
        const originalData = original.input ?? "0x";
        if (original.nonce !== Number(tx.nonce) || originalTo.toLowerCase() !== tx.to.toLowerCase() || originalData.toLowerCase() !== tx.data.toLowerCase() || original.value !== tx.value || original.maxFeePerGas === undefined || original.maxPriorityFeePerGas === undefined) throw new Error("journaled transaction does not match reviewed deployment plan");
        return { gas: original.gas, maxFeePerGas: original.maxFeePerGas, maxPriorityFeePerGas: original.maxPriorityFeePerGas };
      }
      const fees = await client.estimateFeesPerGas();
      const gas = await client.estimateGas({ account, to: tx.to === zero ? undefined : tx.to, data: tx.data, value: tx.value });
      const maxFeePerGas = fees.maxFeePerGas ?? 2_000_000n;
      return { gas: gas + gas / 5n, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 1_000_000n };
    }, waitForReceipt: async hash => { await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 }); }, verifyPrerequisites: (value, stage) => verifyVaultPrerequisites(client, value, stage) });
    console.log(JSON.stringify({ status: "PREREQUISITES_COMPLETE_SAFE_REVIEW_REQUIRED", safe, entries: result.journal.entries.map(entry => ({ id: entry.id, transactionHash: entry.transactionHash, status: entry.status })) }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  } finally { journal.close(); }
}
void main();
