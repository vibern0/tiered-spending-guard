import { createPublicClient, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { loadCredential, loadFundingKey } from "./secrets";
import { createSepoliaLiveContext, readLiveJournal, withLiveJournalStore } from "./runtime";
import { resolveVerifiedDeploymentInfrastructure } from "../../src/config/deployments";
import { passkeySignerBindingHash, verifyPasskeySignerComponent } from "../../src/topology/evidence";
import { deriveComponentAddresses } from "../../src/topology/addressing";
import { buildVaultPlan, deriveVaultSafeProxyAddress, verifyVaultPrerequisites } from "../../src/topology/build";
import { resolveReviewedVaultArtifacts } from "../../src/topology/reviewed-artifacts";
import { ZODIAC_DELAY_V1_1_1 } from "../../src/config/zodiac-delay";
import { executeVaultPrerequisites } from "./vault-runner";
import { buildOrdinaryReviewPolicyDraft, ORDINARY_REVIEW_SIGNER_SOURCE, readOrdinaryReviewConfig, selectApprovedFees } from "./ordinary-review-profile";
import { prepareOrdinaryReviewExecutionPreflight, runOnlyWithLiveSubmitAuthorization } from "./ordinary-review-execution";

const directory = "/Users/bernardo/.local/share/recent-tx-safe-guard/sepolia";
const zero = "0x0000000000000000000000000000000000000000" as const;

async function main(): Promise<void> {
  const repository = process.cwd().replace(/\/packages\/security-core$/, "");
  const config = readOrdinaryReviewConfig(process.env.VAULT_REVIEW_CONFIG ?? `${repository}/packages/security-core/config/sepolia.ordinary-review.json`);
  const primaryCredential = loadCredential(`${directory}/primary-passkey.json`, repository);
  const secondaryCredential = loadCredential(`${directory}/secondary-passkey.json`, repository);
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com") });
  const observedNonce = BigInt(await client.getTransactionCount({ address: config.funder }));
  const startingNonceInput = process.env.VAULT_DEPLOYMENT_START_NONCE;
  if (!startingNonceInput || !/^(0|[1-9][0-9]*)$/.test(startingNonceInput)) throw new Error("exact reviewed deployment starting nonce is required");
  const startingNonce = BigInt(startingNonceInput);
  const journalPath = `${directory}/vault-deploy-${startingNonce}.json`;
  const loadedJournal = readLiveJournal(journalPath, config.funder);
  const prerequisiteIds = ["vault-setup-helper", "vault-guard", "vault-delay", "vault-maintenance"] as const;
  const incomplete = prerequisiteIds.findIndex((id) => loadedJournal.entries.find((entry) => entry.id === id)?.status !== "success");
  const completed = (incomplete === -1 ? prerequisiteIds.length : incomplete) as 0 | 1 | 2 | 3 | 4;
  if (loadedJournal.entries.length !== completed || observedNonce !== startingNonce + BigInt(completed)) {
    throw new Error("deployment journal and on-chain nonce do not describe one contiguous resumable plan");
  }
  const primaryRuntime = await client.getBytecode({ address: config.primaryPasskey });
  if (!primaryRuntime) throw new Error("primary passkey signer is absent");
  const verifier = BigInt("0xc2b78104907F722DABAc4C69f826a522B2754De4");
  const deployments = await resolveVerifiedDeploymentInfrastructure(client, {
    chainId: sepolia.id, deployer: config.funder, expectedDeployerNonce: observedNonce,
    passkeySigner: { address: config.primaryPasskey, runtimeCodeHash: keccak256(primaryRuntime), bindingHash: passkeySignerBindingHash({ factory: "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf", x: primaryCredential.x, y: primaryCredential.y, verifiers: verifier }), source: ORDINARY_REVIEW_SIGNER_SOURCE, binding: { x: primaryCredential.x, y: primaryCredential.y, verifiers: verifier } },
  });
  const secondaryRuntime = await client.getBytecode({ address: config.safeContractSecondary });
  if (!secondaryRuntime) throw new Error("Safe-contract secondary signer is absent");
  await verifyPasskeySignerComponent(client, { name: "safeContractSecondary", address: config.safeContractSecondary, runtimeCodeHash: keccak256(secondaryRuntime), bindingHash: passkeySignerBindingHash({ factory: "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf", x: secondaryCredential.x, y: secondaryCredential.y, verifiers: verifier }), factory: "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf", source: ORDINARY_REVIEW_SIGNER_SOURCE, binding: { x: secondaryCredential.x, y: secondaryCredential.y, verifiers: verifier } });
  const proxyCode = await client.readContract({ address: deployments.safeProxyFactory.address, abi: [{ name: "proxyCreationCode", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] }] as const, functionName: "proxyCreationCode" });
  const components = deriveComponentAddresses({ deployer: config.funder, startingNonce });
  const draft = buildOrdinaryReviewPolicyDraft(config, startingNonce);
  const safe = deriveVaultSafeProxyAddress({ policy: draft, deployer: config.funder, startingNonce, safeProxySaltNonce: config.safeProxySaltNonce, safeProxyCreationCode: proxyCode, deployments });
  const response = await fetch(ZODIAC_DELAY_V1_1_1.sourceUrl); if (!response.ok) throw new Error("pinned Delay artifact fetch failed");
  const artifacts = await resolveReviewedVaultArtifacts({ client, deployments, safe, primaryPasskey: config.primaryPasskey, ecdsaSecondary: config.ecdsaSecondary, delay: components.delay, maintenance: components.maintenance, periodAnchor: config.periodAnchor, cooldownSeconds: 120n, expirationSeconds: 600n, delayArtifactSource: await response.text() });
  const plan = buildVaultPlan({ policy: { ...draft, safe }, deployer: config.funder, startingNonce, safeProxySaltNonce: config.safeProxySaltNonce, artifacts, deployments, completedPrerequisites: completed });
  const packageDirectory = process.env.VAULT_REVIEW_PACKAGE_DIR;
  const packageHash = process.env.VAULT_REVIEW_PACKAGE_HASH;
  if (!packageDirectory || !packageHash || !/^0x[0-9a-fA-F]{64}$/.test(packageHash)) throw new Error("exact reviewed package directory and hash are required for prerequisite execution");
  const preflight = prepareOrdinaryReviewExecutionPreflight(config, plan, packageDirectory, packageHash as Hex);
  console.log(JSON.stringify(preflight.report));
  const submission = await runOnlyWithLiveSubmitAuthorization(process.env.LIVE_SUBMIT, async () => {
    const account = privateKeyToAccount(loadFundingKey(`${directory}/funding-key`, repository));
    if (account.address.toLowerCase() !== config.funder.toLowerCase()) throw new Error("funding key does not match the reviewed public funder");
    return withLiveJournalStore(journalPath, account.address, async journal => {
      const lockedJournal = journal.load();
      const encodeJournal = (value: typeof loadedJournal): string => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
      if (encodeJournal(lockedJournal) !== encodeJournal(loadedJournal)) throw new Error("deployment journal changed after read-only preflight");
      const live = createSepoliaLiveContext({ account, client, verify: async () => { if (await client.getChainId() !== sepolia.id) throw new Error("wrong chain"); }, persist: async journalValue => journal.save(journalValue) });
      return await executeVaultPrerequisites(plan, preflight.approval, { live, journal: loadedJournal, feeFor: async tx => {
        const existing = loadedJournal.entries.find((entry) => entry.nonce === Number(tx.nonce));
        if (existing) {
          const original = await client.getTransaction({ hash: existing.transactionHash });
          const originalTo = original.to ?? zero;
          const originalData = original.input ?? "0x";
          if (original.nonce !== Number(tx.nonce) || originalTo.toLowerCase() !== tx.to.toLowerCase() || originalData.toLowerCase() !== tx.data.toLowerCase() || original.value !== tx.value || original.maxFeePerGas === undefined || original.maxPriorityFeePerGas === undefined) throw new Error("journaled transaction does not match reviewed deployment plan");
          return { gas: original.gas, maxFeePerGas: original.maxFeePerGas, maxPriorityFeePerGas: original.maxPriorityFeePerGas };
        }
        const fees = await client.estimateFeesPerGas();
        const block = await client.getBlock();
        if (block.baseFeePerGas === null) throw new Error("current block is missing an EIP-1559 base fee");
        const approvedFees = selectApprovedFees(fees, block.baseFeePerGas, config);
        const gas = await client.estimateGas({ account, to: tx.to === zero ? undefined : tx.to, data: tx.data, value: tx.value });
        return { gas: (gas * 120n + 99n) / 100n, ...approvedFees };
      }, waitForReceipt: async hash => { await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 }); }, verifyPrerequisites: (value, stage) => verifyVaultPrerequisites(client, value, stage) });
    });
  });
  if (submission.status === "LIVE_SUBMIT") console.log(JSON.stringify({ status: "PREREQUISITES_COMPLETE_SAFE_REVIEW_REQUIRED", safe, entries: submission.result.journal.entries.map(entry => ({ id: entry.id, transactionHash: entry.transactionHash, status: entry.status })) }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}
void main();
