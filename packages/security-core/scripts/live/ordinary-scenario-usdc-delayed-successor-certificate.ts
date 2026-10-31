import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { sha256 } from "../plan-deployment";
import type { OrdinaryScenarioActionRecord, OrdinaryScenarioJournal } from "./ordinary-scenario-executor";
import {
  isVerifiedUsdcDelayedCompletionCertificate,
  isVerifiedUsdcDelayedCompletionCertificateForTestsOnly,
  type UsdcDelayedCompletionSource,
  type VerifiedUsdcDelayedCompletionCertificate,
} from "./ordinary-scenario-usdc-delayed-completion-certificate";
import {
  assertUsdcDelayedCompletionAuthorization,
  assertUsdcDelayedCompletionAuthorizationForTestsOnly,
  type UsdcDelayedCompletionApproval,
  type UsdcDelayedCompletionProposal,
  type UsdcDelayedCompletionStorage,
} from "./ordinary-scenario-usdc-delayed-completion-proposal";
import type { UsdcFreshSuccessorEvidenceProvider } from "./ordinary-scenario-usdc-fresh-successor-certificate";
import type { UsdcSuccessorCanonicalQueue, UsdcSuccessorCanonicalState, UsdcSuccessorRawSpend } from "./ordinary-scenario-usdc-successor-certificate";

export const USDC_DELAYED_SUCCESSOR_SCOPE = "ordinary-usdc-delayed-tier-successor-v1" as const;
const PERIOD_SECONDS = 86_400n;
const DELAY_PLUS_EXPIRY = 720n;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const PINNED_SOURCE_BYTES_SHA256 = "0x7853b6675a2954e7b44ff844bb884d38a4ba69a966cf33c645164b5feb109855" as Hex;
const PINNED_SOURCE_HASH = "0x3e1703dd6f821723898f057b0aa6ec3d96dc5f292a3eb939b3d1e72048bb38ce" as Hex;

const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const publicHash = (value: unknown): Hex => sha256(publicValue(value)) as Hex;

export type UsdcDelayedSuccessorJournal = OrdinaryScenarioJournal & {
  usdcDelayedCompletion: UsdcDelayedCompletionStorage;
  usdcDelayedSuccessor?: unknown;
};

export type UsdcDelayedSuccessorSource = Readonly<{
  prior: UsdcDelayedCompletionSource;
  delayedCertificate: VerifiedUsdcDelayedCompletionCertificate;
  delayedProposal: UsdcDelayedCompletionProposal;
  delayedApproval: UsdcDelayedCompletionApproval;
  journal: UsdcDelayedSuccessorJournal;
  sourceJournalBytesSha256: Hex;
  sourceJournalHash: Hex;
  stoppedRow: OrdinaryScenarioActionRecord;
}>;

declare const certificateBrand: unique symbol;
export type VerifiedUsdcDelayedSuccessorCertificate = Readonly<{
  kind: "VERIFIED_USDC_DELAYED_SUCCESSOR_CERTIFICATE";
  scope: typeof USDC_DELAYED_SUCCESSOR_SCOPE;
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
  activeQueue: UsdcSuccessorCanonicalQueue;
  stoppedRow: Readonly<{ id: string; commitment: Hex; status: "signed-simulated"; outerNonce: number; materializationHash: Hex; prestateHash: Hex; requestHash: Hex; signedCalldataHash: Hex; simulationEvidenceHash: Hex; outerDataHash: Hex }>;
  certificateHash: Hex;
  readonly [certificateBrand]: true;
}>;

const productionSources = new WeakSet<object>();
const testSources = new WeakSet<object>();
const productionCertificates = new WeakSet<object>();
const testCertificates = new WeakSet<object>();

export function usdcDelayedSuccessorPredecessorValue(journal: OrdinaryScenarioJournal): unknown {
  const { usdcDelayedSuccessor: _ignored, ...predecessor } = journal as OrdinaryScenarioJournal & { usdcDelayedSuccessor?: unknown };
  return predecessor;
}

const serializedPredecessor = (journal: OrdinaryScenarioJournal): string => `${JSON.stringify(publicValue(usdcDelayedSuccessorPredecessorValue(journal)))}\n`;
export const usdcDelayedSuccessorSourceJournalBytesSha256 = (journal: OrdinaryScenarioJournal): Hex => `0x${createHash("sha256").update(serializedPredecessor(journal)).digest("hex")}` as Hex;

type SourceInput = Omit<UsdcDelayedSuccessorSource, "sourceJournalBytesSha256" | "sourceJournalHash" | "stoppedRow">;

function exactProgressedSource(input: SourceInput, testOnly: boolean): OrdinaryScenarioActionRecord {
  const assertAuthorization = testOnly ? assertUsdcDelayedCompletionAuthorizationForTestsOnly : assertUsdcDelayedCompletionAuthorization;
  const verified = testOnly ? isVerifiedUsdcDelayedCompletionCertificateForTestsOnly(input.delayedCertificate) : isVerifiedUsdcDelayedCompletionCertificate(input.delayedCertificate);
  assertAuthorization(input.delayedProposal, input.delayedApproval);
  if (!verified) throw new Error("delayed successor requires the exact opaque delayed-completion certificate authority");
  const attached = input.journal.usdcDelayedCompletion;
  if (!attached || input.journal.usdcDelayedSuccessor !== undefined || input.journal.liveJournal.entries.length !== 19 || attached.actions.length !== 13 || attached.actionCommitments.length !== 13) throw new Error("delayed successor source is not the exact progressed predecessor");
  if (!same(attached.proposalHash, input.delayedProposal.proposalHash) || !same(attached.approvalHash, input.delayedApproval.approvalHash) || !same(attached.certificateHash, input.delayedCertificate.certificateHash) || attached.scope !== input.delayedProposal.scope || attached.repairAuthority !== "NONE") throw new Error("delayed successor predecessor authority mismatch");
  const statuses = ["confirmed", "rejection-proved", "confirmed", "rejection-proved", "confirmed", "rejection-proved", "confirmed", "rejection-proved", "signed-simulated", "approved", "approved", "approved", "approved"];
  for (let index = 0; index < attached.actions.length; index++) {
    const action = attached.actions[index]!, expected = input.delayedProposal.actions[index]!, commitment = attached.actionCommitments[index]!;
    if (action.id !== expected.id || !same(action.commitment, expected.commitment) || commitment.id !== expected.id || !same(commitment.commitment, expected.commitment)) throw new Error("delayed successor predecessor catalog changed");
    if (action.status !== statuses[index]) throw new Error(`delayed successor predecessor row ${index + 1} status changed`);
    if (index >= 9 && Object.keys(action).sort().join(",") !== "commitment,id,status") throw new Error("delayed successor untouched old tail changed");
  }
  const liveSuffix = input.journal.liveJournal.entries.slice(15);
  const broadcastIndexes = [0, 2, 4, 6];
  if (liveSuffix.length !== 4 || liveSuffix.some((entry, index) => {
    const record = attached.actions[broadcastIndexes[index]!] as OrdinaryScenarioActionRecord;
    return entry.id !== record.id || record.status !== "confirmed" || !record.transactionHash || !same(entry.transactionHash, record.transactionHash);
  })) throw new Error("delayed successor live suffix does not match confirmed predecessor broadcasts");
  const stopped = attached.actions[8] as OrdinaryScenarioActionRecord;
  const requiredHashes = [stopped.materializationHash, stopped.prestateHash, stopped.requestHash, stopped.signedCalldataHash, stopped.simulationEvidenceHash, stopped.outerDataHash];
  if (stopped.id !== "usdc-delayed-completion-queue-expiry-skip" || stopped.status !== "signed-simulated" || stopped.outerNonce !== 916 || !stopped.finalOuterMaterialization || requiredHashes.some(value => typeof value !== "string" || !HASH.test(value)) || stopped.intentHash !== undefined || stopped.transactionHash !== undefined || stopped.receipt !== undefined || stopped.receiptInclusion !== undefined || input.journal.liveJournal.entries.some(entry => entry.id === stopped.id)) throw new Error("delayed successor stopped row is not the exact hashless row");
  return stopped;
}

function constructSource(input: SourceInput, production: boolean): UsdcDelayedSuccessorSource {
  const stoppedRow = exactProgressedSource(input, !production);
  const sourceJournalBytesSha256 = usdcDelayedSuccessorSourceJournalBytesSha256(input.journal);
  const sourceJournalHash = publicHash(usdcDelayedSuccessorPredecessorValue(input.journal));
  if (production && (!same(sourceJournalBytesSha256, PINNED_SOURCE_BYTES_SHA256) || !same(sourceJournalHash, PINNED_SOURCE_HASH))) throw new Error("delayed successor source journal is not the pinned production predecessor");
  const source = { ...input, sourceJournalBytesSha256, sourceJournalHash, stoppedRow } as UsdcDelayedSuccessorSource;
  (production ? productionSources : testSources).add(source);
  return source;
}

export function createUsdcDelayedSuccessorSource(input: SourceInput): UsdcDelayedSuccessorSource { return constructSource(input, true); }
/** Test-only brander. Production callers require the pinned progressed journal. */
export function createUsdcDelayedSuccessorSourceForTestsOnly(input: SourceInput): UsdcDelayedSuccessorSource { return constructSource(input, false); }

function assertState(source: UsdcDelayedSuccessorSource, state: UsdcSuccessorCanonicalState, timestamp: bigint): void {
  const identity = source.prior.historical.prior.original;
  if (state.chainId !== 11_155_111 || !same(state.safe, identity.safe) || !same(state.guard, identity.guard) || !same(state.delay, identity.delay) || !same(state.funder, source.journal.funder) || !same(state.usdc, identity.usdc) || !same(state.recipient, identity.recipient) || !same(state.primarySigner, identity.primarySigner) || !same(state.safeContractSecondary, identity.safeContractSecondary) || !same(state.ecdsaSecondary, identity.ecdsaSecondary)) throw new Error("delayed successor canonical identity or topology mismatch");
  const expectedQueue = source.delayedProposal.actions[6]!.queue;
  if (state.safeNonce !== 13n || state.delayQueueNonce !== 6n || state.delayTxNonce !== 5n || state.safeNativeBalance !== 0n || state.safeUsdcBalance !== 31_000_000n || state.funderUsdcBalance !== 9_000_000n || !state.queue || !expectedQueue || state.queue.queueNonce !== 5n || !same(state.queue.fingerprint, expectedQueue.fingerprint) || timestamp < state.queue.createdAt + DELAY_PLUS_EXPIRY) throw new Error("delayed successor canonical nonce, expired queue, or balance state mismatch");
}

async function verifyCertificate(source: UsdcDelayedSuccessorSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider], sourceAuthority: WeakSet<object>, certificateAuthority: WeakSet<object>, testOnly: boolean): Promise<VerifiedUsdcDelayedSuccessorCertificate> {
  if (!sourceAuthority.has(source) || providers.length !== 2 || providers[0] === providers[1]) throw new Error("delayed successor certificate requires a pinned production source and two independent providers");
  if (!same(publicHash(usdcDelayedSuccessorPredecessorValue(source.journal)), source.sourceJournalHash)) throw new Error("delayed successor source changed after construction");
  exactProgressedSource(source, testOnly);
  const tips = await Promise.all([providers[0].readLatestBlock(), providers[1].readLatestBlock()] as const);
  const snapshotNumber = (tips[0].number < tips[1].number ? tips[0].number : tips[1].number) - 5n;
  const blocks = await Promise.all([providers[0].readBlock(snapshotNumber), providers[1].readBlock(snapshotNumber)] as const);
  if (!blocks[0] || !blocks[1] || publicHash(blocks[0]) !== publicHash(blocks[1]) || tips.some(tip => tip.number - snapshotNumber + 1n < 6n)) throw new Error("delayed successor providers disagree on six-confirmation snapshot");
  const [leftState, rightState, leftSnapshotNonce, rightSnapshotNonce, leftLatest, rightLatest, leftPending, rightPending] = await Promise.all([
    providers[0].readControlledState(snapshotNumber), providers[1].readControlledState(snapshotNumber),
    providers[0].readTransactionCount(source.journal.funder, snapshotNumber), providers[1].readTransactionCount(source.journal.funder, snapshotNumber),
    providers[0].readTransactionCount(source.journal.funder, "latest"), providers[1].readTransactionCount(source.journal.funder, "latest"),
    providers[0].readTransactionCount(source.journal.funder, "pending"), providers[1].readTransactionCount(source.journal.funder, "pending"),
  ]);
  if (publicHash(leftState) !== publicHash(rightState)) throw new Error("delayed successor providers disagree on canonical state");
  assertState(source, leftState, blocks[0].timestamp);
  const nonces = [leftSnapshotNonce, rightSnapshotNonce, leftLatest, rightLatest, leftPending, rightPending];
  const minimumOuterNonce = nonces[0]!;
  if (nonces.some(value => value !== minimumOuterNonce) || minimumOuterNonce < source.stoppedRow.outerNonce! + 1) throw new Error("delayed successor outer nonce is pending, inconsistent, or precedes stopped row");
  const rechecks = await Promise.all([providers[0].readBlock(snapshotNumber), providers[1].readBlock(snapshotNumber)] as const);
  if (!rechecks[0] || !rechecks[1] || publicHash(rechecks[0]) !== publicHash(blocks[0]) || publicHash(rechecks[1]) !== publicHash(blocks[0])) throw new Error("delayed successor snapshot reorg detected");
  const stopped = source.stoppedRow;
  const stoppedRow = Object.freeze({ id: stopped.id, commitment: stopped.commitment, status: "signed-simulated" as const, outerNonce: stopped.outerNonce!, materializationHash: stopped.materializationHash!, prestateHash: stopped.prestateHash!, requestHash: stopped.requestHash!, signedCalldataHash: stopped.signedCalldataHash!, simulationEvidenceHash: stopped.simulationEvidenceHash!, outerDataHash: stopped.outerDataHash! });
  const body = {
    kind: "VERIFIED_USDC_DELAYED_SUCCESSOR_CERTIFICATE" as const,
    scope: USDC_DELAYED_SUCCESSOR_SCOPE,
    sourceJournalHash: source.sourceJournalHash,
    sourceJournalBytesSha256: source.sourceJournalBytesSha256,
    snapshot: Object.freeze({ blockNumber: blocks[0].number.toString(), blockHash: blocks[0].hash, timestamp: blocks[0].timestamp.toString(), stateHash: publicHash(leftState) }),
    effectivePeriod: blocks[0].timestamp / PERIOD_SECONDS * PERIOD_SECONDS,
    minimumOuterNonce,
    safeNonce: leftState.safeNonce,
    delayQueueNonce: leftState.delayQueueNonce,
    delayTxNonce: leftState.delayTxNonce,
    safeUsdcBalance: leftState.safeUsdcBalance,
    funderUsdcBalance: leftState.funderUsdcBalance,
    rawNativeSpend: Object.freeze({ ...leftState.nativeSpend }),
    rawUsdcSpend: Object.freeze({ ...leftState.usdcSpend }),
    activeQueue: Object.freeze({ ...leftState.queue! }),
    stoppedRow,
  };
  const certificate = Object.freeze({ ...body, certificateHash: publicHash(body) }) as VerifiedUsdcDelayedSuccessorCertificate;
  certificateAuthority.add(certificate);
  return certificate;
}

export function verifyUsdcDelayedSuccessorCertificate(source: UsdcDelayedSuccessorSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider]): Promise<VerifiedUsdcDelayedSuccessorCertificate> { return verifyCertificate(source, providers, productionSources, productionCertificates, false); }
/** Test-only verifier. Production proposal construction rejects its result. */
export function verifyUsdcDelayedSuccessorCertificateForTestsOnly(source: UsdcDelayedSuccessorSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider]): Promise<VerifiedUsdcDelayedSuccessorCertificate> { return verifyCertificate(source, providers, testSources, testCertificates, true); }

export function isVerifiedUsdcDelayedSuccessorCertificate(value: unknown): value is VerifiedUsdcDelayedSuccessorCertificate { return !!value && typeof value === "object" && productionCertificates.has(value as object); }
export function isVerifiedUsdcDelayedSuccessorCertificateForTestsOnly(value: unknown): value is VerifiedUsdcDelayedSuccessorCertificate { return !!value && typeof value === "object" && testCertificates.has(value as object); }

export function serializeUsdcDelayedSuccessorCertificate(certificate: VerifiedUsdcDelayedSuccessorCertificate): string {
  if (!isVerifiedUsdcDelayedSuccessorCertificate(certificate) && !isVerifiedUsdcDelayedSuccessorCertificateForTestsOnly(certificate)) throw new Error("delayed successor certificate is not runtime verified");
  return `${JSON.stringify(publicValue(certificate))}\n`;
}

async function reverifyCertificate(serialized: string, expectedHash: Hex, source: UsdcDelayedSuccessorSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider], sourceAuthority: WeakSet<object>, certificateAuthority: WeakSet<object>, testOnly: boolean): Promise<VerifiedUsdcDelayedSuccessorCertificate> {
  let parsed: any; try { parsed = JSON.parse(serialized); } catch { throw new Error("delayed successor recorded certificate must be JSON"); }
  if (!parsed || parsed.kind !== "VERIFIED_USDC_DELAYED_SUCCESSOR_CERTIFICATE" || parsed.scope !== USDC_DELAYED_SUCCESSOR_SCOPE || !same(parsed.certificateHash, expectedHash)) throw new Error("delayed successor recorded certificate identity mismatch");
  const fresh = await verifyCertificate(source, providers, sourceAuthority, certificateAuthority, testOnly);
  if (!same(fresh.certificateHash, expectedHash) || JSON.stringify(publicValue(fresh)) !== JSON.stringify(parsed)) throw new Error("delayed successor recorded certificate contains unchecked or changed claims");
  return fresh;
}

export function reverifyUsdcDelayedSuccessorCertificate(serialized: string, expectedHash: Hex, source: UsdcDelayedSuccessorSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider]): Promise<VerifiedUsdcDelayedSuccessorCertificate> { return reverifyCertificate(serialized, expectedHash, source, providers, productionSources, productionCertificates, false); }
export function reverifyUsdcDelayedSuccessorCertificateForTestsOnly(serialized: string, expectedHash: Hex, source: UsdcDelayedSuccessorSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider]): Promise<VerifiedUsdcDelayedSuccessorCertificate> { return reverifyCertificate(serialized, expectedHash, source, providers, testSources, testCertificates, true); }
