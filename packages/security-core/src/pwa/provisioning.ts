import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  isAddress,
  parseAbi,
  keccak256,
  stringToHex,
  type Address,
  type Account,
  type Hex,
} from "viem";
import {
  isPwaPlanningInfrastructure,
  resolvePwaPlanningInfrastructure,
  resolveVerifiedDeploymentInfrastructure,
  type PlannedPasskeySigner,
  type PwaPlanningInfrastructure,
  type ReadOnlyDeploymentClient,
  type VerifiedDeploymentInfrastructure,
} from "../config/deployments";
import type { ConfiguredSigner, VaultPolicy } from "../config/policy";
import {
  PWA_RECIPIENT,
  REVIEWED_USDC_RUNTIME_CODE_HASH,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_USDC_ADDRESS,
  type PwaPhaseOneProfile,
} from "./profile";
import {
  assertSafeCreationReady,
  buildVaultPlan,
  deriveVaultSafeProxyAddress,
  planHash as vaultPlanHash,
  policyHash as computePolicyHash,
  isReviewedVaultDeploymentPlan,
  type PlannedDeploymentTransaction,
  type VaultDeploymentPlan,
  verifyVaultPrerequisites,
} from "../topology/build";
import { deriveComponentAddresses } from "../topology/addressing";
import { isReviewedVaultArtifacts, resolveReviewedVaultArtifacts, type ArtifactResolutionClient, type ReviewedVaultArtifacts } from "../topology/reviewed-artifacts";
import { PHASE_OUTLAY_LIMIT, liveIntentHash, submitLiveIntent, type LiveContext, type LiveJournal, type LiveReceipt } from "../../scripts/live/submission";
import { verifyTopology, type TopologyReport } from "../topology/verify";
import { createLiveJournalStore, createSepoliaLiveContext, type SepoliaRpc } from "../../scripts/live/runtime";
import { verifyPasskeySignerComponent } from "../topology/evidence";

export { readLiveJournal, createLiveJournalStore } from "../../scripts/live/runtime";
export type { LiveJournal } from "../../scripts/live/submission";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const FACTORY_ABI = [
  { name: "getSigner", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] },
  { name: "createSigner", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] },
] as const;
const SAFE_PROXY_FACTORY_ABI = [{ name: "proxyCreationCode", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] }] as const;

export type PwaCredentialCoordinates = Readonly<{ x: bigint; y: bigint }>;
export type PwaProvisioningTransactionId = "primary-signer" | "secondary-signer" | "setup-helper" | "guard" | "delay" | "maintenance" | "safe-proxy";
export type PwaProvisioningTransaction = PlannedDeploymentTransaction & Readonly<{ id: PwaProvisioningTransactionId }>;

export type PwaProvisioningPlan = Readonly<{
  formatVersion: 1;
  chainId: typeof SEPOLIA_CHAIN_ID;
  deployer: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  safe: Address;
  guard: Address;
  delay: Address;
  usdc: Address;
  deploymentsHash: Hex;
  policyHash: Hex;
  planHash: Hex;
  policy: VaultPolicy;
  infrastructure: PwaPlanningInfrastructure;
  transactions: readonly PwaProvisioningTransaction[];
  vaultPlan: VaultDeploymentPlan;
}>;

export type PwaProvisioningReceipt = Readonly<{ status: "success"; blockNumber: bigint }>;
export type ApprovedPwaProvisioningTransaction = PwaProvisioningTransaction & Readonly<{
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}>;
export type PwaProvisioningExecutionContext = Readonly<{
  confirmedPrefixLength(): Promise<number>;
  currentDeployerNonce(): Promise<bigint>;
  authorize?(transaction: PwaProvisioningTransaction): Promise<ApprovedPwaProvisioningTransaction>;
  resumePending?(transaction: PwaProvisioningTransaction): Promise<Readonly<{ transactionHash: Hex; receipt: PwaProvisioningReceipt }> | undefined>;
  submit(transaction: ApprovedPwaProvisioningTransaction): Promise<Readonly<{ transactionHash: Hex; receipt: PwaProvisioningReceipt }>>;
  completedSetupReceipt?(): Promise<Readonly<{ transactionHash: Hex; blockNumber: bigint }> | undefined>;
  verifyFinalTopology(plan: PwaProvisioningPlan): Promise<Hex>;
  currentPolicyHash?(): Promise<Hex>;
}>;
const reviewedExecutionContexts = new WeakSet<object>();

type PwaExecutionClient = ReadOnlyDeploymentClient & Readonly<{
  getChainId?(): Promise<number>;
  getBlock?(args: { blockNumber: bigint }): Promise<Readonly<{ number: bigint; hash: Hex | null; timestamp: bigint }>>;
  getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined>;
  getTransactionCount(args: { address: Address; blockTag?: "latest" | "pending" }): Promise<number | bigint>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  estimateGas(args: { account: Address; to?: Address; data: Hex; value: bigint }): Promise<bigint>;
  estimateFeesPerGas(): Promise<Readonly<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(args: { hash: Hex }): Promise<LiveReceipt>;
  getTransaction?(args: { hash: Hex }): Promise<import("./provisioning-recovery").PwaProvisioningRecoveryTransaction | null>;
}>;

export function createDurablePwaProvisioningExecutionContext(input: Readonly<{
  plan: PwaProvisioningPlan;
  journal: LiveJournal;
  liveContext: LiveContext;
  client: PwaExecutionClient;
  authorize?(transaction: PwaProvisioningTransaction): Promise<ApprovedPwaProvisioningTransaction>;
}>): PwaProvisioningExecutionContext {
  const verifyProgress = async (transaction: PwaProvisioningTransaction): Promise<void> => {
    const index = input.plan.transactions.findIndex((candidate) => candidate.id === transaction.id);
    if (index < 0) throw new Error("fail closed: provisioning transaction is not in the reviewed plan");
    const planned = input.plan.transactions[index]!;
    if (
      transaction.nonce !== planned.nonce
      || !isAddressEqual(transaction.to, planned.to)
      || transaction.value !== planned.value
      || transaction.data.toLowerCase() !== planned.data.toLowerCase()
      || transaction.operation !== planned.operation
      || !isAddressEqual(transaction.expectedCreatedAddress, planned.expectedCreatedAddress)
      || transaction.creationCodeHash.toLowerCase() !== planned.creationCodeHash.toLowerCase()
      || transaction.expectedRuntimeCodeHash.toLowerCase() !== planned.expectedRuntimeCodeHash.toLowerCase()
    ) throw new Error("fail closed: provisioning transaction changed from the reviewed plan");
    const [latestNonceRaw, pendingNonceRaw] = await Promise.all([
      input.client.getTransactionCount({ address: input.plan.deployer, blockTag: "latest" }),
      input.client.getTransactionCount({ address: input.plan.deployer, blockTag: "pending" }),
    ]);
    if (BigInt(latestNonceRaw) !== transaction.nonce || BigInt(pendingNonceRaw) !== transaction.nonce) throw new Error("fail closed: deployer latest/pending nonce drift before provisioning transaction");
    for (const [candidateIndex, candidate] of input.plan.transactions.entries()) {
      const code = await input.client.getBytecode({ address: candidate.expectedCreatedAddress });
      if (candidateIndex < index) {
        if (!code || code === "0x" || keccak256(code).toLowerCase() !== candidate.expectedRuntimeCodeHash.toLowerCase()) throw new Error(`fail closed: ${candidate.id} runtime evidence missing before ${transaction.id}`);
      } else if (code && code !== "0x") {
        throw new Error(`fail closed: ${candidate.id} address already has code before its reviewed transaction`);
      }
    }
    if (transaction.id === "safe-proxy") {
      const prerequisites = await verifyVaultPrerequisites(input.client, input.plan.vaultPlan, "before-setup");
      assertSafeCreationReady(input.plan.vaultPlan, prerequisites, transaction.nonce);
    }
  };

  const verifyAdmission = async (transaction: ApprovedPwaProvisioningTransaction): Promise<void> => {
    const estimate = await input.client.estimateGas({
      account: input.plan.deployer,
      ...(isAddressEqual(transaction.to, ZERO) ? {} : { to: transaction.to }),
      data: transaction.data,
      value: transaction.value,
    });
    if (estimate > transaction.gasLimit) throw new Error(`fail closed: ${transaction.id} gas estimate exceeds its committed limit`);
    const fees = await input.client.estimateFeesPerGas();
    if (fees.maxFeePerGas > transaction.maxFeePerGas) throw new Error(`fail closed: ${transaction.id} maximum fee recommendation exceeds its committed limit`);
    if (fees.maxPriorityFeePerGas > transaction.maxPriorityFeePerGas) throw new Error(`fail closed: ${transaction.id} priority fee recommendation exceeds its committed limit`);
    const priorReservation = input.journal.entries.reduce((total, entry) => total + entry.reserved, 0n);
    const reservation = transaction.value + transaction.gasLimit * transaction.maxFeePerGas;
    if (priorReservation < 0n || priorReservation + reservation > PHASE_OUTLAY_LIMIT) throw new Error("fail closed: provisioning phase outlay limit exceeded");
  };

  const verifyConfirmed = async (transaction: PwaProvisioningTransaction, receipt: LiveReceipt): Promise<void> => {
    const head = await input.client.getBlockNumber();
    if (head < receipt.blockNumber + 5n) throw new Error(`fail closed: ${transaction.id} receipt has fewer than six confirmations`);
    const canonical = await input.client.getTransactionReceipt({ hash: receipt.transactionHash });
    if (
      canonical.transactionHash !== receipt.transactionHash
      || canonical.status !== receipt.status
      || canonical.blockNumber !== receipt.blockNumber
      || canonical.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
      || canonical.gasUsed !== receipt.gasUsed
      || canonical.effectiveGasPrice !== receipt.effectiveGasPrice
    ) throw new Error(`fail closed: ${transaction.id} canonical receipt changed`);
    const runtime = await input.client.getBytecode({ address: transaction.expectedCreatedAddress });
    if (!runtime || runtime === "0x" || keccak256(runtime).toLowerCase() !== transaction.expectedRuntimeCodeHash.toLowerCase()) throw new Error(`fail closed: ${transaction.id} runtime does not match the reviewed artifact`);
  };

  let verifiedCurrentPolicyHash: Hex | undefined;
  const verifyFinalTopology = async (): Promise<Hex> => {
    const finalNonce = input.plan.transactions.at(-1)!.nonce + 1n;
    const secondary = input.plan.infrastructure.secondaryPasskeySigner;
    const secondaryRuntime = await input.client.getBytecode({ address: secondary.address });
    if (!secondaryRuntime || secondaryRuntime === "0x" || keccak256(secondaryRuntime).toLowerCase() !== secondary.expectedRuntimeCodeHash.toLowerCase()) throw new Error("fail closed: secondary passkey signer runtime changed before final topology verification");
    const currentNonce = BigInt(await input.client.getTransactionCount({ address: input.plan.deployer, blockTag: "latest" }));
    if (currentNonce < finalNonce) throw new Error("fail closed: current deployer nonce is behind the completed deployment");
    if (!input.client.getBlock || !input.client.getChainId) throw new Error("fail closed: pinned final topology readers are required");
    const proof = await verifyCurrentPwaTopology(input.plan, input.client as PwaSubmissionReadClient, await input.client.getBlockNumber());
    verifiedCurrentPolicyHash = computePolicyHash(proof.policy);
    return proof.topologyReportHash;
  };

  const context: PwaProvisioningExecutionContext = Object.freeze({
    confirmedPrefixLength: async () => {
      let prefixLength = 0;
      for (const [index, entry] of input.journal.entries.entries()) {
        const transaction = input.plan.transactions[index];
        if (!transaction || entry.id !== `pwa-${transaction.id}` || entry.nonce !== Number(transaction.nonce)) throw new Error("fail closed: provisioning journal does not match the reviewed transaction prefix");
        if (entry.status === "success") {
          if (!entry.receipt || entry.receipt.status !== "success") throw new Error("fail closed: successful provisioning journal entry lacks its receipt");
          prefixLength += 1;
          continue;
        }
        if (entry.status !== "pending" || index !== input.journal.entries.length - 1) throw new Error("fail closed: provisioning journal is not a successful prefix plus at most one pending transaction");
      }
      return prefixLength;
    },
    currentDeployerNonce: async () => {
      const pending = input.journal.entries.find((entry) => entry.status === "pending");
      return pending ? BigInt(pending.nonce) : BigInt(await input.liveContext.nonce());
    },
    authorize: input.authorize,
    async resumePending(transaction) {
      const entry = input.journal.entries.find(candidate => candidate.id === `pwa-${transaction.id}`);
      if (!entry) return undefined;
      if (entry.status !== "pending" || entry.nonce !== Number(transaction.nonce) || !input.client.getTransaction) throw new Error("fail closed: exact pending provisioning transaction reader is required");
      const signed = await input.client.getTransaction({ hash: entry.transactionHash });
      if (!signed) throw new Error("fail closed: pending provisioning transaction is unresolved");
      const to = isAddressEqual(transaction.to, ZERO) ? undefined : transaction.to;
      const intent = { id: entry.id, ...(to ? { to } : {}), data: transaction.data, value: transaction.value, nonce: Number(transaction.nonce), gas: signed.gas, maxFeePerGas: signed.maxFeePerGas, maxPriorityFeePerGas: signed.maxPriorityFeePerGas };
      if (signed.hash.toLowerCase() !== entry.transactionHash.toLowerCase() || signed.chainId !== SEPOLIA_CHAIN_ID || signed.type !== "eip1559" || !isAddressEqual(signed.from, input.plan.deployer) || signed.nonce !== entry.nonce || signed.to?.toLowerCase() !== to?.toLowerCase() || signed.input.toLowerCase() !== transaction.data.toLowerCase() || signed.value !== transaction.value || liveIntentHash(intent, input.plan.deployer) !== entry.intentHash || entry.reserved !== signed.value + signed.gas * signed.maxFeePerGas) throw new Error("fail closed: pending provisioning signed envelope changed");
      const receipt = await input.liveContext.receipt(entry.transactionHash);
      if (!receipt) throw new Error("fail closed: pending provisioning transaction is unresolved");
      if (receipt.status !== "success" || receipt.transactionHash !== entry.transactionHash || receipt.gasUsed < 0n || receipt.gasUsed > signed.gas || receipt.effectiveGasPrice < 0n || receipt.effectiveGasPrice > signed.maxFeePerGas) throw new Error("fail closed: pending provisioning receipt disagrees with its signed envelope");
      await verifyConfirmed(transaction, receipt);
      entry.status = "success";
      entry.receipt = receipt;
      entry.reserved = receipt.gasUsed * receipt.effectiveGasPrice + transaction.value;
      await input.liveContext.persist(input.journal);
      return Object.freeze({ transactionHash: entry.transactionHash, receipt: Object.freeze({ status: "success" as const, blockNumber: receipt.blockNumber }) });
    },
    async completedSetupReceipt() {
      const transaction = input.plan.transactions.at(-1)!;
      const entry = input.journal.entries.at(-1);
      if (!entry || entry.id !== `pwa-${transaction.id}` || entry.nonce !== Number(transaction.nonce) || entry.status !== "success" || !entry.receipt) return undefined;
      await verifyConfirmed(transaction, entry.receipt);
      return Object.freeze({ transactionHash: entry.transactionHash, blockNumber: entry.receipt.blockNumber });
    },
    async submit(transaction) {
      const intent = {
        id: `pwa-${transaction.id}`,
        ...(isAddressEqual(transaction.to, ZERO) ? {} : { to: transaction.to }),
        data: transaction.data,
        value: transaction.value,
        nonce: Number(transaction.nonce),
        gas: transaction.gasLimit,
        maxFeePerGas: transaction.maxFeePerGas,
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
      } as const;
      if (!input.journal.entries.some((entry) => entry.id === intent.id)) {
        await verifyProgress(transaction);
        await verifyAdmission(transaction);
      }
      let entry = await submitLiveIntent(intent, input.journal, input.liveContext);
      if (entry.status === "pending") entry = await submitLiveIntent(intent, input.journal, input.liveContext);
      if (!entry.receipt || entry.status !== "success") throw new Error(`fail closed: ${transaction.id} lacks a canonical successful receipt`);
      await verifyConfirmed(transaction, entry.receipt);
      return Object.freeze({ transactionHash: entry.transactionHash, receipt: Object.freeze({ status: "success" as const, blockNumber: entry.receipt.blockNumber }) });
    },
    verifyFinalTopology,
    currentPolicyHash: async () => { if (!verifiedCurrentPolicyHash) throw new Error("fail closed: current policy is not verified"); return verifiedCurrentPolicyHash; },
  });
  reviewedExecutionContexts.add(context);
  return context;
}

export function createPwaProvisioningRuntime(input: Readonly<{
  plan: PwaProvisioningPlan;
  journalPath: string;
  account: Account;
  client: PwaExecutionClient & SepoliaRpc;
  authorize?(transaction: PwaProvisioningTransaction): Promise<ApprovedPwaProvisioningTransaction>;
}>): Readonly<{ context: PwaProvisioningExecutionContext; close(): void }> {
  if (!isAddressEqual(input.account.address, input.plan.deployer)) throw new Error("fail closed: provisioning account does not match reviewed deployer");
  const store = createLiveJournalStore(input.journalPath, input.account.address);
  const journal = store.load();
  const liveContext = createSepoliaLiveContext({
    account: input.account,
    client: input.client,
    verify: async () => { if (await input.client.getChainId() !== SEPOLIA_CHAIN_ID) throw new Error("fail closed: provisioning chain changed"); },
    persist: async (value) => { store.save(value); },
  });
  try {
    const context = createDurablePwaProvisioningExecutionContext({ plan: input.plan, journal, liveContext, client: input.client, authorize: input.authorize });
    return Object.freeze({ context, close: store.close });
  } catch (error) {
    store.close();
    throw error;
  }
}

export function brandPwaProvisioningExecutionContextForTestsOnly(context: PwaProvisioningExecutionContext): PwaProvisioningExecutionContext {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") throw new Error("test-only PWA execution context branding is disabled outside tests");
  reviewedExecutionContexts.add(context);
  return context;
}

export type PwaProvisioningResult = Readonly<{
  chainId: typeof SEPOLIA_CHAIN_ID;
  safe: Address;
  guard: Address;
  delay: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  usdc: Address;
  deploymentsHash: Hex;
  policyHash: Hex;
  setupReceipt: Readonly<{ transactionHash: Hex; blockNumber: bigint }>;
  topologyReportHash: Hex;
}>;
const verifiedProvisioningResults = new WeakSet<object>();
const reviewedPwaPlans = new WeakMap<object, string>();

export type PwaSubmissionReadClient = Readonly<{
  getChainId(): Promise<number>;
  getBlock(args: { blockNumber: bigint }): Promise<Readonly<{ number: bigint; hash: Hex | null; timestamp: bigint }>>;
  getBytecode(args: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
  getStorageAt(args: { address: Address; slot: Hex; blockNumber?: bigint }): Promise<Hex | undefined>;
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>;
  getTransactionCount(args: { address: Address; blockNumber?: bigint }): Promise<number | bigint>;
}>;

function assertReviewedPwaPlan(plan: PwaProvisioningPlan): void {
  if (!isPwaPlanningInfrastructure(plan.infrastructure) || !isReviewedVaultDeploymentPlan(plan.vaultPlan) || reviewedPwaPlans.get(plan) !== canonical(plan) || plan.policyHash !== computePolicyHash(plan.policy) || plan.deploymentsHash !== infrastructureHash(plan.infrastructure)) throw new Error("fail closed: original reviewed PWA plan commitments are required");
}

async function verifyCurrentPwaTopology(plan: PwaProvisioningPlan, client: PwaSubmissionReadClient, blockNumber: bigint): Promise<Readonly<{ deployments: VerifiedDeploymentInfrastructure; policy: VaultPolicy; topologyReport: TopologyReport; topologyReportHash: Hex }>> {
  assertReviewedPwaPlan(plan);
  if (blockNumber < 0n || await client.getChainId() !== SEPOLIA_CHAIN_ID) throw new Error("fail closed: PWA submission chain or block mismatch");
  const before = await client.getBlock({ blockNumber });
  if (before.number !== blockNumber || !before.hash || !HASH.test(before.hash)) throw new Error("fail closed: PWA submission block unavailable");
  const pinned = {
    getBytecode: (args: { address: Address }) => client.getBytecode({ ...args, blockNumber }),
    getStorageAt: (args: { address: Address; slot: Hex }) => client.getStorageAt({ ...args, blockNumber }),
    readContract: (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => client.readContract({ ...args, blockNumber }),
    getTransactionCount: (args: { address: Address }) => client.getTransactionCount({ ...args, blockNumber }),
  };
  const currentNonce = BigInt(await pinned.getTransactionCount({ address: plan.deployer }));
  if (currentNonce < plan.transactions.at(-1)!.nonce + 1n) throw new Error("fail closed: payer nonce is behind completed provisioning");
  const usdcRuntime = await pinned.getBytecode({ address: SEPOLIA_USDC_ADDRESS });
  if (!usdcRuntime || usdcRuntime === "0x" || keccak256(usdcRuntime) !== REVIEWED_USDC_RUNTIME_CODE_HASH) throw new Error("fail closed: reviewed USDC runtime changed");
  const primary = plan.infrastructure.primaryPasskeySigner;
  const secondary = plan.infrastructure.secondaryPasskeySigner;
  const deployments = await resolveVerifiedDeploymentInfrastructure(pinned, { chainId: SEPOLIA_CHAIN_ID, deployer: plan.deployer, expectedDeployerNonce: currentNonce, passkeySigner: { ...primary, runtimeCodeHash: primary.expectedRuntimeCodeHash } });
  await verifyPasskeySignerComponent(pinned, { ...secondary, runtimeCodeHash: secondary.expectedRuntimeCodeHash, factory: deployments.passkeySignerFactory.address });
  for (const [name, dependency] of Object.entries(plan.infrastructure.dependencies)) {
    const current = deployments.dependencies[name as keyof typeof deployments.dependencies];
    if (!current || canonical(current) !== canonical(dependency)) throw new Error("fail closed: PWA deployment identity drift");
  }
  const recipients = await pinned.readContract({ address: plan.guard, abi: parseAbi(["function getPolicyRecipients(address) view returns (address[])"]), functionName: "getPolicyRecipients", args: [SEPOLIA_USDC_ADDRESS] });
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.some((recipient) => typeof recipient !== "string" || !isAddress(recipient) || isAddressEqual(recipient as Address, ZERO)) || new Set(recipients.map((recipient: string) => recipient.toLowerCase())).size !== recipients.length) throw new Error("fail closed: PWA recipients are invalid");
  const original = plan.policy.assets[0]!;
  if (original.recipients.some((recipient, index) => !recipients[index] || !isAddressEqual(recipient, recipients[index] as Address))) throw new Error("fail closed: PWA recipient additions must preserve the original list");
  const policy: VaultPolicy = Object.freeze({ ...plan.policy, assets: Object.freeze([Object.freeze({ ...original, recipients: Object.freeze(recipients.map((recipient: string) => getAddress(recipient))) })]) });
  const counters = await pinned.readContract({ address: plan.guard, abi: parseAbi(["function spendState(address) view returns (uint256,uint256,uint256)"]), functionName: "spendState", args: [SEPOLIA_USDC_ADDRESS] });
  const anchor = policy.periodAnchor, seconds = BigInt(policy.periodSeconds);
  const window = before.timestamp >= anchor ? anchor + ((before.timestamp - anchor) / seconds) * seconds : -1n;
  if (!Array.isArray(counters) || counters.length !== 3 || counters.some((value) => typeof value !== "bigint" || value < 0n) || counters[0] < anchor || counters[0] > window || (counters[0] - anchor) % seconds !== 0n || counters[1] > original.baseDailyLimit || counters[2] < counters[1] || counters[2] > original.instantDailyLimit) throw new Error("fail closed: PWA counter window or limits mismatch");
  const prerequisites = await verifyVaultPrerequisites(pinned, plan.vaultPlan, "after-setup");
  const report = await verifyTopology({ chainId: SEPOLIA_CHAIN_ID, policy, safe: plan.safe, guard: plan.guard, delay: plan.delay, deployments, prerequisites, client: pinned });
  if (!report.ok) throw new Error(`fail closed: PWA submission topology failed: ${report.failures.join(", ")}`);
  const after = await client.getBlock({ blockNumber });
  if (await client.getChainId() !== SEPOLIA_CHAIN_ID || after.number !== blockNumber || !after.hash || after.hash.toLowerCase() !== before.hash.toLowerCase() || after.timestamp !== before.timestamp) throw new Error("fail closed: PWA submission block reorg or chain drift");
  const topologyReport = Object.freeze({ ...report, failures: Object.freeze([...report.failures]), checked: Object.freeze([...report.checked]) });
  return Object.freeze({ deployments, policy, topologyReport, topologyReportHash: keccak256(stringToHex(canonical(topologyReport))) });
}

/** Re-issues a capability only after original provenance and complete current topology agree. */
export type PwaSubmissionState = Readonly<{ vault: PwaProvisioningResult; deployments: VerifiedDeploymentInfrastructure; policy: VaultPolicy; topologyReport: TopologyReport; topologyReportHash: Hex }>;

export async function verifyPwaSubmissionState(input: Readonly<{ plan: PwaProvisioningPlan; vault: PwaProvisioningResult; client: PwaSubmissionReadClient; blockNumber: bigint }>): Promise<PwaSubmissionState> {
  if (!isVerifiedPwaProvisioningResult(input.vault)) throw new Error("fail closed: verified PWA vault evidence required");
  assertReviewedPwaPlan(input.plan);
  for (const key of ["safe", "guard", "delay", "primaryPasskey", "secondaryPasskey", "usdc"] as const) if (!isAddressEqual(input.vault[key], input.plan[key])) throw new Error("fail closed: PWA vault and plan identity mismatch");
  if (input.vault.chainId !== SEPOLIA_CHAIN_ID || input.vault.deploymentsHash !== input.plan.deploymentsHash || input.blockNumber < input.vault.setupReceipt.blockNumber) throw new Error("fail closed: PWA vault deployment commitment mismatch");
  const proof = await verifyCurrentPwaTopology(input.plan, input.client, input.blockNumber);
  const vault = Object.freeze({ ...input.vault, policyHash: computePolicyHash(proof.policy), topologyReportHash: proof.topologyReportHash });
  verifiedProvisioningResults.add(vault);
  return Object.freeze({ ...proof, vault });
}

export function isVerifiedPwaProvisioningResult(value: unknown): value is PwaProvisioningResult {
  return typeof value === "object" && value !== null && verifiedProvisioningResults.has(value);
}

export function brandPwaProvisioningResultForTestsOnly(value: PwaProvisioningResult): PwaProvisioningResult {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") throw new Error("test-only PWA provisioning result branding is disabled outside tests");
  verifiedProvisioningResults.add(value);
  return value;
}

type ProvisioningClient = Pick<ReadOnlyDeploymentClient, "getBytecode" | "readContract">;
type PwaPlanResolutionClient = ReadOnlyDeploymentClient & ArtifactResolutionClient;

export type CreatePwaProvisioningPlanInput = Readonly<{
  profile: PwaPhaseOneProfile;
  deployer: Address;
  expectedDeployerNonce: bigint;
  safeProxySaltNonce: bigint;
  primaryCredential: PwaCredentialCoordinates;
  secondaryCredential: PwaCredentialCoordinates;
  infrastructure: PwaPlanningInfrastructure;
  artifacts: ReviewedVaultArtifacts;
  client: ProvisioningClient;
  confirmedProvisioningPrefixLength?: number;
  verifiedDeploymentPrefixLength?: number;
  expectedCurrentDeployerNonce?: bigint;
  successorStartingNonce?: bigint;
  prerequisiteStartingNonce?: bigint;
  confirmedSuccessorTransactionCount?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}>;

export type ResolvePwaProvisioningPlanInput = Readonly<{
  profile: PwaPhaseOneProfile;
  deployer: Address;
  expectedDeployerNonce: bigint;
  safeProxySaltNonce: bigint;
  primaryCredential: PwaCredentialCoordinates;
  secondaryCredential: PwaCredentialCoordinates;
  client: PwaPlanResolutionClient;
  confirmedProvisioningPrefixLength?: number;
  verifiedDeploymentPrefixLength?: number;
  expectedCurrentDeployerNonce?: bigint;
  successorStartingNonce?: bigint;
  prerequisiteStartingNonce?: bigint;
  confirmedSuccessorTransactionCount?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}>;

function successorLayout(input: Readonly<{
  expectedDeployerNonce: bigint;
  confirmedProvisioningPrefixLength: number;
  successorStartingNonce?: bigint;
  prerequisiteStartingNonce?: bigint;
  confirmedSuccessorTransactionCount?: number;
  expectedCurrentDeployerNonce: bigint;
}>): Readonly<{ successorStartingNonce?: bigint; prerequisiteNonce: bigint; secondarySignerNonce: bigint }> {
  const successorStartingNonce = input.successorStartingNonce ?? input.prerequisiteStartingNonce;
  const confirmedSuccessorTransactionCount = input.confirmedSuccessorTransactionCount ?? 0;
  if (successorStartingNonce === undefined) {
    if (confirmedSuccessorTransactionCount !== 0) throw new Error("fail closed: confirmed successor transactions require a successor starting nonce");
    return Object.freeze({ prerequisiteNonce: input.expectedDeployerNonce + 2n, secondarySignerNonce: input.expectedDeployerNonce + 1n });
  }
  if (input.confirmedProvisioningPrefixLength < 1 || input.confirmedProvisioningPrefixLength > 2) throw new Error("fail closed: successor must preserve one or two confirmed signer transactions");
  const remainingCount = 7 - input.confirmedProvisioningPrefixLength;
  if (!Number.isSafeInteger(confirmedSuccessorTransactionCount) || confirmedSuccessorTransactionCount < 0 || confirmedSuccessorTransactionCount > remainingCount) throw new Error("fail closed: confirmed successor transaction count is invalid");
  const nextNonce = successorStartingNonce + BigInt(confirmedSuccessorTransactionCount);
  const complete = confirmedSuccessorTransactionCount === remainingCount;
  if (complete ? input.expectedCurrentDeployerNonce < nextNonce : input.expectedCurrentDeployerNonce !== nextNonce) throw new Error("fail closed: successor starting nonce does not match its verified current relay nonce");
  const prerequisiteNonce = successorStartingNonce + BigInt(2 - input.confirmedProvisioningPrefixLength);
  if (input.prerequisiteStartingNonce !== undefined && input.prerequisiteStartingNonce !== prerequisiteNonce) throw new Error("fail closed: successor prerequisite starting nonce is inconsistent");
  return Object.freeze({
    successorStartingNonce,
    prerequisiteNonce,
    secondarySignerNonce: input.confirmedProvisioningPrefixLength === 1 ? successorStartingNonce : input.expectedDeployerNonce + 1n,
  });
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertCanonicalProfile(profile: PwaPhaseOneProfile): void {
  if (profile.chainId !== SEPOLIA_CHAIN_ID || !isAddressEqual(profile.token, SEPOLIA_USDC_ADDRESS) || profile.runtimeCodeHash.toLowerCase() !== REVIEWED_USDC_RUNTIME_CODE_HASH || profile.name !== "USDC" || profile.symbol !== "USDC" || profile.decimals !== 6) throw new Error("PWA provisioning requires the reviewed Sepolia USDC profile");
  if (profile.secondaryProfile !== "contract-only" || profile.periodSeconds !== 86400 || profile.periodAnchor !== 0n) throw new Error("PWA provisioning requires the fixed contract-only daily profile");
  if (profile.limits.basePerTransaction !== 1_000_000n || profile.limits.baseDailyLimit !== 1_000_000n || profile.limits.stepUpPerTransaction !== 3_000_000n || profile.limits.instantDailyLimit !== 3_000_000n) throw new Error("PWA provisioning requires canonical X/Y limits");
  if (profile.delay.cooldownSeconds !== 120 || profile.delay.expirationSeconds !== 600 || profile.baseRecipientMode !== "any-valid-address" || profile.elevatedRecipients.length !== 1 || !isAddressEqual(profile.elevatedRecipients[0]!, PWA_RECIPIENT)) throw new Error("PWA provisioning requires canonical recipient policy and Z delay");
}

function fixedPolicy(input: Readonly<{ profile: PwaPhaseOneProfile; safe: Address; primaryPasskey: Address; secondaryPasskey: Address; delay: Address }>): VaultPolicy {
  return Object.freeze({
    chainId: SEPOLIA_CHAIN_ID,
    safe: input.safe,
    passkey: input.primaryPasskey,
    primary: input.primaryPasskey,
    ecdsaSecondary: ZERO,
    secondaries: [{ address: input.secondaryPasskey, role: "secondary", kind: "safe-contract", enabled: true } satisfies ConfiguredSigner],
    secondaryProfile: "contract-only",
    delay: input.delay,
    periodSeconds: 86400,
    periodAnchor: input.profile.periodAnchor,
    cooldownSeconds: input.profile.delay.cooldownSeconds,
    expirationSeconds: input.profile.delay.expirationSeconds,
    assets: [{ token: SEPOLIA_USDC_ADDRESS, basePerTransaction: input.profile.limits.basePerTransaction, stepUpPerTransaction: input.profile.limits.stepUpPerTransaction, baseDailyLimit: input.profile.limits.baseDailyLimit, instantDailyLimit: input.profile.limits.instantDailyLimit, baseRecipientMode: input.profile.baseRecipientMode, recipients: [...input.profile.elevatedRecipients] }],
  });
}

function infrastructureHash(infrastructure: PwaPlanningInfrastructure): Hex {
  return keccak256(stringToHex(canonical({
    chainId: infrastructure.chainId,
    deployer: infrastructure.deployer,
    dependencies: infrastructure.dependencies,
    primaryPasskeySigner: infrastructure.primaryPasskeySigner,
    secondaryPasskeySigner: infrastructure.secondaryPasskeySigner,
  })));
}

function signerTransaction(id: "primary-signer" | "secondary-signer", nonce: bigint, credential: PwaCredentialCoordinates, signer: PlannedPasskeySigner, infrastructure: PwaPlanningInfrastructure): PwaProvisioningTransaction {
  const verifiers = BigInt(infrastructure.passkeySignerVerifier.address);
  const data = encodeFunctionData({ abi: FACTORY_ABI, functionName: "createSigner", args: [credential.x, credential.y, verifiers] });
  return Object.freeze({
    id,
    nonce,
    description: `create ${id === "primary-signer" ? "primary" : "secondary"} Safe WebAuthn signer`,
    to: infrastructure.passkeySignerFactory.address,
    value: 0n,
    operation: 0,
    data,
    expectedCreatedAddress: signer.address,
    creationCodeHash: keccak256(data),
    expectedRuntimeCodeHash: signer.expectedRuntimeCodeHash,
  });
}

async function predictedSigner(
  client: ProvisioningClient,
  infrastructure: PwaPlanningInfrastructure,
  credential: PwaCredentialCoordinates,
  options: Readonly<{ allowExisting?: boolean; expectedRuntimeCodeHash: Hex }>,
): Promise<Address> {
  if (typeof client.readContract !== "function") throw new Error("fail closed: signer factory reader is required");
  const value = await client.readContract({ address: infrastructure.passkeySignerFactory.address, abi: FACTORY_ABI, functionName: "getSigner", args: [credential.x, credential.y, BigInt(infrastructure.passkeySignerVerifier.address)] });
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("fail closed: signer factory prediction is invalid");
  const signer = getAddress(value);
  const bytecode = await client.getBytecode({ address: signer });
  if (options.allowExisting) {
    if (!bytecode || bytecode === "0x" || keccak256(bytecode).toLowerCase() !== options.expectedRuntimeCodeHash.toLowerCase()) throw new Error("fail closed: recovered credential-specific signer runtime mismatch");
  } else if (bytecode && bytecode !== "0x") throw new Error("fail closed: credential-specific signer already exists");
  return signer;
}

export async function createPwaProvisioningPlan(input: CreatePwaProvisioningPlanInput): Promise<PwaProvisioningPlan> {
  assertCanonicalProfile(input.profile);
  if (!isPwaPlanningInfrastructure(input.infrastructure)) throw new Error("fail closed: PWA planning infrastructure must come from the reviewed resolver");
  if (!isReviewedVaultArtifacts(input.artifacts)) throw new Error("fail closed: reviewed PWA vault artifacts are required");
  const confirmedProvisioningPrefixLength = input.confirmedProvisioningPrefixLength ?? 0;
  if (!Number.isSafeInteger(confirmedProvisioningPrefixLength) || confirmedProvisioningPrefixLength < 0 || confirmedProvisioningPrefixLength > 6) throw new Error("fail closed: confirmed provisioning prefix length is invalid");
  const verifiedDeploymentPrefixLength = input.verifiedDeploymentPrefixLength ?? confirmedProvisioningPrefixLength;
  if (!Number.isSafeInteger(verifiedDeploymentPrefixLength) || verifiedDeploymentPrefixLength < confirmedProvisioningPrefixLength || verifiedDeploymentPrefixLength > 6) throw new Error("fail closed: verified deployment prefix length is invalid");
  if ((input.infrastructure.confirmedProvisioningPrefixLength ?? 0) !== verifiedDeploymentPrefixLength) throw new Error("fail closed: planning infrastructure recovery prefix mismatch");
  if (input.infrastructure.chainId !== SEPOLIA_CHAIN_ID || !isAddressEqual(input.infrastructure.deployer, input.deployer)) throw new Error("fail closed: planning infrastructure identity mismatch");
  if (input.infrastructure.observedDeployerNonce !== input.expectedDeployerNonce) throw new Error("fail closed: deployer nonce does not match reviewed planning state");
  const expectedCurrentDeployerNonce = input.expectedCurrentDeployerNonce ?? input.expectedDeployerNonce + BigInt(confirmedProvisioningPrefixLength);
  if (input.infrastructure.observedCurrentDeployerNonce !== expectedCurrentDeployerNonce) throw new Error("fail closed: current deployer nonce does not match reviewed planning state");
  if (input.safeProxySaltNonce < 0n) throw new Error("fail closed: Safe proxy salt must not be negative");
  const primaryBinding = input.infrastructure.primaryPasskeySigner.binding;
  const secondaryBinding = input.infrastructure.secondaryPasskeySigner.binding;
  if (primaryBinding.x !== input.primaryCredential.x || primaryBinding.y !== input.primaryCredential.y || primaryBinding.verifiers !== BigInt(input.infrastructure.passkeySignerVerifier.address)) throw new Error("fail closed: primary credential coordinates do not match reviewed planning evidence");
  if (secondaryBinding.x !== input.secondaryCredential.x || secondaryBinding.y !== input.secondaryCredential.y || secondaryBinding.verifiers !== BigInt(input.infrastructure.passkeySignerVerifier.address)) throw new Error("fail closed: secondary credential coordinates do not match reviewed planning evidence");
  const primaryPasskey = await predictedSigner(input.client, input.infrastructure, input.primaryCredential, { allowExisting: verifiedDeploymentPrefixLength > 0, expectedRuntimeCodeHash: input.infrastructure.primaryPasskeySigner.expectedRuntimeCodeHash });
  const secondaryPasskey = await predictedSigner(input.client, input.infrastructure, input.secondaryCredential, { allowExisting: verifiedDeploymentPrefixLength > 1, expectedRuntimeCodeHash: input.infrastructure.secondaryPasskeySigner.expectedRuntimeCodeHash });
  if (!isAddressEqual(primaryPasskey, input.infrastructure.primaryPasskeySigner.address)) throw new Error("fail closed: primary credential does not match reviewed factory prediction");
  if (!isAddressEqual(secondaryPasskey, input.infrastructure.secondaryPasskeySigner.address)) throw new Error("fail closed: secondary credential does not match reviewed factory prediction");
  if (isAddressEqual(primaryPasskey, secondaryPasskey)) throw new Error("fail closed: primary and secondary credentials must be distinct");

  const layout = successorLayout({
    expectedDeployerNonce: input.expectedDeployerNonce,
    confirmedProvisioningPrefixLength,
    successorStartingNonce: input.successorStartingNonce,
    prerequisiteStartingNonce: input.prerequisiteStartingNonce,
    confirmedSuccessorTransactionCount: input.confirmedSuccessorTransactionCount,
    expectedCurrentDeployerNonce,
  });
  const prerequisiteNonce = layout.prerequisiteNonce;
  const plannedPrefixTransactionCount = prerequisiteNonce - input.expectedDeployerNonce;
  if (plannedPrefixTransactionCount < 2n || plannedPrefixTransactionCount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("fail closed: prerequisite starting nonce is invalid");
  const components = deriveComponentAddresses({ deployer: input.deployer, startingNonce: prerequisiteNonce });
  const policyBase = fixedPolicy({ profile: input.profile, safe: ZERO, primaryPasskey, secondaryPasskey, delay: components.delay });
  const safe = deriveVaultSafeProxyAddress({ policy: policyBase, deployer: input.deployer, startingNonce: prerequisiteNonce, safeProxySaltNonce: input.safeProxySaltNonce, safeProxyCreationCode: input.artifacts.safeProxyCreationCode, deployments: input.infrastructure });
  const policy = Object.freeze({ ...policyBase, safe });
  const vaultPlan = buildVaultPlan({ policy, deployer: input.deployer, startingNonce: prerequisiteNonce, safeProxySaltNonce: input.safeProxySaltNonce, artifacts: input.artifacts, deployments: input.infrastructure, plannedPrefixTransactionCount: Number(plannedPrefixTransactionCount) });
  const signerTransactions = [
    signerTransaction("primary-signer", input.expectedDeployerNonce, input.primaryCredential, input.infrastructure.primaryPasskeySigner, input.infrastructure),
    signerTransaction("secondary-signer", layout.secondarySignerNonce, input.secondaryCredential, input.infrastructure.secondaryPasskeySigner, input.infrastructure),
  ] as const;
  const transactions = Object.freeze([
    ...signerTransactions,
    Object.freeze({ id: "setup-helper" as const, ...vaultPlan.prerequisites.setupHelper }),
    Object.freeze({ id: "guard" as const, ...vaultPlan.prerequisites.guard }),
    Object.freeze({ id: "delay" as const, ...vaultPlan.prerequisites.delay }),
    Object.freeze({ id: "maintenance" as const, ...vaultPlan.prerequisites.maintenance }),
    Object.freeze({ id: "safe-proxy" as const, ...vaultPlan.safeProxyDeployment }),
  ]);
  const planHash = keccak256(stringToHex(canonical({ signerTransactions, vaultPlanHash: vaultPlanHash(vaultPlan) })));
  const result = Object.freeze({ formatVersion: 1 as const, chainId: SEPOLIA_CHAIN_ID, deployer: input.deployer, primaryPasskey, secondaryPasskey, safe, guard: components.guard, delay: components.delay, usdc: SEPOLIA_USDC_ADDRESS, deploymentsHash: infrastructureHash(input.infrastructure), policyHash: vaultPlan.review.policyHash, planHash, policy, infrastructure: input.infrastructure, transactions, vaultPlan });
  reviewedPwaPlans.set(result, canonical(result));
  return result;
}

export async function resolvePwaProvisioningPlan(input: ResolvePwaProvisioningPlanInput): Promise<PwaProvisioningPlan> {
  assertCanonicalProfile(input.profile);
  const confirmedProvisioningPrefixLength = input.confirmedProvisioningPrefixLength ?? 0;
  const verifiedDeploymentPrefixLength = input.verifiedDeploymentPrefixLength ?? confirmedProvisioningPrefixLength;
  const infrastructure = await resolvePwaPlanningInfrastructure(input.client, {
    chainId: SEPOLIA_CHAIN_ID,
    deployer: input.deployer,
    expectedDeployerNonce: input.expectedDeployerNonce,
    primaryCredential: input.primaryCredential,
    secondaryCredential: input.secondaryCredential,
    confirmedProvisioningPrefixLength: verifiedDeploymentPrefixLength,
    expectedCurrentDeployerNonce: input.expectedCurrentDeployerNonce,
  });
  const secondaryPasskey = await predictedSigner(input.client, infrastructure, input.secondaryCredential, { allowExisting: verifiedDeploymentPrefixLength > 1, expectedRuntimeCodeHash: infrastructure.secondaryPasskeySigner.expectedRuntimeCodeHash });
  const expectedCurrentDeployerNonce = input.expectedCurrentDeployerNonce ?? input.expectedDeployerNonce + BigInt(confirmedProvisioningPrefixLength);
  const prerequisiteNonce = successorLayout({
    expectedDeployerNonce: input.expectedDeployerNonce,
    confirmedProvisioningPrefixLength,
    successorStartingNonce: input.successorStartingNonce,
    prerequisiteStartingNonce: input.prerequisiteStartingNonce,
    confirmedSuccessorTransactionCount: input.confirmedSuccessorTransactionCount,
    expectedCurrentDeployerNonce,
  }).prerequisiteNonce;
  const components = deriveComponentAddresses({ deployer: input.deployer, startingNonce: prerequisiteNonce });
  const proxyCreationCode = await input.client.readContract({ address: infrastructure.safeProxyFactory.address, abi: SAFE_PROXY_FACTORY_ABI, functionName: "proxyCreationCode" });
  if (typeof proxyCreationCode !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(proxyCreationCode)) throw new Error("fail closed: Safe proxy factory returned invalid creation code");
  const preliminary = fixedPolicy({ profile: input.profile, safe: ZERO, primaryPasskey: infrastructure.primaryPasskeySigner.address, secondaryPasskey, delay: components.delay });
  const safe = deriveVaultSafeProxyAddress({ policy: preliminary, deployer: input.deployer, startingNonce: prerequisiteNonce, safeProxySaltNonce: input.safeProxySaltNonce, safeProxyCreationCode: proxyCreationCode as Hex, deployments: infrastructure });
  const artifacts = await resolveReviewedVaultArtifacts({ client: input.client, deployments: infrastructure, safe, primaryPasskey: infrastructure.primaryPasskeySigner.address, ecdsaSecondary: ZERO, delay: components.delay, maintenance: components.maintenance, periodAnchor: input.profile.periodAnchor, cooldownSeconds: BigInt(input.profile.delay.cooldownSeconds), expirationSeconds: BigInt(input.profile.delay.expirationSeconds) });
  return createPwaProvisioningPlan({ ...input, infrastructure, artifacts });
}

function reviewPayload(plan: PwaProvisioningPlan): unknown {
  return {
    formatVersion: plan.formatVersion,
    scope: "sepolia-pwa-provisioning-review",
    chainId: plan.chainId,
    deployer: plan.deployer,
    planHash: plan.planHash,
    addresses: { safe: plan.safe, guard: plan.guard, delay: plan.delay, primaryPasskey: plan.primaryPasskey, secondaryPasskey: plan.secondaryPasskey, usdc: plan.usdc },
    policy: plan.vaultPlan.review,
    transactions: plan.transactions,
  };
}

export function provisioningPackageHash(plan: PwaProvisioningPlan): Hex {
  return keccak256(stringToHex(canonical(reviewPayload(plan))));
}

export function pwaProvisioningTransactionHash(transaction: PwaProvisioningTransaction): Hex {
  return keccak256(stringToHex(canonical({
    id: transaction.id,
    nonce: transaction.nonce,
    to: transaction.to,
    value: transaction.value,
    data: transaction.data,
    operation: transaction.operation,
    expectedCreatedAddress: transaction.expectedCreatedAddress,
    creationCodeHash: transaction.creationCodeHash,
    expectedRuntimeCodeHash: transaction.expectedRuntimeCodeHash,
  })));
}

function repositoryRoot(): string {
  const root = realpathSync(resolve(__dirname, "../../../.."));
  const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces?: unknown };
  if (!Array.isArray(value.workspaces) || !value.workspaces.includes("packages/*") || !value.workspaces.includes("apps/*")) throw new Error("repository root could not be resolved safely");
  return root;
}

function resolveExternalPath(value: string, label: string): string {
  const parts: string[] = [];
  let existing = resolve(value);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    parts.unshift(basename(existing));
    existing = parent;
  }
  const output = resolve(realpathSync(existing), ...parts);
  const relativePath = relative(repositoryRoot(), output);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) throw new Error(`${label} must be outside the repository`);
  return output;
}

export function writePwaProvisioningReview(plan: PwaProvisioningPlan, outputDirectory: string): { packageHash: Hex; path: string } {
  if (!isAbsolute(outputDirectory)) throw new Error("review output directory must be absolute and outside the repository");
  const output = resolveExternalPath(outputDirectory, "review output directory");
  const packageHash = provisioningPackageHash(plan);
  const path = join(output, `${packageHash.slice(2)}.pwa-provisioning-review.json`);
  const document = `${canonical({ packageHash, review: reviewPayload(plan) })}\n`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (readFileSync(path, "utf8") === document) return { packageHash, path };
    throw new Error("review package path already contains different bytes");
  } catch (error) {
    if (error instanceof Error && error.message === "review package path already contains different bytes") throw error;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, document, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  return { packageHash, path };
}

export async function executePwaProvisioning(plan: PwaProvisioningPlan, context: PwaProvisioningExecutionContext): Promise<PwaProvisioningResult> {
  if (!reviewedExecutionContexts.has(context)) throw new Error("fail closed: durable reviewed provisioning execution context is required");
  const prefixLength = await context.confirmedPrefixLength();
  if (!Number.isSafeInteger(prefixLength) || prefixLength < 0 || prefixLength > plan.transactions.length) throw new Error("fail closed: confirmed provisioning prefix length is invalid");
  const currentNonce = await context.currentDeployerNonce();
  const complete = prefixLength === plan.transactions.length;
  const expectedNextNonce = complete ? plan.transactions.at(-1)!.nonce + 1n : plan.transactions[prefixLength]!.nonce;
  if (complete ? currentNonce < expectedNextNonce : currentNonce !== expectedNextNonce) {
    const nextId = complete ? "completed-plan" : plan.transactions[prefixLength]!.id;
    throw new Error(`fail closed: deployer nonce does not equal the first missing reviewed transaction ${nextId}: expected ${expectedNextNonce}, observed ${currentNonce}`);
  }
  let setupReceipt: PwaProvisioningResult["setupReceipt"] | undefined = complete ? await context.completedSetupReceipt?.() : undefined;
  for (const transaction of plan.transactions.slice(prefixLength)) {
    let result = await context.resumePending?.(transaction);
    if (!result) {
      if (!context.authorize) throw new Error("fail closed: per-transaction provisioning authorizer is required");
      const approved = await context.authorize(transaction);
      if (pwaProvisioningTransactionHash(approved) !== pwaProvisioningTransactionHash(transaction)) throw new Error("fail closed: authorized provisioning transaction changed");
      result = await context.submit(approved);
    }
    if (result.receipt.status !== "success" || !HASH.test(result.transactionHash)) throw new Error(`fail closed: ${transaction.id} did not confirm successfully`);
    if (transaction.id === "safe-proxy") setupReceipt = Object.freeze({ transactionHash: result.transactionHash, blockNumber: result.receipt.blockNumber });
  }
  if (!setupReceipt) throw new Error("fail closed: Safe setup receipt is missing");
  const topologyReportHash = await context.verifyFinalTopology(plan);
  if (!HASH.test(topologyReportHash)) throw new Error("fail closed: topology report hash is invalid");
  const currentPolicyHash = context.currentPolicyHash ? await context.currentPolicyHash() : plan.policyHash;
  if (!HASH.test(currentPolicyHash)) throw new Error("fail closed: current policy hash is invalid");
  const result = Object.freeze({ chainId: SEPOLIA_CHAIN_ID, safe: plan.safe, guard: plan.guard, delay: plan.delay, primaryPasskey: plan.primaryPasskey, secondaryPasskey: plan.secondaryPasskey, usdc: plan.usdc, deploymentsHash: plan.deploymentsHash, policyHash: currentPolicyHash, setupReceipt, topologyReportHash });
  verifiedProvisioningResults.add(result);
  return result;
}
