import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { sha256 } from "../plan-deployment";
import type { OrdinaryScenarioActionRecord, OrdinaryScenarioJournal } from "./ordinary-scenario-executor";
import {
  isVerifiedUsdcFreshSuccessorCertificate,
  type UsdcFreshSuccessorEvidenceProvider,
  type VerifiedUsdcFreshSuccessorCertificate,
} from "./ordinary-scenario-usdc-fresh-successor-certificate";
import {
  assertUsdcFreshSuccessorAuthorization,
  type UsdcFreshSuccessorApproval,
  type UsdcFreshSuccessorProposal,
} from "./ordinary-scenario-usdc-fresh-successor-proposal";
import type { UsdcRecycleContinuationSource } from "./ordinary-scenario-usdc-recycle-continuation-certificate";
import type { UsdcSuccessorCanonicalState, UsdcSuccessorRawSpend } from "./ordinary-scenario-usdc-successor-certificate";

export const USDC_DELAYED_COMPLETION_SCOPE = "ordinary-usdc-delayed-tier-completion-v1" as const;
export const USDC_DELAYED_COMPLETION_SOURCE_JOURNAL_BYTES_SHA256 = "0x22c3171640cb450024ba6d4964b67ed6e761e75573ac451dffdd3342d6cee07a" as Hex;
const STOPPED_ROW_SHA256 = "0x2f0959ff46ac71383a4bd85b8f1c2834658f4751c3b35066083c3a6f2a82ff1b" as Hex;
const PERIOD_SECONDS = 86_400n;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const publicHash = (value: unknown): Hex => sha256(publicValue(value)) as Hex;

export type UsdcDelayedCompletionJournal = OrdinaryScenarioJournal & {
  usdcFreshSuccessor: NonNullable<OrdinaryScenarioJournal["usdcFreshSuccessor"]>;
  usdcDelayedCompletion?: unknown;
};

export type UsdcDelayedCompletionSource = Readonly<{
  historical: UsdcRecycleContinuationSource;
  freshCertificate: VerifiedUsdcFreshSuccessorCertificate;
  freshProposal: UsdcFreshSuccessorProposal;
  freshApproval: UsdcFreshSuccessorApproval;
  journal: UsdcDelayedCompletionJournal;
  sourceJournalBytesSha256: Hex;
  sourceJournalHash: Hex;
  stoppedRow: OrdinaryScenarioActionRecord;
}>;

declare const certificateBrand: unique symbol;
export type VerifiedUsdcDelayedCompletionCertificate = Readonly<{
  kind: "VERIFIED_USDC_DELAYED_COMPLETION_CERTIFICATE";
  scope: typeof USDC_DELAYED_COMPLETION_SCOPE;
  sourceJournalHash: Hex;
  sourceJournalBytesSha256: Hex;
  snapshot: Readonly<{ blockNumber: string; blockHash: Hex; timestamp: string; stateHash: Hex }>;
  effectivePeriod: bigint;
  minimumOuterNonce: number;
  safeNonce: bigint;
  delayQueueNonce: bigint;
  delayTxNonce: bigint;
  safeUsdcBalance: bigint;
  funderUsdcBalance: bigint;
  rawNativeSpend: UsdcSuccessorRawSpend;
  rawUsdcSpend: UsdcSuccessorRawSpend;
  stoppedRow: Readonly<{ id: string; commitment: Hex; status: "signed-simulated"; outerNonce: number; materializationHash: Hex; prestateHash: Hex; requestHash: Hex; signedCalldataHash: Hex; simulationEvidenceHash: Hex; outerDataHash: Hex }>;
  certificateHash: Hex;
  readonly [certificateBrand]: true;
}>;

const productionSources = new WeakSet<object>();
const testSources = new WeakSet<object>();
const productionCertificates = new WeakSet<object>();
const testCertificates = new WeakSet<object>();

const serializedPredecessor = (journal: OrdinaryScenarioJournal): string => `${JSON.stringify(publicValue(usdcDelayedCompletionPredecessorValue(journal)))}\n`;
export const usdcDelayedCompletionSourceJournalBytesSha256 = (journal: OrdinaryScenarioJournal): Hex => `0x${createHash("sha256").update(serializedPredecessor(journal)).digest("hex")}` as Hex;

export function usdcDelayedCompletionPredecessorValue(journal: OrdinaryScenarioJournal): unknown {
  const { usdcDelayedCompletion: _ignored, usdcDelayedSuccessor: _successor, ...predecessor } = journal as OrdinaryScenarioJournal & { usdcDelayedSuccessor?: unknown };
  return { ...predecessor, liveJournal: { ...predecessor.liveJournal, entries: predecessor.liveJournal.entries.slice(0, 15) } };
}

function exactStoppedSource(input: Omit<UsdcDelayedCompletionSource, "sourceJournalBytesSha256" | "sourceJournalHash" | "stoppedRow">): OrdinaryScenarioActionRecord {
  const { journal, freshProposal, freshApproval, freshCertificate } = input;
  assertUsdcFreshSuccessorAuthorization(freshProposal, freshApproval);
  if (!isVerifiedUsdcFreshSuccessorCertificate(freshCertificate)) throw new Error("delayed completion requires an opaque fresh certificate");
  const attached = journal.usdcFreshSuccessor;
  if (!attached || journal.usdcRecycleContinuation !== undefined || journal.repairContinuation !== undefined || journal.liveJournal.entries.length < 15 || journal.actions.length !== 19 || attached.actions.length !== 18 || attached.actionCommitments.length !== 18) throw new Error("delayed completion source is not the exact stopped fresh sibling");
  if (!same(attached.proposalHash, freshProposal.proposalHash) || !same(attached.approvalHash, freshApproval.approvalHash) || !same(attached.certificateHash, freshCertificate.certificateHash) || attached.scope !== freshProposal.scope || attached.repairAuthority !== "NONE") throw new Error("delayed completion stopped source authority mismatch");
  for (let index = 0; index < attached.actions.length; index++) {
    const action = attached.actions[index]!, expected = freshProposal.actions[index]!, commitment = attached.actionCommitments[index]!;
    if (action.id !== expected.id || !same(action.commitment, expected.commitment) || commitment.id !== expected.id || !same(commitment.commitment, expected.commitment)) throw new Error("delayed completion stopped source catalog changed");
    if (index > 0 && (action.status !== "approved" || Object.keys(action).sort().join(",") !== "commitment,id,status")) throw new Error("delayed completion untouched fresh tail changed");
  }
  const stopped = attached.actions[0] as OrdinaryScenarioActionRecord;
  const requiredHashes = [stopped.materializationHash, stopped.prestateHash, stopped.requestHash, stopped.signedCalldataHash, stopped.simulationEvidenceHash, stopped.outerDataHash];
  if (stopped.id !== "usdc-fresh-successor-prefund-all" || stopped.status !== "signed-simulated" || !Number.isSafeInteger(stopped.outerNonce) || stopped.outerNonce! < attached.minimumOuterNonce || !stopped.finalOuterMaterialization || requiredHashes.some(value => typeof value !== "string" || !HASH.test(value)) || stopped.intentHash !== undefined || stopped.transactionHash !== undefined || stopped.receipt !== undefined || stopped.receiptInclusion !== undefined || journal.liveJournal.entries.some(entry => entry.id.startsWith("usdc-fresh-successor-"))) throw new Error("delayed completion stopped row or live prefix mismatch");
  return stopped;
}

function constructSource(input: Omit<UsdcDelayedCompletionSource, "sourceJournalBytesSha256" | "sourceJournalHash" | "stoppedRow">, production: boolean): UsdcDelayedCompletionSource {
  const stoppedRow = exactStoppedSource(input);
  const sourceJournalBytesSha256 = usdcDelayedCompletionSourceJournalBytesSha256(input.journal);
  if (production && (!same(sourceJournalBytesSha256, USDC_DELAYED_COMPLETION_SOURCE_JOURNAL_BYTES_SHA256) || !same(publicHash(stoppedRow), STOPPED_ROW_SHA256) || stoppedRow.outerNonce !== 905)) throw new Error("delayed completion source is not the pinned nonce-905 stopped journal");
  const source = { ...input, sourceJournalBytesSha256, sourceJournalHash: publicHash(usdcDelayedCompletionPredecessorValue(input.journal)), stoppedRow } as UsdcDelayedCompletionSource;
  (production ? productionSources : testSources).add(source);
  return source;
}

export function createUsdcDelayedCompletionSource(input: Omit<UsdcDelayedCompletionSource, "sourceJournalBytesSha256" | "sourceJournalHash" | "stoppedRow">): UsdcDelayedCompletionSource { return constructSource(input, true); }
/** Test-only brander. Production callers must use createUsdcDelayedCompletionSource, which pins the exact source bytes and nonce-905 row. */
export function createUsdcDelayedCompletionSourceForTestsOnly(input: Omit<UsdcDelayedCompletionSource, "sourceJournalBytesSha256" | "sourceJournalHash" | "stoppedRow">): UsdcDelayedCompletionSource { return constructSource(input, false); }

function assertState(source: UsdcDelayedCompletionSource, state: UsdcSuccessorCanonicalState): void {
  const identity = source.historical.prior.original;
  if (state.chainId !== 11_155_111 || !same(state.safe, identity.safe) || !same(state.guard, identity.guard) || !same(state.delay, identity.delay) || !same(state.funder, source.journal.funder) || !same(state.usdc, identity.usdc) || !same(state.recipient, identity.recipient) || !same(state.primarySigner, identity.primarySigner) || !same(state.safeContractSecondary, identity.safeContractSecondary) || !same(state.ecdsaSecondary, identity.ecdsaSecondary)) throw new Error("delayed completion canonical identity or topology mismatch");
  if (state.safeNonce !== 10n || state.delayQueueNonce !== 4n || state.delayTxNonce !== 4n || state.queue !== null || state.safeNativeBalance !== 0n || state.safeUsdcBalance !== 0n || state.funderUsdcBalance !== 40_000_000n) throw new Error("delayed completion canonical nonce, queue, or balance state mismatch");
  const stale = state.usdcSpend;
  if (stale.window !== 1_793_232_000n || stale.baseSpent !== 10_000_000n || stale.instantSpent !== 20_000_000n) throw new Error("delayed completion stale USDC counter tuple mismatch");
}

async function verifyCertificate(source: UsdcDelayedCompletionSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider], authority: WeakSet<object>, certificateAuthority: WeakSet<object>): Promise<VerifiedUsdcDelayedCompletionCertificate> {
  if (!authority.has(source) || providers.length !== 2 || providers[0] === providers[1]) throw new Error("delayed completion certificate requires a pinned production source and two independent providers");
  if (!same(publicHash(usdcDelayedCompletionPredecessorValue(source.journal)), source.sourceJournalHash)) throw new Error("delayed completion stopped source changed after construction");
  exactStoppedSource(source);
  const tips = await Promise.all([providers[0].readLatestBlock(), providers[1].readLatestBlock()] as const);
  const snapshotNumber = (tips[0].number < tips[1].number ? tips[0].number : tips[1].number) - 5n;
  const blocks = await Promise.all([providers[0].readBlock(snapshotNumber), providers[1].readBlock(snapshotNumber)] as const);
  if (!blocks[0] || !blocks[1] || publicHash(blocks[0]) !== publicHash(blocks[1]) || tips.some(tip => tip.number - snapshotNumber + 1n < 6n)) throw new Error("delayed completion providers disagree on the six-confirmation snapshot");
  const [leftState, rightState, leftSnapshotNonce, rightSnapshotNonce, leftLatest, rightLatest, leftPending, rightPending] = await Promise.all([
    providers[0].readControlledState(snapshotNumber), providers[1].readControlledState(snapshotNumber),
    providers[0].readTransactionCount(source.journal.funder, snapshotNumber), providers[1].readTransactionCount(source.journal.funder, snapshotNumber),
    providers[0].readTransactionCount(source.journal.funder, "latest"), providers[1].readTransactionCount(source.journal.funder, "latest"),
    providers[0].readTransactionCount(source.journal.funder, "pending"), providers[1].readTransactionCount(source.journal.funder, "pending"),
  ]);
  if (publicHash(leftState) !== publicHash(rightState)) throw new Error("delayed completion providers disagree on canonical state");
  assertState(source, leftState);
  const nonces = [leftSnapshotNonce, rightSnapshotNonce, leftLatest, rightLatest, leftPending, rightPending];
  const minimumOuterNonce = nonces[0]!;
  if (nonces.some(value => value !== minimumOuterNonce) || minimumOuterNonce < source.stoppedRow.outerNonce! + 1) throw new Error("delayed completion outer nonce is pending, inconsistent, or precedes the first nonce after the stopped row");
  const rechecks = await Promise.all([providers[0].readBlock(snapshotNumber), providers[1].readBlock(snapshotNumber)] as const);
  if (!rechecks[0] || !rechecks[1] || publicHash(rechecks[0]) !== publicHash(blocks[0]) || publicHash(rechecks[1]) !== publicHash(blocks[0])) throw new Error("delayed completion snapshot reorg detected");
  const effectivePeriod = blocks[0].timestamp / PERIOD_SECONDS * PERIOD_SECONDS;
  const stopped = source.stoppedRow;
  const stoppedRow = Object.freeze({ id: stopped.id, commitment: stopped.commitment, status: "signed-simulated" as const, outerNonce: stopped.outerNonce!, materializationHash: stopped.materializationHash!, prestateHash: stopped.prestateHash!, requestHash: stopped.requestHash!, signedCalldataHash: stopped.signedCalldataHash!, simulationEvidenceHash: stopped.simulationEvidenceHash!, outerDataHash: stopped.outerDataHash! });
  const body = { kind: "VERIFIED_USDC_DELAYED_COMPLETION_CERTIFICATE" as const, scope: USDC_DELAYED_COMPLETION_SCOPE, sourceJournalHash: source.sourceJournalHash, sourceJournalBytesSha256: source.sourceJournalBytesSha256, snapshot: Object.freeze({ blockNumber: blocks[0].number.toString(), blockHash: blocks[0].hash, timestamp: blocks[0].timestamp.toString(), stateHash: publicHash(leftState) }), effectivePeriod, minimumOuterNonce, safeNonce: leftState.safeNonce, delayQueueNonce: leftState.delayQueueNonce, delayTxNonce: leftState.delayTxNonce, safeUsdcBalance: leftState.safeUsdcBalance, funderUsdcBalance: leftState.funderUsdcBalance, rawNativeSpend: Object.freeze({ ...leftState.nativeSpend }), rawUsdcSpend: Object.freeze({ ...leftState.usdcSpend }), stoppedRow };
  const certificate = Object.freeze({ ...body, certificateHash: publicHash(body) }) as VerifiedUsdcDelayedCompletionCertificate;
  certificateAuthority.add(certificate);
  return certificate;
}

export function verifyUsdcDelayedCompletionCertificate(source: UsdcDelayedCompletionSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider]): Promise<VerifiedUsdcDelayedCompletionCertificate> { return verifyCertificate(source, providers, productionSources, productionCertificates); }
/** Test-only certificate authority; its sources are never accepted by the production verifier or reverifier. */
export function verifyUsdcDelayedCompletionCertificateForTestsOnly(source: UsdcDelayedCompletionSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider]): Promise<VerifiedUsdcDelayedCompletionCertificate> { return verifyCertificate(source, providers, testSources, testCertificates); }

export function isVerifiedUsdcDelayedCompletionCertificate(value: unknown): value is VerifiedUsdcDelayedCompletionCertificate {
  return !!value && typeof value === "object" && productionCertificates.has(value as object);
}

/** Test-only brand predicate. Production proposal construction never consults it. */
export function isVerifiedUsdcDelayedCompletionCertificateForTestsOnly(value: unknown): value is VerifiedUsdcDelayedCompletionCertificate { return !!value && typeof value === "object" && testCertificates.has(value as object); }

export function serializeUsdcDelayedCompletionCertificate(certificate: VerifiedUsdcDelayedCompletionCertificate): string {
  if (!isVerifiedUsdcDelayedCompletionCertificate(certificate) && !isVerifiedUsdcDelayedCompletionCertificateForTestsOnly(certificate)) throw new Error("delayed completion certificate is not runtime verified");
  return `${JSON.stringify(publicValue(certificate))}\n`;
}

async function reverifyCertificate(serialized: string, expectedHash: Hex, source: UsdcDelayedCompletionSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider], authority: WeakSet<object>, certificateAuthority: WeakSet<object>, reconciliation?: Readonly<{ outerNonce: number }>): Promise<VerifiedUsdcDelayedCompletionCertificate> {
  let parsed: any; try { parsed = JSON.parse(serialized); } catch { throw new Error("delayed completion recorded certificate must be JSON"); }
  if (!parsed || typeof parsed !== "object" || parsed.kind !== "VERIFIED_USDC_DELAYED_COMPLETION_CERTIFICATE" || parsed.scope !== USDC_DELAYED_COMPLETION_SCOPE || typeof parsed.certificateHash !== "string" || !same(parsed.certificateHash, expectedHash)) throw new Error("delayed completion recorded certificate identity or hash mismatch");
  const { certificateHash, ...body } = parsed;
  if (!same(publicHash(body), certificateHash)) throw new Error("delayed completion recorded certificate body hash mismatch");
  if (!authority.has(source) || providers.length !== 2 || providers[0] === providers[1]) throw new Error("delayed completion recorded certificate requires a pinned production source and two independent providers");
  exactStoppedSource(source);
  if (!same(publicHash(usdcDelayedCompletionPredecessorValue(source.journal)), parsed.sourceJournalHash) || !same(source.sourceJournalHash, parsed.sourceJournalHash) || !same(source.sourceJournalBytesSha256, parsed.sourceJournalBytesSha256)) throw new Error("delayed completion recorded source changed");
  const blockNumber = BigInt(parsed.snapshot.blockNumber);
  const tips = await Promise.all([providers[0].readLatestBlock(), providers[1].readLatestBlock()] as const);
  const [leftBlock, rightBlock, leftState, rightState, leftSnapshotNonce, rightSnapshotNonce, leftLatest, rightLatest, leftPending, rightPending] = await Promise.all([
    providers[0].readBlock(blockNumber), providers[1].readBlock(blockNumber), providers[0].readControlledState(blockNumber), providers[1].readControlledState(blockNumber),
    providers[0].readTransactionCount(source.journal.funder, blockNumber), providers[1].readTransactionCount(source.journal.funder, blockNumber), providers[0].readTransactionCount(source.journal.funder, "latest"), providers[1].readTransactionCount(source.journal.funder, "latest"), providers[0].readTransactionCount(source.journal.funder, "pending"), providers[1].readTransactionCount(source.journal.funder, "pending"),
  ]);
  if (!leftBlock || !rightBlock || tips.some(tip => tip.number - blockNumber + 1n < 6n) || !same(leftBlock.hash, parsed.snapshot.blockHash) || publicHash(leftBlock) !== publicHash(rightBlock) || publicHash(leftState) !== publicHash(rightState) || !same(publicHash(leftState), parsed.snapshot.stateHash) || leftSnapshotNonce !== parsed.minimumOuterNonce || rightSnapshotNonce !== parsed.minimumOuterNonce || parsed.minimumOuterNonce < source.stoppedRow.outerNonce! + 1) throw new Error("delayed completion recorded canonical snapshot changed, precedes the first nonce after the stopped row, or lacks six confirmations");
  assertState(source, leftState);
  const latest = [leftLatest, rightLatest], pending = [leftPending, rightPending];
  const resolved = latest[0] === latest[1] && pending[0] === pending[1] && latest[0] === pending[0] && latest[0]! >= parsed.minimumOuterNonce;
  const knownPending = reconciliation !== undefined && latest[0] === latest[1] && pending[0] === pending[1] && reconciliation.outerNonce === latest[0] && pending[0]! >= latest[0]! && pending[0]! <= latest[0]! + 1;
  const resolvedProgress = reconciliation !== undefined && latest[0] === latest[1] && pending[0] === pending[1] && latest[0]! > reconciliation.outerNonce && pending[0] === latest[0];
  if (!resolved && !knownPending && !resolvedProgress) throw new Error("delayed completion current outer nonce is unresolved or inconsistent");
  const rechecks = await Promise.all([providers[0].readBlock(blockNumber), providers[1].readBlock(blockNumber)] as const);
  if (!rechecks[0] || !rechecks[1] || publicHash(rechecks[0]) !== publicHash(leftBlock) || publicHash(rechecks[1]) !== publicHash(leftBlock)) throw new Error("delayed completion recorded snapshot reorg detected");
  const stopped = exactStoppedSource(source), stoppedRow = Object.freeze({ id: stopped.id, commitment: stopped.commitment, status: "signed-simulated" as const, outerNonce: stopped.outerNonce!, materializationHash: stopped.materializationHash!, prestateHash: stopped.prestateHash!, requestHash: stopped.requestHash!, signedCalldataHash: stopped.signedCalldataHash!, simulationEvidenceHash: stopped.simulationEvidenceHash!, outerDataHash: stopped.outerDataHash! });
  const expectedBody = { kind: "VERIFIED_USDC_DELAYED_COMPLETION_CERTIFICATE" as const, scope: USDC_DELAYED_COMPLETION_SCOPE, sourceJournalHash: source.sourceJournalHash, sourceJournalBytesSha256: source.sourceJournalBytesSha256, snapshot: Object.freeze({ blockNumber: leftBlock.number.toString(), blockHash: leftBlock.hash, timestamp: leftBlock.timestamp.toString(), stateHash: publicHash(leftState) }), effectivePeriod: leftBlock.timestamp / PERIOD_SECONDS * PERIOD_SECONDS, minimumOuterNonce: leftSnapshotNonce, safeNonce: leftState.safeNonce, delayQueueNonce: leftState.delayQueueNonce, delayTxNonce: leftState.delayTxNonce, safeUsdcBalance: leftState.safeUsdcBalance, funderUsdcBalance: leftState.funderUsdcBalance, rawNativeSpend: Object.freeze({ ...leftState.nativeSpend }), rawUsdcSpend: Object.freeze({ ...leftState.usdcSpend }), stoppedRow };
  if (!same(publicHash(expectedBody), certificateHash) || JSON.stringify(publicValue(expectedBody)) !== JSON.stringify(body)) throw new Error("delayed completion recorded certificate contains unchecked or changed claims");
  const restored = Object.freeze({ ...expectedBody, certificateHash }) as VerifiedUsdcDelayedCompletionCertificate;
  certificateAuthority.add(restored);
  return restored;
}

export function reverifyUsdcDelayedCompletionCertificate(serialized: string, expectedHash: Hex, source: UsdcDelayedCompletionSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider], reconciliation?: Readonly<{ outerNonce: number }>): Promise<VerifiedUsdcDelayedCompletionCertificate> { return reverifyCertificate(serialized, expectedHash, source, providers, productionSources, productionCertificates, reconciliation); }
/** Test-only recorded-certificate authority; never accepted by production re-verification. */
export function reverifyUsdcDelayedCompletionCertificateForTestsOnly(serialized: string, expectedHash: Hex, source: UsdcDelayedCompletionSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider], reconciliation?: Readonly<{ outerNonce: number }>): Promise<VerifiedUsdcDelayedCompletionCertificate> { return reverifyCertificate(serialized, expectedHash, source, providers, testSources, testCertificates, reconciliation); }
