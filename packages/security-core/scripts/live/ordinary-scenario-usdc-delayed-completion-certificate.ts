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
const PERIOD_SECONDS = 86_400n;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const publicHash = (value: unknown): Hex => sha256(publicValue(value)) as Hex;

export type UsdcDelayedCompletionJournal = OrdinaryScenarioJournal & {
  usdcFreshSuccessor: NonNullable<OrdinaryScenarioJournal["usdcFreshSuccessor"]>;
  usdcDelayedCompletion?: unknown;
};

export type UsdcDelayedCompletionJournal = OrdinaryScenarioJournal & { usdcDelayedCompletion?: unknown };
export type UsdcDelayedCompletionSource = Readonly<{
  historical: UsdcRecycleContinuationSource;
  freshCertificate: VerifiedUsdcFreshSuccessorCertificate;
  freshProposal: UsdcFreshSuccessorProposal;
  freshApproval: UsdcFreshSuccessorApproval;
  journal: UsdcDelayedCompletionJournal;
  sourceJournalHash: Hex;
  stoppedRow: OrdinaryScenarioActionRecord;
}>;

declare const certificateBrand: unique symbol;
export type VerifiedUsdcDelayedCompletionCertificate = Readonly<{
  kind: "VERIFIED_USDC_DELAYED_COMPLETION_CERTIFICATE";
  scope: typeof USDC_DELAYED_COMPLETION_SCOPE;
  sourceJournalHash: Hex;
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

const sources = new WeakSet<object>();
const certificates = new WeakSet<object>();

function exactStoppedSource(input: Omit<UsdcDelayedCompletionSource, "sourceJournalHash" | "stoppedRow">): OrdinaryScenarioActionRecord {
  const { journal, freshProposal, freshApproval, freshCertificate } = input;
  assertUsdcFreshSuccessorAuthorization(freshProposal, freshApproval);
  if (!isVerifiedUsdcFreshSuccessorCertificate(freshCertificate)) throw new Error("delayed completion requires an opaque fresh certificate");
  const attached = journal.usdcFreshSuccessor;
  if (!attached || journal.usdcRecycleContinuation !== undefined || journal.repairContinuation !== undefined || journal.usdcDelayedCompletion !== undefined || journal.liveJournal.entries.length !== 15 || journal.actions.length !== 19 || attached.actions.length !== 18 || attached.actionCommitments.length !== 18) throw new Error("delayed completion source is not the exact stopped fresh sibling");
  if (!same(attached.proposalHash, freshProposal.proposalHash) || !same(attached.approvalHash, freshApproval.approvalHash) || !same(attached.certificateHash, freshCertificate.certificateHash) || attached.scope !== freshProposal.scope || attached.repairAuthority !== "NONE") throw new Error("delayed completion stopped source authority mismatch");
  for (let index = 0; index < attached.actions.length; index++) {
    const action = attached.actions[index]!, expected = freshProposal.actions[index]!, commitment = attached.actionCommitments[index]!;
    if (action.id !== expected.id || !same(action.commitment, expected.commitment) || commitment.id !== expected.id || !same(commitment.commitment, expected.commitment)) throw new Error("delayed completion stopped source catalog changed");
    if (index > 0 && (action.status !== "approved" || Object.keys(action).sort().join(",") !== "commitment,id,status")) throw new Error("delayed completion untouched fresh tail changed");
  }
  const stopped = attached.actions[0] as OrdinaryScenarioActionRecord;
  const requiredHashes = [stopped.materializationHash, stopped.prestateHash, stopped.requestHash, stopped.signedCalldataHash, stopped.simulationEvidenceHash, stopped.outerDataHash];
  if (stopped.id !== "usdc-fresh-successor-prefund-all" || stopped.status !== "signed-simulated" || !Number.isSafeInteger(stopped.outerNonce) || stopped.outerNonce! < attached.minimumOuterNonce || requiredHashes.some(value => typeof value !== "string" || !HASH.test(value)) || stopped.intentHash !== undefined || stopped.transactionHash !== undefined || stopped.receipt !== undefined || stopped.receiptInclusion !== undefined || journal.liveJournal.entries.some(entry => entry.id.startsWith("usdc-fresh-successor-"))) throw new Error("delayed completion stopped row or live prefix mismatch");
  return stopped;
}

export function createUsdcDelayedCompletionSource(input: Omit<UsdcDelayedCompletionSource, "sourceJournalHash" | "stoppedRow">): UsdcDelayedCompletionSource {
  const stoppedRow = exactStoppedSource(input);
  const source = { ...input, sourceJournalHash: publicHash(input.journal), stoppedRow } as UsdcDelayedCompletionSource;
  sources.add(source);
  return source;
}

function assertState(source: UsdcDelayedCompletionSource, state: UsdcSuccessorCanonicalState): void {
  const identity = source.historical.prior.original;
  if (state.chainId !== 11_155_111 || !same(state.safe, identity.safe) || !same(state.guard, identity.guard) || !same(state.delay, identity.delay) || !same(state.funder, source.journal.funder) || !same(state.usdc, identity.usdc) || !same(state.recipient, identity.recipient) || !same(state.primarySigner, identity.primarySigner) || !same(state.safeContractSecondary, identity.safeContractSecondary) || !same(state.ecdsaSecondary, identity.ecdsaSecondary)) throw new Error("delayed completion canonical identity or topology mismatch");
  if (state.safeNonce !== 10n || state.delayQueueNonce !== 4n || state.delayTxNonce !== 4n || state.queue !== null || state.safeNativeBalance !== 0n || state.safeUsdcBalance !== 0n || state.funderUsdcBalance !== 40_000_000n) throw new Error("delayed completion canonical nonce, queue, or balance state mismatch");
  const stale = state.usdcSpend;
  if (stale.window !== 1_793_232_000n || stale.baseSpent !== 10_000_000n || stale.instantSpent !== 20_000_000n) throw new Error("delayed completion stale USDC counter tuple mismatch");
}

export async function verifyUsdcDelayedCompletionCertificate(source: UsdcDelayedCompletionSource, providers: readonly [UsdcFreshSuccessorEvidenceProvider, UsdcFreshSuccessorEvidenceProvider]): Promise<VerifiedUsdcDelayedCompletionCertificate> {
  if (!sources.has(source) || providers.length !== 2 || providers[0] === providers[1]) throw new Error("delayed completion certificate requires an opaque source and two independent providers");
  if (!same(publicHash(source.journal), source.sourceJournalHash)) throw new Error("delayed completion stopped source changed after construction");
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
  if (nonces.some(value => value !== minimumOuterNonce) || minimumOuterNonce <= source.stoppedRow.outerNonce!) throw new Error("delayed completion outer nonce is pending, inconsistent, or did not consume the stopped nonce");
  const rechecks = await Promise.all([providers[0].readBlock(snapshotNumber), providers[1].readBlock(snapshotNumber)] as const);
  if (!rechecks[0] || !rechecks[1] || publicHash(rechecks[0]) !== publicHash(blocks[0]) || publicHash(rechecks[1]) !== publicHash(blocks[0])) throw new Error("delayed completion snapshot reorg detected");
  const effectivePeriod = blocks[0].timestamp / PERIOD_SECONDS * PERIOD_SECONDS;
  const stopped = source.stoppedRow;
  const stoppedRow = Object.freeze({ id: stopped.id, commitment: stopped.commitment, status: "signed-simulated" as const, outerNonce: stopped.outerNonce!, materializationHash: stopped.materializationHash!, prestateHash: stopped.prestateHash!, requestHash: stopped.requestHash!, signedCalldataHash: stopped.signedCalldataHash!, simulationEvidenceHash: stopped.simulationEvidenceHash!, outerDataHash: stopped.outerDataHash! });
  const body = { kind: "VERIFIED_USDC_DELAYED_COMPLETION_CERTIFICATE" as const, scope: USDC_DELAYED_COMPLETION_SCOPE, sourceJournalHash: source.sourceJournalHash, snapshot: Object.freeze({ blockNumber: blocks[0].number.toString(), blockHash: blocks[0].hash, timestamp: blocks[0].timestamp.toString(), stateHash: publicHash(leftState) }), effectivePeriod, minimumOuterNonce, safeNonce: leftState.safeNonce, delayQueueNonce: leftState.delayQueueNonce, delayTxNonce: leftState.delayTxNonce, safeUsdcBalance: leftState.safeUsdcBalance, funderUsdcBalance: leftState.funderUsdcBalance, rawNativeSpend: Object.freeze({ ...leftState.nativeSpend }), rawUsdcSpend: Object.freeze({ ...leftState.usdcSpend }), stoppedRow };
  const certificate = Object.freeze({ ...body, certificateHash: publicHash(body) }) as VerifiedUsdcDelayedCompletionCertificate;
  certificates.add(certificate);
  return certificate;
}

export function isVerifiedUsdcDelayedCompletionCertificate(value: unknown): value is VerifiedUsdcDelayedCompletionCertificate {
  return !!value && typeof value === "object" && certificates.has(value as object);
}
