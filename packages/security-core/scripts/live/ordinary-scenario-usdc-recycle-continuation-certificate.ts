import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import { hydrateActivityAlert, publicAlertPayloadHash } from "../../src/monitoring/notifier";
import { sha256 } from "../plan-deployment";
import type { OrdinaryScenarioJournal } from "./ordinary-scenario-executor";
import {
  isVerifiedUsdcSuccessorCertificate,
  type UsdcSuccessorCanonicalBlock,
  type UsdcSuccessorCanonicalReceipt,
  type UsdcSuccessorCanonicalState,
  type UsdcSuccessorCanonicalTransaction,
  type UsdcSuccessorEvidenceProvider,
  type UsdcSuccessorRawSpend,
  type UsdcSuccessorSource,
  type VerifiedUsdcSuccessorCertificate,
} from "./ordinary-scenario-usdc-successor-certificate";
import {
  assertExpiredHashlessContinuationAuthorization,
  assertExpiredHashlessContinuationLineage,
} from "./ordinary-scenario-hashless-continuation";
import {
  assertUsdcSuccessorAuthorization,
  getUsdcSuccessorApprovalPublicValue,
  type UsdcSuccessorApproval,
  type UsdcSuccessorProposal,
} from "./ordinary-scenario-usdc-successor-proposal";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const CHAIN_ID = 11_155_111;
const PERIOD = 1_793_232_000n;
const PERIOD_END = PERIOD + 86_400n;
const SOURCE_JOURNAL_BYTES_SHA256 = "0x3d860cf927ccbdd6cfe45864aa42cd60577f8e7745db046e061613e6d3242dae" as Hex;
const SOURCE_STRUCTURE_HASH = "0x7f5547d3b9b92763f03614ac1550bca376df3c3c5607d259e529caf3c889ed9a" as Hex;
const PRIOR_CERTIFICATE_HASH = "0x909f9d5b36c3a8d4dcc099eb6519c1079f7f400e522d17b752ff3f4e37794b1a" as Hex;
const PRIOR_PROPOSAL_HASH = "0xb2886755d8f1fc601b84a18139f25822e655089364291c2546ecdd5ba8eb2917" as Hex;
const PRIOR_APPROVAL_HASH = "0x6855653735904925cff3a09765788cee295a92ec3111f0044148c7a19ca376e7" as Hex;
const PRIMARY_MANIFEST_HASH = "0xe1978a45917c1f0caab4574e4a61460493a1c9a10a979f96860ab2ae5c23ec7b" as Hex;
const PRIMARY_LEDGER_HASH = "0x2582059e3f914c16fbf1de029658da992dd0b9e1444384eab11dc0bc4dc92eb9" as Hex;
const PRIMARY_ACK_HASH = "0x230b8576b3056ac8480f3e60cf0170e5aed35914195e3426f4c3d3d4a5ffd43d" as Hex;
const POLICY_HASH = "0x5b19fb0f9dcc35db4d45ec227f01348985431d74a2092d887bc7b4f26ade4a82" as Hex;
const INVALIDATION_HASH = "0xa81d6df9e9720da44c096b713fdf389fa28ae41aee2224d7f492560ee864781e" as Hex;
const INVALIDATION_BLOCK = Object.freeze({ number: 12_019_394n, hash: "0xe00b2c4b73f45e9eea3a2476c8399ccad6b9c00273e92bc19a73868b0db4fdac" as Hex, timestamp: 1_793_275_548n });
const INVALIDATION_TO = "0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27" as Address;
const INVALIDATION_INPUT_HASH = keccak256("0xa0eb5570");
const INVALIDATION_COST = 124_785_100_000n;
const PRIOR_ACTUAL_COST = 168_855_544n;
const AGGREGATE_KNOWN_CHARGE = 124_953_955_544n;
const HISTORICAL_SOURCE_SNAPSHOT = Object.freeze({ number: 12_019_465n, hash: "0xbf7cbfcf7b46054149edf3a71b9cb26ccdf728ef3db5389af09fc51550a4f754" as Hex, timestamp: 1_793_276_400n });

export type UsdcRecycleContinuationSource = Readonly<{
  prior: UsdcSuccessorSource;
  priorCertificate: VerifiedUsdcSuccessorCertificate;
  priorProposal: UsdcSuccessorProposal;
  priorApproval: UsdcSuccessorApproval;
}>;

export type UsdcRecycleContinuationPrimaryEvidence = Readonly<{
  manifest: string;
  stepUpLedger: string;
  stepUpAcknowledgement: string;
}>;

type ReceiptEvidence = Readonly<{ id: string; transactionHash: Hex; blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint; gasUsed: bigint; effectiveGasPrice: bigint; gasCost: bigint; postStateHash: Hex }>;
type InvalidationEvidence = Readonly<{ transactionHash: Hex; recoveredSender: Address; nonce: 869; blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint; gasUsed: bigint; effectiveGasPrice: bigint; gasCost: bigint; confirmations: bigint; postStateHash: Hex; cause: "UNKNOWN" }>;
declare const certificateBrand: unique symbol;
export type VerifiedUsdcRecycleContinuationCertificate = Readonly<{
  kind: "VERIFIED_USDC_RECYCLE_CONTINUATION_CERTIFICATE";
  sourceHash: Hex;
  sourceJournalBytesSha256: typeof SOURCE_JOURNAL_BYTES_SHA256;
  primaryEvidenceHash: Hex;
  effectivePeriod: bigint;
  snapshot: Readonly<{ blockNumber: string; blockHash: Hex; timestamp: string; stateHash: Hex }>;
  currentCheckpoint: Readonly<{ blockNumber: string; blockHash: Hex; stateHash: Hex; snapshotNonce: number; latestNonce: number; pendingNonce: number }>;
  rawNativeSpend: UsdcSuccessorRawSpend;
  rawUsdcSpend: UsdcSuccessorRawSpend;
  priorReceipts: readonly ReceiptEvidence[];
  invalidation: InvalidationEvidence;
  priorActualGasCostWei: bigint;
  aggregateKnownChargeWei: bigint;
  certificateHash: Hex;
  readonly [certificateBrand]: true;
}>;

type FileSnapshot = Readonly<{ path: string; bytesSha256: Hex; structureHash: Hex; size: bigint; mtimeNs: bigint; mode: "initial" | "pinned" }>;
const sourceSnapshots = new WeakMap<OrdinaryScenarioJournal, FileSnapshot>();
const verifiedCertificates = new WeakSet<object>();
const rawSha256 = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const publicHash = (value: unknown): Hex => sha256(publicValue(value)) as Hex;
const record = (value: unknown, label: string): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; };
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => { const actual = Object.keys(value).sort(), expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} shape mismatch`); };
const parseJson = (serialized: string, label: string): Record<string, unknown> => { let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error(`${label} must be JSON`); } return record(parsed, label); };
const hash = (value: unknown, label: string): Hex => { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a hash`); return value as Hex; };
const decimal = (value: unknown, label: string): bigint => { if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`); return BigInt(value); };
const integer = (value: unknown, label: string): number => { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`); return value; };

function fixedJournalValue(journal: OrdinaryScenarioJournal): unknown {
  return {
    schemaVersion: journal.schemaVersion, chainId: journal.chainId, reviewPackageHash: journal.reviewPackageHash,
    proposalHash: journal.proposalHash, approvalHash: journal.approvalHash, funder: journal.funder,
    actions: journal.actions,
    liveJournal: { chainId: journal.liveJournal.chainId, funder: journal.liveJournal.funder, entries: journal.liveJournal.entries.slice(0, 15) },
    hashlessContinuation: journal.hashlessContinuation,
    usdcSuccessor: journal.usdcSuccessor,
  };
}

function unresolvedFilesystemState(path: string): void {
  if (existsSync(`${path}.lock`)) throw new Error("USDC recycle source journal lock is unresolved");
  const prefix = `${basename(path)}.`;
  if (readdirSync(dirname(path)).some(name => name.startsWith(prefix) && name.endsWith(".tmp"))) throw new Error("USDC recycle source journal temporary file is unresolved");
}

function readStableSource(path: string): Readonly<{ raw: string; stat: BigIntStats }> {
  const absolute = resolve(path), initial = lstatSync(absolute, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("USDC recycle source journal must be a direct regular file");
  realpathSync(absolute); unresolvedFilesystemState(absolute);
  const raw = readFileSync(absolute, "utf8"), final = statSync(absolute, { bigint: true });
  unresolvedFilesystemState(absolute);
  if (initial.dev !== final.dev || initial.ino !== final.ino || initial.size !== final.size || initial.mtimeNs !== final.mtimeNs) throw new Error("USDC recycle source journal changed while being read");
  return { raw, stat: final };
}

function decodeJournal(raw: string, mode: "initial" | "pinned"): OrdinaryScenarioJournal {
  const value = parseJson(raw, "USDC recycle source journal");
  const baseKeys = ["schemaVersion", "chainId", "reviewPackageHash", "proposalHash", "approvalHash", "funder", "liveJournal", "actions", "hashlessContinuation", "usdcSuccessor"];
  const descendants = mode === "pinned" ? ["usdcRecycleContinuation", "repairContinuation"].filter(key => value[key] !== undefined) : [];
  exactKeys(value, [...baseKeys, ...descendants], "USDC recycle source journal");
  const live = record(value.liveJournal, "USDC recycle source live journal"); exactKeys(live, ["chainId", "funder", "entries"], "USDC recycle source live journal");
  if (value.schemaVersion !== 1 || value.chainId !== CHAIN_ID || live.chainId !== CHAIN_ID || !Array.isArray(value.actions) || !Array.isArray(live.entries) || !value.hashlessContinuation || !value.usdcSuccessor) throw new Error("USDC recycle source journal identity or lineage is incomplete");
  return value as unknown as OrdinaryScenarioJournal;
}

function assertFixedJournal(journal: OrdinaryScenarioJournal, mode: "initial" | "pinned"): void {
  if (!same(publicHash(fixedJournalValue(journal)), SOURCE_STRUCTURE_HASH)) throw new Error("USDC recycle source frozen structure, row, receipt, inclusion, cost, or live prefix changed");
  if (journal.actions.length !== 19 || journal.liveJournal.entries.length < 15 || !journal.hashlessContinuation || !journal.usdcSuccessor || journal.hashlessContinuation.actions.length !== 22 || journal.usdcSuccessor.actions.length !== 19 || journal.usdcSuccessor.actionCommitments.length !== 19) throw new Error("USDC recycle source exact lineage counts mismatch");
  if (mode === "initial" && (journal.liveJournal.entries.length !== 15 || "usdcRecycleContinuation" in journal || "repairContinuation" in journal)) throw new Error("USDC recycle initial source must be the exact partial source with no sibling, repair, or later live progress");
  const rows = journal.usdcSuccessor.actions as Array<Record<string, unknown>>;
  if (!same(String(journal.usdcSuccessor.certificateHash), PRIOR_CERTIFICATE_HASH) || !same(String(journal.usdcSuccessor.proposalHash), PRIOR_PROPOSAL_HASH) || !same(String(journal.usdcSuccessor.approvalHash), PRIOR_APPROVAL_HASH)) throw new Error("USDC recycle old successor header mismatch");
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (index < 2 && (row.status !== "confirmed" || !row.transactionHash || !row.receipt || !row.receiptInclusion || !row.ourReceiptGasCost)) throw new Error("USDC recycle old confirmed row evidence is incomplete");
    if (index === 2 && (row.id !== "usdc-successor-recycle-topup-step-up" || row.status !== "signed-simulated" || row.outerNonce !== 869 || row.gas !== "740292" || row.maxFeePerGas !== "69" || row.maxPriorityFeePerGas !== "51" || row.transactionHash !== undefined || row.receipt !== undefined || row.receiptInclusion !== undefined || row.ourReceiptGasCost !== undefined || typeof row.materializationHash !== "string")) throw new Error("USDC recycle stopped row 3 materialization mismatch");
    if (index > 2 && (row.status !== "approved" || Object.keys(row).sort().join(",") !== "commitment,id,status")) throw new Error("USDC recycle old untouched tail is not minimally approved");
  }
  const expectedLive = rows.slice(0, 2);
  for (let index = 0; index < 2; index++) {
    const live = journal.liveJournal.entries[13 + index]!, row = expectedLive[index]!;
    if (live.status !== "success" || live.id !== row.id || !same(live.transactionHash, String(row.transactionHash))) throw new Error("USDC recycle old live prefix mismatch");
  }
  if (journal.liveJournal.entries.some(entry => entry.id === rows[2]!.id)) throw new Error("USDC recycle stopped row 3 has a forbidden live entry");
}

export function loadUsdcRecycleContinuationSourceJournalReadOnly(path: string, mode: "initial" | "pinned" = "initial"): OrdinaryScenarioJournal {
  const absolute = resolve(path), read = readStableSource(absolute), journal = decodeJournal(read.raw, mode), bytesSha256 = rawSha256(read.raw);
  if (mode === "initial" && !same(bytesSha256, SOURCE_JOURNAL_BYTES_SHA256)) throw new Error("USDC recycle initial source bytes do not match the fixed public source");
  assertFixedJournal(journal, mode);
  sourceSnapshots.set(journal, { path: absolute, bytesSha256, structureHash: SOURCE_STRUCTURE_HASH, size: read.stat.size, mtimeNs: read.stat.mtimeNs, mode });
  return journal;
}

/** Closed descendant codec used when the historical loader adopts this exact stable file. */
export function assertUsdcRecycleContinuationSourceJournalAdoptable(path: string, journal: OrdinaryScenarioJournal): void {
  const read = readStableSource(resolve(path));
  const decoded = decodeJournal(read.raw, "pinned");
  assertFixedJournal(decoded, "pinned");
  if (JSON.stringify(decoded) !== JSON.stringify(journal)) throw new Error("USDC recycle source journal does not match its stable decoded file");
}

function assertSourceSnapshot(journal: OrdinaryScenarioJournal, mode: "initial" | "pinned"): void {
  const snapshot = sourceSnapshots.get(journal);
  if (!snapshot || (mode === "initial" && snapshot.mode !== "initial")) throw new Error(`USDC recycle source lacks a ${mode} read-only filesystem snapshot`);
  assertFixedJournal(journal, mode);
  const read = readStableSource(snapshot.path);
  if (read.stat.size !== snapshot.size || read.stat.mtimeNs !== snapshot.mtimeNs || !same(rawSha256(read.raw), snapshot.bytesSha256)) throw new Error("USDC recycle source filesystem snapshot changed before certificate branding");
  const current = decodeJournal(read.raw, snapshot.mode); assertFixedJournal(current, mode);
}

function assertOpaqueAuthority(source: UsdcRecycleContinuationSource): Readonly<Record<string, unknown>> {
  assertExpiredHashlessContinuationLineage(source.prior.original, source.prior.recovery);
  assertExpiredHashlessContinuationAuthorization(source.prior.recovery, source.prior.recoveryApproval);
  if (!isVerifiedUsdcSuccessorCertificate(source.priorCertificate)) throw new Error("USDC recycle prior certificate is not opaque and verified");
  assertUsdcSuccessorAuthorization(source.priorProposal, source.priorApproval);
  if (!same(source.priorCertificate.certificateHash, PRIOR_CERTIFICATE_HASH) || !same(source.priorProposal.proposalHash, PRIOR_PROPOSAL_HASH) || !same(source.priorApproval.approvalHash, PRIOR_APPROVAL_HASH)) throw new Error("USDC recycle prior authority hashes mismatch");
  if (!same(source.priorProposal.certificateHash, source.priorCertificate.certificateHash) || !same(source.priorProposal.sourceHash, source.priorCertificate.sourceHash)) throw new Error("USDC recycle prior proposal is not certificate-bound");
  return getUsdcSuccessorApprovalPublicValue(source.priorApproval);
}

function sourceHashValue(source: UsdcRecycleContinuationSource, approvalBody: Readonly<Record<string, unknown>>): unknown {
  return {
    journal: fixedJournalValue(source.prior.journal),
    original: source.prior.original,
    recovery: source.prior.recovery,
    recoveryApproval: source.prior.recoveryApproval,
    priorCertificate: source.priorCertificate,
    priorProposal: source.priorProposal,
    priorApproval: approvalBody,
  };
}

export function hashUsdcRecycleContinuationSource(source: UsdcRecycleContinuationSource): Hex {
  const approvalBody = assertOpaqueAuthority(source);
  const mode = sourceSnapshots.get(source.prior.journal)?.mode;
  if (!mode) throw new Error("USDC recycle source journal is not read-only tracked");
  assertSourceSnapshot(source.prior.journal, mode);
  return publicHash(sourceHashValue(source, approvalBody));
}

function assertSource(source: UsdcRecycleContinuationSource, mode: "initial" | "pinned"): Hex {
  assertSourceSnapshot(source.prior.journal, mode);
  const approvalBody = assertOpaqueAuthority(source);
  const attached = source.prior.journal.usdcSuccessor!;
  if (!same(attached.certificateHash, source.priorCertificate.certificateHash) || !same(attached.proposalHash, source.priorProposal.proposalHash) || !same(attached.approvalHash, source.priorApproval.approvalHash)) throw new Error("USDC recycle journal attachment and old opaque authority differ");
  for (let index = 0; index < 19; index++) if (attached.actions[index]?.id !== source.priorProposal.actions[index]?.id || !same(attached.actions[index]!.commitment, source.priorProposal.actions[index]!.commitment)) throw new Error("USDC recycle old proposal descriptor or attachment drifted");
  return publicHash(sourceHashValue(source, approvalBody));
}

function validatePrimary(primary: UsdcRecycleContinuationPrimaryEvidence, source: UsdcRecycleContinuationSource): Hex {
  if (!same(rawSha256(primary.manifest), PRIMARY_MANIFEST_HASH) || !same(rawSha256(primary.stepUpLedger), PRIMARY_LEDGER_HASH) || !same(rawSha256(primary.stepUpAcknowledgement), PRIMARY_ACK_HASH)) throw new Error("USDC recycle primary manifest or evidence hash mismatch");
  const manifest = parseJson(primary.manifest, "USDC recycle primary manifest"); exactKeys(manifest, ["schemaVersion", "scope", "files"], "USDC recycle primary manifest");
  if (manifest.schemaVersion !== 1 || manifest.scope !== "USDC_RECYCLE_SOURCE_PRIMARY_V1" || !Array.isArray(manifest.files) || manifest.files.length !== 3) throw new Error("USDC recycle primary manifest identity mismatch");
  const expectedFiles = [
    ["source-journal.public.json", 56_828, SOURCE_JOURNAL_BYTES_SHA256],
    ["source-step-up-ledger.public.json", 1_114, PRIMARY_LEDGER_HASH],
    ["source-step-up-ack.public.json", 538, PRIMARY_ACK_HASH],
  ] as const;
  manifest.files.forEach((raw, index) => { const value = record(raw, `primary manifest file ${index}`); exactKeys(value, ["file", "bytes", "sha256"], `primary manifest file ${index}`); const expected = expectedFiles[index]!; if (value.file !== expected[0] || value.bytes !== expected[1] || !same(hash(value.sha256, "primary file hash"), expected[2])) throw new Error("USDC recycle primary manifest file binding mismatch"); });
  const ledger = parseJson(primary.stepUpLedger, "USDC recycle step-up ledger"); exactKeys(ledger, ["records", "outbox", "deliveries", "cursor"], "USDC recycle step-up ledger");
  if (Object.keys(record(ledger.outbox, "USDC recycle step-up outbox")).length !== 0) throw new Error("USDC recycle step-up watcher outbox is not empty");
  const records = record(ledger.records, "USDC recycle step-up records"), deliveries = record(ledger.deliveries, "USDC recycle step-up deliveries");
  if (Object.keys(records).length !== 1 || Object.keys(deliveries).length !== 1) throw new Error("USDC recycle step-up watcher requires one exact record and delivery");
  const key = Object.keys(records)[0]!, alert = hydrateActivityAlert(records[key]);
  const oldStepUp = source.prior.journal.usdcSuccessor!.actions[1] as Record<string, any>;
  if (alert.kind !== "step-up-executed" || alert.chainId !== CHAIN_ID || !same(alert.safe, source.prior.original.safe) || !same(alert.guard, source.prior.original.guard) || !same(alert.transactionHash, String(oldStepUp.transactionHash)) || alert.blockNumber !== BigInt(oldStepUp.receipt.blockNumber) || !same(alert.token, source.prior.original.usdc) || !same(alert.recipient, source.prior.original.funder) || alert.amount !== 10_000_000n || alert.baseSpent !== 10_000_000n || alert.instantSpent !== 20_000_000n || alert.window !== PERIOD) throw new Error("USDC recycle step-up watcher payload mismatch");
  const delivery = record(deliveries[key], "USDC recycle step-up delivery"); exactKeys(delivery, ["channel", "httpStatus", "payloadHash", "deliveredAt"], "USDC recycle step-up delivery");
  const payloadHash = publicAlertPayloadHash(alert);
  if (delivery.channel !== "webhook" || delivery.httpStatus !== 200 || !same(hash(delivery.payloadHash, "delivery payload hash"), payloadHash)) throw new Error("USDC recycle step-up delivery binding mismatch");
  const ack = parseJson(primary.stepUpAcknowledgement, "USDC recycle step-up acknowledgement"); exactKeys(ack, ["schemaVersion", "endpointHash", "transactionHash", "payloadSha256", "receiverRequestId", "receiverRecordedAt", "retrievedAt", "retrievalProvenance", "expiresAt"], "USDC recycle step-up acknowledgement");
  const observer = source.priorProposal.observer;
  if (ack.schemaVersion !== 1 || ack.retrievalProvenance !== "official-receiver-api" || !same(hash(ack.endpointHash, "ack endpoint"), observer.endpointHash) || !same(hash(ack.transactionHash, "ack transaction"), alert.transactionHash) || !same(hash(ack.payloadSha256, "ack payload"), payloadHash)) throw new Error("USDC recycle official acknowledgement binding mismatch");
  const delivered = Date.parse(String(delivery.deliveredAt)), recorded = Date.parse(String(ack.receiverRecordedAt)), retrieved = Date.parse(String(ack.retrievedAt)), expires = Date.parse(String(ack.expiresAt));
  const readyMs = Number(BigInt(observer.readyAt) * 1_000n), expiresMs = Number(BigInt(observer.expiresAt) * 1_000n);
  if (![delivered, recorded, retrieved, expires].every(Number.isFinite) || delivered < readyMs || recorded < readyMs || delivered > expiresMs || recorded > expiresMs || retrieved < recorded || expires !== expiresMs) throw new Error("USDC recycle acknowledgement delivery or expiry window mismatch");
  return publicHash({ manifest: PRIMARY_MANIFEST_HASH, sourceJournal: SOURCE_JOURNAL_BYTES_SHA256, stepUpLedger: PRIMARY_LEDGER_HASH, stepUpAcknowledgement: PRIMARY_ACK_HASH });
}

function assertBlock(actual: UsdcSuccessorCanonicalBlock, expected: UsdcSuccessorCanonicalBlock, label: string): void {
  if (actual.number !== expected.number || !same(actual.hash, expected.hash) || actual.timestamp !== expected.timestamp) throw new Error(`${label} canonical block mismatch`);
}

function expectedCurrentState(source: UsdcRecycleContinuationSource, block: UsdcSuccessorCanonicalBlock): UsdcSuccessorCanonicalState {
  const original = source.prior.original;
  return { blockNumber: block.number, blockHash: block.hash, chainId: CHAIN_ID, identityHash: original.publicIdentitiesHash, topologyHash: original.topologyEvidenceHash, policyHash: POLICY_HASH, safe: original.safe, guard: original.guard, delay: original.delay, funder: original.funder, usdc: original.usdc, recipient: original.recipient, primarySigner: original.primarySigner, safeContractSecondary: original.safeContractSecondary, ecdsaSecondary: original.ecdsaSecondary, safeNonce: 10n, delayQueueNonce: 4n, delayTxNonce: 4n, queue: null, safeNativeBalance: 0n, safeUsdcBalance: 0n, funderUsdcBalance: 20_000_000n, nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: PERIOD, baseSpent: 10_000_000n, instantSpent: 20_000_000n } };
}

function expectedReceiptState(source: UsdcRecycleContinuationSource, block: UsdcSuccessorCanonicalBlock, index: number): UsdcSuccessorCanonicalState {
  const current = expectedCurrentState(source, block);
  return index === 0 ? { ...current, safeNonce: 9n, safeUsdcBalance: 10_000_000n, funderUsdcBalance: 10_000_000n, usdcSpend: { window: PERIOD, baseSpent: 10_000_000n, instantSpent: 10_000_000n } } : current;
}

type ProviderView = Readonly<{ snapshot: UsdcSuccessorCanonicalBlock; state: UsdcSuccessorCanonicalState; snapshotNonce: number; latestNonce: number; pendingNonce: number; transactions: readonly UsdcSuccessorCanonicalTransaction[]; receipts: readonly UsdcSuccessorCanonicalReceipt[]; receiptBlocks: readonly UsdcSuccessorCanonicalBlock[]; receiptPostStates: readonly UsdcSuccessorCanonicalState[]; rechecks: readonly (UsdcSuccessorCanonicalBlock | undefined)[] }>;
async function readView(provider: UsdcSuccessorEvidenceProvider, source: UsdcRecycleContinuationSource, snapshotNumber: bigint, recordedNonces?: Readonly<{ latestNonce: number; pendingNonce: number }>): Promise<ProviderView> {
  const snapshot = await provider.readBlock(snapshotNumber); if (!snapshot) throw new Error("USDC recycle snapshot block is missing");
  const state = await provider.readControlledState(snapshotNumber), snapshotNonce = await provider.readTransactionCount(state.funder, snapshotNumber);
  const [latestNonce, pendingNonce] = recordedNonces ? [recordedNonces.latestNonce, recordedNonces.pendingNonce] : await Promise.all([provider.readTransactionCount(state.funder, "latest"), provider.readTransactionCount(state.funder, "pending")]);
  const oldRows = source.prior.journal.usdcSuccessor!.actions.slice(0, 2) as Array<Record<string, any>>;
  const hashes = [...oldRows.map(row => row.transactionHash as Hex), INVALIDATION_HASH];
  const transactions: UsdcSuccessorCanonicalTransaction[] = [], receipts: UsdcSuccessorCanonicalReceipt[] = [], receiptBlocks: UsdcSuccessorCanonicalBlock[] = [], receiptPostStates: UsdcSuccessorCanonicalState[] = [];
  for (const transactionHash of hashes) {
    const [transaction, receipt] = await Promise.all([provider.readTransaction(transactionHash), provider.readReceipt(transactionHash)]); if (!transaction || !receipt) throw new Error("USDC recycle canonical transaction or receipt is missing");
    const block = await provider.readBlock(receipt.blockNumber); if (!block) throw new Error("USDC recycle receipt block is missing");
    transactions.push(transaction); receipts.push(receipt); receiptBlocks.push(block); receiptPostStates.push(await provider.readControlledState(receipt.blockNumber));
  }
  const rechecks = await Promise.all([provider.readBlock(snapshotNumber), ...receiptBlocks.map(block => provider.readBlock(block.number))]);
  return { snapshot, state, snapshotNonce, latestNonce, pendingNonce, transactions, receipts, receiptBlocks, receiptPostStates, rechecks };
}

function assertView(view: ProviderView, source: UsdcRecycleContinuationSource): Readonly<{ priorReceipts: readonly ReceiptEvidence[]; invalidation: InvalidationEvidence }> {
  if (view.snapshot.timestamp < PERIOD || view.snapshot.timestamp >= PERIOD_END) throw new Error("USDC recycle canonical snapshot is outside the fixed USDC period");
  if (publicHash(view.state) !== publicHash(expectedCurrentState(source, view.snapshot))) throw new Error("USDC recycle canonical profile, topology, policy, balance, nonce, queue, or raw state mismatch");
  if (view.snapshotNonce < 870 || view.snapshotNonce !== view.latestNonce || view.snapshotNonce !== view.pendingNonce) throw new Error("USDC recycle checkpoint nonce must satisfy snapshot=latest=pending>=870");
  const oldRows = source.prior.journal.usdcSuccessor!.actions.slice(0, 2) as Array<Record<string, any>>;
  const priorReceipts = oldRows.map((row, index) => {
    const transaction = view.transactions[index]!, receipt = view.receipts[index]!, block = view.receiptBlocks[index]!, postState = view.receiptPostStates[index]!, inclusion = row.receiptInclusion;
    if (view.snapshot.number - block.number + 1n < 6n) throw new Error("USDC recycle old receipt has fewer than six confirmations");
    if (transaction.type !== "eip1559" || !same(transaction.hash, row.transactionHash) || !same(transaction.from, source.prior.original.funder) || transaction.nonce !== row.outerNonce || transaction.to === null || !same(transaction.to, row.outerTo) || transaction.value !== BigInt(row.outerValue) || !same(transaction.inputHash, row.outerDataHash) || transaction.gas !== BigInt(row.gas) || transaction.chainId !== CHAIN_ID || transaction.maxFeePerGas !== BigInt(row.maxFeePerGas) || transaction.maxPriorityFeePerGas !== BigInt(row.maxPriorityFeePerGas) || transaction.blockNumber !== BigInt(row.receipt.blockNumber) || !same(transaction.blockHash, row.receipt.blockHash)) throw new Error("USDC recycle old canonical type-2 transaction envelope mismatch");
    if (!same(receipt.transactionHash, row.transactionHash) || receipt.status !== "success" || receipt.blockNumber !== BigInt(row.receipt.blockNumber) || !same(receipt.blockHash, row.receipt.blockHash) || receipt.gasUsed !== BigInt(row.receipt.gasUsed) || receipt.effectiveGasPrice !== BigInt(row.receipt.effectiveGasPrice) || receipt.gasUsed * receipt.effectiveGasPrice !== BigInt(row.ourReceiptGasCost)) throw new Error("USDC recycle old canonical receipt or gas product mismatch");
    if (block.timestamp !== BigInt(inclusion.blockTimestamp) || BigInt(inclusion.effectivePeriod) !== PERIOD || block.timestamp < PERIOD || block.timestamp >= PERIOD_END) throw new Error("USDC recycle old receipt canonical inclusion period mismatch");
    if (publicHash(postState) !== publicHash(expectedReceiptState(source, block, index))) throw new Error("USDC recycle old receipt exact poststate effect mismatch");
    return Object.freeze({ id: row.id, transactionHash: transaction.hash, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, gasCost: receipt.gasUsed * receipt.effectiveGasPrice, postStateHash: publicHash(postState) });
  });
  const index = 2, transaction = view.transactions[index]!, receipt = view.receipts[index]!, block = view.receiptBlocks[index]!, postState = view.receiptPostStates[index]!;
  const stopped = source.prior.journal.usdcSuccessor!.actions[2] as Record<string, any>;
  const matchesStopped = transaction.type === "eip1559" && transaction.to !== null && same(transaction.to, stopped.outerTo) && transaction.value === BigInt(stopped.outerValue) && same(transaction.inputHash, stopped.outerDataHash) && transaction.gas === BigInt(stopped.gas) && transaction.maxFeePerGas === BigInt(stopped.maxFeePerGas) && transaction.maxPriorityFeePerGas === BigInt(stopped.maxPriorityFeePerGas);
  if (matchesStopped) throw new Error(`MATCH_FOUND_RECONCILE:${transaction.hash}`);
  if (view.snapshot.number - block.number + 1n < 6n) throw new Error("USDC recycle nonce-869 invalidation has fewer than six confirmations");
  if (transaction.type !== "legacy" || !same(transaction.hash, INVALIDATION_HASH) || !same(transaction.from, source.prior.original.funder) || transaction.nonce !== 869 || transaction.to === null || !same(transaction.to, INVALIDATION_TO) || transaction.value !== 0n || !same(transaction.inputHash, INVALIDATION_INPUT_HASH) || transaction.gas !== 1_820_162n || transaction.chainId !== CHAIN_ID || transaction.gasPrice !== 100_000n || transaction.v !== 22_310_258n || transaction.blockNumber !== INVALIDATION_BLOCK.number || !same(transaction.blockHash, INVALIDATION_BLOCK.hash)) throw new Error("USDC recycle exact legacy nonce-869 transaction or recovered sender mismatch");
  assertBlock(block, INVALIDATION_BLOCK, "USDC recycle invalidation receipt");
  if (!same(receipt.transactionHash, INVALIDATION_HASH) || receipt.status !== "success" || receipt.blockNumber !== INVALIDATION_BLOCK.number || !same(receipt.blockHash, INVALIDATION_BLOCK.hash) || receipt.gasUsed !== 1_247_851n || receipt.effectiveGasPrice !== 100_000n || receipt.gasUsed * receipt.effectiveGasPrice !== INVALIDATION_COST) throw new Error("USDC recycle invalidation receipt gas product mismatch");
  if (publicHash(postState) !== publicHash(expectedReceiptState(source, block, 2))) throw new Error("USDC recycle invalidation exact poststate effect mismatch");
  const invalidation = Object.freeze({ transactionHash: INVALIDATION_HASH, recoveredSender: transaction.from, nonce: 869 as const, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, gasCost: INVALIDATION_COST, confirmations: view.snapshot.number - block.number + 1n, postStateHash: publicHash(postState), cause: "UNKNOWN" as const });
  return Object.freeze({ priorReceipts: Object.freeze(priorReceipts), invalidation });
}

function assertRechecks(view: ProviderView): void {
  for (let index = 0; index < view.rechecks.length; index++) { const before = index === 0 ? view.snapshot : view.receiptBlocks[index - 1]!, after = view.rechecks[index]; if (!after || publicHash(before) !== publicHash(after)) throw new Error("USDC recycle canonical recheck detected a reorg"); }
}

async function verifyPinned(source: UsdcRecycleContinuationSource, primary: UsdcRecycleContinuationPrimaryEvidence, providers: readonly [UsdcSuccessorEvidenceProvider, UsdcSuccessorEvidenceProvider], block: UsdcSuccessorCanonicalBlock, mode: "initial" | "pinned", recorded?: Readonly<{ stateHash: Hex; snapshotNonce: number; latestNonce: number; pendingNonce: number; priorReceipts: readonly ReceiptEvidence[]; invalidation: InvalidationEvidence }>, historicalNonces?: Readonly<{ latestNonce: number; pendingNonce: number }>) {
  const sourceHash = assertSource(source, mode), primaryEvidenceHash = validatePrimary(primary, source);
  if (!Array.isArray(providers) || providers.length !== 2 || providers[0] === providers[1]) throw new Error("USDC recycle certificate requires two independent providers");
  const nonces = recorded ? { latestNonce: recorded.latestNonce, pendingNonce: recorded.pendingNonce } : historicalNonces;
  const views = await Promise.all([readView(providers[0], source, block.number, nonces), readView(providers[1], source, block.number, nonces)] as const);
  assertBlock(views[0].snapshot, block, "USDC recycle snapshot"); assertBlock(views[1].snapshot, block, "USDC recycle snapshot");
  const evidence = assertView(views[0], source), second = assertView(views[1], source); assertRechecks(views[0]); assertRechecks(views[1]);
  const comparable = (view: ProviderView) => ({ snapshot: view.snapshot, state: view.state, snapshotNonce: view.snapshotNonce, latestNonce: view.latestNonce, pendingNonce: view.pendingNonce, transactions: view.transactions, receipts: view.receipts, receiptBlocks: view.receiptBlocks, receiptPostStates: view.receiptPostStates });
  if (publicHash(comparable(views[0])) !== publicHash(comparable(views[1])) || publicHash(evidence) !== publicHash(second)) throw new Error("USDC recycle providers disagree on canonical evidence");
  if (recorded && (!same(publicHash(views[0].state), recorded.stateHash) || views[0].snapshotNonce !== recorded.snapshotNonce || views[0].latestNonce !== recorded.latestNonce || views[0].pendingNonce !== recorded.pendingNonce || publicHash(evidence.priorReceipts) !== publicHash(recorded.priorReceipts) || publicHash(evidence.invalidation) !== publicHash(recorded.invalidation))) throw new Error("USDC recycle recorded pinned history mismatch");
  assertSource(source, mode);
  return { sourceHash, primaryEvidenceHash, views, ...evidence };
}

export type VerifiedUsdcRecycleHistoricalEvidence = Readonly<{
  sourceHash: Hex;
  primaryEvidenceHash: Hex;
  snapshot: UsdcSuccessorCanonicalBlock;
  state: UsdcSuccessorCanonicalState;
  snapshotNonce: number;
  latestNonce: number;
  pendingNonce: number;
  priorReceipts: readonly ReceiptEvidence[];
  invalidation: InvalidationEvidence;
}>;

/** Revalidates the immutable stopped source at its fixed recorded canonical boundary. */
export async function verifyUsdcRecycleHistoricalEvidence(
  source: UsdcRecycleContinuationSource,
  primary: UsdcRecycleContinuationPrimaryEvidence,
  providers: readonly [UsdcSuccessorEvidenceProvider, UsdcSuccessorEvidenceProvider],
): Promise<VerifiedUsdcRecycleHistoricalEvidence> {
  const snapshotNonces = await Promise.all(providers.map(provider => provider.readTransactionCount(source.prior.original.funder, HISTORICAL_SOURCE_SNAPSHOT.number)));
  if (snapshotNonces[0] !== snapshotNonces[1]) throw new Error("USDC recycle historical snapshot nonce providers disagree");
  const pinned = await verifyPinned(source, primary, providers, HISTORICAL_SOURCE_SNAPSHOT, "initial", undefined, { latestNonce: snapshotNonces[0]!, pendingNonce: snapshotNonces[0]! });
  const first = pinned.views[0];
  return Object.freeze({
    sourceHash: pinned.sourceHash,
    primaryEvidenceHash: pinned.primaryEvidenceHash,
    snapshot: first.snapshot,
    state: Object.freeze(structuredClone(first.state)),
    snapshotNonce: first.snapshotNonce,
    latestNonce: first.latestNonce,
    pendingNonce: first.pendingNonce,
    priorReceipts: pinned.priorReceipts,
    invalidation: pinned.invalidation,
  });
}

export async function verifyUsdcRecycleContinuationCertificate(source: UsdcRecycleContinuationSource, primary: UsdcRecycleContinuationPrimaryEvidence, providers: readonly [UsdcSuccessorEvidenceProvider, UsdcSuccessorEvidenceProvider]): Promise<VerifiedUsdcRecycleContinuationCertificate> {
  assertSource(source, "initial"); validatePrimary(primary, source);
  if (providers.length !== 2 || providers[0] === providers[1]) throw new Error("USDC recycle certificate requires two independent providers");
  const tips = await Promise.all([providers[0].readLatestBlock(), providers[1].readLatestBlock()] as const), minimum = tips[0].number <= tips[1].number ? tips[0] : tips[1];
  if (minimum.number < 5n) throw new Error("USDC recycle provider tip is too low");
  const snapshotNumber = minimum.number - 5n;
  const blocks = await Promise.all([providers[0].readBlock(snapshotNumber), providers[1].readBlock(snapshotNumber)] as const);
  if (!blocks[0] || !blocks[1]) throw new Error("USDC recycle snapshot block is missing");
  if (tips.some(tip => tip.number - snapshotNumber + 1n < 6n) || publicHash(blocks[0]) !== publicHash(blocks[1])) throw new Error("USDC recycle providers disagree on the canonical min-head-minus-five snapshot");
  const pinned = await verifyPinned(source, primary, providers, blocks[0], "initial");
  const state = pinned.views[0].state, stateHash = publicHash(state), checkpoint = Object.freeze({ blockNumber: blocks[0].number.toString(), blockHash: blocks[0].hash, stateHash, snapshotNonce: pinned.views[0].snapshotNonce, latestNonce: pinned.views[0].latestNonce, pendingNonce: pinned.views[0].pendingNonce });
  const body = { kind: "VERIFIED_USDC_RECYCLE_CONTINUATION_CERTIFICATE" as const, sourceHash: pinned.sourceHash, sourceJournalBytesSha256: SOURCE_JOURNAL_BYTES_SHA256, primaryEvidenceHash: pinned.primaryEvidenceHash, effectivePeriod: PERIOD, snapshot: Object.freeze({ blockNumber: blocks[0].number.toString(), blockHash: blocks[0].hash, timestamp: blocks[0].timestamp.toString(), stateHash }), currentCheckpoint: checkpoint, rawNativeSpend: Object.freeze({ ...state.nativeSpend }), rawUsdcSpend: Object.freeze({ ...state.usdcSpend }), priorReceipts: Object.freeze([...pinned.priorReceipts]), invalidation: pinned.invalidation, priorActualGasCostWei: PRIOR_ACTUAL_COST, aggregateKnownChargeWei: AGGREGATE_KNOWN_CHARGE };
  const certificate = Object.freeze({ ...body, certificateHash: publicHash(body) }) as VerifiedUsdcRecycleContinuationCertificate;
  assertSource(source, "initial"); verifiedCertificates.add(certificate); return certificate;
}

export function isVerifiedUsdcRecycleContinuationCertificate(value: unknown): value is VerifiedUsdcRecycleContinuationCertificate { return !!value && typeof value === "object" && verifiedCertificates.has(value as object); }
export function serializeUsdcRecycleContinuationCertificate(certificate: VerifiedUsdcRecycleContinuationCertificate): string { if (!isVerifiedUsdcRecycleContinuationCertificate(certificate)) throw new Error("USDC recycle certificate is not runtime verified"); return `${JSON.stringify(publicValue(certificate))}\n`; }

function decodeReceipt(raw: unknown, label: string): ReceiptEvidence {
  const value = record(raw, label); exactKeys(value, ["id", "transactionHash", "blockNumber", "blockHash", "blockTimestamp", "gasUsed", "effectiveGasPrice", "gasCost", "postStateHash"], label);
  return Object.freeze({ id: String(value.id), transactionHash: hash(value.transactionHash, `${label} hash`), blockNumber: decimal(value.blockNumber, `${label} block`), blockHash: hash(value.blockHash, `${label} block hash`), blockTimestamp: decimal(value.blockTimestamp, `${label} timestamp`), gasUsed: decimal(value.gasUsed, `${label} gas used`), effectiveGasPrice: decimal(value.effectiveGasPrice, `${label} gas price`), gasCost: decimal(value.gasCost, `${label} gas cost`), postStateHash: hash(value.postStateHash, `${label} poststate`) });
}

function decodeCertificate(serialized: string, expectedHash: Hex): VerifiedUsdcRecycleContinuationCertificate {
  const value = parseJson(serialized, "USDC recycle recorded certificate");
  exactKeys(value, ["kind", "sourceHash", "sourceJournalBytesSha256", "primaryEvidenceHash", "effectivePeriod", "snapshot", "currentCheckpoint", "rawNativeSpend", "rawUsdcSpend", "priorReceipts", "invalidation", "priorActualGasCostWei", "aggregateKnownChargeWei", "certificateHash"], "USDC recycle recorded certificate");
  const snapshotValue = record(value.snapshot, "recorded snapshot"); exactKeys(snapshotValue, ["blockNumber", "blockHash", "timestamp", "stateHash"], "recorded snapshot");
  const checkpointValue = record(value.currentCheckpoint, "recorded checkpoint"); exactKeys(checkpointValue, ["blockNumber", "blockHash", "stateHash", "snapshotNonce", "latestNonce", "pendingNonce"], "recorded checkpoint");
  const snapshot = Object.freeze({ blockNumber: String(snapshotValue.blockNumber), blockHash: hash(snapshotValue.blockHash, "recorded snapshot hash"), timestamp: String(snapshotValue.timestamp), stateHash: hash(snapshotValue.stateHash, "recorded snapshot state hash") });
  if (!DECIMAL.test(snapshot.blockNumber) || !DECIMAL.test(snapshot.timestamp)) throw new Error("recorded snapshot decimal shape mismatch");
  const currentCheckpoint = Object.freeze({ blockNumber: String(checkpointValue.blockNumber), blockHash: hash(checkpointValue.blockHash, "recorded checkpoint hash"), stateHash: hash(checkpointValue.stateHash, "recorded checkpoint state hash"), snapshotNonce: integer(checkpointValue.snapshotNonce, "recorded snapshot nonce"), latestNonce: integer(checkpointValue.latestNonce, "recorded latest nonce"), pendingNonce: integer(checkpointValue.pendingNonce, "recorded pending nonce") });
  if (!DECIMAL.test(currentCheckpoint.blockNumber) || currentCheckpoint.blockNumber !== snapshot.blockNumber || !same(currentCheckpoint.blockHash, snapshot.blockHash) || !same(currentCheckpoint.stateHash, snapshot.stateHash)) throw new Error("recorded snapshot and checkpoint mismatch");
  const spend = (raw: unknown, label: string): UsdcSuccessorRawSpend => { const item = record(raw, label); exactKeys(item, ["window", "baseSpent", "instantSpent"], label); return Object.freeze({ window: decimal(item.window, `${label} window`), baseSpent: decimal(item.baseSpent, `${label} base`), instantSpent: decimal(item.instantSpent, `${label} instant`) }); };
  if (!Array.isArray(value.priorReceipts) || value.priorReceipts.length !== 2) throw new Error("recorded prior receipts shape mismatch");
  const priorReceipts = Object.freeze(value.priorReceipts.map((item, index) => decodeReceipt(item, `recorded prior receipt ${index}`)));
  const invalidationValue = record(value.invalidation, "recorded invalidation"); exactKeys(invalidationValue, ["transactionHash", "recoveredSender", "nonce", "blockNumber", "blockHash", "blockTimestamp", "gasUsed", "effectiveGasPrice", "gasCost", "confirmations", "postStateHash", "cause"], "recorded invalidation");
  const invalidation = Object.freeze({ transactionHash: hash(invalidationValue.transactionHash, "recorded invalidation hash"), recoveredSender: String(invalidationValue.recoveredSender) as Address, nonce: integer(invalidationValue.nonce, "recorded invalidation nonce") as 869, blockNumber: decimal(invalidationValue.blockNumber, "recorded invalidation block"), blockHash: hash(invalidationValue.blockHash, "recorded invalidation block hash"), blockTimestamp: decimal(invalidationValue.blockTimestamp, "recorded invalidation timestamp"), gasUsed: decimal(invalidationValue.gasUsed, "recorded invalidation gas"), effectiveGasPrice: decimal(invalidationValue.effectiveGasPrice, "recorded invalidation price"), gasCost: decimal(invalidationValue.gasCost, "recorded invalidation cost"), confirmations: decimal(invalidationValue.confirmations, "recorded invalidation confirmations"), postStateHash: hash(invalidationValue.postStateHash, "recorded invalidation poststate"), cause: invalidationValue.cause as "UNKNOWN" });
  const body = { kind: "VERIFIED_USDC_RECYCLE_CONTINUATION_CERTIFICATE" as const, sourceHash: hash(value.sourceHash, "recorded source hash"), sourceJournalBytesSha256: hash(value.sourceJournalBytesSha256, "recorded source bytes hash") as typeof SOURCE_JOURNAL_BYTES_SHA256, primaryEvidenceHash: hash(value.primaryEvidenceHash, "recorded primary hash"), effectivePeriod: decimal(value.effectivePeriod, "recorded period"), snapshot, currentCheckpoint, rawNativeSpend: spend(value.rawNativeSpend, "recorded native spend"), rawUsdcSpend: spend(value.rawUsdcSpend, "recorded USDC spend"), priorReceipts, invalidation, priorActualGasCostWei: decimal(value.priorActualGasCostWei, "recorded prior actual cost"), aggregateKnownChargeWei: decimal(value.aggregateKnownChargeWei, "recorded aggregate charge") };
  const certificateHash = hash(value.certificateHash, "recorded certificate hash");
  if (value.kind !== body.kind || !same(body.sourceJournalBytesSha256, SOURCE_JOURNAL_BYTES_SHA256) || body.effectivePeriod !== PERIOD || body.priorActualGasCostWei !== PRIOR_ACTUAL_COST || body.aggregateKnownChargeWei !== AGGREGATE_KNOWN_CHARGE || body.invalidation.nonce !== 869 || body.invalidation.cause !== "UNKNOWN" || !same(body.invalidation.transactionHash, INVALIDATION_HASH) || !same(certificateHash, expectedHash) || !same(publicHash(body), certificateHash)) throw new Error("USDC recycle recorded certificate fixed shape or hash mismatch");
  return Object.freeze({ ...body, certificateHash }) as VerifiedUsdcRecycleContinuationCertificate;
}

export async function reverifyUsdcRecycleContinuationCertificate(serialized: string, expectedHash: Hex, source: UsdcRecycleContinuationSource, primary: UsdcRecycleContinuationPrimaryEvidence, providers: readonly [UsdcSuccessorEvidenceProvider, UsdcSuccessorEvidenceProvider]): Promise<VerifiedUsdcRecycleContinuationCertificate> {
  const certificate = decodeCertificate(serialized, expectedHash);
  const block = Object.freeze({ number: BigInt(certificate.snapshot.blockNumber), hash: certificate.snapshot.blockHash, timestamp: BigInt(certificate.snapshot.timestamp) });
  const pinned = await verifyPinned(source, primary, providers, block, "pinned", { stateHash: certificate.currentCheckpoint.stateHash, snapshotNonce: certificate.currentCheckpoint.snapshotNonce, latestNonce: certificate.currentCheckpoint.latestNonce, pendingNonce: certificate.currentCheckpoint.pendingNonce, priorReceipts: certificate.priorReceipts, invalidation: certificate.invalidation });
  if (!same(pinned.sourceHash, certificate.sourceHash) || !same(pinned.primaryEvidenceHash, certificate.primaryEvidenceHash) || publicHash(certificate.rawNativeSpend) !== publicHash(pinned.views[0].state.nativeSpend) || publicHash(certificate.rawUsdcSpend) !== publicHash(pinned.views[0].state.usdcSpend)) throw new Error("USDC recycle recorded certificate source, primary, or raw state mismatch");
  assertSource(source, "pinned"); verifiedCertificates.add(certificate); return certificate;
}
