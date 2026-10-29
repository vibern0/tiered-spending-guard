import { createHash } from "node:crypto";
import type { Address, Hex } from "viem";
import { publicAlertPayloadHash, hydrateActivityAlert } from "../../src/monitoring/notifier";
import { sha256 } from "../plan-deployment";
import { assertHashlessSourceJournalReadOnlySnapshot } from "./ordinary-scenario-hashless-certificate";
import {
  assertExpiredHashlessContinuationAuthorization,
  assertExpiredHashlessContinuationLineage,
  type ExpiredHashlessContinuationApproval,
  type ExpiredHashlessContinuationProposal,
} from "./ordinary-scenario-hashless-continuation";
import type { OrdinaryScenarioJournal, OrdinaryScenarioProposal } from "./ordinary-scenario-executor";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const CHAIN_ID = 11_155_111;
const OLD_PERIOD = 1_793_145_600n;
const PERIOD_SECONDS = 86_400n;
const SOURCE_HASH = "0x3c2177fe2d88581d430c80db7e9d605275b816c4a39a12b454be18540ddb85eb" as Hex;
const ORIGINAL_PROPOSAL_HASH = "0x22770c7944ee289543c10090b3483bdcd87f0d2c193887df4f32916c5782e45f" as Hex;
const ORIGINAL_PREFIX_HASH = "0x299d8cf298cf0a905046e4fbe569c44c2329b54207e159db551d41fee1dbb83d" as Hex;
const RECOVERY_PROPOSAL_HASH = "0x3a92e6d8a383f015f16c1e35746ad84ea31915208c1cc36e9e724a02fcd9f857" as Hex;
const RECOVERY_CERTIFICATE_HASH = "0x43742e96deb6855d1b2e86b268080892c700f453ffd36da4284de3ec2d252efc" as Hex;
const RECOVERY_APPROVAL_HASH = "0x644bf0b6e9cd4710683717511db665684ff31a86107198282d2364c9816dee26" as Hex;
const PRIMARY_MANIFEST_HASH = "0x96059e1e945b9201e84457f74b98d147c4a6b2d9bc93a2ce8978d4a2425295c6" as Hex;
const POLICY_HASH = "0x5b19fb0f9dcc35db4d45ec227f01348985431d74a2092d887bc7b4f26ade4a82" as Hex;
const EXPECTED_RECEIPTS = Object.freeze([
  { id: "native-queue-ready-hashless-skip", hash: "0x0b80a651b416e815930f1664558c29bee5525f496b1410291d40295f85eb11f7" as Hex, block: 12_015_599n, blockHash: "0xa55ddf8f2857776bcc156fbfe25eb9b6d583cfade4f30f1bebb52552fdd3f2bd" as Hex, gasUsed: 40_110n, effectiveGasPrice: 17n },
  { id: "native-queue-ready-replacement", hash: "0x5dc85b25ee465159478ddb989dfb7818b9423a7f146510494f8108c3edb0aa3e" as Hex, block: 12_015_643n, blockHash: "0x932ea24867fb1064d8543d6ff5b3cfd0a9a576380126e1c55a5f70f6a3f1c3d8" as Hex, gasUsed: 1_434_077n, effectiveGasPrice: 17n },
  { id: "native-queue-ready-replacement-execute", hash: "0xd99c42d02e46371d4e94cb4ebdb85fd0a5d7127e0fe0399346590e9a9fac10fe" as Hex, block: 12_015_659n, blockHash: "0xacfb1490e125160df2c04ef33404175c690497a58bfc20d92967bf6ba9c59f9e" as Hex, gasUsed: 94_033n, effectiveGasPrice: 17n },
] as const);
const PRIMARY_FILES = Object.freeze({
  "ledger-source-native-item2.json": { key: "ledgerSourceNativeItem2", sha256: "0xbee106f2486ff37a01580b9304118a70eb5a1e95a9c02725ef1e842fdc85c994", bytes: 2128 },
  "ledger-replacement-native-item3.json": { key: "ledgerReplacementNativeItem3", sha256: "0xc8c6631558b3935c262314e0d23cc1bed6d04df3fd94ba2ef2c37289c041372f", bytes: 2129 },
  "ack-native-queue-ready-hashless-skip.json": { key: "ackNativeQueueReadyHashlessSkip", sha256: "0x988c112343be5a5433edf10190be4d3737b2bf02885e62b456d9c8e83b3616f7", bytes: 538 },
  "ack-native-queue-ready-replacement.json": { key: "ackNativeQueueReadyReplacement", sha256: "0x3ababf5cf452cffeda36a02d41065efc48aa187839638e33ed766f462b1df733", bytes: 538 },
  "ack-native-queue-ready-replacement-execute.json": { key: "ackNativeQueueReadyReplacementExecute", sha256: "0x6f25d47b4b240f0f2661510a3fc9b34d6a411d4964db425d08dc8f788838d6a4", bytes: 538 },
} as const);

export type UsdcSuccessorSource = Readonly<{
  original: OrdinaryScenarioProposal;
  recovery: ExpiredHashlessContinuationProposal;
  recoveryApproval: ExpiredHashlessContinuationApproval;
  journal: OrdinaryScenarioJournal;
}>;

export type UsdcSuccessorPrimaryEvidence = Readonly<{
  manifest: string;
  ledgerSourceNativeItem2: string;
  ledgerReplacementNativeItem3: string;
  ackNativeQueueReadyHashlessSkip: string;
  ackNativeQueueReadyReplacement: string;
  ackNativeQueueReadyReplacementExecute: string;
}>;

export type UsdcSuccessorCanonicalBlock = Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>;
type UsdcSuccessorTransactionBase = Readonly<{ hash: Hex; from: Address; nonce: number; to: Address | null; value: bigint; inputHash: Hex; gas: bigint; blockNumber: bigint; blockHash: Hex }>;
export type UsdcSuccessorCanonicalTransaction = UsdcSuccessorTransactionBase & (
  | Readonly<{ type: "legacy"; chainId: number; gasPrice: bigint; v: bigint }>
  | Readonly<{ type: "eip1559"; chainId: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
);
export type UsdcSuccessorCanonicalReceipt = Readonly<{ transactionHash: Hex; status: "success" | "reverted"; blockNumber: bigint; blockHash: Hex; gasUsed: bigint; effectiveGasPrice: bigint }>;
export type UsdcSuccessorRawSpend = Readonly<{ window: bigint; baseSpent: bigint; instantSpent: bigint }>;
export type UsdcSuccessorCanonicalQueue = Readonly<{ queueNonce: bigint; fingerprint: Hex; createdAt: bigint; to: Address; value: bigint; data: Hex; operation: number }>;
export type UsdcSuccessorCanonicalState = Readonly<{
  blockNumber: bigint;
  blockHash: Hex;
  chainId: number;
  identityHash: Hex;
  topologyHash: Hex;
  policyHash: Hex;
  safe: Address;
  guard: Address;
  delay: Address;
  funder: Address;
  usdc: Address;
  recipient: Address;
  primarySigner: Address;
  safeContractSecondary: Address;
  ecdsaSecondary: Address;
  safeNonce: bigint;
  delayQueueNonce: bigint;
  delayTxNonce: bigint;
  queue: UsdcSuccessorCanonicalQueue | null;
  safeNativeBalance: bigint;
  safeUsdcBalance: bigint;
  funderUsdcBalance: bigint;
  nativeSpend: UsdcSuccessorRawSpend;
  usdcSpend: UsdcSuccessorRawSpend;
}>;

export type UsdcSuccessorEvidenceProvider = Readonly<{
  readLatestBlock(): Promise<UsdcSuccessorCanonicalBlock>;
  readBlock(number: bigint): Promise<UsdcSuccessorCanonicalBlock | undefined>;
  readTransaction(hash: Hex): Promise<UsdcSuccessorCanonicalTransaction | undefined>;
  readReceipt(hash: Hex): Promise<UsdcSuccessorCanonicalReceipt | undefined>;
  readTransactionCount(address: Address, block: bigint | "latest" | "pending"): Promise<number>;
  readControlledState(blockNumber: bigint): Promise<UsdcSuccessorCanonicalState>;
}>;

type ReceiptEvidence = Readonly<{ id: string; transactionHash: Hex; blockNumber: bigint; blockHash: Hex; gasUsed: bigint; effectiveGasPrice: bigint; gasCost: bigint; postStateHash: Hex }>;
declare const certificateBrand: unique symbol;
export type VerifiedUsdcSuccessorCertificate = Readonly<{
  kind: "VERIFIED_USDC_SUCCESSOR_CERTIFICATE";
  sourceHash: Hex;
  primaryEvidenceHash: Hex;
  snapshot: Readonly<{ block: UsdcSuccessorCanonicalBlock; controlledStateHash: Hex; funderNonce: number; latestNonce: number; pendingNonce: number }>;
  effectivePeriod: bigint;
  rawNativeSpend: UsdcSuccessorRawSpend;
  rawUsdcSpend: UsdcSuccessorRawSpend;
  recoveryReceipts: readonly ReceiptEvidence[];
  recoveryGasCostWei: bigint;
  certificateHash: Hex;
  readonly [certificateBrand]: true;
}>;

const verifiedCertificates = new WeakSet<object>();
const rawSha256 = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const publicHash = (value: unknown): Hex => sha256(publicValue(value)) as Hex;
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const record = (value: unknown, label: string): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; };
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => { const actual = Object.keys(value).sort(), expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} shape mismatch`); };
const decimal = (value: unknown, label: string): bigint => { if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`); return BigInt(value); };
const integer = (value: unknown, label: string): number => { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`); return value; };
const hash = (value: unknown, label: string): Hex => { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a hash`); return value as Hex; };
const parseJson = (serialized: string, label: string): Record<string, unknown> => { let value: unknown; try { value = JSON.parse(serialized); } catch { throw new Error(`${label} must be JSON`); } return record(value, label); };

function fixedSourceValue(journal: OrdinaryScenarioJournal): unknown {
  return {
    schemaVersion: journal.schemaVersion, chainId: journal.chainId, reviewPackageHash: journal.reviewPackageHash,
    proposalHash: journal.proposalHash, approvalHash: journal.approvalHash, funder: journal.funder,
    actions: journal.actions.slice(0, 19),
    liveJournal: { chainId: journal.liveJournal.chainId, funder: journal.liveJournal.funder, entries: journal.liveJournal.entries.slice(0, 13) },
    hashlessContinuation: journal.hashlessContinuation,
  };
}

export function hashUsdcSuccessorSource(journal: OrdinaryScenarioJournal): Hex {
  return publicHash(fixedSourceValue(journal));
}

function assertSource(source: UsdcSuccessorSource, mode: "clean" | "pinned"): void {
  assertHashlessSourceJournalReadOnlySnapshot(source.journal);
  assertExpiredHashlessContinuationLineage(source.original, source.recovery);
  assertExpiredHashlessContinuationAuthorization(source.recovery, source.recoveryApproval);
  if (!same(source.original.proposalHash, ORIGINAL_PROPOSAL_HASH) || !same(source.recovery.historicalPrefixHash, ORIGINAL_PREFIX_HASH) || !same(source.recovery.proposalHash, RECOVERY_PROPOSAL_HASH) || !same(source.recovery.certificateHash, RECOVERY_CERTIFICATE_HASH) || !same(source.recoveryApproval.approvalHash, RECOVERY_APPROVAL_HASH)) throw new Error("USDC successor source approved header mismatch");
  const journal = source.journal;
  if (journal.actions.length !== 19 || journal.liveJournal.entries.length < 13 || !journal.hashlessContinuation) throw new Error("USDC successor source must contain the complete fixed 19/10+3 lineage");
  if (mode === "clean" && (journal.liveJournal.entries.length !== 13 || "repairContinuation" in journal)) throw new Error("USDC successor initial source must be the exact clean 19/10+3 checkpoint with no later progress");
  if (!same(hashUsdcSuccessorSource(journal), SOURCE_HASH)) throw new Error("USDC successor fixed source hash mismatch");
  const continuation = journal.hashlessContinuation;
  if (!same(continuation.proposalHash, RECOVERY_PROPOSAL_HASH) || !same(continuation.certificateHash, RECOVERY_CERTIFICATE_HASH) || !same(continuation.approvalHash, RECOVERY_APPROVAL_HASH) || continuation.actions.length !== 22 || continuation.actionCommitments.length !== 22) throw new Error("USDC successor recovery attachment header mismatch");
  for (let index = 0; index < continuation.actions.length; index++) {
    const actual = continuation.actions[index]!, expected = source.recovery.actions[index]!;
    if (actual.id !== expected.id || !same(actual.commitment, expected.commitment)) throw new Error("USDC successor recovery action order or commitment mismatch");
    if (index < 3) {
      if (actual.status !== "confirmed" || !actual.transactionHash || !actual.receipt || !actual.evidenceHash) throw new Error("USDC successor native recovery action is not fully confirmed");
    } else if (actual.status !== "approved" || Object.keys(actual).sort().join(",") !== "commitment,id,status") throw new Error("USDC successor USDC tail is not untouched and approved");
  }
  const fixedLive = journal.liveJournal.entries.slice(0, 13);
  if (fixedLive.some(entry => entry.status !== "success") || fixedLive.slice(10).some((entry, index) => entry.id !== EXPECTED_RECEIPTS[index]!.id || !same(entry.transactionHash, EXPECTED_RECEIPTS[index]!.hash))) throw new Error("USDC successor source live prefix is not the exact 13 successful entries");
}

function validatePrimary(primary: UsdcSuccessorPrimaryEvidence, source: UsdcSuccessorSource): Hex {
  if (!same(rawSha256(primary.manifest), PRIMARY_MANIFEST_HASH)) throw new Error("USDC successor primary manifest hash mismatch");
  const manifest = parseJson(primary.manifest, "USDC successor primary manifest");
  exactKeys(manifest, ["schemaVersion", "scope", "source", "limitations", "files"], "USDC successor primary manifest");
  if (manifest.schemaVersion !== 1 || manifest.scope !== "FROZEN_PRIMARY_NATIVE_OBSERVER_EVIDENCE") throw new Error("USDC successor primary manifest identity mismatch");
  const files = record(manifest.files, "USDC successor primary files"); exactKeys(files, Object.keys(PRIMARY_FILES), "USDC successor primary files");
  for (const [name, expected] of Object.entries(PRIMARY_FILES)) {
    const meta = record(files[name], `primary ${name}`); exactKeys(meta, ["sha256", "bytes"], `primary ${name}`);
    const raw = primary[expected.key];
    if (meta.sha256 !== expected.sha256 || meta.bytes !== expected.bytes || Buffer.byteLength(raw, "utf8") !== expected.bytes || !same(rawSha256(raw), expected.sha256 as Hex)) throw new Error(`USDC successor primary ${name} bytes or hash mismatch`);
  }
  const observer = source.recovery.observer;
  const ledgers = [parseJson(primary.ledgerSourceNativeItem2, "primary source ledger"), parseJson(primary.ledgerReplacementNativeItem3, "primary replacement ledger")];
  for (const ledger of ledgers) {
    exactKeys(ledger, ["cursor", "records", "outbox", "deliveries"], "primary watcher ledger");
    if (Object.keys(record(ledger.outbox, "primary watcher outbox")).length !== 0) throw new Error("primary watcher outbox is not empty");
  }
  const acknowledgements = [primary.ackNativeQueueReadyHashlessSkip, primary.ackNativeQueueReadyReplacement, primary.ackNativeQueueReadyReplacementExecute].map((raw, index) => parseJson(raw, `primary acknowledgement ${index}`));
  for (let index = 0; index < EXPECTED_RECEIPTS.length; index++) {
    const expected = EXPECTED_RECEIPTS[index]!;
    const matches: Array<{ record: Record<string, unknown>; delivery: Record<string, unknown> }> = [];
    for (const ledger of ledgers) {
      const records = record(ledger.records, "primary watcher records"), deliveries = record(ledger.deliveries, "primary watcher deliveries");
      for (const [key, rawRecord] of Object.entries(records)) {
        const alert = hydrateActivityAlert(rawRecord);
        if (same(alert.transactionHash, expected.hash)) matches.push({ record: rawRecord as Record<string, unknown>, delivery: record(deliveries[key], "primary watcher delivery") });
      }
    }
    if (matches.length !== 1) throw new Error(`primary watcher target ${expected.id} must have one unique alert`);
    const { record: rawAlert, delivery } = matches[0]!; const alert = hydrateActivityAlert(rawAlert);
    if (alert.blockNumber !== expected.block || alert.chainId !== CHAIN_ID || !same(alert.safe, source.original.safe)) throw new Error(`primary watcher target ${expected.id} receipt binding mismatch`);
    exactKeys(delivery, ["channel", "httpStatus", "payloadHash", "deliveredAt"], "primary watcher delivery");
    const payloadHash = publicAlertPayloadHash(alert);
    if (delivery.channel !== "webhook" || delivery.httpStatus !== 200 || !same(hash(delivery.payloadHash, "primary delivery payload hash"), payloadHash)) throw new Error("primary watcher exact payload delivery mismatch");
    const ack = acknowledgements[index]!; exactKeys(ack, ["schemaVersion", "endpointHash", "transactionHash", "payloadSha256", "receiverRequestId", "receiverRecordedAt", "retrievedAt", "retrievalProvenance", "expiresAt"], "primary acknowledgement");
    if (ack.schemaVersion !== 1 || ack.retrievalProvenance !== "official-receiver-api" || !same(hash(ack.endpointHash, "ack endpoint"), observer.endpointHash) || !same(hash(ack.transactionHash, "ack transaction"), expected.hash) || !same(hash(ack.payloadSha256, "ack payload"), payloadHash)) throw new Error("primary acknowledgement exact binding mismatch");
    const delivered = Date.parse(String(delivery.deliveredAt)), recorded = Date.parse(String(ack.receiverRecordedAt)), retrieved = Date.parse(String(ack.retrievedAt)), expires = Date.parse(String(ack.expiresAt));
    const readyMs = Number(BigInt(observer.readyAt) * 1000n), observerExpiresMs = Number(BigInt(observer.expiresAt) * 1000n);
    if (![delivered, recorded, retrieved, expires].every(Number.isFinite) || delivered < readyMs || recorded < readyMs || delivered > observerExpiresMs || recorded > observerExpiresMs || retrieved < recorded || expires !== observerExpiresMs) throw new Error("primary acknowledgement or delivery window mismatch");
  }
  return publicHash(Object.fromEntries(Object.entries(PRIMARY_FILES).map(([name, expected]) => [name, expected.sha256]).concat([["manifest.json", PRIMARY_MANIFEST_HASH]])));
}

function assertBlock(actual: UsdcSuccessorCanonicalBlock, expected: UsdcSuccessorCanonicalBlock, label: string): void {
  if (actual.number !== expected.number || !same(actual.hash, expected.hash) || actual.timestamp !== expected.timestamp) throw new Error(`${label} canonical block mismatch`);
}

function expectedState(source: UsdcSuccessorSource, block: UsdcSuccessorCanonicalBlock): UsdcSuccessorCanonicalState {
  return {
    blockNumber: block.number, blockHash: block.hash, chainId: CHAIN_ID,
    identityHash: source.original.publicIdentitiesHash, topologyHash: source.original.topologyEvidenceHash, policyHash: POLICY_HASH,
    safe: source.original.safe, guard: source.original.guard, delay: source.original.delay, funder: source.original.funder, usdc: source.original.usdc, recipient: source.original.recipient,
    primarySigner: source.original.primarySigner, safeContractSecondary: source.original.safeContractSecondary, ecdsaSecondary: source.original.ecdsaSecondary,
    safeNonce: 8n, delayQueueNonce: 4n, delayTxNonce: 4n, queue: null,
    safeNativeBalance: 0n, safeUsdcBalance: 20_000_000n, funderUsdcBalance: 0n,
    nativeSpend: { window: OLD_PERIOD, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n },
    usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n },
  };
}

function expectedRecoveryPostState(source: UsdcSuccessorSource, block: UsdcSuccessorCanonicalBlock, index: number): UsdcSuccessorCanonicalState {
  const base = expectedState(source, block);
  if (index === 0) return { ...base, safeNonce: 7n, delayQueueNonce: 3n, delayTxNonce: 3n, safeNativeBalance: 1n };
  if (index === 1) {
    const action = source.recovery.actions[1]!;
    const queue = action.queue;
    const record = source.journal.hashlessContinuation!.actions[1] as Record<string, unknown>;
    if (!queue || typeof record.queueCreatedAt !== "string") throw new Error("USDC successor replacement queue evidence is missing");
    const createdAt = BigInt(record.queueCreatedAt);
    if (createdAt !== block.timestamp) throw new Error("USDC successor replacement queue creation time does not match its canonical block");
    return { ...base, safeNonce: 8n, delayQueueNonce: 4n, delayTxNonce: 3n, queue: { queueNonce: BigInt(queue.queueNonce), fingerprint: queue.fingerprint, createdAt, to: queue.to, value: BigInt(queue.value), data: queue.data, operation: queue.operation }, safeNativeBalance: 1n };
  }
  return base;
}

type ProviderView = Readonly<{ snapshot: UsdcSuccessorCanonicalBlock; state: UsdcSuccessorCanonicalState; snapshotNonce: number; latestNonce: number; pendingNonce: number; transactions: readonly UsdcSuccessorCanonicalTransaction[]; receipts: readonly UsdcSuccessorCanonicalReceipt[]; receiptBlocks: readonly UsdcSuccessorCanonicalBlock[]; receiptPostStates: readonly UsdcSuccessorCanonicalState[]; rechecks: readonly (UsdcSuccessorCanonicalBlock | undefined)[] }>;
async function readView(provider: UsdcSuccessorEvidenceProvider, snapshotNumber: bigint, pinnedCurrentNonces?: Readonly<{ latestNonce: number; pendingNonce: number }>): Promise<ProviderView> {
  const snapshot = await provider.readBlock(snapshotNumber); if (!snapshot) throw new Error("USDC successor snapshot block is missing");
  const state = await provider.readControlledState(snapshotNumber);
  const snapshotNonce = await provider.readTransactionCount(state.funder, snapshotNumber);
  const [latestNonce, pendingNonce] = pinnedCurrentNonces ? [pinnedCurrentNonces.latestNonce, pinnedCurrentNonces.pendingNonce] : await Promise.all([provider.readTransactionCount(state.funder, "latest"), provider.readTransactionCount(state.funder, "pending")]);
  const transactions: UsdcSuccessorCanonicalTransaction[] = [], receipts: UsdcSuccessorCanonicalReceipt[] = [], receiptBlocks: UsdcSuccessorCanonicalBlock[] = [], receiptPostStates: UsdcSuccessorCanonicalState[] = [];
  for (const expected of EXPECTED_RECEIPTS) {
    const [transaction, receipt] = await Promise.all([provider.readTransaction(expected.hash), provider.readReceipt(expected.hash)]);
    if (!transaction || !receipt) throw new Error("USDC successor canonical transaction or receipt is missing");
    const block = await provider.readBlock(receipt.blockNumber); if (!block) throw new Error("USDC successor receipt block is missing");
    const postState = await provider.readControlledState(receipt.blockNumber);
    transactions.push(transaction); receipts.push(receipt); receiptBlocks.push(block); receiptPostStates.push(postState);
  }
  const rechecks = await Promise.all([provider.readBlock(snapshotNumber), ...receiptBlocks.map(block => provider.readBlock(block.number))]);
  return { snapshot, state, snapshotNonce, latestNonce, pendingNonce, transactions, receipts, receiptBlocks, receiptPostStates, rechecks };
}

function assertView(view: ProviderView, source: UsdcSuccessorSource): readonly ReceiptEvidence[] {
  if (publicHash(view.state) !== publicHash(expectedState(source, view.snapshot))) throw new Error("USDC successor canonical controlled state, topology, policy, balance, nonce, or raw tuple mismatch");
  if (view.latestNonce < view.snapshotNonce || view.pendingNonce !== view.latestNonce) throw new Error("USDC successor funder nonce has unresolved pending activity");
  const records = source.journal.hashlessContinuation!.actions.slice(0, 3) as Array<Record<string, unknown>>;
  return EXPECTED_RECEIPTS.map((expected, index) => {
    const transaction = view.transactions[index]!, receipt = view.receipts[index]!, block = view.receiptBlocks[index]!, postState = view.receiptPostStates[index]!, sourceRecord = records[index]!;
    assertBlock(block, { number: expected.block, hash: expected.blockHash, timestamp: block.timestamp }, `${expected.id} receipt`);
    if (view.snapshot.number - block.number + 1n < 6n) throw new Error(`${expected.id} receipt has fewer than six confirmations`);
    if (!same(transaction.hash, expected.hash) || !same(transaction.from, source.original.funder) || transaction.nonce !== sourceRecord.outerNonce || transaction.to === null || !same(transaction.to, String(sourceRecord.outerTo)) || transaction.value !== BigInt(String(sourceRecord.outerValue)) || !same(transaction.inputHash, String(sourceRecord.outerDataHash)) || transaction.gas !== BigInt(String(sourceRecord.gas)) || transaction.chainId !== CHAIN_ID || transaction.type !== "eip1559" || transaction.maxFeePerGas !== BigInt(String(sourceRecord.maxFeePerGas)) || transaction.maxPriorityFeePerGas !== BigInt(String(sourceRecord.maxPriorityFeePerGas)) || transaction.blockNumber !== expected.block || !same(transaction.blockHash, expected.blockHash)) throw new Error(`${expected.id} canonical type-2 transaction envelope or fee mismatch`);
    if (!same(receipt.transactionHash, expected.hash) || receipt.status !== "success" || receipt.blockNumber !== expected.block || !same(receipt.blockHash, expected.blockHash) || receipt.gasUsed !== expected.gasUsed || receipt.effectiveGasPrice !== expected.effectiveGasPrice || receipt.gasUsed * receipt.effectiveGasPrice !== BigInt(String(sourceRecord.ourReceiptGasCost))) throw new Error(`${expected.id} canonical receipt or gas product mismatch`);
    const expectedPostState = expectedRecoveryPostState(source, block, index);
    if (publicHash(postState) !== publicHash(expectedPostState)) throw new Error(`${expected.id} exact receipt effect poststate mismatch`);
    return Object.freeze({ id: expected.id, transactionHash: expected.hash, blockNumber: expected.block, blockHash: expected.blockHash, gasUsed: expected.gasUsed, effectiveGasPrice: expected.effectiveGasPrice, gasCost: expected.gasUsed * expected.effectiveGasPrice, postStateHash: publicHash(postState) });
  });
}

function assertRechecks(view: ProviderView): void {
  for (let index = 0; index < view.rechecks.length; index++) {
    const before = index === 0 ? view.snapshot : view.receiptBlocks[index - 1]!, after = view.rechecks[index];
    if (!after || publicHash(before) !== publicHash(after)) throw new Error("USDC successor canonical recheck detected a reorg");
  }
}

async function verifyPinned(source: UsdcSuccessorSource, primary: UsdcSuccessorPrimaryEvidence, providers: readonly [UsdcSuccessorEvidenceProvider, UsdcSuccessorEvidenceProvider], block: UsdcSuccessorCanonicalBlock, recorded?: Readonly<{ stateHash: Hex; funderNonce: number; latestNonce: number; pendingNonce: number; receipts: readonly ReceiptEvidence[] }>): Promise<Readonly<{ primaryEvidenceHash: Hex; views: readonly [ProviderView, ProviderView]; receipts: readonly ReceiptEvidence[] }>> {
  const sourceMode = recorded ? "pinned" : "clean";
  assertSource(source, sourceMode); const primaryEvidenceHash = validatePrimary(primary, source);
  if (providers.length !== 2 || providers[0] === providers[1]) throw new Error("USDC successor certificate requires two independent providers");
  const pinnedCurrentNonces = recorded ? { latestNonce: recorded.latestNonce, pendingNonce: recorded.pendingNonce } : undefined;
  const views = await Promise.all([readView(providers[0], block.number, pinnedCurrentNonces), readView(providers[1], block.number, pinnedCurrentNonces)] as const);
  assertBlock(views[0].snapshot, block, "USDC successor snapshot"); assertBlock(views[1].snapshot, block, "USDC successor snapshot");
  const receipts = assertView(views[0], source); const secondReceipts = assertView(views[1], source);
  assertRechecks(views[0]); assertRechecks(views[1]);
  if (publicHash({ snapshot: views[0].snapshot, state: views[0].state, snapshotNonce: views[0].snapshotNonce, latestNonce: views[0].latestNonce, pendingNonce: views[0].pendingNonce, transactions: views[0].transactions, receipts: views[0].receipts, receiptBlocks: views[0].receiptBlocks, receiptPostStates: views[0].receiptPostStates }) !== publicHash({ snapshot: views[1].snapshot, state: views[1].state, snapshotNonce: views[1].snapshotNonce, latestNonce: views[1].latestNonce, pendingNonce: views[1].pendingNonce, transactions: views[1].transactions, receipts: views[1].receipts, receiptBlocks: views[1].receiptBlocks, receiptPostStates: views[1].receiptPostStates }) || publicHash(receipts) !== publicHash(secondReceipts)) throw new Error("USDC successor providers disagree on canonical evidence");
  if (recorded && (!same(publicHash(views[0].state), recorded.stateHash) || views[0].snapshotNonce !== recorded.funderNonce || views[0].latestNonce !== recorded.latestNonce || views[0].pendingNonce !== recorded.pendingNonce || publicHash(receipts) !== publicHash(recorded.receipts))) throw new Error("USDC successor recorded pinned history mismatch");
  assertSource(source, sourceMode); return { primaryEvidenceHash, views, receipts };
}

function effectivePeriodAt(source: UsdcSuccessorSource, timestamp: bigint): bigint {
  const anchor = BigInt(source.original.periodAnchor);
  return anchor + ((timestamp - anchor) / PERIOD_SECONDS) * PERIOD_SECONDS;
}

export async function verifyUsdcSuccessorCertificate(source: UsdcSuccessorSource, primary: UsdcSuccessorPrimaryEvidence, providers: readonly [UsdcSuccessorEvidenceProvider, UsdcSuccessorEvidenceProvider]): Promise<VerifiedUsdcSuccessorCertificate> {
  assertSource(source, "clean"); validatePrimary(primary, source);
  if (providers.length !== 2 || providers[0] === providers[1]) throw new Error("USDC successor certificate requires two independent providers");
  const tips = await Promise.all([providers[0].readLatestBlock(), providers[1].readLatestBlock()] as const);
  const minimumTip = tips[0].number <= tips[1].number ? tips[0] : tips[1]; if (minimumTip.number < 5n) throw new Error("USDC successor provider tip is too low");
  const snapshotNumber = minimumTip.number - 5n;
  const initialBlocks = await Promise.all([providers[0].readBlock(snapshotNumber), providers[1].readBlock(snapshotNumber)] as const);
  if (!initialBlocks[0] || !initialBlocks[1]) throw new Error("USDC successor snapshot block is missing");
  if (tips.some(tip => tip.number - snapshotNumber + 1n < 6n) || publicHash(initialBlocks[0]) !== publicHash(initialBlocks[1])) throw new Error("USDC successor providers disagree on a six-confirmation snapshot");
  const effectivePeriod = effectivePeriodAt(source, initialBlocks[0].timestamp);
  if (effectivePeriod <= OLD_PERIOD) throw new Error("USDC successor snapshot belongs to the old period");
  const pinned = await verifyPinned(source, primary, providers, initialBlocks[0]);
  const state = pinned.views[0].state, recoveryGasCostWei = pinned.receipts.reduce((sum, receipt) => sum + receipt.gasCost, 0n);
  if (recoveryGasCostWei !== 26_659_740n) throw new Error("USDC successor recovery gas total mismatch");
  const snapshot = Object.freeze({ block: Object.freeze({ ...initialBlocks[0] }), controlledStateHash: publicHash(state), funderNonce: pinned.views[0].snapshotNonce, latestNonce: pinned.views[0].latestNonce, pendingNonce: pinned.views[0].pendingNonce });
  const body = { kind: "VERIFIED_USDC_SUCCESSOR_CERTIFICATE" as const, sourceHash: SOURCE_HASH, primaryEvidenceHash: pinned.primaryEvidenceHash, snapshot, effectivePeriod, rawNativeSpend: Object.freeze({ ...state.nativeSpend }), rawUsdcSpend: Object.freeze({ ...state.usdcSpend }), recoveryReceipts: Object.freeze([...pinned.receipts]), recoveryGasCostWei };
  const certificate = Object.freeze({ ...body, certificateHash: publicHash(body) }) as VerifiedUsdcSuccessorCertificate;
  assertSource(source, "clean"); verifiedCertificates.add(certificate); return certificate;
}

export function isVerifiedUsdcSuccessorCertificate(value: unknown): value is VerifiedUsdcSuccessorCertificate {
  return !!value && typeof value === "object" && verifiedCertificates.has(value as object);
}

export function serializeUsdcSuccessorCertificate(certificate: VerifiedUsdcSuccessorCertificate): string {
  if (!isVerifiedUsdcSuccessorCertificate(certificate)) throw new Error("USDC successor certificate is not runtime verified");
  return `${JSON.stringify(publicValue(certificate))}\n`;
}

function decodeCertificate(serialized: string, expectedHash: Hex): VerifiedUsdcSuccessorCertificate {
  if (!HASH.test(expectedHash)) throw new Error("USDC successor expected certificate hash is malformed");
  const value = parseJson(serialized, "USDC successor recorded certificate");
  exactKeys(value, ["kind", "sourceHash", "primaryEvidenceHash", "snapshot", "effectivePeriod", "rawNativeSpend", "rawUsdcSpend", "recoveryReceipts", "recoveryGasCostWei", "certificateHash"], "USDC successor recorded certificate");
  const blockValue = record(record(value.snapshot, "recorded snapshot").block, "recorded snapshot block"); exactKeys(record(value.snapshot, "recorded snapshot"), ["block", "controlledStateHash", "funderNonce", "latestNonce", "pendingNonce"], "recorded snapshot"); exactKeys(blockValue, ["number", "hash", "timestamp"], "recorded snapshot block");
  const snapshot = Object.freeze({ block: Object.freeze({ number: decimal(blockValue.number, "recorded block number"), hash: hash(blockValue.hash, "recorded block hash"), timestamp: decimal(blockValue.timestamp, "recorded block timestamp") }), controlledStateHash: hash((value.snapshot as any).controlledStateHash, "recorded state hash"), funderNonce: integer((value.snapshot as any).funderNonce, "recorded funder nonce"), latestNonce: integer((value.snapshot as any).latestNonce, "recorded latest nonce"), pendingNonce: integer((value.snapshot as any).pendingNonce, "recorded pending nonce") });
  const spend = (raw: unknown, label: string): UsdcSuccessorRawSpend => { const item = record(raw, label); exactKeys(item, ["window", "baseSpent", "instantSpent"], label); return Object.freeze({ window: decimal(item.window, `${label} window`), baseSpent: decimal(item.baseSpent, `${label} base`), instantSpent: decimal(item.instantSpent, `${label} instant`) }); };
  if (!Array.isArray(value.recoveryReceipts) || value.recoveryReceipts.length !== 3) throw new Error("recorded recovery receipts shape mismatch");
  const recoveryReceipts = Object.freeze(value.recoveryReceipts.map((raw, index) => { const item = record(raw, `recorded receipt ${index}`); exactKeys(item, ["id", "transactionHash", "blockNumber", "blockHash", "gasUsed", "effectiveGasPrice", "gasCost", "postStateHash"], `recorded receipt ${index}`); return Object.freeze({ id: String(item.id), transactionHash: hash(item.transactionHash, "recorded receipt hash"), blockNumber: decimal(item.blockNumber, "recorded receipt block"), blockHash: hash(item.blockHash, "recorded receipt block hash"), gasUsed: decimal(item.gasUsed, "recorded gas used"), effectiveGasPrice: decimal(item.effectiveGasPrice, "recorded gas price"), gasCost: decimal(item.gasCost, "recorded gas cost"), postStateHash: hash(item.postStateHash, "recorded receipt poststate hash") }); }));
  const body = { kind: "VERIFIED_USDC_SUCCESSOR_CERTIFICATE" as const, sourceHash: hash(value.sourceHash, "recorded source hash"), primaryEvidenceHash: hash(value.primaryEvidenceHash, "recorded primary evidence hash"), snapshot, effectivePeriod: decimal(value.effectivePeriod, "recorded effective period"), rawNativeSpend: spend(value.rawNativeSpend, "recorded native spend"), rawUsdcSpend: spend(value.rawUsdcSpend, "recorded USDC spend"), recoveryReceipts, recoveryGasCostWei: decimal(value.recoveryGasCostWei, "recorded recovery gas total") };
  const certificateHash = hash(value.certificateHash, "recorded certificate hash");
  if (value.kind !== body.kind || !same(body.sourceHash, SOURCE_HASH) || !same(certificateHash, expectedHash) || !same(publicHash(body), certificateHash)) throw new Error("USDC successor recorded certificate fixed shape or hash mismatch");
  return Object.freeze({ ...body, certificateHash }) as VerifiedUsdcSuccessorCertificate;
}

export async function reverifyUsdcSuccessorCertificate(serialized: string, expectedHash: Hex, source: UsdcSuccessorSource, primary: UsdcSuccessorPrimaryEvidence, providers: readonly [UsdcSuccessorEvidenceProvider, UsdcSuccessorEvidenceProvider]): Promise<VerifiedUsdcSuccessorCertificate> {
  const certificate = decodeCertificate(serialized, expectedHash);
  const pinned = await verifyPinned(source, primary, providers, certificate.snapshot.block, { stateHash: certificate.snapshot.controlledStateHash, funderNonce: certificate.snapshot.funderNonce, latestNonce: certificate.snapshot.latestNonce, pendingNonce: certificate.snapshot.pendingNonce, receipts: certificate.recoveryReceipts });
  if (!same(pinned.primaryEvidenceHash, certificate.primaryEvidenceHash) || certificate.effectivePeriod !== effectivePeriodAt(source, certificate.snapshot.block.timestamp) || certificate.effectivePeriod <= OLD_PERIOD || publicHash(certificate.rawNativeSpend) !== publicHash(pinned.views[0].state.nativeSpend) || publicHash(certificate.rawUsdcSpend) !== publicHash(pinned.views[0].state.usdcSpend) || certificate.recoveryGasCostWei !== pinned.receipts.reduce((sum, receipt) => sum + receipt.gasCost, 0n)) throw new Error("USDC successor recorded certificate effective period or pinned evidence mismatch");
  assertSource(source, "pinned"); verifiedCertificates.add(certificate); return certificate;
}
