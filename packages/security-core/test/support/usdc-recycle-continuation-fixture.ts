import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, recoverTransactionAddress, type Address, type Hex } from "viem";
import { reconstructCanonicalLegacyTransaction } from "../../scripts/live/ordinary-scenario-hashless-continuation-cli";
import {
  loadUsdcRecycleContinuationSourceJournalReadOnly,
  verifyUsdcRecycleContinuationCertificate,
  type UsdcRecycleContinuationPrimaryEvidence,
  type UsdcRecycleContinuationSource,
} from "../../scripts/live/ordinary-scenario-usdc-recycle-continuation-certificate";
import { reverifyUsdcSuccessorCertificate, type UsdcSuccessorCanonicalState, type UsdcSuccessorEvidenceProvider } from "../../scripts/live/ordinary-scenario-usdc-successor-certificate";
import { loadUsdcSuccessorApproval, parseUsdcSuccessorProposal } from "../../scripts/live/ordinary-scenario-usdc-successor-proposal";
import { sha256 } from "../../scripts/plan-deployment";
import {
  attachUsdcRecycleContinuation,
  createUsdcRecycleContinuationProposal,
  loadUsdcRecycleContinuationApproval,
} from "../../scripts/live/ordinary-scenario-usdc-recycle-continuation-proposal";
import { canonicalUsdcSuccessorState, cleanupUsdcSuccessorFixtures, createUsdcSuccessorSource, usdcSuccessorFixture } from "./usdc-successor-fixture";

const fixtureDirectory = join(__dirname, "../fixtures");
const CHAIN_ID = 11_155_111;
const read = (name: string): string => readFileSync(join(fixtureDirectory, name), "utf8");
export const recycleFixture = Object.freeze({
  sourceJournal: read("ordinary-usdc-recycle-continuation-source.public.json"),
  primary: Object.freeze({
    manifest: read("ordinary-usdc-recycle-continuation-primary-manifest.public.json"),
    stepUpLedger: read("ordinary-usdc-recycle-continuation-step-up-ledger.public.json"),
    stepUpAcknowledgement: read("ordinary-usdc-recycle-continuation-step-up-ack.public.json"),
  }) as UsdcRecycleContinuationPrimaryEvidence,
  nonce869: read("ordinary-usdc-recycle-continuation-nonce869.public.json"),
  priorCertificate: read("ordinary-usdc-recycle-continuation-prior-certificate.public.json"),
  priorProposal: read("ordinary-usdc-recycle-continuation-prior-proposal.public.json"),
  priorApproval: read("ordinary-usdc-recycle-continuation-prior-approval.public.json"),
});

const cleanup = new Set<string>();
export function cleanupUsdcRecycleContinuationFixtures(): void {
  for (const directory of cleanup) rmSync(directory, { recursive: true, force: true });
  cleanup.clear();
  cleanupUsdcSuccessorFixtures();
}

export function trackedRecycleJournal(raw = recycleFixture.sourceJournal, mode: "initial" | "pinned" = "initial") {
  const directory = mkdtempSync(join(tmpdir(), "usdc-recycle-source-"));
  cleanup.add(directory);
  const path = join(directory, "journal.json");
  writeFileSync(path, raw);
  return { directory, path, journal: loadUsdcRecycleContinuationSourceJournalReadOnly(path, mode) };
}

function genuinePriorCertificateProvider(source: Awaited<ReturnType<typeof createUsdcSuccessorSource>>): UsdcSuccessorEvidenceProvider {
  const snapshot = { number: 12_019_201n, hash: "0xd7fceb0b7f4bbb2164db7a23d2452944889035f25307a69bfb93845ebafbc251" as Hex, timestamp: 1_793_273_232n };
  const rows = source.journal.hashlessContinuation!.actions.slice(0, 3) as Array<Record<string, any>>;
  const blocks = new Map<bigint, { number: bigint; hash: Hex; timestamp: bigint }>([[snapshot.number, snapshot]]);
  rows.forEach((row, index) => blocks.set(BigInt(row.receipt.blockNumber), { number: BigInt(row.receipt.blockNumber), hash: row.receipt.blockHash, timestamp: 1_793_230_000n + BigInt(index * 500) }));
  const current = (block: { number: bigint; hash: Hex }) => ({ ...canonicalUsdcSuccessorState(source.original), blockNumber: block.number, blockHash: block.hash });
  const postState = (index: number, block: { number: bigint; hash: Hex; timestamp: bigint }): UsdcSuccessorCanonicalState => {
    const state = current(block);
    if (index === 0) return { ...state, safeNonce: 7n, delayQueueNonce: 3n, delayTxNonce: 3n, safeNativeBalance: 1n };
    if (index === 1) { const queue = source.recovery.actions[1]!.queue!; return { ...state, safeNonce: 8n, delayQueueNonce: 4n, delayTxNonce: 3n, safeNativeBalance: 1n, queue: { queueNonce: BigInt(queue.queueNonce), fingerprint: queue.fingerprint, createdAt: block.timestamp, to: queue.to, value: BigInt(queue.value), data: queue.data, operation: queue.operation } }; }
    return state;
  };
  return {
    readLatestBlock: async () => ({ number: snapshot.number + 5n, hash: `0x${"9".repeat(64)}` as Hex, timestamp: snapshot.timestamp + 60n }),
    readBlock: async number => blocks.get(number),
    readTransaction: async hash => { const row = rows.find(item => item.transactionHash === hash); return row ? { hash, from: funder, nonce: row.outerNonce, to: row.outerTo, value: BigInt(row.outerValue), inputHash: row.outerDataHash, gas: BigInt(row.gas), type: "eip1559" as const, chainId: CHAIN_ID, maxFeePerGas: BigInt(row.maxFeePerGas), maxPriorityFeePerGas: BigInt(row.maxPriorityFeePerGas), blockNumber: BigInt(row.receipt.blockNumber), blockHash: row.receipt.blockHash } : undefined; },
    readReceipt: async hash => { const row = rows.find(item => item.transactionHash === hash); return row ? { transactionHash: hash, status: row.receipt.status, blockNumber: BigInt(row.receipt.blockNumber), blockHash: row.receipt.blockHash, gasUsed: BigInt(row.receipt.gasUsed), effectiveGasPrice: BigInt(row.receipt.effectiveGasPrice) } : undefined; },
    readTransactionCount: async (_address, block) => block === snapshot.number ? 866 : 866,
    readControlledState: async blockNumber => { const block = blocks.get(blockNumber)!; const index = rows.findIndex(row => BigInt(row.receipt.blockNumber) === blockNumber); return structuredClone(index >= 0 ? postState(index, block) : current(block)); },
  };
}

export async function createUsdcRecycleContinuationSource(raw = recycleFixture.sourceJournal): Promise<UsdcRecycleContinuationSource> {
  const predecessor = await createUsdcSuccessorSource(raw);
  const priorCertificate = await reverifyUsdcSuccessorCertificate(
    recycleFixture.priorCertificate,
    "0x909f9d5b36c3a8d4dcc099eb6519c1079f7f400e522d17b752ff3f4e37794b1a",
    predecessor,
    usdcSuccessorFixture.primary,
    [genuinePriorCertificateProvider(predecessor), genuinePriorCertificateProvider(predecessor)],
  );
  const priorProposal = parseUsdcSuccessorProposal(recycleFixture.priorProposal, predecessor, priorCertificate);
  const priorApproval = loadUsdcSuccessorApproval(
    priorProposal,
    recycleFixture.priorApproval,
    "0x6855653735904925cff3a09765788cee295a92ec3111f0044148c7a19ca376e7",
  );
  const tracked = trackedRecycleJournal(raw);
  const prior = { ...predecessor, journal: tracked.journal };
  return Object.freeze({ prior, priorCertificate, priorProposal, priorApproval });
}

export function sourceWithPinnedJournal(source: UsdcRecycleContinuationSource, raw: string): UsdcRecycleContinuationSource {
  const tracked = trackedRecycleJournal(raw, "pinned");
  return Object.freeze({ ...source, prior: Object.freeze({ ...source.prior, journal: tracked.journal }) });
}

export const recycleSnapshot = Object.freeze({ number: 12_019_400n, hash: `0x${"a".repeat(64)}` as Hex, timestamp: 1_793_275_620n });
const tips = Object.freeze([
  Object.freeze({ number: 12_019_405n, hash: `0x${"b".repeat(64)}` as Hex, timestamp: 1_793_275_680n }),
  Object.freeze({ number: 12_019_408n, hash: `0x${"c".repeat(64)}` as Hex, timestamp: 1_793_275_716n }),
] as const);
const funder = "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address;

export function canonicalRecycleState(source: UsdcRecycleContinuationSource, block = recycleSnapshot): UsdcSuccessorCanonicalState {
  const original = source.prior.original;
  return {
    blockNumber: block.number,
    blockHash: block.hash,
    chainId: 11_155_111,
    identityHash: original.publicIdentitiesHash,
    topologyHash: original.topologyEvidenceHash,
    policyHash: "0x5b19fb0f9dcc35db4d45ec227f01348985431d74a2092d887bc7b4f26ade4a82",
    safe: original.safe,
    guard: original.guard,
    delay: original.delay,
    funder: original.funder,
    usdc: original.usdc,
    recipient: original.recipient,
    primarySigner: original.primarySigner,
    safeContractSecondary: original.safeContractSecondary,
    ecdsaSecondary: original.ecdsaSecondary,
    safeNonce: 10n,
    delayQueueNonce: 4n,
    delayTxNonce: 4n,
    queue: null,
    safeNativeBalance: 0n,
    safeUsdcBalance: 0n,
    funderUsdcBalance: 20_000_000n,
    nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n },
    usdcSpend: { window: 1_793_232_000n, baseSpent: 10_000_000n, instantSpent: 20_000_000n },
  };
}

type ProviderMutation = Readonly<{
  tip?: { number: bigint; hash: Hex; timestamp: bigint };
  snapshot?: Partial<typeof recycleSnapshot>;
  snapshotMissing?: boolean;
  reorgHash?: Hex;
  state?: Partial<UsdcSuccessorCanonicalState>;
  receiptState?: Readonly<{ hash: Hex; patch: Partial<UsdcSuccessorCanonicalState> }>;
  transaction?: Readonly<{ hash: Hex; patch: Record<string, unknown> }>;
  receipt?: Readonly<{ hash: Hex; patch: Record<string, unknown> }>;
  snapshotNonce?: number;
  latestNonce?: number;
  pendingNonce?: number;
}>;

async function canonicalInvalidation() {
  const fixture = JSON.parse(recycleFixture.nonce869);
  const raw = fixture.transaction;
  const serialized = reconstructCanonicalLegacyTransaction({
    chainId: Number(raw.chainId), nonce: Number(raw.nonce), gas: BigInt(raw.gas), gasPrice: BigInt(raw.gasPrice),
    to: raw.to as Address, value: BigInt(raw.value), data: raw.input as Hex, r: raw.r as Hex, s: raw.s as Hex,
    v: BigInt(raw.v), hash: raw.hash as Hex,
  });
  const recovered = await recoverTransactionAddress({ serializedTransaction: serialized as never });
  if (recovered.toLowerCase() !== String(raw.from).toLowerCase()) throw new Error("nonce869 fixture sender recovery mismatch");
  return {
    transaction: {
      type: "legacy" as const, chainId: Number(raw.chainId), gasPrice: BigInt(raw.gasPrice), v: BigInt(raw.v), hash: raw.hash as Hex,
      from: recovered, nonce: Number(raw.nonce), to: raw.to as Address, value: BigInt(raw.value), inputHash: keccak256(raw.input as Hex),
      gas: BigInt(raw.gas), blockNumber: BigInt(raw.blockNumber), blockHash: raw.blockHash as Hex,
    },
    receipt: { transactionHash: fixture.receipt.transactionHash as Hex, status: fixture.receipt.status as "success", blockNumber: BigInt(fixture.receipt.blockNumber), blockHash: fixture.receipt.blockHash as Hex, gasUsed: BigInt(fixture.receipt.gasUsed), effectiveGasPrice: BigInt(fixture.receipt.effectiveGasPrice) },
    block: { number: BigInt(fixture.block.number), hash: fixture.block.hash as Hex, timestamp: BigInt(fixture.block.timestamp) },
  };
}

export async function recycleProvider(index: 0 | 1, source: UsdcRecycleContinuationSource, mutation: ProviderMutation = {}): Promise<UsdcSuccessorEvidenceProvider> {
  const invalidation = await canonicalInvalidation();
  const old = source.prior.journal.usdcSuccessor!.actions.slice(0, 2) as Array<Record<string, any>>;
  const snapshot = { ...recycleSnapshot, ...mutation.snapshot };
  const blocks = new Map<bigint, { number: bigint; hash: Hex; timestamp: bigint }>([[snapshot.number, snapshot], [invalidation.block.number, invalidation.block]]);
  for (const record of old) blocks.set(BigInt(record.receipt.blockNumber), { number: BigInt(record.receipt.blockNumber), hash: record.receipt.blockHash, timestamp: BigInt(record.receiptInclusion.blockTimestamp) });
  let snapshotReads = 0;
  const currentState = { ...canonicalRecycleState(source, snapshot), ...mutation.state } as UsdcSuccessorCanonicalState;
  const transaction = (hash: Hex) => {
    if (hash === invalidation.transaction.hash) return { ...invalidation.transaction, ...(mutation.transaction?.hash === hash ? mutation.transaction.patch : {}) } as any;
    const record = old.find(item => item.transactionHash === hash); if (!record) return undefined;
    const value = { hash, from: funder, nonce: record.outerNonce, to: record.outerTo, value: BigInt(record.outerValue), inputHash: record.outerDataHash, gas: BigInt(record.gas), type: "eip1559" as const, chainId: 11_155_111, maxFeePerGas: BigInt(record.maxFeePerGas), maxPriorityFeePerGas: BigInt(record.maxPriorityFeePerGas), blockNumber: BigInt(record.receipt.blockNumber), blockHash: record.receipt.blockHash };
    return { ...value, ...(mutation.transaction?.hash === hash ? mutation.transaction.patch : {}) } as any;
  };
  const receipt = (hash: Hex) => {
    const record = old.find(item => item.transactionHash === hash);
    const value = hash === invalidation.transaction.hash ? invalidation.receipt : record ? { transactionHash: hash, status: record.receipt.status, blockNumber: BigInt(record.receipt.blockNumber), blockHash: record.receipt.blockHash, gasUsed: BigInt(record.receipt.gasUsed), effectiveGasPrice: BigInt(record.receipt.effectiveGasPrice) } : undefined;
    return value ? { ...value, ...(mutation.receipt?.hash === hash ? mutation.receipt.patch : {}) } as any : undefined;
  };
  const stateAt = (blockNumber: bigint): UsdcSuccessorCanonicalState => {
    const block = blocks.get(blockNumber)!;
    let state = { ...currentState, blockNumber, blockHash: block.hash };
    const oldIndex = old.findIndex(item => BigInt(item.receipt.blockNumber) === blockNumber);
    if (oldIndex === 0) state = { ...state, safeNonce: 9n, safeUsdcBalance: 10_000_000n, funderUsdcBalance: 10_000_000n, usdcSpend: { window: 1_793_232_000n, baseSpent: 10_000_000n, instantSpent: 10_000_000n } };
    if (mutation.receiptState && transaction(mutation.receiptState.hash)?.blockNumber === blockNumber) state = { ...state, ...mutation.receiptState.patch };
    return state;
  };
  return {
    readLatestBlock: async () => mutation.tip ?? tips[index],
    readBlock: async number => {
      if (mutation.snapshotMissing && number === snapshot.number) return undefined;
      const block = blocks.get(number); if (!block) return undefined;
      if (number === snapshot.number && mutation.reorgHash && snapshotReads++ > 0) return { ...block, hash: mutation.reorgHash };
      return block;
    },
    readTransaction: async hash => transaction(hash),
    readReceipt: async hash => receipt(hash),
    readTransactionCount: async (_address, block) => block === snapshot.number ? (mutation.snapshotNonce ?? 870) : block === "latest" ? (mutation.latestNonce ?? mutation.snapshotNonce ?? 870) : (mutation.pendingNonce ?? mutation.latestNonce ?? mutation.snapshotNonce ?? 870),
    readControlledState: async blockNumber => structuredClone(stateAt(blockNumber)),
  };
}

export async function recycleProviders(source: UsdcRecycleContinuationSource, left: ProviderMutation = {}, right: ProviderMutation = {}) {
  return [await recycleProvider(0, source, left), await recycleProvider(1, source, right)] as const;
}

export async function createApprovedUsdcRecycleContinuation(nonce = 870) {
  const source = await createUsdcRecycleContinuationSource();
  const certificate = await verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { snapshotNonce: nonce }, { snapshotNonce: nonce }));
  const proposal = createUsdcRecycleContinuationProposal({
    source,
    certificate,
    observer: structuredClone(source.priorProposal.observer),
    caps: { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" },
  });
  const document = {
    schemaVersion: 1,
    scope: "ordinary-usdc-recycle-continuation-v1",
    authorization: "STANDING_BOUNDED_SUCCESSOR_AUTHORIZATION",
    authorityEvidenceHash: "0xc7dca18faa9a9bf1cb2028c8bb77a5ccf8b0577145a408dd301d043be09bad3b",
    proposalHash: proposal.proposalHash,
    sourceHash: proposal.sourceHash,
    certificateHash: proposal.certificateHash,
    snapshot: proposal.snapshot,
    currentCheckpoint: proposal.currentCheckpoint,
    minimumOuterNonce: proposal.minimumOuterNonce,
    effectivePeriod: proposal.effectivePeriod,
    deadline: proposal.deadline,
    observer: proposal.observer,
    schedule: proposal.schedule,
    groups: proposal.groups,
    caps: proposal.caps,
    reservation: proposal.reservation,
    repairAuthority: "NONE",
    sharedBudgetCharges: proposal.sharedBudgetCharges,
    maxBroadcastAttempts: 1,
    approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })),
  };
  const approval = loadUsdcRecycleContinuationApproval(proposal, JSON.stringify(document), sha256(document) as Hex);
  const journal = attachUsdcRecycleContinuation(source.prior.journal, proposal, approval);
  return { source, certificate, proposal, approval, journal };
}
