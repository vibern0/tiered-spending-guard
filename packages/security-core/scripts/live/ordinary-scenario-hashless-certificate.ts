import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { queueFingerprint } from "../../src/queue/delay";
import { sha256 } from "../plan-deployment";
import type { Address, Hex } from "viem";
import type { OrdinaryScenarioJournal } from "./ordinary-scenario-executor";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ORIGINAL_JOURNAL_SHA256 = "0x6cd8213656cb5efb2b5bfafbab7192be93462f2d290f81916fb6eb9eaa657c74" as Hex;
const EXPECTED_ARTIFACT_SHA256 = "0xfc9c71e506c6941496501178fc2b826575ede10839fc61fbda838bb747a8f339" as Hex;
const EXPECTED_PREFIX_HASH = "0x299d8cf298cf0a905046e4fbe569c44c2329b54207e159db551d41fee1dbb83d" as Hex;
const CHAIN_ID = 11_155_111;
const FUNDER = "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address;
const SAFE = "0xd751a1479f49d63DC61E0081B0b4d8c60623D9a6" as Address;
const DELAY = "0xB8E143098CcCb9935228022173c2c987DF5FD53a" as Address;
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const CONSUMING_TRANSACTION = "0x83923abf9c1224125296a3485f8cc0a910e7f729ea5d5a73d6f01bf1cdbfe1f5" as Hex;
const MATERIALIZATION_BLOCK = Object.freeze({ number: 12_013_857n, hash: "0x197add23b0385bce509adab0a3f3234b58b71e63d0ebccad9aa2e99ba5f44e20" as Hex, timestamp: 1_793_209_056n });
const CERTIFICATE_BLOCK = Object.freeze({ number: 12_013_934n, hash: "0x05d0f3b8f503bfee60455adc88c717e330aa2bafaffb6badca3b5c8215f3948e" as Hex, timestamp: 1_793_209_980n });
const TRANSACTION_BLOCK = Object.freeze({ number: 12_013_885n, hash: "0x1cd3daf4cef11721feb5d564c0768f42e88d1d14c6c909e64b7cd5532b6f158b" as Hex });
const QUEUE_FINGERPRINT = "0xbc952941d43eba0cc5b9f3f0e3b98e7984a10e085ab43d623e15224af13f4e67" as Hex;

export type HashlessCanonicalBlock = Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>;
type HashlessCanonicalTransactionBase = Readonly<{
  hash: Hex;
  recoveredSender: Address;
  nonce: number;
  to: Address | null;
  value: bigint;
  inputHash: Hex;
  gas: bigint;
  blockNumber: bigint;
  blockHash: Hex;
}>;
export type HashlessCanonicalTransaction = HashlessCanonicalTransactionBase & (
  | Readonly<{ type: "legacy"; chainId: number; gasPrice: bigint; v: bigint }>
  | Readonly<{ type: "eip1559"; chainId: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
);
export type HashlessCanonicalReceipt = Readonly<{ transactionHash: Hex; status: "success" | "reverted"; blockNumber: bigint; blockHash: Hex }>;
export type HashlessControlledState = {
  chainId: number;
  safe: Address;
  delay: Address;
  usdc: Address;
  safeNonce: bigint;
  delayQueueNonce: bigint;
  delayTxNonce: bigint;
  queue: { queueNonce: bigint; to: Address; value: bigint; data: Hex; operation: 0 | 1; createdAt: bigint; expiresAt: bigint };
  safeNativeBalance: bigint;
  safeUsdcBalance: bigint;
  funderUsdcBalance: bigint;
  effectiveGuardWindow: bigint;
  nativeSpend: { window: bigint; baseSpent: bigint; instantSpent: bigint };
  usdcSpend: { window: bigint; baseSpent: bigint; instantSpent: bigint };
};

export type HashlessEvidenceProvider = Readonly<{
  readLatestBlock(): Promise<HashlessCanonicalBlock>;
  readBlock(number: bigint): Promise<HashlessCanonicalBlock | undefined>;
  readTransaction(hash: Hex): Promise<HashlessCanonicalTransaction | undefined>;
  readReceipt(hash: Hex): Promise<HashlessCanonicalReceipt | undefined>;
  readTransactionCount(address: Address, block: bigint | "latest" | "pending"): Promise<number>;
  readControlledState(blockNumber: bigint): Promise<HashlessControlledState>;
}>;

export type HashlessNonce809Resolution =
  | Readonly<{ kind: "NONCE_809_INVALIDATED"; transactionHash: Hex; recoveredSender: Address; confirmations: bigint; envelopeDifferenceHash: Hex }>
  | Readonly<{ kind: "MATCH_FOUND_RECONCILE"; transactionHash: Hex }>;

const sourceProvenance = Object.freeze({
  interruptionRevision: "1e24c636b665b8d44f5755e0e30fd6d485939d35",
  laterCorrectedRevision: "e11a893fd36913411e7f7c4598832e96bdf368b7",
  failureCause: "UNKNOWN" as const,
  historicalExecutorSha256: "0x3c1112c780b54752109239f617b037eacb5e127c726923005ebd58c22ae816fb" as Hex,
  historicalCliAdapterSha256: "0x4f9e7f4cda5da2a4d659bd9ed48f2c9a41f413a126967a24f1a0fb0e8ff6d94d" as Hex,
  historicalSubmissionSha256: "0xd80b7ef9b27d3c848026956fd90da5c0dba80a9c499e6ca3fe08cba6e8488d2b" as Hex,
  descriptorSha256: "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831" as Hex,
  approvalBytesSha256: "0x90b370004c0bffec9d082bbae70a901b92251a2c1c3ebae5d055f2f967accd14" as Hex,
  approvalHash: "0x9f4af3d3a6142dd901019a7acd5dc10c69af23c89a884cb018c201b095e4e4a1" as Hex,
  originalJournalBytesSha256: ORIGINAL_JOURNAL_SHA256,
  failedCommandLogSha256: "0xbde7946063b9d9dcb2bf0b3a8ab567f730071545f565b4d29675670bf9a00631" as Hex,
  failedCommandExitSha256: "0x4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865" as Hex,
  publicStateArtifactSha256: EXPECTED_ARTIFACT_SHA256,
  nonceInvalidationProofSha256: "0xefbde290c5fa6a39008c6f1a3c66fb72c5b24f1ce0b7fc036bc9df1b46fcfcd3" as Hex,
  approvedRecoverySpecSha256: "0xfd877315cb3db6f634a4e318e26e8651206054c409131dfdd607d14960733be1" as Hex,
  controlFlow: "validate signed envelope -> derive hash -> append live entry -> await atomic persistence -> broadcast" as const,
});

declare const certificateBrand: unique symbol;
export type VerifiedHashlessStateCertificate = Readonly<{
  kind: "VERIFIED_HASHLESS_STATE_CERTIFICATE";
  source: typeof sourceProvenance;
  artifactSha256: Hex;
  historicalPrefixHash: Hex;
  materializationBlock: HashlessCanonicalBlock;
  certificateBlock: HashlessCanonicalBlock;
  controlledStateHash: Hex;
  currentSnapshot: Readonly<{ block: HashlessCanonicalBlock; controlledStateHash: Hex; funderUsdcBalance: bigint; funderNonce: number; latestNonce: number; pendingNonce: number; sharedFunderActivity: "NONE" | "UNRELATED_CONFIRMED_OR_PENDING_ACTIVITY" }>;
  classification: "EXPIRED_UNEXECUTED";
  nonce809: Extract<HashlessNonce809Resolution, { kind: "NONCE_809_INVALIDATED" }>;
  certificateHash: Hex;
  readonly [certificateBrand]: true;
}>;

type FileSnapshot = Readonly<{ path: string; bytesSha256: Hex; prefixHash: Hex; size: bigint; mtimeNs: bigint }>;
const sourceSnapshots = new WeakMap<OrdinaryScenarioJournal, FileSnapshot>();
const verifiedCertificates = new WeakSet<object>();

const rawSha256 = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
};
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} shape mismatch`);
};
const decimal = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`);
  return BigInt(value);
};
const number = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
};
const hash = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a hash`);
  return value as Hex;
};
const address = (value: unknown, label: string): Address => {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new Error(`${label} must be an address`);
  return value as Address;
};
const publicValue = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(publicValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)]));
};
const publicHash = (value: unknown): Hex => sha256(publicValue(value)) as Hex;

function prefixValue(journal: OrdinaryScenarioJournal): unknown {
  if (journal.actions.length < 19 || journal.liveJournal.entries.length < 10) throw new Error("hashless source historical counts are incomplete");
  return {
    schemaVersion: journal.schemaVersion,
    chainId: journal.chainId,
    reviewPackageHash: journal.reviewPackageHash,
    proposalHash: journal.proposalHash,
    approvalHash: journal.approvalHash,
    funder: journal.funder,
    actions: journal.actions.slice(0, 19),
    liveJournal: { chainId: journal.liveJournal.chainId, funder: journal.liveJournal.funder, entries: journal.liveJournal.entries.slice(0, 10) },
  };
}

export function hashHistoricalPrefix(journal: OrdinaryScenarioJournal): Hex {
  return publicHash(prefixValue(journal));
}

function unresolvedFilesystemState(path: string): void {
  if (existsSync(`${path}.lock`)) throw new Error("hashless source journal lock is unresolved");
  const prefix = `${basename(path)}.`;
  if (readdirSync(dirname(path)).some(name => name.startsWith(prefix) && name.endsWith(".tmp"))) throw new Error("hashless source journal temporary file is unresolved");
}

function readStableSource(path: string): Readonly<{ raw: string; stat: BigIntStats }> {
  const absolute = resolve(path);
  const initial = lstatSync(absolute, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("hashless source journal must be a direct regular file");
  realpathSync(absolute);
  unresolvedFilesystemState(absolute);
  const raw = readFileSync(absolute, "utf8");
  const final = statSync(absolute, { bigint: true });
  unresolvedFilesystemState(absolute);
  if (initial.dev !== final.dev || initial.ino !== final.ino || initial.size !== final.size || initial.mtimeNs !== final.mtimeNs) throw new Error("hashless source journal changed while being read");
  return { raw, stat: final };
}

function decodeSourceJournal(raw: string): OrdinaryScenarioJournal {
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error("hashless source journal must be JSON"); }
  const value = record(parsed, "hashless source journal");
  const optional = ["hashlessContinuation", "repairContinuation", "usdcSuccessor"].filter(key => value[key] !== undefined);
  exactKeys(value, ["schemaVersion", "chainId", "reviewPackageHash", "proposalHash", "approvalHash", "funder", "liveJournal", "actions", ...optional], "hashless source journal");
  const live = record(value.liveJournal, "hashless source live journal");
  exactKeys(live, ["chainId", "funder", "entries"], "hashless source live journal");
  if (value.schemaVersion !== 1 || value.chainId !== CHAIN_ID || live.chainId !== CHAIN_ID || !same(String(value.reviewPackageHash), "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571") || !same(String(value.proposalHash), "0x22770c7944ee289543c10090b3483bdcd87f0d2c193887df4f32916c5782e45f") || !same(String(value.approvalHash), sourceProvenance.approvalHash) || !same(String(value.funder), FUNDER) || !same(String(live.funder), FUNDER)) throw new Error("hashless source journal identity mismatch");
  value.actions = array(value.actions, "hashless source actions"); live.entries = array(live.entries, "hashless source live entries");
  return value as unknown as OrdinaryScenarioJournal;
}

export function loadHashlessSourceJournalReadOnly(path: string): OrdinaryScenarioJournal {
  const absolute = resolve(path); const read = readStableSource(absolute); const journal = decodeSourceJournal(read.raw);
  const prefixHash = hashHistoricalPrefix(journal);
  if (!same(prefixHash, EXPECTED_PREFIX_HASH)) throw new Error("hashless source historical prefix mismatch");
  const bytesSha256 = rawSha256(read.raw);
  if (!same(bytesSha256, ORIGINAL_JOURNAL_SHA256) && !("hashlessContinuation" in (journal as unknown as Record<string, unknown>))) throw new Error("hashless source bytes changed without append-only continuation lineage");
  sourceSnapshots.set(journal, { path: absolute, bytesSha256, prefixHash, size: read.stat.size, mtimeNs: read.stat.mtimeNs });
  return journal;
}

function revalidateSourceJournal(journal: OrdinaryScenarioJournal): FileSnapshot {
  const snapshot = sourceSnapshots.get(journal);
  if (!snapshot) throw new Error("hashless source journal lacks a read-only filesystem snapshot");
  if (!same(hashHistoricalPrefix(journal), snapshot.prefixHash) || !same(snapshot.prefixHash, EXPECTED_PREFIX_HASH)) throw new Error("hashless source historical prefix changed after load");
  const read = readStableSource(snapshot.path);
  if (read.stat.size !== snapshot.size || read.stat.mtimeNs !== snapshot.mtimeNs || !same(rawSha256(read.raw), snapshot.bytesSha256)) throw new Error("hashless source filesystem snapshot changed before certificate branding");
  const current = decodeSourceJournal(read.raw);
  if (!same(hashHistoricalPrefix(current), snapshot.prefixHash)) throw new Error("hashless source filesystem prefix changed before certificate branding");
  return snapshot;
}

/** Re-check the stable read-only source snapshot without exposing its filesystem metadata. */
export function assertHashlessSourceJournalReadOnlySnapshot(journal: OrdinaryScenarioJournal): void {
  revalidateSourceJournal(journal);
  assertSourceRow(journal);
}

type Artifact = Readonly<{ selected: HashlessCanonicalBlock; tip: HashlessCanonicalBlock; transactionHash: Hex }>;
function decodeArtifact(serialized: string, expectedSha256: Hex): Artifact {
  if (!HASH.test(expectedSha256)) throw new Error("hashless artifact SHA-256 is malformed");
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("hashless artifact must be JSON"); }
  const value = record(parsed, "hashless artifact");
  exactKeys(value, ["scope", "selected", "tip", "failedOuterNonce", "currentOuterNonce", "delayTxNonce", "delayQueueNonce", "createdAt", "expiresAt", "nonceTransactions", "signing", "broadcast"], "hashless artifact");
  if (value.scope !== "PUBLIC_HASHLESS_STOP_STATE_NOT_RECOVERY_AUTHORIZATION" || value.failedOuterNonce !== 809 || value.currentOuterNonce !== 811 || decimal(value.delayTxNonce, "artifact Delay tx nonce") !== 2n || decimal(value.delayQueueNonce, "artifact Delay queue nonce") !== 3n || decimal(value.createdAt, "artifact queue createdAt") !== 1_793_208_888n || decimal(value.expiresAt, "artifact queue expiry") !== 1_793_209_608n || value.signing !== false || value.broadcast !== false) throw new Error("hashless artifact fixed source facts mismatch");
  const decodeBlock = (raw: unknown, label: string): HashlessCanonicalBlock => { const block = record(raw, label); exactKeys(block, ["number", "hash", "timestamp"], label); return { number: decimal(block.number, `${label} number`), hash: hash(block.hash, `${label} hash`), timestamp: decimal(block.timestamp, `${label} timestamp`) }; };
  const selected = decodeBlock(value.selected, "artifact selected block"); const tip = decodeBlock(value.tip, "artifact certificate block");
  if (publicHash(selected) !== publicHash(MATERIALIZATION_BLOCK) || publicHash(tip) !== publicHash(CERTIFICATE_BLOCK)) throw new Error("hashless artifact canonical block mismatch");
  const transactions = array(value.nonceTransactions, "artifact nonce transactions").map((raw, index) => { const tx = record(raw, `artifact nonce transaction ${index}`); exactKeys(tx, ["hash", "nonce", "to", "inputHash", "value", "blockNumber", "blockHash", "confirmations", "matchesFailedEnvelope"], `artifact nonce transaction ${index}`); return { hash: hash(tx.hash, "artifact transaction hash"), nonce: number(tx.nonce, "artifact transaction nonce") }; });
  const nonce809 = transactions.filter(transaction => transaction.nonce === 809);
  if (nonce809.length !== 1 || !same(nonce809[0]!.hash, CONSUMING_TRANSACTION)) throw new Error("hashless artifact nonce-809 transaction mismatch");
  if (!same(rawSha256(serialized), expectedSha256) || !same(expectedSha256, EXPECTED_ARTIFACT_SHA256)) throw new Error("hashless artifact SHA-256 mismatch");
  return { selected, tip, transactionHash: nonce809[0]!.hash };
}

const expectedControlledState = (): HashlessControlledState => ({
  chainId: CHAIN_ID, safe: SAFE, delay: DELAY, usdc: USDC, safeNonce: 7n, delayQueueNonce: 3n, delayTxNonce: 2n,
  queue: { queueNonce: 2n, to: FUNDER, value: 1n, data: "0x", operation: 0, createdAt: 1_793_208_888n, expiresAt: 1_793_209_608n },
  safeNativeBalance: 1n, safeUsdcBalance: 20_000_000n, funderUsdcBalance: 0n, effectiveGuardWindow: 1_793_145_600n,
  nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n },
});

type ProviderView = Readonly<{ selected: HashlessCanonicalBlock; certificate: HashlessCanonicalBlock; transactionBlock: HashlessCanonicalBlock; current: HashlessCanonicalBlock; transaction: HashlessCanonicalTransaction; receipt: HashlessCanonicalReceipt; selectedNonce: number; certificateNonce: number; currentNonce: number; latestNonce: number; pendingNonce: number; selectedState: HashlessControlledState; certificateState: HashlessControlledState; currentState: HashlessControlledState; canonicalRecheck: readonly [HashlessCanonicalBlock | undefined, HashlessCanonicalBlock | undefined, HashlessCanonicalBlock | undefined, HashlessCanonicalBlock | undefined] }>;
async function readProvider(provider: HashlessEvidenceProvider, artifact: Artifact, currentNumber: bigint): Promise<ProviderView> {
  const selected = await provider.readBlock(artifact.selected.number); const certificate = await provider.readBlock(artifact.tip.number);
  const transaction = await provider.readTransaction(artifact.transactionHash); const receipt = await provider.readReceipt(artifact.transactionHash);
  if (!selected || !certificate || !transaction || !receipt) throw new Error("hashless provider canonical evidence is incomplete");
  const transactionBlock = await provider.readBlock(transaction.blockNumber); const current = await provider.readBlock(currentNumber);
  if (!transactionBlock || !current) throw new Error("hashless provider transaction or current block is unavailable");
  const [selectedNonce, certificateNonce, currentNonce, latestNonce, pendingNonce, selectedState, certificateState, currentState] = await Promise.all([
    provider.readTransactionCount(FUNDER, selected.number), provider.readTransactionCount(FUNDER, certificate.number), provider.readTransactionCount(FUNDER, currentNumber), provider.readTransactionCount(FUNDER, "latest"), provider.readTransactionCount(FUNDER, "pending"),
    provider.readControlledState(selected.number), provider.readControlledState(certificate.number), provider.readControlledState(currentNumber),
  ]);
  const canonicalRecheck = await Promise.all([provider.readBlock(selected.number), provider.readBlock(certificate.number), provider.readBlock(transaction.blockNumber), provider.readBlock(currentNumber)] as const);
  return { selected, certificate, transactionBlock, current, transaction, receipt, selectedNonce, certificateNonce, currentNonce, latestNonce, pendingNonce, selectedState, certificateState, currentState, canonicalRecheck };
}

function assertBlock(actual: HashlessCanonicalBlock, expected: HashlessCanonicalBlock, label: string): void {
  if (actual.number !== expected.number || !same(actual.hash, expected.hash) || actual.timestamp !== expected.timestamp) throw new Error(`${label} canonical block mismatch`);
}

function assertHistoricalTransactionEvidence(view: ProviderView): void {
  assertBlock(view.selected, MATERIALIZATION_BLOCK, "materialization"); assertBlock(view.certificate, CERTIFICATE_BLOCK, "certificate");
  if (view.transactionBlock.number !== TRANSACTION_BLOCK.number || !same(view.transactionBlock.hash, TRANSACTION_BLOCK.hash)) throw new Error("nonce-809 canonical transaction block mismatch");
  const tx = view.transaction; const receipt = view.receipt;
  if (!same(tx.hash, CONSUMING_TRANSACTION) || tx.nonce !== 809 || !same(tx.recoveredSender, FUNDER)) throw new Error("nonce-809 recovered sender or transaction mismatch");
  if (tx.chainId !== CHAIN_ID || (tx.type === "legacy" ? tx.v !== 22_310_258n || tx.gasPrice !== 100_000n : tx.maxFeePerGas <= 0n || tx.maxPriorityFeePerGas < 0n || tx.maxPriorityFeePerGas > tx.maxFeePerGas)) throw new Error("nonce-809 canonical transaction type or fee mismatch");
  if (!same(tx.blockHash, TRANSACTION_BLOCK.hash) || tx.blockNumber !== TRANSACTION_BLOCK.number || !same(receipt.transactionHash, tx.hash) || receipt.status !== "success" || receipt.blockNumber !== tx.blockNumber || !same(receipt.blockHash, tx.blockHash)) throw new Error("nonce-809 canonical receipt mismatch");
  const confirmations = view.certificate.number - tx.blockNumber + 1n;
  if (confirmations < 6n) throw new Error("nonce-809 confirmation depth is below six");
}

function assertProviderView(view: ProviderView, latest: HashlessCanonicalBlock): void {
  assertHistoricalTransactionEvidence(view);
  if (latest.number - view.current.number + 1n < 6n || view.current.number <= view.certificate.number || view.current.timestamp <= view.certificate.timestamp) throw new Error("current controlled snapshot lacks six confirmations or ordering");
  for (const [label, before, after] of [["materialization", view.selected, view.canonicalRecheck[0]], ["certificate", view.certificate, view.canonicalRecheck[1]], ["nonce-809 transaction", view.transactionBlock, view.canonicalRecheck[2]], ["current", view.current, view.canonicalRecheck[3]]] as const) {
    if (!after || before.number !== after.number || !same(before.hash, after.hash) || before.timestamp !== after.timestamp) throw new Error(`${label} canonical recheck detected a reorg`);
  }
  if (view.selectedNonce !== 809 || view.certificateNonce !== 811 || view.currentNonce < 811 || view.latestNonce < view.currentNonce || view.pendingNonce < view.latestNonce) throw new Error("nonce-809 is unused, pending-only, or nonce state drifted");
  const expectedState = expectedControlledState();
  for (const [label, state] of [["materialization", view.selectedState], ["certificate", view.certificateState], ["current", view.currentState]] as const) {
    if (!HASH.test(state.queue.data) && state.queue.data !== "0x") throw new Error(`${label} controlled queue calldata is malformed`);
    if (!same(queueFingerprint({ safe: state.safe, delay: state.delay, to: state.queue.to, value: state.queue.value, data: state.queue.data, operation: state.queue.operation, queueNonce: state.queue.queueNonce }), QUEUE_FINGERPRINT) || publicHash(state) !== publicHash(expectedState)) throw new Error(`${label} controlled state or queue tuple drifted`);
  }
  if (view.selected.timestamp >= expectedState.queue.expiresAt || view.certificate.timestamp <= expectedState.queue.expiresAt) throw new Error("hashless source expiry classification mismatch");
}

function resolution(view: ProviderView, journal: OrdinaryScenarioJournal): HashlessNonce809Resolution {
  const source = journal.actions[18]!; const tx = view.transaction;
  const exact = tx.type === "eip1559" && tx.to !== null && source.outerTo !== undefined && same(tx.to, source.outerTo) && tx.value.toString() === source.outerValue && source.outerDataHash !== undefined && same(tx.inputHash, source.outerDataHash) && tx.gas.toString() === source.gas && tx.maxFeePerGas.toString() === source.maxFeePerGas && tx.maxPriorityFeePerGas.toString() === source.maxPriorityFeePerGas;
  if (exact) return { kind: "MATCH_FOUND_RECONCILE", transactionHash: tx.hash };
  const canonical = tx.type === "legacy" ? { type: tx.type, chainId: tx.chainId, to: tx.to, value: tx.value, inputHash: tx.inputHash, gas: tx.gas, gasPrice: tx.gasPrice, v: tx.v } : { type: tx.type, chainId: tx.chainId, to: tx.to, value: tx.value, inputHash: tx.inputHash, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas };
  const envelopeDifferenceHash = publicHash({ source: { type: "eip1559", chainId: CHAIN_ID, to: source.outerTo, value: source.outerValue, inputHash: source.outerDataHash, gas: source.gas, maxFeePerGas: source.maxFeePerGas, maxPriorityFeePerGas: source.maxPriorityFeePerGas }, canonical });
  return { kind: "NONCE_809_INVALIDATED", transactionHash: tx.hash, recoveredSender: tx.recoveredSender, confirmations: view.certificate.number - tx.blockNumber + 1n, envelopeDifferenceHash };
}

function assertSourceRow(journal: OrdinaryScenarioJournal): void {
  if (journal.actions.length !== 19) throw new Error("hashless source top-level actions must contain exactly 19 original records");
  if (!same(hashHistoricalPrefix(journal), EXPECTED_PREFIX_HASH)) throw new Error("hashless source historical prefix mismatch");
  const row = journal.actions[18];
  if (!row || row.id !== "native-queue-ready-execute" || row.status !== "signed-simulated" || row.outerNonce !== 809 || row.gas !== "300000" || row.maxFeePerGas !== "28" || row.maxPriorityFeePerGas !== "2" || row.intentHash !== undefined || row.transactionHash !== undefined || row.receipt !== undefined || journal.liveJournal.entries.some(entry => entry.id === row.id)) throw new Error("hashless source row 19 is not the immutable stopped attempt");
  const materializationHash = sha256({ action: row.commitment, outerNonce: row.outerNonce, fees: { maxFeePerGas: row.maxFeePerGas, maxPriorityFeePerGas: row.maxPriorityFeePerGas }, blockNumber: MATERIALIZATION_BLOCK.number.toString(), blockHash: MATERIALIZATION_BLOCK.hash }) as Hex;
  if (!row.materializationHash || !same(materializationHash, row.materializationHash)) throw new Error("hashless source materialization block derivation mismatch");
}

export async function verifyHashlessStateCertificate(artifactText: string, expectedArtifactSha256: Hex, journal: OrdinaryScenarioJournal, providers: readonly [HashlessEvidenceProvider, HashlessEvidenceProvider]): Promise<VerifiedHashlessStateCertificate> {
  const artifact = decodeArtifact(artifactText, expectedArtifactSha256);
  revalidateSourceJournal(journal); assertSourceRow(journal);
  if (!Array.isArray(providers) || providers.length !== 2 || providers[0] === providers[1]) throw new Error("hashless certificate requires two independent providers");
  const latest = await Promise.all([providers[0].readLatestBlock(), providers[1].readLatestBlock()] as const);
  if (publicHash(latest[0]) !== publicHash(latest[1]) || latest[0].number < 5n) throw new Error("hashless providers disagree on the current canonical tip");
  const currentNumber = latest[0].number - 5n;
  const views = await Promise.all([readProvider(providers[0], artifact, currentNumber), readProvider(providers[1], artifact, currentNumber)] as const);
  assertProviderView(views[0], latest[0]); assertProviderView(views[1], latest[1]);
  if (publicHash(views[0]) !== publicHash(views[1])) throw new Error("hashless providers disagree on canonical evidence");
  const nonce809 = resolution(views[0], journal);
  if (nonce809.kind === "MATCH_FOUND_RECONCILE") throw new Error(`MATCH_FOUND_RECONCILE:${nonce809.transactionHash}`);
  const controlledStateHash = publicHash(views[0].certificateState);
  const currentStateHash = publicHash(views[0].currentState);
  const sharedFunderActivity = views[0].currentNonce > 811 || views[0].latestNonce > 811 || views[0].pendingNonce > 811 ? "UNRELATED_CONFIRMED_OR_PENDING_ACTIVITY" as const : "NONE" as const;
  const currentSnapshot = Object.freeze({ block: Object.freeze({ ...views[0].current }), controlledStateHash: currentStateHash, funderUsdcBalance: views[0].currentState.funderUsdcBalance, funderNonce: views[0].currentNonce, latestNonce: views[0].latestNonce, pendingNonce: views[0].pendingNonce, sharedFunderActivity });
  const body = { kind: "VERIFIED_HASHLESS_STATE_CERTIFICATE" as const, source: sourceProvenance, artifactSha256: expectedArtifactSha256, historicalPrefixHash: EXPECTED_PREFIX_HASH, materializationBlock: MATERIALIZATION_BLOCK, certificateBlock: CERTIFICATE_BLOCK, controlledStateHash, currentSnapshot, classification: "EXPIRED_UNEXECUTED" as const, nonce809 };
  const certificate = Object.freeze({ ...body, nonce809: Object.freeze(nonce809), certificateHash: publicHash(body) }) as VerifiedHashlessStateCertificate;
  revalidateSourceJournal(journal); assertSourceRow(journal);
  verifiedCertificates.add(certificate);
  return certificate;
}

export function isVerifiedHashlessStateCertificate(value: unknown): value is VerifiedHashlessStateCertificate {
  return !!value && typeof value === "object" && verifiedCertificates.has(value as object);
}

export function serializeHashlessStateCertificate(certificate: VerifiedHashlessStateCertificate): string {
  if (!isVerifiedHashlessStateCertificate(certificate)) throw new Error("hashless certificate is not runtime verified");
  return `${JSON.stringify(publicValue(certificate))}\n`;
}

function decodeRecordedCertificate(serialized: string, expectedCertificateHash: Hex): VerifiedHashlessStateCertificate {
  if (!HASH.test(expectedCertificateHash)) throw new Error("recorded certificate expected hash is malformed");
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("recorded certificate must be JSON"); }
  const value = record(parsed, "recorded certificate");
  exactKeys(value, ["kind", "source", "artifactSha256", "historicalPrefixHash", "materializationBlock", "certificateBlock", "controlledStateHash", "currentSnapshot", "classification", "nonce809", "certificateHash"], "recorded certificate");
  const decodeBlock = (raw: unknown, label: string): HashlessCanonicalBlock => { const block = record(raw, label); exactKeys(block, ["number", "hash", "timestamp"], label); return Object.freeze({ number: decimal(block.number, `${label} number`), hash: hash(block.hash, `${label} hash`), timestamp: decimal(block.timestamp, `${label} timestamp`) }); };
  const current = record(value.currentSnapshot, "recorded certificate current snapshot");
  exactKeys(current, ["block", "controlledStateHash", "funderUsdcBalance", "funderNonce", "latestNonce", "pendingNonce", "sharedFunderActivity"], "recorded certificate current snapshot");
  const nonce = record(value.nonce809, "recorded certificate nonce-809 proof");
  exactKeys(nonce, ["kind", "transactionHash", "recoveredSender", "confirmations", "envelopeDifferenceHash"], "recorded certificate nonce-809 proof");
  if (value.kind !== "VERIFIED_HASHLESS_STATE_CERTIFICATE" || value.classification !== "EXPIRED_UNEXECUTED" || publicHash(value.source) !== publicHash(sourceProvenance) || !same(hash(value.artifactSha256, "recorded artifact hash"), EXPECTED_ARTIFACT_SHA256) || !same(hash(value.historicalPrefixHash, "recorded prefix hash"), EXPECTED_PREFIX_HASH) || nonce.kind !== "NONCE_809_INVALIDATED" || !same(hash(nonce.transactionHash, "recorded transaction hash"), CONSUMING_TRANSACTION) || !same(address(nonce.recoveredSender, "recorded recovered sender"), FUNDER)) throw new Error("recorded certificate fixed evidence mismatch");
  const materializationBlock = decodeBlock(value.materializationBlock, "recorded materialization block"); const certificateBlock = decodeBlock(value.certificateBlock, "recorded certificate block");
  assertBlock(materializationBlock, MATERIALIZATION_BLOCK, "recorded materialization"); assertBlock(certificateBlock, CERTIFICATE_BLOCK, "recorded certificate");
  const currentSnapshot = Object.freeze({ block: decodeBlock(current.block, "recorded current block"), controlledStateHash: hash(current.controlledStateHash, "recorded current state hash"), funderUsdcBalance: decimal(current.funderUsdcBalance, "recorded funder USDC balance"), funderNonce: number(current.funderNonce, "recorded funder nonce"), latestNonce: number(current.latestNonce, "recorded latest nonce"), pendingNonce: number(current.pendingNonce, "recorded pending nonce"), sharedFunderActivity: current.sharedFunderActivity as VerifiedHashlessStateCertificate["currentSnapshot"]["sharedFunderActivity"] });
  if ((currentSnapshot.sharedFunderActivity !== "NONE" && currentSnapshot.sharedFunderActivity !== "UNRELATED_CONFIRMED_OR_PENDING_ACTIVITY") || currentSnapshot.funderUsdcBalance !== 0n) throw new Error("recorded certificate current snapshot shape mismatch");
  const nonce809 = Object.freeze({ kind: "NONCE_809_INVALIDATED" as const, transactionHash: CONSUMING_TRANSACTION, recoveredSender: FUNDER, confirmations: decimal(nonce.confirmations, "recorded confirmations"), envelopeDifferenceHash: hash(nonce.envelopeDifferenceHash, "recorded envelope difference hash") });
  const body = { kind: "VERIFIED_HASHLESS_STATE_CERTIFICATE" as const, source: sourceProvenance, artifactSha256: EXPECTED_ARTIFACT_SHA256, historicalPrefixHash: EXPECTED_PREFIX_HASH, materializationBlock, certificateBlock, controlledStateHash: hash(value.controlledStateHash, "recorded controlled state hash"), currentSnapshot, classification: "EXPIRED_UNEXECUTED" as const, nonce809 };
  const certificateHash = hash(value.certificateHash, "recorded certificate hash");
  if (!same(certificateHash, expectedCertificateHash) || !same(publicHash(body), certificateHash)) throw new Error("recorded certificate hash mismatch");
  return Object.freeze({ ...body, certificateHash }) as VerifiedHashlessStateCertificate;
}

export async function reverifyHashlessStateCertificate(recordedCertificate: string, expectedCertificateHash: Hex, journal: OrdinaryScenarioJournal, providers: readonly [HashlessEvidenceProvider, HashlessEvidenceProvider]): Promise<VerifiedHashlessStateCertificate> {
  const certificate = decodeRecordedCertificate(recordedCertificate, expectedCertificateHash);
  revalidateSourceJournal(journal); assertSourceRow(journal);
  if (providers.length !== 2 || providers[0] === providers[1]) throw new Error("recorded certificate requires two independent providers");
  const artifact: Artifact = { selected: MATERIALIZATION_BLOCK, tip: CERTIFICATE_BLOCK, transactionHash: CONSUMING_TRANSACTION };
  const views = await Promise.all([readProvider(providers[0], artifact, certificate.currentSnapshot.block.number), readProvider(providers[1], artifact, certificate.currentSnapshot.block.number)] as const);
  for (const view of views) {
    assertHistoricalTransactionEvidence(view); assertBlock(view.current, certificate.currentSnapshot.block, "recorded current snapshot");
    if (view.selectedNonce !== 809 || view.certificateNonce !== 811 || view.currentNonce !== certificate.currentSnapshot.funderNonce) throw new Error("recorded certificate historical nonce mismatch");
    if (publicHash(view.selectedState) !== certificate.controlledStateHash || publicHash(view.certificateState) !== certificate.controlledStateHash || publicHash(view.currentState) !== certificate.currentSnapshot.controlledStateHash || view.currentState.funderUsdcBalance !== certificate.currentSnapshot.funderUsdcBalance) throw new Error("recorded certificate controlled state mismatch");
    const nonce809 = resolution(view, journal); if (nonce809.kind !== "NONCE_809_INVALIDATED" || publicHash(nonce809) !== publicHash(certificate.nonce809)) throw new Error("recorded certificate nonce-809 proof mismatch");
    for (const [before, after] of [[view.selected, view.canonicalRecheck[0]], [view.certificate, view.canonicalRecheck[1]], [view.transactionBlock, view.canonicalRecheck[2]], [view.current, view.canonicalRecheck[3]]] as const) if (!after || publicHash(before) !== publicHash(after)) throw new Error("recorded certificate canonical recheck detected a reorg");
  }
  const comparable = (view: ProviderView) => ({ selected: view.selected, certificate: view.certificate, transactionBlock: view.transactionBlock, current: view.current, transaction: view.transaction, receipt: view.receipt, selectedNonce: view.selectedNonce, certificateNonce: view.certificateNonce, currentNonce: view.currentNonce, selectedState: view.selectedState, certificateState: view.certificateState, currentState: view.currentState, canonicalRecheck: view.canonicalRecheck });
  if (publicHash(comparable(views[0])) !== publicHash(comparable(views[1]))) throw new Error("recorded certificate providers disagree on canonical history");
  revalidateSourceJournal(journal); assertSourceRow(journal); verifiedCertificates.add(certificate); return certificate;
}
