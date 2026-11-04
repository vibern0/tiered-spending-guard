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

type RecoveryTransaction = Readonly<{
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
  getTransaction(input: Readonly<{ hash: Hex }>): Promise<RecoveryTransaction | null>;
  getTransactionReceipt(input: Readonly<{ hash: Hex }>): Promise<LiveReceipt | null>;
  getTransactionCount(input: Readonly<{ address: Address; blockTag?: "latest" | "pending" }>): Promise<number | bigint>;
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
  plan: PwaProvisioningPlan,
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

function sameTransaction(left: RecoveryTransaction, right: RecoveryTransaction): boolean {
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
  plan: PwaProvisioningPlan,
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

async function rebuildCandidate(
  input: ResolvePwaProvisioningRecoveryInput,
  document: ReviewDocument,
  prefixLength: number,
  successorSuffix: boolean,
  successor: PwaProvisioningSuccessor | undefined,
): Promise<PwaProvisioningRecovery> {
  const credentials = decodeCredentials(document);
  const expectedDeployerNonce = BigInt(input.journal.entries[0]!.nonce);
  if (successorSuffix && !successor) fail("successor journal suffix is not bound to the original review package");
  const signerPrefixLength = successor?.confirmedPrefixLength ?? prefixLength;
  const expectedCurrentDeployerNonce = successor
    ? successor.expectedNextNonce + BigInt(Math.max(0, prefixLength - successor.confirmedPrefixLength))
    : expectedDeployerNonce + BigInt(prefixLength);
  const verifiedDeploymentPrefixLength = successor ? Math.min(prefixLength, 2) : prefixLength;
  const plan = await rebuildPlan(input, credentials, expectedDeployerNonce, signerPrefixLength, successor ? { expectedCurrentDeployerNonce, verifiedDeploymentPrefixLength } : {});
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
  if (BigInt(latest) !== nextNonce || BigInt(pending) !== nextNonce) fail("relay latest/pending nonce does not equal the first missing transaction");
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
