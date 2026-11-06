import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  decodeFunctionData,
  isAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { LiveJournal, LiveReceipt } from "../../scripts/live/submission";
import { liveIntentHash } from "../../scripts/live/submission";
import CommittedSuccessor from "../../config/sepolia.pwa-provisioning-successor.json";
import CommittedPrefixOneSuccessor from "../../config/sepolia.pwa-provisioning-successor-1031.json";
import CommittedHistoricalVault from "../../config/sepolia.pwa-historical-vault.json";
import type { DeploymentInfrastructureRegistry } from "../config/deployments";
import { verifyHistoricalPwaTopology, type HistoricalPwaReadClient, type HistoricalReview, type PwaHistoricalVault } from "./historical-topology";
export type { HistoricalPwaReadClient, PwaHistoricalVault } from "./historical-topology";
import type { ArtifactResolutionClient } from "../topology/reviewed-artifacts";
import type { ReadOnlyDeploymentClient } from "../config/deployments";
import { SEPOLIA_CHAIN_ID, type PwaPhaseOneProfile } from "./profile";
import {
  provisioningPackageHash,
  resolvePwaProvisioningPlan,
  type PwaCredentialCoordinates,
  type PwaProvisioningPlan,
  type PwaProvisioningTransaction,
} from "./provisioning";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const EXPECTED_IDS = ["primary-signer", "secondary-signer", "setup-helper", "guard", "delay", "maintenance", "safe-proxy"] as const;
const CREATE_SIGNER_ABI = [{ name: "createSigner", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] }] as const;
type RecoveryPlan = Pick<PwaProvisioningPlan, "chainId" | "deployer" | "transactions">;

export type PwaProvisioningRecoveryTransaction = Readonly<{
  hash: Hex;
  chainId: number;
  type: "eip1559";
  from: Address;
  to: Address | null;
  nonce: number;
  value: bigint;
  input: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}>;

type RecoveryBlock = Readonly<{ number: bigint; hash: Hex | null }>;

export type PwaProvisioningRecoveryClient = ReadOnlyDeploymentClient & ArtifactResolutionClient & Readonly<{
  source: string;
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<RecoveryBlock>;
  getBlockWithTransactions?(input: Readonly<{ blockNumber: bigint }>): Promise<RecoveryBlock & Readonly<{ transactions: readonly PwaProvisioningRecoveryTransaction[] }>>;
  getTransaction(input: Readonly<{ hash: Hex }>): Promise<PwaProvisioningRecoveryTransaction | null>;
  getTransactionReceipt(input: Readonly<{ hash: Hex }>): Promise<LiveReceipt | null>;
  getTransactionCount(input: Readonly<{ address: Address; blockNumber?: bigint; blockTag?: "latest" | "pending" }>): Promise<number | bigint>;
}>;

export type PwaProvisioningRecoveryRelay = Readonly<{
  getTransactionCount(input: Readonly<{ address: Address; blockTag: "latest" | "pending" }>): Promise<number | bigint>;
}>;

type RecoveryRebuildInput = Readonly<{
  credentials: Readonly<{ primary: PwaCredentialCoordinates; secondary: PwaCredentialCoordinates }>;
  expectedDeployerNonce: bigint;
  confirmedPrefixLength: number;
  expectedCurrentDeployerNonce?: bigint;
  verifiedDeploymentPrefixLength?: number;
  successorStartingNonce?: bigint;
  prerequisiteStartingNonce?: bigint;
  confirmedSuccessorTransactionCount?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}>;

export type PwaProvisioningSuccessor = Readonly<{
  formatVersion: 1;
  scope: "sepolia-pwa-provisioning-successor";
  chainId: typeof SEPOLIA_CHAIN_ID;
  originalPackageHash: Hex;
  confirmedPrefixLength: 1 | 2;
  consumedTransactions: readonly Readonly<{ nonce: bigint; transactionHash: Hex }>[];
  expectedNextNonce: bigint;
}>;

export type ResolvePwaProvisioningRecoveryInput = Readonly<{
  reviewDirectory: string;
  journal: LiveJournal;
  profile: PwaPhaseOneProfile;
  safeProxySaltNonce: bigint;
  providers: readonly [PwaProvisioningRecoveryClient, PwaProvisioningRecoveryClient];
  relay: PwaProvisioningRecoveryRelay;
  successor?: PwaProvisioningSuccessor;
  successors?: readonly PwaProvisioningSuccessor[];
  /** Test-only seam. Production always rebuilds through committed resolvers. */
  rebuildPlan?(input: RecoveryRebuildInput): Promise<PwaProvisioningPlan>;
}>;

export type PwaProvisioningRecovery = Readonly<{
  plan: PwaProvisioningPlan;
  confirmedPrefixLength: number;
  credentials: Readonly<{ primary: PwaCredentialCoordinates; secondary: PwaCredentialCoordinates }>;
}>;

type ReviewDocument = Readonly<{
  bytes: string;
  packageHash: Hex;
  review: Readonly<Record<string, unknown> & { transactions: readonly Record<string, unknown>[] }>;
}>;

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

function fail(message: string): never {
  throw new Error(`fail closed: PWA provisioning recovery ${message}`);
}

function safeCandidateFailure(error: unknown): string {
  if (!(error instanceof Error)) return "plan reconstruction failed";
  const prefix = "fail closed: PWA provisioning recovery ";
  if (error.message.startsWith(prefix)) return error.message.slice(prefix.length);
  return error.message
    .replace(/https?:\/\/\S+/gi, "[redacted-rpc]")
    .replace(/0x[0-9a-fA-F]{64}/g, "[redacted-32-byte-value]")
    .replace(/\b[0-9]{20,}\b/g, "[redacted-large-value]")
    .slice(0, 240);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) fail(`${label} has unexpected fields`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is malformed`);
  return value as Record<string, unknown>;
}

function decimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail(`${label} is not a canonical decimal`);
  return BigInt(value);
}

export function loadPwaProvisioningSuccessor(value: unknown): PwaProvisioningSuccessor {
  const successor = object(value, "successor lineage");
  exactKeys(successor, ["formatVersion", "scope", "chainId", "originalPackageHash", "confirmedPrefixLength", "consumedTransactions", "expectedNextNonce"], "successor lineage");
  if (successor.formatVersion !== 1 || successor.scope !== "sepolia-pwa-provisioning-successor" || successor.chainId !== SEPOLIA_CHAIN_ID) fail("successor lineage identity is invalid");
  if (typeof successor.originalPackageHash !== "string" || !HASH.test(successor.originalPackageHash)) fail("successor original package hash is malformed");
  if (successor.confirmedPrefixLength !== 1 && successor.confirmedPrefixLength !== 2) fail("successor must preserve one or two confirmed signer transactions");
  const rawConsumedTransactions = successor.consumedTransactions;
  if (!Array.isArray(rawConsumedTransactions) || rawConsumedTransactions.length === 0) fail("successor consumed transaction lineage is empty");
  let previousNonce: bigint | undefined;
  const consumedTransactions = rawConsumedTransactions.map((item, index) => {
    const transaction = object(item, `successor consumed transaction ${index}`);
    exactKeys(transaction, ["nonce", "transactionHash"], `successor consumed transaction ${index}`);
    const nonce = decimal(transaction.nonce, `successor consumed transaction ${index} nonce`);
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) fail("successor consumed transaction nonce is unsafe");
    if (typeof transaction.transactionHash !== "string" || !HASH.test(transaction.transactionHash)) fail("successor consumed transaction hash is malformed");
    if (previousNonce !== undefined && nonce !== previousNonce + 1n) fail("successor consumed transaction nonces are not contiguous");
    previousNonce = nonce;
    return Object.freeze({ nonce, transactionHash: transaction.transactionHash.toLowerCase() as Hex });
  });
  const expectedNextNonce = decimal(successor.expectedNextNonce, "successor expected next nonce");
  if (expectedNextNonce > BigInt(Number.MAX_SAFE_INTEGER)) fail("successor expected next nonce is unsafe");
  if (expectedNextNonce !== consumedTransactions.at(-1)!.nonce + 1n) fail("successor expected next nonce does not follow consumed lineage");
  return Object.freeze({
    formatVersion: 1,
    scope: "sepolia-pwa-provisioning-successor",
    chainId: SEPOLIA_CHAIN_ID,
    originalPackageHash: successor.originalPackageHash.toLowerCase() as Hex,
    confirmedPrefixLength: successor.confirmedPrefixLength,
    consumedTransactions: Object.freeze(consumedTransactions),
    expectedNextNonce,
  });
}

export function loadCommittedPwaProvisioningSuccessor(): PwaProvisioningSuccessor {
  return loadPwaProvisioningSuccessor(CommittedSuccessor);
}

export function loadCommittedPwaProvisioningSuccessors(): readonly PwaProvisioningSuccessor[] {
  const successors = [loadPwaProvisioningSuccessor(CommittedSuccessor), loadPwaProvisioningSuccessor(CommittedPrefixOneSuccessor)];
  if (new Set(successors.map((item) => item.originalPackageHash)).size !== successors.length) fail("committed successor package hashes are not unique");
  return Object.freeze(successors);
}

function readReviewDocuments(directory: string): readonly ReviewDocument[] {
  if (!isAbsolute(directory)) fail("review directory must be absolute");
  const uniqueBytes = new Set<string>();
  const documents: ReviewDocument[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const bytes = readFileSync(join(directory, entry.name), "utf8");
    if (uniqueBytes.has(bytes)) continue;
    uniqueBytes.add(bytes);
    let parsed: unknown;
    try { parsed = JSON.parse(bytes); } catch { fail("review package is not JSON"); }
    const wrapper = object(parsed, "review package");
    exactKeys(wrapper, ["packageHash", "review"], "review package");
    if (typeof wrapper.packageHash !== "string" || !HASH.test(wrapper.packageHash)) fail("review package hash is malformed");
    const review = object(wrapper.review, "review payload");
    if (keccak256(stringToHex(canonical(review))).toLowerCase() !== wrapper.packageHash.toLowerCase()) fail("review package hash mismatch");
    if (`${canonical({ packageHash: wrapper.packageHash, review })}\n` !== bytes) fail("review package bytes are not canonical");
    if (review.formatVersion !== 1 || review.scope !== "sepolia-pwa-provisioning-review" || review.chainId !== SEPOLIA_CHAIN_ID || typeof review.deployer !== "string" || !isAddress(review.deployer) || typeof review.planHash !== "string" || !HASH.test(review.planHash) || !Array.isArray(review.transactions) || review.transactions.length !== EXPECTED_IDS.length) fail("review payload identity is invalid");
    documents.push(Object.freeze({ bytes, packageHash: wrapper.packageHash.toLowerCase() as Hex, review: review as ReviewDocument["review"] }));
  }
  return documents;
}

function assertJournalPrefix(journal: LiveJournal, successors: readonly PwaProvisioningSuccessor[] = []): Readonly<{ length: number; successorSuffix: boolean }> {
  if (journal.chainId !== SEPOLIA_CHAIN_ID || !isAddress(journal.funder)) fail("journal identity mismatch");
  if (journal.entries.length === 0) return Object.freeze({ length: 0, successorSuffix: false });
  if (journal.entries.length > EXPECTED_IDS.length) fail("journal exceeds the reviewed provisioning sequence");
  const firstNonce = journal.entries[0]!.nonce;
  if (!Number.isSafeInteger(firstNonce) || firstNonce < 0) fail("journal starting nonce is invalid");
  const contiguous = journal.entries.every((entry, index) => entry.nonce === firstNonce + index);
  const successorSuffix = successors.some((successor) => journal.entries.length > successor.confirmedPrefixLength
    && journal.entries.every((entry, index) => entry.nonce === (index < successor.confirmedPrefixLength ? firstNonce + index : Number(successor.expectedNextNonce) + index - successor.confirmedPrefixLength)));
  if (!contiguous && !successorSuffix) fail("journal entries are not a recognized reviewed prefix");
  for (const [index, entry] of journal.entries.entries()) {
    if (entry.id !== `pwa-${EXPECTED_IDS[index]}`) fail("journal entries are not an ordered reviewed prefix");
    if (entry.status !== "success" || !entry.receipt || entry.receipt.status !== "success" || entry.receipt.transactionHash.toLowerCase() !== entry.transactionHash.toLowerCase()) fail("journal prefix is not fully successful");
    if (!HASH.test(entry.intentHash) || !HASH.test(entry.transactionHash) || !HASH.test(entry.receipt.blockHash)) fail("journal evidence hash is malformed");
  }
  return Object.freeze({ length: journal.entries.length, successorSuffix });
}

function candidateMatchesPrefix(document: ReviewDocument, journal: LiveJournal): boolean {
  if (!isAddressEqual(document.review.deployer as Address, journal.funder)) return false;
  return journal.entries.every((entry, index) => {
    const transaction = document.review.transactions[index];
    return transaction?.id === EXPECTED_IDS[index] && decimal(transaction.nonce, "review transaction nonce") === BigInt(entry.nonce);
  });
}

function decodeCredentials(document: ReviewDocument): Readonly<{ primary: PwaCredentialCoordinates; secondary: PwaCredentialCoordinates }> {
  const decoded = document.review.transactions.slice(0, 2).map((transaction, index) => {
    if (transaction.id !== EXPECTED_IDS[index] || typeof transaction.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(transaction.data)) fail("review signer transaction is malformed");
    try {
      const value = decodeFunctionData({ abi: CREATE_SIGNER_ABI, data: transaction.data as Hex });
      if (value.functionName !== "createSigner") fail("review signer selector changed");
      return Object.freeze({ x: value.args[0], y: value.args[1], verifiers: value.args[2] });
    } catch { return fail("review signer calldata cannot be decoded"); }
  });
  if (decoded[0]!.verifiers !== decoded[1]!.verifiers || decoded[0]!.x === decoded[1]!.x && decoded[0]!.y === decoded[1]!.y) fail("review signer credentials are invalid");
  return Object.freeze({ primary: Object.freeze({ x: decoded[0]!.x, y: decoded[0]!.y }), secondary: Object.freeze({ x: decoded[1]!.x, y: decoded[1]!.y }) });
}

function sameReceipt(left: LiveReceipt, right: LiveReceipt): boolean {
  return left.transactionHash.toLowerCase() === right.transactionHash.toLowerCase()
    && left.status === right.status
    && left.gasUsed === right.gasUsed
    && left.effectiveGasPrice === right.effectiveGasPrice
    && left.blockNumber === right.blockNumber
    && left.blockHash.toLowerCase() === right.blockHash.toLowerCase();
}

function expectedTransactionTo(transaction: PwaProvisioningTransaction): Address | null {
  return isAddressEqual(transaction.to, ZERO) ? null : transaction.to;
}

async function verifyProviderPrefix(
  client: PwaProvisioningRecoveryClient,
  plan: RecoveryPlan,
  journal: LiveJournal,
  prefixLength: number,
  permittedFutureRuntimeHashes: ReadonlyMap<string, Hex> = new Map(),
): Promise<void> {
  if (!client.source || await client.getChainId() !== SEPOLIA_CHAIN_ID) fail("evidence provider identity or chain mismatch");
  const head = await client.getBlockNumber();
  for (let index = 0; index < prefixLength; index += 1) {
    const planned = plan.transactions[index]!;
    const entry = journal.entries[index]!;
    const storedReceipt = entry.receipt!;
    const [transaction, receipt, block] = await Promise.all([
      client.getTransaction({ hash: entry.transactionHash }),
      client.getTransactionReceipt({ hash: entry.transactionHash }),
      client.getBlock({ blockNumber: storedReceipt.blockNumber }),
    ]);
    if (!transaction || !receipt || !block.hash) fail("an evidence provider is missing confirmed prefix evidence");
    if (head < receipt.blockNumber + 5n) fail("an evidence provider reports fewer than six confirmations");
    if (block.number !== receipt.blockNumber || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase() || !sameReceipt(receipt, storedReceipt)) fail("an evidence provider canonical receipt changed");
    const actualCost = receipt.gasUsed * receipt.effectiveGasPrice + planned.value;
    if (entry.reserved !== actualCost) fail("journal confirmed cost does not match the canonical receipt");
    const expectedTo = expectedTransactionTo(planned);
    if (
      transaction.hash.toLowerCase() !== entry.transactionHash.toLowerCase()
      || transaction.chainId !== SEPOLIA_CHAIN_ID
      || transaction.type !== "eip1559"
      || !isAddressEqual(transaction.from, plan.deployer)
      || (expectedTo === null ? transaction.to !== null : transaction.to === null || !isAddressEqual(transaction.to, expectedTo))
      || transaction.nonce !== Number(planned.nonce)
      || transaction.value !== planned.value
      || transaction.input.toLowerCase() !== planned.data.toLowerCase()
      || transaction.gas <= 0n
      || transaction.maxFeePerGas <= 0n
      || transaction.maxPriorityFeePerGas < 0n
      || transaction.maxPriorityFeePerGas > transaction.maxFeePerGas
      || planned.operation !== 0
    ) fail("an evidence provider transaction changed from the reviewed plan");
    const intentHash = liveIntentHash({
      id: `pwa-${planned.id}`,
      ...(expectedTo === null ? {} : { to: expectedTo }),
      data: planned.data,
      value: planned.value,
      nonce: Number(planned.nonce),
      gas: transaction.gas,
      maxFeePerGas: transaction.maxFeePerGas,
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
    }, plan.deployer);
    if (intentHash.toLowerCase() !== entry.intentHash.toLowerCase()) fail("an evidence provider historical signed intent hash changed");
    const runtime = await client.getBytecode({ address: planned.expectedCreatedAddress });
    if (!runtime || runtime === "0x" || keccak256(runtime).toLowerCase() !== planned.expectedRuntimeCodeHash.toLowerCase()) fail("an evidence provider confirmed runtime changed");
  }
  for (const future of plan.transactions.slice(prefixLength)) {
    const runtime = await client.getBytecode({ address: future.expectedCreatedAddress });
    if (runtime && runtime !== "0x") {
      const permitted = permittedFutureRuntimeHashes.get(future.expectedCreatedAddress.toLowerCase());
      if (!permitted || keccak256(runtime).toLowerCase() !== permitted.toLowerCase()) fail(`an evidence provider future ${future.id} address already has code`);
    }
  }
}

function sameTransaction(left: PwaProvisioningRecoveryTransaction, right: PwaProvisioningRecoveryTransaction): boolean {
  return left.hash.toLowerCase() === right.hash.toLowerCase()
    && left.chainId === right.chainId
    && left.type === right.type
    && isAddressEqual(left.from, right.from)
    && (left.to === null ? right.to === null : right.to !== null && isAddressEqual(left.to, right.to))
    && left.nonce === right.nonce
    && left.value === right.value
    && left.input.toLowerCase() === right.input.toLowerCase()
    && left.gas === right.gas
    && left.maxFeePerGas === right.maxFeePerGas
    && left.maxPriorityFeePerGas === right.maxPriorityFeePerGas;
}

async function verifyConsumedLineage(
  providers: readonly [PwaProvisioningRecoveryClient, PwaProvisioningRecoveryClient],
  plan: RecoveryPlan,
  successor: PwaProvisioningSuccessor,
  prefixLength: number,
): Promise<void> {
  const firstMissing = plan.transactions[prefixLength]?.nonce;
  if (firstMissing === undefined || successor.consumedTransactions[0]!.nonce !== firstMissing) fail("successor lineage does not begin at the first missing reviewed nonce");
  for (const [index, committed] of successor.consumedTransactions.entries()) {
    if (committed.nonce !== firstMissing + BigInt(index)) fail("successor consumed transaction nonces changed");
    const evidence = await Promise.all(providers.map(async (provider) => {
      if (!provider.source || await provider.getChainId() !== SEPOLIA_CHAIN_ID) fail("successor evidence provider identity or chain mismatch");
      const [head, transaction, receipt] = await Promise.all([
        provider.getBlockNumber(),
        provider.getTransaction({ hash: committed.transactionHash }),
        provider.getTransactionReceipt({ hash: committed.transactionHash }),
      ]);
      if (!transaction || !receipt) fail("a successor evidence provider is missing consumed transaction evidence");
      const block = await provider.getBlock({ blockNumber: receipt.blockNumber });
      if (!block.hash || block.number !== receipt.blockNumber || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) fail("a successor consumed transaction is not canonical");
      if (head < receipt.blockNumber + 5n) fail("a successor consumed transaction has fewer than six confirmations");
      if (
        transaction.hash.toLowerCase() !== committed.transactionHash.toLowerCase()
        || transaction.chainId !== SEPOLIA_CHAIN_ID
        || transaction.type !== "eip1559"
        || !isAddressEqual(transaction.from, plan.deployer)
        || transaction.nonce !== Number(committed.nonce)
        || transaction.gas <= 0n
        || transaction.maxFeePerGas <= 0n
        || transaction.maxPriorityFeePerGas < 0n
        || transaction.maxPriorityFeePerGas > transaction.maxFeePerGas
        || receipt.transactionHash.toLowerCase() !== committed.transactionHash.toLowerCase()
        || receipt.status !== "success"
      ) fail("a successor consumed transaction changed from its committed lineage");
      return Object.freeze({ transaction, receipt });
    }));
    if (!sameTransaction(evidence[0].transaction, evidence[1].transaction) || !sameReceipt(evidence[0].receipt, evidence[1].receipt)) fail("successor evidence providers disagree on consumed lineage");
    const displaced = plan.transactions[prefixLength + index];
    if (displaced) {
      const expectedTo = expectedTransactionTo(displaced);
      if (
        (expectedTo === null ? evidence[0].transaction.to === null : evidence[0].transaction.to !== null && isAddressEqual(evidence[0].transaction.to, expectedTo))
        && evidence[0].transaction.value === displaced.value
        && evidence[0].transaction.input.toLowerCase() === displaced.data.toLowerCase()
      ) fail("successor lineage consumed an original reviewed transaction instead of an unrelated transaction");
    }
  }
  if (successor.expectedNextNonce !== firstMissing + BigInt(successor.consumedTransactions.length)) fail("successor expected next nonce is inconsistent with the reviewed plan");
}

async function rebuildPlan(
  input: ResolvePwaProvisioningRecoveryInput,
  credentials: Readonly<{ primary: PwaCredentialCoordinates; secondary: PwaCredentialCoordinates }>,
  expectedDeployerNonce: bigint,
  confirmedPrefixLength: number,
  options: Readonly<{ expectedCurrentDeployerNonce?: bigint; verifiedDeploymentPrefixLength?: number; successorStartingNonce?: bigint; prerequisiteStartingNonce?: bigint; confirmedSuccessorTransactionCount?: 0 | 1 | 2 | 3 | 4 | 5 | 6 }> = {},
): Promise<PwaProvisioningPlan> {
  const rebuildInput = { credentials, expectedDeployerNonce, confirmedPrefixLength, ...options };
  if (input.rebuildPlan) {
    if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") fail("test-only plan rebuilder is disabled");
    return input.rebuildPlan(rebuildInput);
  }
  return resolvePwaProvisioningPlan({
    profile: input.profile,
    deployer: input.journal.funder,
    expectedDeployerNonce,
    safeProxySaltNonce: input.safeProxySaltNonce,
    primaryCredential: credentials.primary,
    secondaryCredential: credentials.secondary,
    client: input.providers[0],
    confirmedProvisioningPrefixLength: confirmedPrefixLength,
    ...options,
  });
}

async function completedDeployerNonce(input: Pick<ResolvePwaProvisioningRecoveryInput, "providers" | "relay" | "journal">, minimumNonce: bigint): Promise<bigint> {
  const observations = await Promise.all([...input.providers, input.relay].map(async (client) => {
    const [latest, pending] = await Promise.all([
      client.getTransactionCount({ address: input.journal.funder, blockTag: "latest" }),
      client.getTransactionCount({ address: input.journal.funder, blockTag: "pending" }),
    ]);
    const confirmedNonce = BigInt(latest);
    if (confirmedNonce < minimumNonce || BigInt(pending) < confirmedNonce) fail("completed deployment latest/pending nonce is behind confirmed history");
    return confirmedNonce;
  }));
  if (observations.some((nonce) => nonce !== observations[0])) fail("completed deployment providers disagree on the current confirmed deployer nonce");
  return observations[0]!;
}

async function rebuildCandidate(
  input: ResolvePwaProvisioningRecoveryInput,
  document: ReviewDocument,
  prefixLength: number,
  successorSuffix: boolean,
  successor: PwaProvisioningSuccessor | undefined,
): Promise<PwaProvisioningRecovery> {
  const credentials = decodeCredentials(document);
  const expectedDeployerNonce = BigInt(input.journal.entries[0]!.nonce);
  const complete = prefixLength === EXPECTED_IDS.length;
  if (successorSuffix && !successor) fail("successor journal suffix is not bound to the original review package");
  // The planner reconstructs the pre-Safe layout; all seven historical rows are verified below.
  const signerPrefixLength = successor?.confirmedPrefixLength ?? Math.min(prefixLength, EXPECTED_IDS.length - 1);
  const expectedCurrentDeployerNonce = complete
    ? await completedDeployerNonce(input, BigInt(input.journal.entries.at(-1)!.nonce) + 1n)
    : successor
    ? successor.expectedNextNonce + BigInt(Math.max(0, prefixLength - successor.confirmedPrefixLength))
    : expectedDeployerNonce + BigInt(prefixLength);
  const verifiedDeploymentPrefixLength = successor ? Math.min(prefixLength, 2) : signerPrefixLength;
  const plan = await rebuildPlan(input, credentials, expectedDeployerNonce, signerPrefixLength, successor || complete ? { expectedCurrentDeployerNonce, verifiedDeploymentPrefixLength } : {});
  if (provisioningPackageHash(plan).toLowerCase() !== document.packageHash || plan.planHash.toLowerCase() !== String(document.review.planHash).toLowerCase()) fail("rebuilt plan does not match the review package");
  if (plan.transactions.length !== EXPECTED_IDS.length || plan.transactions.some((transaction, index) => transaction.id !== EXPECTED_IDS[index] || transaction.nonce !== expectedDeployerNonce + BigInt(index))) fail("rebuilt plan transaction sequence changed");
  let recoveredPlan = plan;
  let nextNonce = expectedDeployerNonce + BigInt(prefixLength);
  if (successor) {
    await verifyConsumedLineage(input.providers, plan, successor, successor.confirmedPrefixLength);
    recoveredPlan = await rebuildPlan(input, credentials, expectedDeployerNonce, successor.confirmedPrefixLength, {
      expectedCurrentDeployerNonce,
      verifiedDeploymentPrefixLength,
      successorStartingNonce: successor.expectedNextNonce,
      prerequisiteStartingNonce: successor.expectedNextNonce + BigInt(2 - successor.confirmedPrefixLength),
      confirmedSuccessorTransactionCount: (prefixLength - successor.confirmedPrefixLength) as 0 | 1 | 2 | 3 | 4 | 5 | 6,
    });
    if (recoveredPlan.transactions.length !== EXPECTED_IDS.length || recoveredPlan.transactions.some((transaction, index) => transaction.id !== EXPECTED_IDS[index])) fail("successor plan transaction identity changed");
    if (recoveredPlan.transactions.slice(0, successor.confirmedPrefixLength).some((transaction, index) => canonical(transaction) !== canonical(plan.transactions[index]))) fail("successor plan changed a confirmed signer transaction");
    if (recoveredPlan.transactions.slice(successor.confirmedPrefixLength).some((transaction, index) => transaction.nonce !== successor.expectedNextNonce + BigInt(index))) fail("successor plan suffix nonce sequence changed");
    if (provisioningPackageHash(recoveredPlan).toLowerCase() === document.packageHash) fail("successor plan did not produce a distinct review package");
    const permittedOldFutureCode = new Map(recoveredPlan.transactions.slice(successor.confirmedPrefixLength, prefixLength).map((transaction) => [transaction.expectedCreatedAddress.toLowerCase(), transaction.expectedRuntimeCodeHash]));
    await Promise.all(input.providers.map((provider) => verifyProviderPrefix(provider, plan, input.journal, signerPrefixLength, permittedOldFutureCode)));
    await Promise.all(input.providers.map((provider) => verifyProviderPrefix(provider, recoveredPlan, input.journal, prefixLength)));
    const next = recoveredPlan.transactions[prefixLength];
    nextNonce = next?.nonce ?? recoveredPlan.transactions.at(-1)!.nonce + 1n;
  } else {
    await Promise.all(input.providers.map((provider) => verifyProviderPrefix(provider, plan, input.journal, prefixLength)));
  }
  const [latest, pending] = await Promise.all([
    input.relay.getTransactionCount({ address: recoveredPlan.deployer, blockTag: "latest" }),
    input.relay.getTransactionCount({ address: recoveredPlan.deployer, blockTag: "pending" }),
  ]);
  if (complete) {
    if (BigInt(latest) < nextNonce || BigInt(pending) < BigInt(latest)) fail("completed deployment relay latest/pending nonce is behind confirmed history");
  } else if (BigInt(latest) !== nextNonce || BigInt(pending) !== nextNonce) fail("relay latest/pending nonce does not equal the first missing transaction");
  return Object.freeze({ plan: recoveredPlan, confirmedPrefixLength: prefixLength, credentials });
}

export async function resolvePwaProvisioningRecovery(input: ResolvePwaProvisioningRecoveryInput): Promise<PwaProvisioningRecovery | undefined> {
  const successors = input.successors ?? (input.successor ? [input.successor] : []);
  const journalPrefix = assertJournalPrefix(input.journal, successors);
  const prefixLength = journalPrefix.length;
  if (prefixLength === 0) return undefined;
  if (input.providers[0].source === input.providers[1].source) fail("requires two distinct evidence providers");
  const candidates = readReviewDocuments(input.reviewDirectory).filter((document) => journalPrefix.successorSuffix
    ? successors.some((successor) => document.packageHash === successor.originalPackageHash.toLowerCase())
    : candidateMatchesPrefix(document, input.journal));
  if (candidates.length === 0) fail("has no matching review package");
  const recovered: PwaProvisioningRecovery[] = [];
  const candidateFailures = new Set<string>();
  for (const document of candidates) {
    const matchingSuccessors = successors.filter((successor) => successor.originalPackageHash.toLowerCase() === document.packageHash
      && (journalPrefix.successorSuffix || prefixLength === successor.confirmedPrefixLength));
    if (matchingSuccessors.length > 1) fail("review package has ambiguous successor lineage");
    try { recovered.push(await rebuildCandidate(input, document, prefixLength, journalPrefix.successorSuffix, matchingSuccessors[0])); }
    catch (error) { candidateFailures.add(safeCandidateFailure(error)); }
  }
  if (recovered.length === 0) fail(`has no fully verified review package (${[...candidateFailures].join("; ")})`);
  const unique = new Map(recovered.map((value) => [provisioningPackageHash(value.plan).toLowerCase(), value]));
  if (unique.size !== 1) fail("review package is ambiguous");
  return [...unique.values()][0];
}

/** Read-only exact-hash reconciliation. The caller persists only a fully verified returned journal. */
export async function reconcilePwaProvisioningPending(input: ResolvePwaProvisioningRecoveryInput): Promise<LiveJournal> {
  const journal = structuredClone(input.journal);
  const pending = journal.entries.filter(entry => entry.status === "pending");
  if (pending.length === 0) return journal;
  if (pending.length !== 1 || pending[0] !== journal.entries.at(-1) || pending[0]!.receipt) fail("pending journal is not a successful prefix plus one unresolved hash");
  if (!input.providers[0].source || !input.providers[1].source || input.providers[0].source === input.providers[1].source) fail("pending reconciliation requires two distinct evidence providers");
  const entry = pending[0]!;
  const successors = input.successors ?? (input.successor ? [input.successor] : []);
  assertJournalPrefix({ ...journal, entries: journal.entries.slice(0, -1) }, successors);
  if (journal.entries.length > EXPECTED_IDS.length || entry.id !== `pwa-${EXPECTED_IDS[journal.entries.length - 1]}` || !Number.isSafeInteger(entry.nonce) || entry.nonce < 0 || !HASH.test(entry.intentHash) || !HASH.test(entry.transactionHash) || entry.reserved <= 0n) fail("pending journal transaction identity or bounds changed");
  let documents: readonly ReviewDocument[];
  try { documents = readReviewDocuments(input.reviewDirectory); }
  catch { fail("pending original review directory is missing or invalid"); }
  const anchors = documents.filter(document => {
    if (!isAddressEqual(document.review.deployer as Address, journal.funder)) return false;
    const ordinaryPrefix = candidateMatchesPrefix(document, journal);
    const successorPrefix = successors.some(successor => successor.originalPackageHash.toLowerCase() === document.packageHash
      && journal.entries.every((candidate, index) => candidate.id === `pwa-${EXPECTED_IDS[index]}` && BigInt(candidate.nonce) === (index < successor.confirmedPrefixLength ? decimal(document.review.transactions[index]!.nonce, "pending original review nonce") : successor.expectedNextNonce + BigInt(index - successor.confirmedPrefixLength))));
    if (!ordinaryPrefix && !successorPrefix) return false;
    // Parse every original transaction and creation-code commitment before treating
    // an absent receipt as a known pending plan. This grants no execution authority.
    historicalReview(document);
    return true;
  });
  if (anchors.length === 0) fail("pending journal has no matching original canonical review package");
  const evidence = await Promise.all(input.providers.map(async provider => {
    if (await provider.getChainId() !== SEPOLIA_CHAIN_ID) fail("pending reconciliation chain changed");
    const [transaction, receipt, head] = await Promise.all([provider.getTransaction({ hash: entry.transactionHash }), provider.getTransactionReceipt({ hash: entry.transactionHash }), provider.getBlockNumber()]);
    return { transaction, receipt, head };
  }));
  if (!evidence[0].receipt && !evidence[1].receipt) return journal;
  if (!evidence[0].transaction || !evidence[1].transaction || !evidence[0].receipt || !evidence[1].receipt || !sameTransaction(evidence[0].transaction, evidence[1].transaction) || !sameReceipt(evidence[0].receipt, evidence[1].receipt)) fail("pending evidence providers disagree on the exact hash");
  const transaction = evidence[0].transaction;
  const receipt = evidence[0].receipt;
  if (evidence.some(item => item.head < receipt.blockNumber + 5n)) return journal;
  if (receipt.status !== "success" || transaction.hash.toLowerCase() !== entry.transactionHash.toLowerCase() || receipt.transactionHash.toLowerCase() !== entry.transactionHash.toLowerCase() || transaction.nonce !== entry.nonce || entry.reserved !== transaction.value + transaction.gas * transaction.maxFeePerGas || receipt.gasUsed < 0n || receipt.gasUsed > transaction.gas || receipt.effectiveGasPrice < 0n || receipt.effectiveGasPrice > transaction.maxFeePerGas) fail("pending receipt or reservation changed from the signed envelope");
  entry.status = "success";
  entry.receipt = receipt;
  entry.reserved = receipt.gasUsed * receipt.effectiveGasPrice + transaction.value;
  let recovered: PwaProvisioningRecovery | undefined;
  try {
    recovered = await resolvePwaProvisioningRecovery({ ...input, journal });
  } catch (error) {
    // A recorded signer may have mined before the payer consumed another nonce.
    // Discovery repeats every prefix and canonical-lineage gate on this clone.
    const successor = await discoverPwaProvisioningSuccessor({ ...input, journal });
    if (!successor) throw error;
    recovered = await resolvePwaProvisioningRecovery({ ...input, journal, successor, successors: [successor] });
  }
  if (!recovered || recovered.confirmedPrefixLength !== journal.entries.length) fail("pending hash has no fully verified reviewed plan");
  // Re-read exact canonical receipts after full reconstruction, before returning persistence data.
  await Promise.all(input.providers.map(provider => verifyProviderPrefix(provider, recovered.plan, journal, journal.entries.length)));
  return journal;
}

/** Discover only bounded unrelated nonce consumption after an exactly verified signer prefix. */
export async function discoverPwaProvisioningSuccessor(input: ResolvePwaProvisioningRecoveryInput): Promise<PwaProvisioningSuccessor | undefined> {
  const prefixLength = assertJournalPrefix(input.journal).length;
  if (prefixLength === 0) return undefined;
  if (prefixLength !== 1 && prefixLength !== 2) fail("automatic successor requires exactly one or two confirmed signers");
  if (!input.providers[0].source || !input.providers[1].source || input.providers[0].source === input.providers[1].source) fail("automatic successor requires two distinct evidence providers");
  const nonceObservations = await Promise.all([...input.providers, input.relay].map(async client => {
    const [latest, pending] = await Promise.all([client.getTransactionCount({ address: input.journal.funder, blockTag: "latest" }), client.getTransactionCount({ address: input.journal.funder, blockTag: "pending" })]);
    if (BigInt(latest) !== BigInt(pending)) fail("automatic successor cannot proceed with pending or unknown nonce consumption");
    return BigInt(latest);
  }));
  const nextNonce = nonceObservations[0]!;
  if (nonceObservations.some(nonce => nonce !== nextNonce)) fail("automatic successor providers disagree on current nonce");
  const firstMissing = BigInt(input.journal.entries[0]!.nonce) + BigInt(prefixLength);
  if (nextNonce === firstMissing) return undefined;
  if (nextNonce < firstMissing || nextNonce - firstMissing > 32n) fail("automatic successor nonce gap exceeds the supported bound");
  if (input.providers.some(provider => !provider.getBlockWithTransactions)) fail("automatic successor canonical block transaction reader is required");
  const heads = await Promise.all(input.providers.map(provider => provider.getBlockNumber()));
  const upper = (heads[0] < heads[1] ? heads[0] : heads[1]) - 5n;
  const lower = input.journal.entries.at(-1)!.receipt!.blockNumber - 1n;
  if (lower < 0n || upper < lower || upper - lower > 4096n) fail("automatic successor canonical block span exceeds the supported bound");
  const anchors = new Map<bigint, Hex>();
  const canonicalBlock = async (blockNumber: bigint): Promise<Hex> => {
    const blocks = await Promise.all(input.providers.map(provider => provider.getBlock({ blockNumber })));
    if (!blocks[0].hash || !blocks[1].hash || blocks.some(block => block.number !== blockNumber || block.hash!.toLowerCase() !== blocks[0].hash!.toLowerCase())) fail("automatic successor canonical block providers disagree");
    const hash = blocks[0].hash!.toLowerCase() as Hex;
    if (anchors.has(blockNumber) && anchors.get(blockNumber) !== hash) fail("automatic successor canonical block changed");
    anchors.set(blockNumber, hash);
    return hash;
  };
  const nonceAt = async (blockNumber: bigint): Promise<bigint> => {
    await canonicalBlock(blockNumber);
    const counts = await Promise.all(input.providers.map(provider => provider.getTransactionCount({ address: input.journal.funder, blockNumber })));
    if (BigInt(counts[0]) !== BigInt(counts[1])) fail("automatic successor historical nonce providers disagree");
    return BigInt(counts[0]);
  };
  if (await nonceAt(lower) > firstMissing || await nonceAt(upper) !== nextNonce) fail("automatic successor nonce history is not fully confirmed within its anchors");
  const consumedTransactions: { nonce: bigint; transactionHash: Hex }[] = [];
  for (let nonce = firstMissing; nonce < nextNonce; nonce += 1n) {
    let left = lower;
    let right = upper;
    while (right - left > 1n) {
      const middle = (left + right) / 2n;
      if (await nonceAt(middle) > nonce) right = middle;
      else left = middle;
    }
    if (await nonceAt(left) > nonce || await nonceAt(right) <= nonce) fail("automatic successor historical nonce transition changed");
    const blockHash = await canonicalBlock(right);
    const blocks = await Promise.all(input.providers.map(provider => provider.getBlockWithTransactions!({ blockNumber: right })));
    const matched = blocks.map(block => {
      if (block.number !== right || block.hash?.toLowerCase() !== blockHash) fail("automatic successor transaction block anchor changed");
      const matches = block.transactions.filter(transaction => isAddressEqual(transaction.from, input.journal.funder) && transaction.nonce === Number(nonce));
      if (matches.length !== 1) fail("automatic successor consumed transaction is missing or ambiguous");
      return matches[0]!;
    });
    if (!sameTransaction(matched[0], matched[1])) fail("automatic successor providers disagree on consumed envelope");
    const receipts = await Promise.all(input.providers.map(provider => provider.getTransactionReceipt({ hash: matched[0].hash })));
    if (receipts.some(receipt => !receipt || receipt.blockNumber !== right || receipt.blockHash.toLowerCase() !== blockHash)) fail("automatic successor receipt differs from its discovered canonical block");
    consumedTransactions.push(Object.freeze({ nonce, transactionHash: matched[0].hash }));
  }
  const candidates = readReviewDocuments(input.reviewDirectory).filter(document => candidateMatchesPrefix(document, input.journal));
  const verified: PwaProvisioningSuccessor[] = [];
  const failures = new Set<string>();
  for (const document of candidates) {
    try {
      const credentials = decodeCredentials(document);
      const original = await rebuildPlan(input, credentials, BigInt(input.journal.entries[0]!.nonce), prefixLength, { expectedCurrentDeployerNonce: nextNonce, verifiedDeploymentPrefixLength: prefixLength });
      if (provisioningPackageHash(original).toLowerCase() !== document.packageHash) continue;
      await Promise.all(input.providers.map(provider => verifyProviderPrefix(provider, original, input.journal, prefixLength)));
      const candidate = Object.freeze({ formatVersion: 1 as const, scope: "sepolia-pwa-provisioning-successor" as const, chainId: SEPOLIA_CHAIN_ID, originalPackageHash: document.packageHash, confirmedPrefixLength: prefixLength, consumedTransactions: Object.freeze(consumedTransactions), expectedNextNonce: nextNonce });
      await verifyConsumedLineage(input.providers, original, candidate, prefixLength);
      const resolved = await resolvePwaProvisioningRecovery({ ...input, successor: candidate, successors: [candidate] });
      if (!resolved) fail("automatic successor did not rebuild a verified plan");
      verified.push(candidate);
    } catch (error) { failures.add(safeCandidateFailure(error)); }
  }
  if (verified.length !== 1) fail(`automatic successor original review is missing or ambiguous (${[...failures].join("; ")})`);
  for (const [blockNumber, hash] of anchors) if (await canonicalBlock(blockNumber) !== hash) fail("automatic successor canonical anchor changed");
  const finalNonces = await Promise.all([...input.providers, input.relay].map(async client => [BigInt(await client.getTransactionCount({ address: input.journal.funder, blockTag: "latest" })), BigInt(await client.getTransactionCount({ address: input.journal.funder, blockTag: "pending" }))]));
  if (finalNonces.some(counts => counts.some(nonce => nonce !== nextNonce))) fail("automatic successor nonce changed during verification");
  const result = verified[0]!;
  if (!await resolvePwaProvisioningRecovery({ ...input, successor: result, successors: [result] })) fail("automatic successor final reconstruction changed");
  return result;
}

export type ResolveHistoricalPwaVaultInput = Readonly<{
  reviewDirectory: string;
  journal: LiveJournal;
  providers: readonly [HistoricalPwaReadClient, HistoricalPwaReadClient];
  relay: PwaProvisioningRecoveryRelay;
  successors: readonly PwaProvisioningSuccessor[];
}>;
type HistoricalAnchor = Readonly<{ originalPackageHash: Hex; completedPackageHash: Hex; profileVersion: PwaHistoricalVault["profileVersion"] }>;

function historicalReview(document: ReviewDocument): HistoricalReview {
  const transactions = document.review.transactions.map((raw, index) => {
    if (raw.id !== EXPECTED_IDS[index] || raw.operation !== 0 || typeof raw.to !== "string" || !isAddress(raw.to) || typeof raw.expectedCreatedAddress !== "string" || !isAddress(raw.expectedCreatedAddress) || typeof raw.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw.data) || typeof raw.creationCodeHash !== "string" || !HASH.test(raw.creationCodeHash) || typeof raw.expectedRuntimeCodeHash !== "string" || !HASH.test(raw.expectedRuntimeCodeHash)) fail("historical transaction identity is malformed");
    if (keccak256(raw.data as Hex).toLowerCase() !== raw.creationCodeHash.toLowerCase()) fail("historical creation code hash changed");
    return Object.freeze({ ...raw, nonce: decimal(raw.nonce, "historical nonce"), value: decimal(raw.value, "historical value") }) as unknown as PwaProvisioningTransaction;
  });
  const review = { ...document.review, transactions } as unknown as HistoricalReview;
  for (const [key, index] of [["primaryPasskey", 0], ["secondaryPasskey", 1], ["guard", 3], ["delay", 4], ["safe", 6]] as const) {
    if (!isAddressEqual(review.addresses[key], transactions[index]!.expectedCreatedAddress)) fail("historical reviewed addresses changed");
  }
  return review;
}

async function resolveHistoricalVault(input: ResolveHistoricalPwaVaultInput, anchor: HistoricalAnchor, registry?: DeploymentInfrastructureRegistry): Promise<PwaHistoricalVault | undefined> {
  const prefix = assertJournalPrefix(input.journal, input.successors);
  if (prefix.length === 0) return undefined;
  const documents = readReviewDocuments(input.reviewDirectory);
  const originalDocument = documents.find(document => document.packageHash === anchor.originalPackageHash);
  const completedDocument = documents.find(document => document.packageHash === anchor.completedPackageHash);
  if (!originalDocument && !completedDocument) return undefined;
  if (prefix.length !== EXPECTED_IDS.length || !originalDocument || !completedDocument) fail("historical compatibility requires both pinned packages and all seven successful rows");
  if (!input.providers[0].source || !input.providers[1].source || input.providers[0].source === input.providers[1].source) fail("historical compatibility requires two distinct evidence providers");
  const original = historicalReview(originalDocument);
  const completed = historicalReview(completedDocument);
  if (!isAddressEqual(original.deployer, input.journal.funder) || !isAddressEqual(completed.deployer, input.journal.funder)) fail("historical deployer identity changed");
  const successors = input.successors.filter(successor => successor.originalPackageHash === anchor.originalPackageHash);
  if (successors.length !== 1) fail("historical successor lineage is missing or ambiguous");
  const successor = successors[0]!;
  if (canonical(original.transactions.slice(0, successor.confirmedPrefixLength)) !== canonical(completed.transactions.slice(0, successor.confirmedPrefixLength))) fail("historical successor changed its confirmed prefix");
  if (completed.transactions.some((transaction, index) => transaction.nonce !== (index < successor.confirmedPrefixLength ? original.transactions[index]!.nonce : successor.expectedNextNonce + BigInt(index - successor.confirmedPrefixLength)))) fail("historical successor nonce sequence changed");
  const lastNonce = completed.transactions.at(-1)!.nonce;
  await completedDeployerNonce(input, lastNonce + 1n);
  await verifyConsumedLineage(input.providers, original, successor, successor.confirmedPrefixLength);
  const permittedCode = new Map(completed.transactions.slice(successor.confirmedPrefixLength).map(transaction => [transaction.expectedCreatedAddress.toLowerCase(), transaction.expectedRuntimeCodeHash]));
  await Promise.all(input.providers.map(async provider => {
    await verifyProviderPrefix(provider, original, input.journal, successor.confirmedPrefixLength, permittedCode);
    await verifyProviderPrefix(provider, completed, input.journal, EXPECTED_IDS.length);
  }));
  const confirmedCost = input.journal.entries.reduce((sum, entry) => sum + entry.reserved, 0n);
  if (confirmedCost > 50_000_000_000_000_000n) fail("historical provisioning exceeds the phase outlay ceiling");
  const heads = await Promise.all(input.providers.map(provider => provider.getBlockNumber()));
  const blockNumber = heads[0] < heads[1] ? heads[0] : heads[1];
  const blocks = await Promise.all(input.providers.map(provider => provider.getBlock({ blockNumber })));
  if (blocks.some(block => block.number !== blockNumber || !block.hash || block.hash.toLowerCase() !== blocks[0]!.hash?.toLowerCase())) fail("historical topology snapshot block disagrees");
  const credentials = decodeCredentials(completedDocument);
  const states = await Promise.all(input.providers.map(client => verifyHistoricalPwaTopology({ review: completed, client, blockNumber, credentials, registry })));
  if (canonical(states[0]) !== canonical(states[1])) fail("historical topology providers disagree on spending state");
  const rechecked = await Promise.all(input.providers.map(provider => provider.getBlock({ blockNumber })));
  if (rechecked.some(block => block.number !== blockNumber || block.hash?.toLowerCase() !== blocks[0]!.hash?.toLowerCase())) fail("historical topology snapshot block changed");
  const blockHash = blocks[0]!.hash!;
  const policy = Object.freeze({ recipientMode: "all-lanes-allowlisted" as const, assets: Object.freeze(completed.policy.assets.map(asset => Object.freeze({ ...asset, recipients: Object.freeze([...asset.recipients]) }))) });
  const topologyReportHash = keccak256(stringToHex(canonical({ profileVersion: anchor.profileVersion, packageHash: completedDocument.packageHash, blockNumber, blockHash, policy, states: states[0] })));
  return Object.freeze({
    mode: "read-only" as const, profileVersion: anchor.profileVersion, chainId: SEPOLIA_CHAIN_ID, ...completed.addresses, policy, credentials: Object.freeze({ primary: Object.freeze({ ...credentials.primary }), secondary: Object.freeze({ ...credentials.secondary }) }),
    evidence: Object.freeze({ originalPackageHash: originalDocument.packageHash, packageHash: completedDocument.packageHash, planHash: completed.planHash, policyHash: completed.policy.policyHash, setupTransactionHash: input.journal.entries.at(-1)!.transactionHash, topologyReportHash, blockNumber: String(blockNumber), blockHash }),
  });
}

/** Only the committed historical package pair may select this non-authorizing path. */
export async function resolveCompletedHistoricalPwaVault(input: ResolveHistoricalPwaVaultInput): Promise<PwaHistoricalVault | undefined> {
  return resolveHistoricalVault(input, CommittedHistoricalVault as HistoricalAnchor);
}

/** Explicit test fixture registry; never selected by backend/environment/browser input. */
export async function resolveCompletedHistoricalPwaVaultForTestsOnly(input: ResolveHistoricalPwaVaultInput, options: Readonly<{ anchor: HistoricalAnchor; registry: DeploymentInfrastructureRegistry }>): Promise<PwaHistoricalVault | undefined> {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") fail("test-only historical registry is disabled");
  return resolveHistoricalVault(input, options.anchor, options.registry);
}
