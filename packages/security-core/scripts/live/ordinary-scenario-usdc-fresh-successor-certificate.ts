import type { Address, Hex } from "viem";
import { sha256 } from "../plan-deployment";
import {
  hashUsdcRecycleContinuationSource,
  hashUsdcRecycleContinuationSourceValue,
  verifyUsdcRecycleHistoricalEvidence,
  type UsdcRecycleContinuationPrimaryEvidence,
  type UsdcRecycleContinuationSource,
  type VerifiedUsdcRecycleHistoricalEvidence,
} from "./ordinary-scenario-usdc-recycle-continuation-certificate";
import type {
  UsdcSuccessorCanonicalBlock,
  UsdcSuccessorCanonicalReceipt,
  UsdcSuccessorCanonicalState,
  UsdcSuccessorCanonicalTransaction,
  UsdcSuccessorEvidenceProvider,
  UsdcSuccessorRawSpend,
} from "./ordinary-scenario-usdc-successor-certificate";

export const FRESH_SUCCESSOR_SCOPE = "ordinary-usdc-fresh-period-successor-v1" as const;
export const FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH =
  "0x6230026c81cc67ce4aa3cf713838875c7b1d770cbe0f9b48b7b4b3b49f1a59fa" as Hex;

const CHAIN_ID = 11_155_111;
const OLD_PERIOD = 1_793_232_000n;
const PERIOD_SECONDS = 86_400n;
const FAUCET_BLOCK = Object.freeze({ number: 12_026_817n, hash: "0x8bda9049010367bff921be7b89c281c6f30367af9534743463a61859aefe1d83" as Hex, timestamp: 1_793_365_008n });
const FAUCET = "0xd844ba11f64d23a7481e24474d2f184e350b9b3d" as Address;
const FUNDER = "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address;
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238" as Address;
const FAUCET_INPUT_HASH = "0xb55612dc53b2c541469c774e8e4238a2a94d376826a7d8ebe099e02dd578a53b" as Hex;
const FAUCET_AMOUNT = 20_000_000n;
const AGGREGATE_KNOWN_CHARGE = 124_953_955_544n;

type FaucetEvidence = Readonly<{
  transactionHash: typeof FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH;
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestamp: bigint;
  sender: Address;
  token: Address;
  recipient: Address;
  amount: bigint;
  logIndex: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  preBalance: bigint;
  postBalance: bigint;
}>;

export type UsdcFreshSuccessorTransferLog = Readonly<{
  address: Address;
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  logIndex: number;
  removed: boolean;
  from: Address;
  to: Address;
  amount: bigint;
}>;

export type UsdcFreshSuccessorEvidenceProvider = UsdcSuccessorEvidenceProvider & Readonly<{
  readFaucetTransferLog(hash: Hex): Promise<UsdcFreshSuccessorTransferLog | undefined>;
}>;

declare const certificateBrand: unique symbol;
export type VerifiedUsdcFreshSuccessorCertificate = Readonly<{
  kind: "VERIFIED_USDC_FRESH_SUCCESSOR_CERTIFICATE";
  scope: typeof FRESH_SUCCESSOR_SCOPE;
  sourceHash: Hex;
  primaryEvidenceHash: Hex;
  historicalSnapshot: UsdcSuccessorCanonicalBlock;
  effectivePeriod: bigint;
  snapshot: Readonly<{ blockNumber: string; blockHash: Hex; timestamp: string; stateHash: Hex }>;
  currentCheckpoint: Readonly<{ blockNumber: string; blockHash: Hex; stateHash: Hex; snapshotNonce: number; latestNonce: number; pendingNonce: number }>;
  rawNativeSpend: UsdcSuccessorRawSpend;
  rawUsdcSpend: UsdcSuccessorRawSpend;
  safeUsdcBalance: bigint;
  funderUsdcBalance: bigint;
  priorActualGasCostWei: bigint;
  aggregateKnownChargeWei: bigint;
  faucet: FaucetEvidence;
  certificateHash: Hex;
  readonly [certificateBrand]: true;
}>;

type ProviderView = Readonly<{
  snapshot: UsdcSuccessorCanonicalBlock;
  state: UsdcSuccessorCanonicalState;
  snapshotNonce: number;
  latestNonce: number;
  pendingNonce: number;
  faucetTransaction: UsdcSuccessorCanonicalTransaction;
  faucetReceipt: UsdcSuccessorCanonicalReceipt;
  faucetBlock: UsdcSuccessorCanonicalBlock;
  faucetPreState: UsdcSuccessorCanonicalState;
  faucetPostState: UsdcSuccessorCanonicalState;
  faucetTransferLog: UsdcFreshSuccessorTransferLog;
  snapshotRecheck: UsdcSuccessorCanonicalBlock;
  faucetRecheck: UsdcSuccessorCanonicalBlock;
}>;

type RecordedCheckpoint = VerifiedUsdcFreshSuccessorCertificate["currentCheckpoint"];
export type UsdcFreshSuccessorKnownPendingReconciliation = Readonly<{ outerNonce: number }>;

const verifiedCertificates = new WeakSet<object>();
const verifiedSourceHashes = new WeakMap<object, Hex>();
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const publicHash = (value: unknown): Hex => sha256(publicValue(value)) as Hex;

export function hashUsdcFreshSuccessorSource(source: UsdcRecycleContinuationSource): Hex {
  const current = hashUsdcRecycleContinuationSourceValue(source), verified = verifiedSourceHashes.get(source);
  if (verified !== undefined) { if (!same(current, verified)) throw new Error("fresh successor verified source changed in memory"); return current; }
  const strict = hashUsdcRecycleContinuationSource(source); if (!same(strict, current)) throw new Error("fresh successor stable source and in-memory source disagree"); return strict;
}

function exactState(historical: VerifiedUsdcRecycleHistoricalEvidence, block: UsdcSuccessorCanonicalBlock, funderUsdcBalance: bigint): UsdcSuccessorCanonicalState {
  return Object.freeze({ ...structuredClone(historical.state), blockNumber: block.number, blockHash: block.hash, funderUsdcBalance });
}

function assertBlock(actual: UsdcSuccessorCanonicalBlock | undefined, expected: UsdcSuccessorCanonicalBlock, label: string): asserts actual is UsdcSuccessorCanonicalBlock {
  if (!actual || actual.number !== expected.number || !same(actual.hash, expected.hash) || actual.timestamp !== expected.timestamp) throw new Error(`${label} canonical block mismatch`);
}

async function readView(provider: UsdcFreshSuccessorEvidenceProvider, snapshot: UsdcSuccessorCanonicalBlock): Promise<ProviderView> {
  const [state, snapshotNonce, faucetTransaction, faucetReceipt, faucetBlock, faucetPreState, faucetPostState, faucetTransferLog] = await Promise.all([
    provider.readControlledState(snapshot.number),
    provider.readTransactionCount(FUNDER, snapshot.number),
    provider.readTransaction(FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH),
    provider.readReceipt(FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH),
    provider.readBlock(FAUCET_BLOCK.number),
    provider.readControlledState(FAUCET_BLOCK.number - 1n),
    provider.readControlledState(FAUCET_BLOCK.number),
    provider.readFaucetTransferLog(FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH),
  ]);
  if (!faucetTransaction || !faucetReceipt || !faucetBlock || !faucetTransferLog) throw new Error("fresh successor faucet canonical receipt or transfer log evidence is missing");
  const [latestNonce, pendingNonce, snapshotRecheck, faucetRecheck] = await Promise.all([
    provider.readTransactionCount(FUNDER, "latest"),
    provider.readTransactionCount(FUNDER, "pending"),
    provider.readBlock(snapshot.number),
    provider.readBlock(FAUCET_BLOCK.number),
  ]);
  if (!snapshotRecheck || !faucetRecheck) throw new Error("fresh successor canonical recheck is missing");
  return { snapshot, state, snapshotNonce, latestNonce, pendingNonce, faucetTransaction, faucetReceipt, faucetBlock, faucetPreState, faucetPostState, faucetTransferLog, snapshotRecheck, faucetRecheck };
}

function assertView(view: ProviderView, historical: VerifiedUsdcRecycleHistoricalEvidence, recorded?: RecordedCheckpoint, reconciliation?: UsdcFreshSuccessorKnownPendingReconciliation): FaucetEvidence {
  if (publicHash(view.state) !== publicHash(exactState(historical, view.snapshot, 40_000_000n))) throw new Error("fresh successor current profile, state, or funder balance mismatch");
  if (view.snapshotNonce < historical.snapshotNonce) throw new Error("fresh successor checkpoint nonce is below the historical lower bound");
  if (recorded) {
    const resolved = reconciliation === undefined && view.latestNonce === view.pendingNonce;
    const knownMempool = reconciliation !== undefined && view.latestNonce === reconciliation.outerNonce && view.pendingNonce >= view.latestNonce && view.pendingNonce <= reconciliation.outerNonce + 1;
    const resolvedProgress = reconciliation !== undefined && view.latestNonce > reconciliation.outerNonce && view.pendingNonce === view.latestNonce;
    const knownPending = reconciliation !== undefined && Number.isSafeInteger(reconciliation.outerNonce) && reconciliation.outerNonce >= recorded.latestNonce && (knownMempool || resolvedProgress);
    if (view.snapshotNonce !== recorded.snapshotNonce || view.latestNonce < recorded.latestNonce || view.pendingNonce < recorded.pendingNonce || (!resolved && !knownPending)) throw new Error("fresh successor recorded checkpoint nonce regressed or has unresolved pending activity");
  } else if (view.snapshotNonce !== view.latestNonce || view.snapshotNonce !== view.pendingNonce) {
    throw new Error("fresh successor checkpoint nonce must satisfy snapshot=latest=pending");
  }
  const tx = view.faucetTransaction;
  if (tx.type !== "eip1559" || !same(tx.hash, FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH) || !same(tx.from, FAUCET) || tx.nonce !== 1_059_380 || tx.to === null || !same(tx.to, USDC) || tx.value !== 0n || !same(tx.inputHash, FAUCET_INPUT_HASH) || tx.gas !== 73_785n || tx.chainId !== CHAIN_ID || tx.maxFeePerGas !== 1_000_000_015n || tx.maxPriorityFeePerGas !== 999_999_985n || tx.blockNumber !== FAUCET_BLOCK.number || !same(tx.blockHash, FAUCET_BLOCK.hash)) throw new Error("fresh successor faucet transaction, token, input, or transfer mismatch");
  const receipt = view.faucetReceipt;
  if (!same(receipt.transactionHash, FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH) || receipt.status !== "success" || receipt.blockNumber !== FAUCET_BLOCK.number || !same(receipt.blockHash, FAUCET_BLOCK.hash) || receipt.gasUsed !== 53_859n || receipt.effectiveGasPrice !== 1_000_000_000n) throw new Error("fresh successor faucet receipt or gas mismatch");
  assertBlock(view.faucetBlock, FAUCET_BLOCK, "fresh successor faucet");
  const log = view.faucetTransferLog;
  if (!same(log.address, USDC) || !same(log.transactionHash, FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH) || log.blockNumber !== FAUCET_BLOCK.number || !same(log.blockHash, FAUCET_BLOCK.hash) || log.logIndex !== 299 || log.removed !== false || !same(log.from, FAUCET) || !same(log.to, FUNDER) || log.amount !== FAUCET_AMOUNT) throw new Error("fresh successor faucet Transfer log token, sender, recipient, amount, or canonical identity mismatch");
  if (view.snapshot.number - FAUCET_BLOCK.number + 1n < 6n) throw new Error("fresh successor faucet receipt has fewer than six confirmations");
  if (publicHash(view.faucetPreState) !== publicHash(exactState(historical, { number: FAUCET_BLOCK.number - 1n, hash: view.faucetPreState.blockHash, timestamp: FAUCET_BLOCK.timestamp - 12n }, 20_000_000n)) || publicHash(view.faucetPostState) !== publicHash(exactState(historical, FAUCET_BLOCK, 40_000_000n))) throw new Error("fresh successor faucet balance amount or poststate mismatch");
  if (publicHash(view.snapshotRecheck) !== publicHash(view.snapshot) || publicHash(view.faucetRecheck) !== publicHash(FAUCET_BLOCK)) throw new Error("fresh successor canonical recheck detected a reorg");
  return Object.freeze({ transactionHash: FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH, blockNumber: FAUCET_BLOCK.number, blockHash: FAUCET_BLOCK.hash, blockTimestamp: FAUCET_BLOCK.timestamp, sender: FAUCET, token: USDC, recipient: FUNDER, amount: FAUCET_AMOUNT, logIndex: log.logIndex, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, preBalance: 20_000_000n, postBalance: 40_000_000n });
}

async function verifyAtSnapshot(
  source: UsdcRecycleContinuationSource,
  primary: UsdcRecycleContinuationPrimaryEvidence,
  providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider],
  historical: VerifiedUsdcRecycleHistoricalEvidence,
  block: UsdcSuccessorCanonicalBlock,
  recordedCheckpoint?: RecordedCheckpoint,
  reconciliation?: UsdcFreshSuccessorKnownPendingReconciliation,
): Promise<VerifiedUsdcFreshSuccessorCertificate> {
  const effectivePeriod = block.timestamp / PERIOD_SECONDS * PERIOD_SECONDS;
  if (effectivePeriod <= OLD_PERIOD || block.timestamp >= effectivePeriod + PERIOD_SECONDS) throw new Error("fresh successor canonical snapshot is not in a later valid period");
  const views = await Promise.all([readView(providers[0], block), readView(providers[1], block)] as const);
  const faucet = assertView(views[0], historical, recordedCheckpoint, reconciliation), secondFaucet = assertView(views[1], historical, recordedCheckpoint, reconciliation);
  if (publicHash(views[0]) !== publicHash(views[1]) || publicHash(faucet) !== publicHash(secondFaucet)) throw new Error("fresh successor providers disagree on canonical state or faucet evidence");
  const state = views[0].state, stateHash = publicHash(state);
  const currentCheckpoint = recordedCheckpoint
    ? Object.freeze({ ...recordedCheckpoint })
    : Object.freeze({ blockNumber: block.number.toString(), blockHash: block.hash, stateHash, snapshotNonce: views[0].snapshotNonce, latestNonce: views[0].latestNonce, pendingNonce: views[0].pendingNonce });
  const body = {
    kind: "VERIFIED_USDC_FRESH_SUCCESSOR_CERTIFICATE" as const,
    scope: FRESH_SUCCESSOR_SCOPE,
    sourceHash: historical.sourceHash,
    primaryEvidenceHash: historical.primaryEvidenceHash,
    historicalSnapshot: historical.snapshot,
    effectivePeriod,
    snapshot: Object.freeze({ blockNumber: block.number.toString(), blockHash: block.hash, timestamp: block.timestamp.toString(), stateHash }),
    currentCheckpoint,
    rawNativeSpend: Object.freeze({ ...state.nativeSpend }),
    rawUsdcSpend: Object.freeze({ ...state.usdcSpend }),
    safeUsdcBalance: state.safeUsdcBalance,
    funderUsdcBalance: state.funderUsdcBalance,
    priorActualGasCostWei: 168_855_544n,
    aggregateKnownChargeWei: AGGREGATE_KNOWN_CHARGE,
    faucet,
  };
  const certificate = Object.freeze({ ...body, certificateHash: publicHash(body) }) as VerifiedUsdcFreshSuccessorCertificate;
  if (!same(hashUsdcFreshSuccessorSource(source), certificate.sourceHash)) throw new Error("fresh successor source changed during certificate verification");
  verifiedSourceHashes.set(source, certificate.sourceHash);
  verifiedCertificates.add(certificate);
  return certificate;
}

export async function verifyUsdcFreshSuccessorCertificate(
  source: UsdcRecycleContinuationSource,
  primary: UsdcRecycleContinuationPrimaryEvidence,
  providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider],
): Promise<VerifiedUsdcFreshSuccessorCertificate> {
  if (!Array.isArray(providers) || providers.length !== 2 || providers[0] === providers[1]) throw new Error("fresh successor certificate requires two independent providers");
  const historical = await verifyUsdcRecycleHistoricalEvidence(source, primary, providers);
  const tips = await Promise.all([providers[0].readLatestBlock(), providers[1].readLatestBlock()] as const);
  const minimum = tips[0].number <= tips[1].number ? tips[0] : tips[1];
  if (minimum.number < 5n) throw new Error("fresh successor provider tip is too low");
  const snapshotNumber = minimum.number - 5n;
  const blocks = await Promise.all([providers[0].readBlock(snapshotNumber), providers[1].readBlock(snapshotNumber)] as const);
  if (!blocks[0] || !blocks[1] || publicHash(blocks[0]) !== publicHash(blocks[1]) || tips.some(tip => tip.number - snapshotNumber + 1n < 6n)) throw new Error("fresh successor providers disagree on the canonical min-head-minus-five snapshot");
  return verifyAtSnapshot(source, primary, providers, historical, blocks[0]);
}

export function isVerifiedUsdcFreshSuccessorCertificate(value: unknown): value is VerifiedUsdcFreshSuccessorCertificate {
  return !!value && typeof value === "object" && verifiedCertificates.has(value as object);
}

export function serializeUsdcFreshSuccessorCertificate(certificate: VerifiedUsdcFreshSuccessorCertificate): string {
  if (!isVerifiedUsdcFreshSuccessorCertificate(certificate)) throw new Error("fresh successor certificate is not runtime verified");
  return `${JSON.stringify(publicValue(certificate))}\n`;
}

export async function reverifyUsdcFreshSuccessorCertificate(
  serialized: string,
  expectedHash: Hex,
  source: UsdcRecycleContinuationSource,
  primary: UsdcRecycleContinuationPrimaryEvidence,
  providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider],
  reconciliation?: UsdcFreshSuccessorKnownPendingReconciliation,
): Promise<VerifiedUsdcFreshSuccessorCertificate> {
  let parsed: any;
  try { parsed = JSON.parse(serialized); } catch { throw new Error("fresh successor recorded certificate must be JSON"); }
  const keys = ["kind", "scope", "sourceHash", "primaryEvidenceHash", "historicalSnapshot", "effectivePeriod", "snapshot", "currentCheckpoint", "rawNativeSpend", "rawUsdcSpend", "safeUsdcBalance", "funderUsdcBalance", "priorActualGasCostWei", "aggregateKnownChargeWei", "faucet", "certificateHash"].sort();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).sort().join(",") !== keys.join(",")) throw new Error("fresh successor recorded certificate shape mismatch");
  if (typeof parsed.certificateHash !== "string" || !same(parsed.certificateHash, expectedHash)) throw new Error("fresh successor recorded certificate hash mismatch");
  const { certificateHash, ...body } = parsed;
  if (!same(publicHash(body), certificateHash)) throw new Error("fresh successor recorded certificate body hash mismatch");
  if (!parsed.snapshot || !/^(0|[1-9][0-9]*)$/.test(parsed.snapshot.blockNumber) || !/^(0|[1-9][0-9]*)$/.test(parsed.snapshot.timestamp) || typeof parsed.snapshot.blockHash !== "string") throw new Error("fresh successor recorded certificate snapshot shape mismatch");
  const checkpointKeys = ["blockNumber", "blockHash", "stateHash", "snapshotNonce", "latestNonce", "pendingNonce"].sort();
  const checkpoint = parsed.currentCheckpoint;
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint) || Object.keys(checkpoint).sort().join(",") !== checkpointKeys.join(",") || !/^(0|[1-9][0-9]*)$/.test(checkpoint.blockNumber) || typeof checkpoint.blockHash !== "string" || typeof checkpoint.stateHash !== "string" || !Number.isSafeInteger(checkpoint.snapshotNonce) || !Number.isSafeInteger(checkpoint.latestNonce) || !Number.isSafeInteger(checkpoint.pendingNonce)) throw new Error("fresh successor recorded checkpoint shape mismatch");
  if (checkpoint.blockNumber !== parsed.snapshot.blockNumber || !same(checkpoint.blockHash, parsed.snapshot.blockHash) || !same(checkpoint.stateHash, parsed.snapshot.stateHash) || checkpoint.snapshotNonce < 0 || checkpoint.snapshotNonce !== checkpoint.latestNonce || checkpoint.snapshotNonce !== checkpoint.pendingNonce) throw new Error("fresh successor recorded checkpoint must match the snapshot and preserve a nonnegative resolved nonce tuple");
  if (!Array.isArray(providers) || providers.length !== 2 || providers[0] === providers[1]) throw new Error("fresh successor certificate requires two independent providers");
  const historical = await verifyUsdcRecycleHistoricalEvidence(source, primary, providers, "pinned");
  const recorded = { number: BigInt(parsed.snapshot.blockNumber), hash: parsed.snapshot.blockHash as Hex, timestamp: BigInt(parsed.snapshot.timestamp) };
  const tips = await Promise.all([providers[0].readLatestBlock(), providers[1].readLatestBlock()] as const);
  const blocks = await Promise.all([providers[0].readBlock(recorded.number), providers[1].readBlock(recorded.number)] as const);
  if (!blocks[0] || !blocks[1] || publicHash(blocks[0]) !== publicHash(recorded) || publicHash(blocks[1]) !== publicHash(recorded) || tips.some(tip => tip.number - recorded.number + 1n < 6n)) throw new Error("fresh successor recorded snapshot is not canonical with six confirmations");
  const verified = await verifyAtSnapshot(source, primary, providers, historical, recorded, checkpoint as RecordedCheckpoint, reconciliation);
  if (JSON.stringify(publicValue(verified)) !== JSON.stringify(parsed)) throw new Error("fresh successor recorded certificate differs from canonical verification");
  return verified;
}
