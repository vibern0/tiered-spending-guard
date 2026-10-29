import { createHash } from "node:crypto";
import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { queueFingerprint, queueMonitoringFingerprint, type DelayQueueItem } from "../../src/queue/delay";
import { SAFE_TX_TYPES } from "../../src/signers/types";
import { passkeySignerBindingHash } from "../../src/topology/evidence";
import { PHASE_OUTLAY_LIMIT, type LiveJournal } from "./submission";
import type { OrdinaryScenarioJournal, OrdinaryScenarioProposal } from "./ordinary-scenario-executor";
import {
  assertExpiredHashlessContinuationAuthorization,
  assertExpiredHashlessContinuationLineage,
  type ExpiredHashlessContinuationApproval,
  type ExpiredHashlessContinuationProposal,
} from "./ordinary-scenario-hashless-continuation";
import { assertUsdcSuccessorAuthorization, type UsdcSuccessorApproval, type UsdcSuccessorProposal } from "./ordinary-scenario-usdc-successor-proposal";
import { isVerifiedUsdcSuccessorCertificate, type UsdcSuccessorRawSpend, type UsdcSuccessorSource, type VerifiedUsdcSuccessorCertificate } from "./ordinary-scenario-usdc-successor-certificate";

export const REPAIR_ACTION_IDS = Object.freeze([
  "repair-signer-create",
  "repair-queue",
  "repair-ready-execute",
  "post-rotation-old-secondary-rejection",
  "post-rotation-new-secondary-queue",
  "post-rotation-proof-cancel",
  "final-freeze",
] as const);
export const REPAIR_PROOF_HASH = "0x0914781ff9eb80767d7ac821c6202faeff67d931f8f7e5c106c604bb8d5575af" as Hex;
export const REPAIR_BINDING_HASH = "0x0b6ee6df2bef06f7b57292fef28157928a7026b668d3e1e2a9a641d7a5bedeef" as Hex;
export const PRE_ROTATION_POLICY_HASH = "0x5b19fb0f9dcc35db4d45ec227f01348985431d74a2092d887bc7b4f26ade4a82" as Hex;
export const POST_ROTATION_POLICY_HASH = "0xf77e71d221b6ba2ac8daba8f64e4527ff34322d22449d3159a4b92a0e9f07229" as Hex;
export const REPAIR_MAX_APPROVAL_WAIT_MS = 600_000;
const CHAIN_ID = 11155111;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const CANDIDATE = "0xCc3C12cFB2508E5E9E4EB9b21CC44A9dEEFf0908" as Address;
const OLD_SECONDARY = "0xF94b0fbDCa0eF0Bf7Bd142aF832Bab17108C0D42" as Address;
const FACTORY = "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf" as Address;
export const REPAIR_MAINTENANCE = "0x3d20c6c361bdb1970827c9450beec0e3cd78e654" as Address;
export const REPAIR_RECIPIENT = "0xad4d5cd2ec5becdb9608bad4c36f0dbe8b2492bc" as Address;
const VERIFIERS = 1111636484949241205398856388087597953580887526884n;
const CREATION_CALLDATA_HASH = "0x0ed506887dea4406bb68a77a9d4c54b2454946b80b9205772900008859a92c7b" as Hex;
const HASH = /^0x[0-9a-fA-F]{64}$/;

const FACTORY_ABI = [{ type: "function", name: "createSigner", stateMutability: "nonpayable", inputs: [{ name: "x", type: "uint256" }, { name: "y", type: "uint256" }, { name: "verifiers", type: "uint176" }], outputs: [{ type: "address" }] }] as const;
const REPLACE_ABI = [{ type: "function", name: "replaceSigner", stateMutability: "nonpayable", inputs: [{ name: "guard", type: "address" }, { name: "role", type: "uint8" }, { name: "expectedOld", type: "address" }, { name: "replacement", type: "address" }, { name: "previousOwner", type: "address" }, { name: "threshold", type: "uint256" }, { name: "replacementProof", type: "bytes" }] }] as const;
const DELAY_MODULE_ABI = [{ type: "function", name: "execTransactionFromModule", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }], outputs: [{ type: "bool" }] }] as const;
const DELAY_ABI = [
  { type: "function", name: "executeNextTx", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }] },
  { type: "function", name: "setTxNonce", stateMutability: "nonpayable", inputs: [{ name: "nonce", type: "uint256" }] },
] as const;
const GUARD_ABI = [{ type: "function", name: "freeze", stateMutability: "nonpayable", inputs: [] }] as const;
const FACTORY_CREATED_ABI = [{ type: "event", name: "Created", inputs: [{ indexed: false, name: "signer", type: "address" }, { indexed: false, name: "x", type: "uint256" }, { indexed: false, name: "y", type: "uint256" }, { indexed: false, name: "verifiers", type: "uint176" }] }] as const;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const publicHash = (value: unknown): Hex => `0x${createHash("sha256").update(JSON.stringify(publicValue(value))).digest("hex")}` as Hex;
const rawHash = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const safeHash = (chainId: number, safe: Address, nonce: bigint, to: Address, value: bigint, data: Hex, operation: 0 | 1 = 0): Hex => hashTypedData({ domain: { chainId, verifyingContract: safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { to, value, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce } });
const canonicalHex = (value: Hex, label: string): void => { if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`${label} must be canonical bytes`); };

export type RepairCanonicalState = Readonly<{
  chainId: number; blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint;
  safeNonce: bigint; delayQueueNonce: bigint; delayTxNonce: bigint;
  safeContractSecondary: Address; candidateRuntimeCodeHash: Hex; candidateBindingHash: Hex;
  policyHash: Hex; frozen: boolean;
  nativeWindow: bigint; nativeBaseSpent: bigint; nativeInstantSpent: bigint;
  usdcWindow: bigint; usdcBaseSpent: bigint; usdcInstantSpent: bigint;
  nativeBalance: bigint; usdcBalance: bigint; topologyEvidenceHash: Hex; observerReady: boolean;
}>;

export type RepairCreationQuote = Readonly<{
  chainId: number; factory: Address; candidate: Address; x: bigint; y: bigint; verifiers: bigint;
  calldata: Hex; calldataHash: Hex; gasLimitCap: bigint; maxFeePerGasCap: bigint; maxPriorityFeePerGasCap: bigint;
}>;

export type RepairExecutionDomain = Readonly<{ chainId: number; candidate: Address; factory: Address; oldSecondary: Address; maintenance: Address; recipient: Address; bindingHash: Hex; proofHash: Hex; beforePolicyHash: Hex; afterPolicyHash: Hex; verifiers: bigint; creationCalldataHash: Hex }>;
const domainBrands = new WeakSet<object>();
export function validateRepairExecutionDomain(domain: RepairExecutionDomain, verifyCanonicalProfile: (domain: RepairExecutionDomain) => true): RepairExecutionDomain {
  if (!Number.isSafeInteger(domain.chainId) || domain.chainId <= 0 || [domain.candidate, domain.factory, domain.oldSecondary, domain.maintenance, domain.recipient].some(value => !/^0x[0-9a-fA-F]{40}$/.test(value)) || domain.verifiers <= 0n || !HASH.test(domain.bindingHash) || !HASH.test(domain.proofHash) || !HASH.test(domain.beforePolicyHash) || !HASH.test(domain.afterPolicyHash) || !HASH.test(domain.creationCalldataHash) || verifyCanonicalProfile(domain) !== true) throw new Error("repair execution domain canonical profile verification failed");
  const value = Object.freeze({ ...domain }); domainBrands.add(value); return value;
}
export const PRODUCTION_REPAIR_EXECUTION_DOMAIN = validateRepairExecutionDomain({ chainId: CHAIN_ID, candidate: CANDIDATE, factory: FACTORY, oldSecondary: OLD_SECONDARY, maintenance: REPAIR_MAINTENANCE, recipient: REPAIR_RECIPIENT, bindingHash: REPAIR_BINDING_HASH, proofHash: REPAIR_PROOF_HASH, beforePolicyHash: PRE_ROTATION_POLICY_HASH, afterPolicyHash: POST_ROTATION_POLICY_HASH, verifiers: VERIFIERS, creationCalldataHash: CREATION_CALLDATA_HASH }, () => true);
const assertDomain = (domain: RepairExecutionDomain): void => { if (!domainBrands.has(domain)) throw new Error("repair execution domain is not canonically verified"); };

export type RepairActionReview = Readonly<{
  id: typeof REPAIR_ACTION_IDS[number]; kind: "factory-create" | "safe-queue" | "delay-execute" | "signed-rejection" | "safe-cancel" | "safe-freeze";
  dependsOn: readonly string[]; signerRoles: readonly string[]; policyPhase: "pre-rotation" | "post-rotation";
  safeNonceBefore: string; safeNonceAfter: string; delayQueueNonceBefore: string; delayQueueNonceAfter: string; delayTxNonceBefore: string; delayTxNonceAfter: string;
  commitment: Hex; gasLimitCap: string; maxFeePerGasCap: string; maxPriorityFeePerGasCap: string;
  safeTxHash: Hex | null; requestDataHash: Hex; queueFingerprint: Hex | null; monitoringFingerprint: Hex | null;
  alert: "none" | "delayed-queued" | "delayed-executed" | "delayed-cancelled";
}>;

export type RepairCreationProposal = Readonly<{
  schemaVersion: 1; scope: "repair-signer-create-v1"; authorization: "NONE"; chainId: number;
  proposalHash: Hex; predecessor: RepairPredecessorBinding; prefixHash: Hex; originalProposalHash: Hex; originalApprovalHash: Hex; originalActionCount: 38 | 41;
  cumulativeActualCostWei: string; maximumCumulativeOutlayWei: string; phaseLimitWei: string;
  safe: Address; guard: Address; delay: Address; funder: Address; periodAnchor: string;
  candidate: Address; factory: Address; x: string; y: string; verifiers: string; creationCalldata: Hex; bindingHash: Hex; candidateRuntimeCodeHash: Hex; alreadyDeployed: boolean;
  preRotationBlockNumber: string; preRotationBlockHash: Hex; originalIdentityHash: Hex; currentTopologyEvidenceHash: Hex;
  baseline: Readonly<{ safeNonce: string; delayQueueNonce: string; delayTxNonce: string; safeContractSecondary: Address; policyHash: Hex; frozen: false; nativeWindow: string; nativeBaseSpent: string; nativeInstantSpent: string; usdcWindow: string; usdcBaseSpent: string; usdcInstantSpent: string; nativeBalance: string; usdcBalance: string }>;
  action: RepairActionReview;
}>;

export type RepairFixedFields = Readonly<{ guard: Address; role: 1; expectedOld: Address; replacement: Address; previousOwner: Address; threshold: "1"; proofHash: Hex; assertionHash: Hex; maintenance: Address; maintenanceCalldataHash: Hex }>;
export type RepairGroupProposal = Readonly<{
  schemaVersion: 1; scope: "repair-tail-group-v1"; authorization: "NONE"; chainId: number; proposalHash: Hex;
  predecessor: RepairPredecessorBinding; prefixHash: Hex; creationProposalHash: Hex; originalProposalHash: Hex; originalApprovalHash: Hex;
  cumulativeActualCostWei: string; maximumCumulativeOutlayWei: string; phaseLimitWei: string;
  safe: Address; delay: Address; guard: Address; candidate: Address; oldSecondary: Address; recipient: Address;
  beforePolicyHash: Hex; afterPolicyHash: Hex; beforeSignerIdentityHash: Hex; afterSignerIdentityHash: Hex;
  periodAnchor: string; establishedNativeWindow: string; establishedEffectivePeriod?: string; repair: RepairFixedFields; actions: readonly RepairActionReview[];
  repairQueueTiming: Readonly<{ source: "CANONICAL_RECEIPT_CREATED_AT_ONLY"; queueNonce: string; queueFingerprint: Hex; cooldownSeconds: "120"; expirationSeconds: "600" }>;
  baseline: RepairCreationProposal["baseline"];
}>;
export type TransientRepairGroup = Readonly<{ assertion: Hex; maintenanceCalldata: Hex; safeTransactionData: Hex }>;
export type PreparedRepairGroup = Readonly<{ proposal: RepairGroupProposal; transient: TransientRepairGroup }>;
export type RepairQueueTimingEvidence = Readonly<{ transactionHash: Hex; blockNumber: bigint; blockHash: Hex; queueFingerprint: Hex; createdAt: bigint; readyAt: bigint; expiresAt: bigint; maintenanceCalldata: Hex }>;
export type RepairApproval = Readonly<{ approvalHash: Hex }>;
const approvalBindings = new WeakMap<object, RepairCreationProposal | RepairGroupProposal>();

export type RepairPrefixEvidence = Readonly<{ actionId: string; evidenceHash: Hex; transactionHash?: Hex }>;
export type RepairPredecessorBinding = Readonly<{
  kind: "terminal-first38-v1" | "expired-hashless-continuation-v1" | "usdc-period-successor-v1";
  actionCount: 38 | 41;
  prefixHash: Hex;
  certificateHash: Hex | null;
  continuationProposalHash: Hex | null;
  continuationApprovalHash: Hex | null;
  observerIdentityHash: Hex | null;
  observerEvidenceHash: Hex;
  effectivePeriod?: string;
  rawNativeSpend?: Readonly<{ window: string; baseSpent: string; instantSpent: string }>;
  rawUsdcSpend?: Readonly<{ window: string; baseSpent: string; instantSpent: string }>;
}>;
export type VerifiedRepairPredecessor = RepairPredecessorBinding & Readonly<{
  safeNonce: bigint; delayQueueNonce: bigint; delayTxNonce: bigint; cumulativeActualCostWei: bigint; effectivePeriod?: bigint;
}>;
const predecessorBrands = new WeakSet<object>();
const assertVerifiedPredecessor = (value: VerifiedRepairPredecessor): void => { if (!predecessorBrands.has(value)) throw new Error("repair predecessor is not opaque and verified"); };

export type RepairContinuationStorage = {
  schemaVersion: 1; predecessor: RepairPredecessorBinding; prefixHash: Hex; originalActionCount: 38 | 41; cumulativeActualCostWei: string;
  creationProposalHash: Hex; creationApprovalHash?: Hex; groupProposalHash?: Hex; groupApprovalHash?: Hex;
  actions: Array<{ id: typeof REPAIR_ACTION_IDS[number]; commitment: Hex; status: "proposed" | "approved" | "pending" | "confirmed" | "rejection-proved" | "stopped"; transactionHash?: Hex; evidenceHash?: Hex }>;
};

const assertEvidence = (records: readonly Readonly<{ id: string; evidenceHash?: Hex; transactionHash?: Hex }>[], evidence: readonly RepairPrefixEvidence[], offset: number, sourceEvidence?: Readonly<{ index: number; hash: Hex }>): void => {
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!; const expectedHash = sourceEvidence?.index === index ? sourceEvidence.hash : record.evidenceHash; const item = evidence[offset + index];
    if (!expectedHash || !item || item.actionId !== record.id || !same(item.evidenceHash, expectedHash) || (record.transactionHash !== undefined && (!item.transactionHash || !same(item.transactionHash, record.transactionHash))) || (record.transactionHash === undefined && item.transactionHash !== undefined)) throw new Error(`repair continuation canonical prefix evidence mismatch at ${offset + index}`);
  }
};

export type RepairPredecessorLineage =
  | Readonly<{ kind: "expired-hashless-continuation-v1"; continuation: ExpiredHashlessContinuationProposal; approval: ExpiredHashlessContinuationApproval }>
  | Readonly<{ kind: "usdc-period-successor-v1"; source: UsdcSuccessorSource; certificate: VerifiedUsdcSuccessorCertificate; successor: UsdcSuccessorProposal; approval: UsdcSuccessorApproval }>;

const successfulReceiptGas = (
  records: readonly import("./ordinary-scenario-executor").OrdinaryScenarioActionRecord[],
  liveEntries: readonly LiveJournal["entries"][number][],
  offset: number,
  label: string,
): bigint => records.reduce((sum, record, index) => {
  if (!record.receipt || record.ourReceiptGasCost === undefined) throw new Error(`${label} receipt gas accounting is incomplete`);
  const receiptGasUsed = BigInt(record.receipt.gasUsed), receiptEffectiveGasPrice = BigInt(record.receipt.effectiveGasPrice), receiptCost = receiptGasUsed * receiptEffectiveGasPrice;
  if (BigInt(record.ourReceiptGasCost) !== receiptCost) throw new Error(`${label} stored receipt gas accounting mismatch`);
  const live = liveEntries[offset + index]; const outerValue = BigInt(record.outerValue ?? "0");
  if (!live || live.id !== record.id || !live.receipt || live.transactionHash !== record.transactionHash || live.receipt.transactionHash !== record.receipt.transactionHash || BigInt(live.receipt.gasUsed) !== receiptGasUsed || BigInt(live.receipt.effectiveGasPrice) !== receiptEffectiveGasPrice || BigInt(live.receipt.blockNumber) !== BigInt(record.receipt.blockNumber) || !same(live.receipt.blockHash, record.receipt.blockHash) || BigInt(live.reserved) !== receiptCost + outerValue) throw new Error(`${label} live receipt gas accounting mismatch`);
  return sum + receiptCost;
}, 0n);

const spendBinding = (value: UsdcSuccessorRawSpend) => Object.freeze({ window: value.window.toString(), baseSpent: value.baseSpent.toString(), instantSpent: value.instantSpent.toString() });

export function verifyRepairPredecessor(
  proposal: OrdinaryScenarioProposal,
  journal: OrdinaryScenarioJournal,
  evidence: readonly RepairPrefixEvidence[],
  lineage?: RepairPredecessorLineage,
): VerifiedRepairPredecessor {
  if (journal.proposalHash !== proposal.proposalHash || journal.reviewPackageHash !== proposal.reviewPackageHash || journal.chainId !== proposal.chainId || journal.liveJournal.chainId !== proposal.chainId) throw new Error("repair continuation prefix identity mismatch");
  const assertProjectedLivePrefix = (expectedIds: readonly string[]): typeof journal.liveJournal.entries => {
    const prefix = journal.liveJournal.entries.slice(0, expectedIds.length);
    if (prefix.length !== expectedIds.length || prefix.some((entry, index) => entry.id !== expectedIds[index] || entry.status !== "success" || !entry.receipt)) throw new Error("repair continuation live entry catalog has extras, duplicates, or omissions");
    const repairEntries = journal.liveJournal.entries.slice(expectedIds.length);
    const repairIds = new Set<string>();
    for (const entry of repairEntries) {
      if (!REPAIR_ACTION_IDS.includes(entry.id as typeof REPAIR_ACTION_IDS[number]) || repairIds.has(entry.id)) throw new Error("repair continuation live entry catalog has extras, duplicates, or omissions");
      repairIds.add(entry.id);
    }
    return prefix;
  };
  if (lineage === undefined) {
    if (journal.hashlessContinuation !== undefined || proposal.actions.length !== 38 || journal.actions.length !== 38 || evidence.length !== 38) throw new Error("repair continuation requires the terminal 38-action predecessor or complete continuation lineage");
    for (let index = 0; index < 38; index++) { const action = proposal.actions[index]!; const record = journal.actions[index]!; const expected = action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed"; if (record.id !== action.id || !same(record.commitment, action.commitment) || record.status !== expected || (expected === "confirmed" && !record.transactionHash)) throw new Error("repair continuation canonical predecessor is incomplete"); }
    assertEvidence(journal.actions, evidence, 0);
    const firstRepairEntry = journal.liveJournal.entries.findIndex(entry => REPAIR_ACTION_IDS.includes(entry.id as typeof REPAIR_ACTION_IDS[number]));
    const predecessorLiveEntries = journal.liveJournal.entries.slice(0, firstRepairEntry < 0 ? journal.liveJournal.entries.length : firstRepairEntry);
    if (predecessorLiveEntries.some(entry => entry.status !== "success" || !entry.receipt)) throw new Error("repair continuation prior journal is pending, reverted, or uncertain");
    assertProjectedLivePrefix(predecessorLiveEntries.map(entry => entry.id));
    const cumulative = BigInt(proposal.baselineActualCostWei) + predecessorLiveEntries.reduce((sum, entry) => sum + entry.reserved, 0n);
    if (cumulative > PHASE_OUTLAY_LIMIT) throw new Error("repair continuation cumulative phase cost exceeds ceiling");
    const value = Object.freeze({ kind: "terminal-first38-v1" as const, actionCount: 38 as const, prefixHash: publicHash({ proposalHash: proposal.proposalHash, approvalHash: journal.approvalHash, actions: journal.actions, liveJournal: { chainId: journal.liveJournal.chainId, entries: predecessorLiveEntries } }), certificateHash: null, continuationProposalHash: null, continuationApprovalHash: null, observerIdentityHash: null, observerEvidenceHash: proposal.observerEvidenceHash, safeNonce: 14n, delayQueueNonce: 6n, delayTxNonce: 6n, cumulativeActualCostWei: cumulative }); predecessorBrands.add(value); return value;
  }
  if (lineage.kind === "usdc-period-successor-v1") {
    assertExpiredHashlessContinuationLineage(proposal, lineage.source.recovery); assertExpiredHashlessContinuationAuthorization(lineage.source.recovery, lineage.source.recoveryApproval);
    if (!isVerifiedUsdcSuccessorCertificate(lineage.certificate)) throw new Error("repair USDC successor certificate is not opaque and verified");
    assertUsdcSuccessorAuthorization(lineage.successor, lineage.approval);
    const attachedRecovery = journal.hashlessContinuation, attachedSuccessor = journal.usdcSuccessor;
    if (evidence.length !== 41) throw new Error("repair USDC successor evidence must cover exactly 19+3+19 semantic actions");
    if (!attachedRecovery || !attachedSuccessor || journal.actions.length !== 19 || attachedRecovery.actions.length !== 22 || attachedRecovery.actionCommitments.length !== 22 || attachedSuccessor.actions.length !== 19 || attachedSuccessor.actionCommitments.length !== 19 || !same(attachedRecovery.historicalPrefixHash, lineage.source.recovery.historicalPrefixHash) || !same(attachedRecovery.certificateHash, lineage.source.recovery.certificateHash) || !same(attachedRecovery.proposalHash, lineage.source.recovery.proposalHash) || !same(attachedRecovery.approvalHash, lineage.source.recoveryApproval.approvalHash) || publicHash(attachedRecovery.source) !== publicHash(lineage.source.recovery.source) || !same(attachedSuccessor.sourceHash, lineage.successor.sourceHash) || !same(attachedSuccessor.certificateHash, lineage.certificate.certificateHash) || !same(attachedSuccessor.proposalHash, lineage.successor.proposalHash) || !same(attachedSuccessor.approvalHash, lineage.approval.approvalHash) || attachedSuccessor.effectivePeriod !== lineage.successor.effectivePeriod) throw new Error("repair USDC successor lineage header or catalog is not canonical");
    for (let index = 0; index < 19; index++) { const record = journal.actions[index]!, source = proposal.actions[index]!; const expected = index === 18 ? "signed-simulated" : source.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed"; if (record.id !== source.id || !same(record.commitment, source.commitment) || record.status !== expected) throw new Error("repair USDC successor historical source prefix changed"); }
    assertEvidence(journal.actions, evidence, 0, { index: 18, hash: publicHash(lineage.source.recovery.source.stoppedRow) });
    const recoveryRecords = attachedRecovery.actions as readonly import("./ordinary-scenario-executor").OrdinaryScenarioActionRecord[];
    for (let index = 0; index < 22; index++) { const record = recoveryRecords[index]!, action = lineage.source.recovery.actions[index]!, commitment = attachedRecovery.actionCommitments[index]; if (record.id !== action.id || !same(record.commitment, action.commitment) || commitment?.id !== action.id || !same(commitment.commitment, action.commitment)) throw new Error("repair USDC successor native recovery catalog changed"); if (index < 3) { if (record.status !== "confirmed" || !record.transactionHash || !record.receipt || !record.evidenceHash) throw new Error("repair USDC successor native prefix is incomplete"); } else if (record.status !== "approved" || Object.keys(record).sort().join(",") !== "commitment,id,status") throw new Error("repair USDC successor superseded old USDC tail must remain untouched"); }
    assertEvidence(recoveryRecords.slice(0, 3), evidence, 19);
    const successorRecords = attachedSuccessor.actions as readonly import("./ordinary-scenario-executor").OrdinaryScenarioActionRecord[];
    for (let index = 0; index < 19; index++) { const record = successorRecords[index]!, action = lineage.successor.actions[index]!, commitment = attachedSuccessor.actionCommitments[index], expected = action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed"; if (record.id !== action.id || !same(record.commitment, action.commitment) || commitment?.id !== action.id || !same(commitment.commitment, action.commitment) || record.status !== expected || !record.evidenceHash || (expected === "confirmed" && (!record.transactionHash || !record.receipt))) throw new Error("repair USDC successor terminal catalog is incomplete or changed"); }
    assertEvidence(successorRecords, evidence, 22);
    const historicalRecords = journal.actions.slice(0, 18).filter((record): record is import("./ordinary-scenario-executor").OrdinaryScenarioActionRecord => record.status === "confirmed");
    const nativeRecords = recoveryRecords.slice(0, 3);
    const confirmedSuccessor = successorRecords.filter(record => record.status === "confirmed");
    const expectedLiveIds = [...historicalRecords, ...nativeRecords, ...confirmedSuccessor].map(record => record.id);
    if (expectedLiveIds.length !== 24) throw new Error("repair USDC successor must have exactly 24 successful live entries");
    const predecessorLiveEntries = assertProjectedLivePrefix(expectedLiveIds);
    const historicalGas = successfulReceiptGas(historicalRecords, predecessorLiveEntries, 0, "repair USDC successor historical");
    const nativeGas = successfulReceiptGas(nativeRecords, predecessorLiveEntries, historicalRecords.length, "repair USDC successor native");
    const successorGas = successfulReceiptGas(confirmedSuccessor, predecessorLiveEntries, historicalRecords.length + nativeRecords.length, "repair USDC successor");
    const priorActual = BigInt(proposal.baselineActualCostWei) + historicalGas + nativeGas;
    if (BigInt(lineage.successor.reservation.priorActualGasCostWei) !== priorActual || BigInt(lineage.successor.reservation.priorPrincipalWei) !== 60_000_000_000_002n) throw new Error("repair USDC successor prior accounting lineage changed");
    if (confirmedSuccessor.some(record => BigInt(record.ourPrincipalDelta ?? "0") !== 0n || BigInt(record.outerValue ?? "0") !== 0n)) throw new Error("repair USDC successor principal accounting mismatch");
    const cumulative = priorActual + BigInt(lineage.successor.reservation.priorPrincipalWei) + successorGas;
    if (cumulative > PHASE_OUTLAY_LIMIT) throw new Error("repair USDC successor cumulative phase cost exceeds ceiling");
    const rawNativeSpend = spendBinding(lineage.certificate.rawNativeSpend), rawUsdcSpend = spendBinding(lineage.certificate.rawUsdcSpend), effectivePeriod = lineage.certificate.effectivePeriod;
    if (lineage.successor.effectivePeriod !== effectivePeriod.toString() || rawNativeSpend.window === effectivePeriod.toString() || rawUsdcSpend.window !== "0") throw new Error("repair USDC successor raw/effective period binding mismatch");
    const prefixHash = publicHash({ originalProposalHash: proposal.proposalHash, originalApprovalHash: journal.approvalHash, historicalActions: journal.actions.slice(0, 19), historicalLiveEntries: journal.liveJournal.entries.slice(0, 10), recoveryCertificateHash: lineage.source.recovery.certificateHash, recoveryProposalHash: lineage.source.recovery.proposalHash, recoveryApprovalHash: lineage.source.recoveryApproval.approvalHash, nativeRecoveryActions: recoveryRecords.slice(0, 3), untouchedOldUsdcActions: recoveryRecords.slice(3), successorCertificateHash: lineage.certificate.certificateHash, successorProposalHash: lineage.successor.proposalHash, successorApprovalHash: lineage.approval.approvalHash, successorActions: successorRecords, successorCommitments: attachedSuccessor.actionCommitments, observer: lineage.successor.observer, effectivePeriod: effectivePeriod.toString(), rawNativeSpend, rawUsdcSpend });
    const value = Object.freeze({ kind: "usdc-period-successor-v1" as const, actionCount: 41 as const, prefixHash, certificateHash: lineage.certificate.certificateHash, continuationProposalHash: lineage.successor.proposalHash, continuationApprovalHash: lineage.approval.approvalHash, observerIdentityHash: publicHash(lineage.successor.observer), observerEvidenceHash: lineage.successor.observer.probeEvidenceHash, effectivePeriod, rawNativeSpend, rawUsdcSpend, safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, cumulativeActualCostWei: cumulative }); predecessorBrands.add(value); return value;
  }
  if (lineage.kind !== "expired-hashless-continuation-v1") throw new Error("repair continuation lineage kind is unsupported");
  assertExpiredHashlessContinuationLineage(proposal, lineage.continuation); assertExpiredHashlessContinuationAuthorization(lineage.continuation, lineage.approval);
  const attached = journal.hashlessContinuation;
  if (evidence.length !== 41) throw new Error("repair continuation evidence must cover the complete 19+22 lineage");
  if (!attached || journal.actions.length !== 19 || attached.actions.length !== 22 || attached.actionCommitments.length !== 22 || !same(attached.historicalPrefixHash, lineage.continuation.historicalPrefixHash) || !same(attached.certificateHash, lineage.continuation.certificateHash) || !same(attached.proposalHash, lineage.continuation.proposalHash) || !same(attached.approvalHash, lineage.approval.approvalHash) || publicHash(attached.source) !== publicHash(lineage.continuation.source)) throw new Error("repair continuation lineage header or catalog is not canonical");
  for (let index = 0; index < 19; index++) { const record = journal.actions[index]!; const source = proposal.actions[index]!; if (record.id !== source.id || !same(record.commitment, source.commitment)) throw new Error("repair continuation historical source prefix changed"); const expected = index === 18 ? "signed-simulated" : source.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed"; if (record.status !== expected) throw new Error("repair continuation historical source prefix is incomplete"); }
  const stoppedEvidence = publicHash(lineage.continuation.source.stoppedRow); assertEvidence(journal.actions, evidence, 0, { index: 18, hash: stoppedEvidence });
  const progressed = attached.actions as readonly import("./ordinary-scenario-executor").OrdinaryScenarioActionRecord[];
  for (let index = 0; index < 22; index++) { const action = lineage.continuation.actions[index]!; const record = progressed[index]!; const expected = action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed"; if (record.id !== action.id || !same(record.commitment, action.commitment) || attached.actionCommitments[index]?.id !== action.id || !same(attached.actionCommitments[index]!.commitment, action.commitment) || record.status !== expected || !record.evidenceHash || (expected === "confirmed" && (!record.transactionHash || !record.receipt))) throw new Error("repair continuation terminal catalog is incomplete or changed"); }
  assertEvidence(progressed, evidence, 19);
  const historicalRecords = journal.actions.slice(0, 18).filter((record): record is import("./ordinary-scenario-executor").OrdinaryScenarioActionRecord => record.status === "confirmed");
  const continuationRecords = progressed.filter(record => record.status === "confirmed");
  const expectedLiveIds = [...historicalRecords.map(record => record.id), ...continuationRecords.map(record => record.id)];
  const predecessorLiveEntries = assertProjectedLivePrefix(expectedLiveIds);
  const historicalGas = successfulReceiptGas(historicalRecords, predecessorLiveEntries, 0, "repair continuation");
  if (BigInt(lineage.continuation.reservation.originalActualGasCostWei) !== BigInt(proposal.baselineActualCostWei) + historicalGas || BigInt(lineage.continuation.reservation.originalPrincipalWei) !== 60_000_000_000_001n) throw new Error("repair continuation original accounting lineage changed");
  const continuationGas = successfulReceiptGas(continuationRecords, predecessorLiveEntries, historicalRecords.length, "repair continuation");
  const replacementPrincipal = progressed.reduce((sum, record) => sum + BigInt(record.ourPrincipalDelta ?? "0"), 0n);
  if (replacementPrincipal !== 1n) throw new Error("repair continuation replacement principal accounting mismatch");
  const cumulative = BigInt(lineage.continuation.reservation.originalActualGasCostWei) + 60_000_000_000_001n + continuationGas + replacementPrincipal;
  if (cumulative > PHASE_OUTLAY_LIMIT) throw new Error("repair continuation cumulative phase cost exceeds ceiling");
  const prefixHash = publicHash({ originalProposalHash: proposal.proposalHash, originalApprovalHash: journal.approvalHash, historicalActions: journal.actions.slice(0, 19), historicalLiveEntries: journal.liveJournal.entries.slice(0, 10), certificateHash: lineage.continuation.certificateHash, continuationProposalHash: lineage.continuation.proposalHash, continuationApprovalHash: lineage.approval.approvalHash, continuationActions: progressed.slice(0, 22), continuationCommitments: attached.actionCommitments, observer: lineage.continuation.observer });
  const value = Object.freeze({ kind: "expired-hashless-continuation-v1" as const, actionCount: 41 as const, prefixHash, certificateHash: lineage.continuation.certificateHash, continuationProposalHash: lineage.continuation.proposalHash, continuationApprovalHash: lineage.approval.approvalHash, observerIdentityHash: publicHash(lineage.continuation.observer), observerEvidenceHash: lineage.continuation.observer.probeEvidenceHash, safeNonce: 15n, delayQueueNonce: 7n, delayTxNonce: 7n, cumulativeActualCostWei: cumulative }); predecessorBrands.add(value); return value;
}

function assertPreRepairState(state: RepairCanonicalState, proposal: OrdinaryScenarioProposal, candidateMustExist: boolean, predecessor: VerifiedRepairPredecessor, domain: RepairExecutionDomain): void {
  assertVerifiedPredecessor(predecessor);
  if (state.chainId !== domain.chainId || state.safeNonce !== predecessor.safeNonce || state.delayQueueNonce !== predecessor.delayQueueNonce || state.delayTxNonce !== predecessor.delayTxNonce) throw new Error("repair continuation protocol nonce mismatch");
  if (!same(state.safeContractSecondary, domain.oldSecondary) || !same(state.safeContractSecondary, proposal.safeContractSecondary) || !same(state.policyHash, domain.beforePolicyHash) || state.frozen || !HASH.test(state.topologyEvidenceHash) || !state.observerReady) throw new Error("repair continuation pre-rotation state mismatch");
  const deployed = !/^0x0{64}$/i.test(state.candidateRuntimeCodeHash);
  if (candidateMustExist !== deployed || (deployed && !same(state.candidateBindingHash, domain.bindingHash))) throw new Error("repair continuation candidate runtime/binding mismatch");
  if (predecessor.kind === "usdc-period-successor-v1") {
    if (!predecessor.rawNativeSpend || !predecessor.rawUsdcSpend || predecessor.effectivePeriod === undefined || state.nativeWindow.toString() !== predecessor.rawNativeSpend.window || state.nativeBaseSpent.toString() !== predecessor.rawNativeSpend.baseSpent || state.nativeInstantSpent.toString() !== predecessor.rawNativeSpend.instantSpent || state.usdcWindow !== predecessor.effectivePeriod || state.usdcBaseSpent !== 10_000_000n || state.usdcInstantSpent !== 30_000_000n || state.nativeBalance !== 0n || state.usdcBalance !== 0n) throw new Error("repair USDC successor terminal raw spend, period, balance, or counter mismatch");
  }
}

function quoteAction(quote: RepairCreationQuote, predecessor: VerifiedRepairPredecessor): RepairActionReview {
  assertVerifiedPredecessor(predecessor);
  const base = { id: "repair-signer-create" as const, kind: "factory-create" as const, dependsOn: [predecessor.kind === "usdc-period-successor-v1" ? "usdc-successor-queue-ready-execute" : "usdc-queue-ready-execute"], signerRoles: ["funder"], policyPhase: "pre-rotation" as const, safeNonceBefore: predecessor.safeNonce.toString(), safeNonceAfter: predecessor.safeNonce.toString(), delayQueueNonceBefore: predecessor.delayQueueNonce.toString(), delayQueueNonceAfter: predecessor.delayQueueNonce.toString(), delayTxNonceBefore: predecessor.delayTxNonce.toString(), delayTxNonceAfter: predecessor.delayTxNonce.toString(), gasLimitCap: quote.gasLimitCap.toString(), maxFeePerGasCap: quote.maxFeePerGasCap.toString(), maxPriorityFeePerGasCap: quote.maxPriorityFeePerGasCap.toString(), safeTxHash: null, requestDataHash: quote.calldataHash, queueFingerprint: null, monitoringFingerprint: null, alert: "none" as const };
  return Object.freeze({ ...base, commitment: publicHash(base) });
}

export function createRepairCreationProposal(input: Readonly<{ proposal: OrdinaryScenarioProposal; journal: OrdinaryScenarioJournal; evidence: readonly RepairPrefixEvidence[]; lineage?: RepairPredecessorLineage; state: RepairCanonicalState; quote: RepairCreationQuote; domain?: RepairExecutionDomain }>): RepairCreationProposal {
  const domain = input.domain ?? PRODUCTION_REPAIR_EXECUTION_DOMAIN; assertDomain(domain);
  const predecessor = verifyRepairPredecessor(input.proposal, input.journal, input.evidence, input.lineage); assertVerifiedPredecessor(predecessor);
  if (input.proposal.chainId !== domain.chainId) throw new Error("repair predecessor chain/domain mismatch");
  const prefixHash = predecessor.prefixHash, cumulative = predecessor.cumulativeActualCostWei; assertPreRepairState(input.state, input.proposal, !/^0x0{64}$/i.test(input.state.candidateRuntimeCodeHash), predecessor, domain);
  const quote = input.quote; canonicalHex(quote.calldata, "repair creation calldata");
  let decoded: ReturnType<typeof decodeFunctionData>; try { decoded = decodeFunctionData({ abi: FACTORY_ABI, data: quote.calldata }); } catch { throw new Error("repair creation calldata mismatch"); }
  const expectedCalldata = encodeFunctionData({ abi: FACTORY_ABI, functionName: "createSigner", args: [quote.x, quote.y, quote.verifiers] });
  if (quote.chainId !== domain.chainId || !same(quote.factory, domain.factory) || !same(quote.candidate, domain.candidate) || quote.verifiers !== domain.verifiers || !same(passkeySignerBindingHash({ factory: quote.factory, x: quote.x, y: quote.y, verifiers: quote.verifiers }), domain.bindingHash) || decoded.functionName !== "createSigner" || !same(expectedCalldata, quote.calldata) || !same(keccak256(quote.calldata), quote.calldataHash) || !same(quote.calldataHash, domain.creationCalldataHash) || quote.gasLimitCap !== 740292n || quote.maxFeePerGasCap !== 1000000n || quote.maxPriorityFeePerGasCap !== 1000000n) throw new Error("repair creation fixed quote mismatch");
  const action = quoteAction(quote, predecessor); const maximum = cumulative + quote.gasLimitCap * quote.maxFeePerGasCap;
  if (maximum > PHASE_OUTLAY_LIMIT) throw new Error("repair creation maximum cumulative outlay exceeds ceiling");
  const originalIdentityHash = repairOriginalIdentityHash(input.proposal);
  const baseline = Object.freeze({ safeNonce: predecessor.safeNonce.toString(), delayQueueNonce: predecessor.delayQueueNonce.toString(), delayTxNonce: predecessor.delayTxNonce.toString(), safeContractSecondary: input.state.safeContractSecondary, policyHash: input.state.policyHash, frozen: false as const, nativeWindow: input.state.nativeWindow.toString(), nativeBaseSpent: input.state.nativeBaseSpent.toString(), nativeInstantSpent: input.state.nativeInstantSpent.toString(), usdcWindow: input.state.usdcWindow.toString(), usdcBaseSpent: input.state.usdcBaseSpent.toString(), usdcInstantSpent: input.state.usdcInstantSpent.toString(), nativeBalance: input.state.nativeBalance.toString(), usdcBalance: input.state.usdcBalance.toString() });
  const predecessorBinding: RepairPredecessorBinding = Object.freeze({ kind: predecessor.kind, actionCount: predecessor.actionCount, prefixHash: predecessor.prefixHash, certificateHash: predecessor.certificateHash, continuationProposalHash: predecessor.continuationProposalHash, continuationApprovalHash: predecessor.continuationApprovalHash, observerIdentityHash: predecessor.observerIdentityHash, observerEvidenceHash: predecessor.observerEvidenceHash, ...(predecessor.kind === "usdc-period-successor-v1" ? { effectivePeriod: predecessor.effectivePeriod!.toString(), rawNativeSpend: predecessor.rawNativeSpend!, rawUsdcSpend: predecessor.rawUsdcSpend! } : {}) });
  const base = { schemaVersion: 1 as const, scope: "repair-signer-create-v1" as const, authorization: "NONE" as const, chainId: domain.chainId, predecessor: predecessorBinding, prefixHash, originalProposalHash: input.proposal.proposalHash, originalApprovalHash: input.journal.approvalHash, originalActionCount: predecessor.actionCount, cumulativeActualCostWei: cumulative.toString(), maximumCumulativeOutlayWei: maximum.toString(), phaseLimitWei: PHASE_OUTLAY_LIMIT.toString(), safe: input.proposal.safe, guard: input.proposal.guard, delay: input.proposal.delay, funder: input.proposal.funder, periodAnchor: input.proposal.periodAnchor, candidate: domain.candidate, factory: domain.factory, x: quote.x.toString(), y: quote.y.toString(), verifiers: quote.verifiers.toString(), creationCalldata: quote.calldata, bindingHash: domain.bindingHash, candidateRuntimeCodeHash: input.state.candidateRuntimeCodeHash, alreadyDeployed: !/^0x0{64}$/i.test(input.state.candidateRuntimeCodeHash), preRotationBlockNumber: input.state.blockNumber.toString(), preRotationBlockHash: input.state.blockHash, originalIdentityHash, currentTopologyEvidenceHash: input.state.topologyEvidenceHash, baseline, action };
  return Object.freeze({ ...base, proposalHash: publicHash(base) });
}

export function extendJournalForRepair(journal: OrdinaryScenarioJournal, creation: RepairCreationProposal): OrdinaryScenarioJournal {
  const holder = journal as OrdinaryScenarioJournal & { repairContinuation?: RepairContinuationStorage };
  if (holder.repairContinuation) {
    if (!same(holder.repairContinuation.prefixHash, creation.prefixHash) || !same(holder.repairContinuation.creationProposalHash, creation.proposalHash) || publicHash(holder.repairContinuation.predecessor) !== publicHash(creation.predecessor)) throw new Error("repair continuation header drift");
    return journal;
  }
  holder.repairContinuation = { schemaVersion: 1, predecessor: creation.predecessor, prefixHash: creation.prefixHash, originalActionCount: creation.originalActionCount, cumulativeActualCostWei: creation.cumulativeActualCostWei, creationProposalHash: creation.proposalHash, actions: [{ id: "repair-signer-create", commitment: creation.action.commitment, status: "proposed" }] };
  return journal;
}

function continuation(journal: OrdinaryScenarioJournal, creation: RepairCreationProposal): RepairContinuationStorage {
  const value = (journal as OrdinaryScenarioJournal & { repairContinuation?: RepairContinuationStorage }).repairContinuation;
  if (!value || value.schemaVersion !== 1 || value.originalActionCount !== creation.originalActionCount || publicHash(value.predecessor) !== publicHash(creation.predecessor) || !same(value.prefixHash, creation.prefixHash) || !same(value.creationProposalHash, creation.proposalHash) || !value.creationApprovalHash || value.actions[0]?.status !== "confirmed" || !value.actions[0].evidenceHash) throw new Error("repair continuation confirmed creation header is missing or changed");
  return value;
}

function action(input: Omit<RepairActionReview, "commitment">): RepairActionReview { return Object.freeze({ ...input, commitment: publicHash(input) }); }

export function createRepairGroupProposal(input: Readonly<{ creation: RepairCreationProposal; journal: OrdinaryScenarioJournal; state: RepairCanonicalState; assertion: Hex; lineage?: RepairPredecessorLineage; domain?: RepairExecutionDomain }>): PreparedRepairGroup {
  const domain = input.domain ?? PRODUCTION_REPAIR_EXECUTION_DOMAIN; assertDomain(domain);
  const header = continuation(input.journal, input.creation); canonicalHex(input.assertion, "replacement assertion");
  if (input.creation.predecessor.kind === "expired-hashless-continuation-v1") {
    if (!input.lineage || input.lineage.kind !== "expired-hashless-continuation-v1") throw new Error("repair group requires the opaque continuation lineage");
    assertExpiredHashlessContinuationAuthorization(input.lineage.continuation, input.lineage.approval);
    if (!same(input.lineage.continuation.certificateHash, input.creation.predecessor.certificateHash ?? "") || !same(input.lineage.continuation.proposalHash, input.creation.predecessor.continuationProposalHash ?? "") || !same(input.lineage.approval.approvalHash, input.creation.predecessor.continuationApprovalHash ?? "") || publicHash(input.lineage.continuation.observer) !== input.creation.predecessor.observerIdentityHash) throw new Error("repair group continuation lineage binding mismatch");
  } else if (input.creation.predecessor.kind === "usdc-period-successor-v1") {
    if (!input.lineage || input.lineage.kind !== "usdc-period-successor-v1") throw new Error("repair group requires the opaque USDC successor lineage");
    assertUsdcSuccessorAuthorization(input.lineage.successor, input.lineage.approval);
    if (!isVerifiedUsdcSuccessorCertificate(input.lineage.certificate) || !same(input.lineage.certificate.certificateHash, input.creation.predecessor.certificateHash ?? "") || !same(input.lineage.successor.proposalHash, input.creation.predecessor.continuationProposalHash ?? "") || !same(input.lineage.approval.approvalHash, input.creation.predecessor.continuationApprovalHash ?? "") || publicHash(input.lineage.successor.observer) !== input.creation.predecessor.observerIdentityHash || input.lineage.successor.effectivePeriod !== input.creation.predecessor.effectivePeriod) throw new Error("repair group USDC successor lineage binding mismatch");
  } else if (input.lineage !== undefined) throw new Error("legacy repair group rejects continuation lineage substitution");
  if (input.assertion === "0x" || !same(input.creation.candidate, domain.candidate) || input.creation.chainId !== domain.chainId) throw new Error("repair group fixed input mismatch");
  const baseSafe = BigInt(input.creation.baseline.safeNonce), baseQueue = BigInt(input.creation.baseline.delayQueueNonce), baseTx = BigInt(input.creation.baseline.delayTxNonce);
  if (input.state.chainId !== domain.chainId || input.state.safeNonce !== baseSafe || input.state.delayQueueNonce !== baseQueue || input.state.delayTxNonce !== baseTx || !same(input.state.safeContractSecondary, domain.oldSecondary) || !same(input.state.policyHash, domain.beforePolicyHash) || input.state.frozen || !same(input.state.candidateBindingHash, domain.bindingHash) || /^0x0{64}$/i.test(input.state.candidateRuntimeCodeHash) || !input.state.observerReady) throw new Error("repair group preflight state mismatch");
  assertRepairCreationState(input.creation, input.state, true, domain);
  const guard = input.creation.guard; const safe = input.creation.safe; const delay = input.creation.delay;
  const assertionHash = keccak256(input.assertion);
  const maintenanceCalldata = encodeFunctionData({ abi: REPLACE_ABI, functionName: "replaceSigner", args: [guard, 1, domain.oldSecondary, domain.candidate, ZERO, 1n, input.assertion] });
  const repairItem: DelayQueueItem = { safe, delay, to: domain.maintenance, value: 0n, data: maintenanceCalldata, operation: 1, queueNonce: baseQueue };
  const repairQueueData = encodeFunctionData({ abi: DELAY_MODULE_ABI, functionName: "execTransactionFromModule", args: [repairItem.to, repairItem.value, repairItem.data, repairItem.operation] });
  const repairSafeHash = safeHash(domain.chainId, safe, baseSafe, delay, 0n, repairQueueData);
  const proofItem: DelayQueueItem = { safe, delay, to: domain.recipient, value: 1n, data: "0x", operation: 0, queueNonce: baseQueue + 1n };
  const proofQueueData = encodeFunctionData({ abi: DELAY_MODULE_ABI, functionName: "execTransactionFromModule", args: [proofItem.to, proofItem.value, proofItem.data, proofItem.operation] });
  const proofSafeHash = safeHash(domain.chainId, safe, baseSafe + 1n, delay, 0n, proofQueueData);
  const cancelData = encodeFunctionData({ abi: DELAY_ABI, functionName: "setTxNonce", args: [baseTx + 2n] });
  const cancelSafeHash = safeHash(domain.chainId, safe, baseSafe + 2n, delay, 0n, cancelData);
  const freezeData = encodeFunctionData({ abi: GUARD_ABI, functionName: "freeze" });
  const freezeSafeHash = safeHash(domain.chainId, safe, baseSafe + 3n, guard, 0n, freezeData);
  const repairFp = queueFingerprint(repairItem); const repairMonitoring = queueMonitoringFingerprint(repairItem); const proofFp = queueFingerprint(proofItem); const proofMonitoring = queueMonitoringFingerprint(proofItem);
  const gas = (cap: bigint) => ({ gasLimitCap: cap.toString(), maxFeePerGasCap: "1000000", maxPriorityFeePerGasCap: "1000000" });
  const n = (value: bigint) => value.toString();
  const actions: RepairActionReview[] = [
    action({ id: "repair-queue", kind: "safe-queue", dependsOn: ["repair-signer-create"], signerRoles: ["primary-passkey", "current-safe-contract-secondary"], policyPhase: "pre-rotation", safeNonceBefore: n(baseSafe), safeNonceAfter: n(baseSafe + 1n), delayQueueNonceBefore: n(baseQueue), delayQueueNonceAfter: n(baseQueue + 1n), delayTxNonceBefore: n(baseTx), delayTxNonceAfter: n(baseTx), ...gas(2000000n), safeTxHash: repairSafeHash, requestDataHash: keccak256(repairQueueData), queueFingerprint: repairFp, monitoringFingerprint: repairMonitoring, alert: "delayed-queued" }),
    action({ id: "repair-ready-execute", kind: "delay-execute", dependsOn: ["repair-queue"], signerRoles: [], policyPhase: "pre-rotation", safeNonceBefore: n(baseSafe + 1n), safeNonceAfter: n(baseSafe + 1n), delayQueueNonceBefore: n(baseQueue + 1n), delayQueueNonceAfter: n(baseQueue + 1n), delayTxNonceBefore: n(baseTx), delayTxNonceAfter: n(baseTx + 1n), ...gas(1000000n), safeTxHash: null, requestDataHash: keccak256(encodeFunctionData({ abi: DELAY_ABI, functionName: "executeNextTx", args: [repairItem.to, repairItem.value, repairItem.data, repairItem.operation] })), queueFingerprint: repairFp, monitoringFingerprint: repairMonitoring, alert: "delayed-executed" }),
    action({ id: "post-rotation-old-secondary-rejection", kind: "signed-rejection", dependsOn: ["repair-ready-execute"], signerRoles: ["primary-passkey", "old-safe-contract-secondary"], policyPhase: "post-rotation", safeNonceBefore: n(baseSafe + 1n), safeNonceAfter: n(baseSafe + 1n), delayQueueNonceBefore: n(baseQueue + 1n), delayQueueNonceAfter: n(baseQueue + 1n), delayTxNonceBefore: n(baseTx + 1n), delayTxNonceAfter: n(baseTx + 1n), ...gas(2000000n), safeTxHash: proofSafeHash, requestDataHash: keccak256(proofQueueData), queueFingerprint: proofFp, monitoringFingerprint: proofMonitoring, alert: "none" }),
    action({ id: "post-rotation-new-secondary-queue", kind: "safe-queue", dependsOn: ["post-rotation-old-secondary-rejection"], signerRoles: ["primary-passkey", "new-safe-contract-secondary"], policyPhase: "post-rotation", safeNonceBefore: n(baseSafe + 1n), safeNonceAfter: n(baseSafe + 2n), delayQueueNonceBefore: n(baseQueue + 1n), delayQueueNonceAfter: n(baseQueue + 2n), delayTxNonceBefore: n(baseTx + 1n), delayTxNonceAfter: n(baseTx + 1n), ...gas(2000000n), safeTxHash: proofSafeHash, requestDataHash: keccak256(proofQueueData), queueFingerprint: proofFp, monitoringFingerprint: proofMonitoring, alert: "delayed-queued" }),
    action({ id: "post-rotation-proof-cancel", kind: "safe-cancel", dependsOn: ["post-rotation-new-secondary-queue"], signerRoles: ["primary-passkey", "new-safe-contract-secondary"], policyPhase: "post-rotation", safeNonceBefore: n(baseSafe + 2n), safeNonceAfter: n(baseSafe + 3n), delayQueueNonceBefore: n(baseQueue + 2n), delayQueueNonceAfter: n(baseQueue + 2n), delayTxNonceBefore: n(baseTx + 1n), delayTxNonceAfter: n(baseTx + 2n), ...gas(2000000n), safeTxHash: cancelSafeHash, requestDataHash: keccak256(cancelData), queueFingerprint: proofFp, monitoringFingerprint: proofMonitoring, alert: "delayed-cancelled" }),
    action({ id: "final-freeze", kind: "safe-freeze", dependsOn: ["post-rotation-proof-cancel"], signerRoles: ["primary-passkey", "new-safe-contract-secondary"], policyPhase: "post-rotation", safeNonceBefore: n(baseSafe + 3n), safeNonceAfter: n(baseSafe + 4n), delayQueueNonceBefore: n(baseQueue + 2n), delayQueueNonceAfter: n(baseQueue + 2n), delayTxNonceBefore: n(baseTx + 2n), delayTxNonceAfter: n(baseTx + 2n), ...gas(2000000n), safeTxHash: freezeSafeHash, requestDataHash: keccak256(freezeData), queueFingerprint: null, monitoringFingerprint: null, alert: "none" }),
  ];
  const creationEntry = input.journal.liveJournal.entries.find(entry => entry.id === "repair-signer-create");
  const cumulative = BigInt(input.creation.cumulativeActualCostWei) + (creationEntry?.status === "success" ? creationEntry.reserved : 0n);
  header.cumulativeActualCostWei = cumulative.toString();
  const reservation = actions.filter(value => value.kind !== "signed-rejection").reduce((sum, value) => sum + BigInt(value.gasLimitCap) * BigInt(value.maxFeePerGasCap), 0n);
  if (cumulative + reservation > PHASE_OUTLAY_LIMIT) throw new Error("repair group maximum cumulative outlay exceeds ceiling");
  const fixed: RepairFixedFields = { guard, role: 1, expectedOld: domain.oldSecondary, replacement: domain.candidate, previousOwner: ZERO, threshold: "1", proofHash: domain.proofHash, assertionHash, maintenance: domain.maintenance, maintenanceCalldataHash: keccak256(maintenanceCalldata) };
  const repairQueueTiming = Object.freeze({ source: "CANONICAL_RECEIPT_CREATED_AT_ONLY" as const, queueNonce: n(baseQueue), queueFingerprint: repairFp, cooldownSeconds: "120" as const, expirationSeconds: "600" as const });
  const base = { schemaVersion: 1 as const, scope: "repair-tail-group-v1" as const, authorization: "NONE" as const, chainId: domain.chainId, predecessor: input.creation.predecessor, prefixHash: input.creation.prefixHash, creationProposalHash: input.creation.proposalHash, originalProposalHash: input.creation.originalProposalHash, originalApprovalHash: input.creation.originalApprovalHash, cumulativeActualCostWei: cumulative.toString(), maximumCumulativeOutlayWei: (cumulative + reservation).toString(), phaseLimitWei: PHASE_OUTLAY_LIMIT.toString(), safe, delay, guard, candidate: domain.candidate, oldSecondary: domain.oldSecondary, recipient: domain.recipient, beforePolicyHash: domain.beforePolicyHash, afterPolicyHash: domain.afterPolicyHash, beforeSignerIdentityHash: publicHash({ primary: "immutable", safeContractSecondary: domain.oldSecondary }), afterSignerIdentityHash: publicHash({ primary: "immutable", safeContractSecondary: domain.candidate }), periodAnchor: input.creation.periodAnchor, establishedNativeWindow: input.state.nativeWindow.toString(), ...(input.creation.predecessor.kind === "usdc-period-successor-v1" ? { establishedEffectivePeriod: input.creation.predecessor.effectivePeriod } : {}), repair: fixed, repairQueueTiming, baseline: input.creation.baseline, actions: Object.freeze(actions) };
  const proposal = Object.freeze({ ...base, proposalHash: publicHash(base) });
  return Object.freeze({ proposal, transient: Object.freeze({ assertion: input.assertion, maintenanceCalldata, safeTransactionData: repairQueueData }) });
}

export function validateTransientRepairQueue(proposal: RepairGroupProposal, safeTransactionData: Hex, maintenanceCalldata: Hex): true {
  canonicalHex(safeTransactionData, "repair Safe transaction data"); canonicalHex(maintenanceCalldata, "repair maintenance calldata");
  let maintenance: { functionName: "replaceSigner"; args: readonly [Address, number, Address, Address, Address, bigint, Hex] };
  let queue: { functionName: "execTransactionFromModule"; args: readonly [Address, bigint, Hex, number] };
  try {
    maintenance = decodeFunctionData({ abi: REPLACE_ABI, data: maintenanceCalldata }) as typeof maintenance;
    queue = decodeFunctionData({ abi: DELAY_MODULE_ABI, data: safeTransactionData }) as typeof queue;
  } catch { throw new Error("repair transient bytes are not canonical ABI"); }
  if (maintenance.functionName !== "replaceSigner" || !same(maintenance.args[0], proposal.repair.guard) || maintenance.args[1] !== 1 || !same(maintenance.args[2], proposal.oldSecondary) || !same(maintenance.args[3], proposal.candidate) || !same(maintenance.args[4], ZERO) || maintenance.args[5] !== 1n || keccak256(maintenance.args[6]) !== proposal.repair.assertionHash || keccak256(maintenanceCalldata) !== proposal.repair.maintenanceCalldataHash) throw new Error("repair transient decoded maintenance fields mismatch");
  const canonicalMaintenance = encodeFunctionData({ abi: REPLACE_ABI, functionName: "replaceSigner", args: [proposal.repair.guard, 1, proposal.oldSecondary, proposal.candidate, ZERO, 1n, maintenance.args[6]] });
  if (!same(canonicalMaintenance, maintenanceCalldata)) throw new Error("repair maintenance calldata is noncanonical");
  if (queue.functionName !== "execTransactionFromModule" || !same(queue.args[0], proposal.repair.maintenance) || queue.args[1] !== 0n || !same(queue.args[2], maintenanceCalldata) || queue.args[3] !== 1) throw new Error("repair transient decoded queue fields mismatch");
  const canonicalQueue = encodeFunctionData({ abi: DELAY_MODULE_ABI, functionName: "execTransactionFromModule", args: [proposal.repair.maintenance, 0n, maintenanceCalldata, 1] });
  if (!same(canonicalQueue, safeTransactionData) || keccak256(safeTransactionData) !== proposal.actions[0]!.requestDataHash) throw new Error("repair Safe transaction data is noncanonical");
  return true;
}

export function createRepairPrepareAuthorization(input: Readonly<{ creation: RepairCreationProposal; state: RepairCanonicalState; purpose: "materialize-one-repair-proof"; domain?: RepairExecutionDomain }>) {
  const domain = input.domain ?? PRODUCTION_REPAIR_EXECUTION_DOMAIN; assertDomain(domain);
  if (input.purpose !== "materialize-one-repair-proof" || input.creation.chainId !== domain.chainId || !same(input.creation.candidate, domain.candidate) || input.state.chainId !== domain.chainId || !same(input.state.policyHash, domain.beforePolicyHash) || !same(input.state.candidateBindingHash, domain.bindingHash)) throw new Error("repair prepare authorization binding mismatch");
  const base = { schemaVersion: 1 as const, scope: "repair-proof-prepare-v1" as const, authority: "PREPARE_PROOF_ONLY" as const, chainId: domain.chainId, candidate: domain.candidate, proofHash: domain.proofHash, prefixHash: input.creation.prefixHash, currentPolicyHash: input.state.policyHash, purpose: input.purpose, safeSignatureAuthority: false as const, outerSignatureAuthority: false as const, broadcastAuthority: false as const };
  return Object.freeze({ ...base, authorizationHash: publicHash(base) });
}

export function loadRepairApproval(proposal: RepairCreationProposal | RepairGroupProposal, serialized: string, expectedApprovalHash: Hex): RepairApproval {
  if (!same(rawHash(serialized), expectedApprovalHash)) throw new Error("repair approval hash mismatch");
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("repair approval must be JSON"); }
  const value = parsed as Record<string, unknown>; const actionCommitments = "action" in proposal ? [proposal.action.commitment] : proposal.actions.map(action => action.commitment);
  const expectedScope = proposal.scope;
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== ["actionCommitments", "authorization", "maxBroadcastAttempts", "phaseLimitWei", "proposalHash", "schemaVersion", "scope"].sort().join(",") || value.schemaVersion !== 1 || value.scope !== expectedScope || value.authorization !== "EXACT_ACTION_APPROVAL" || value.proposalHash !== proposal.proposalHash || value.phaseLimitWei !== PHASE_OUTLAY_LIMIT.toString() || value.maxBroadcastAttempts !== 1 || !Array.isArray(value.actionCommitments) || value.actionCommitments.length !== actionCommitments.length || value.actionCommitments.some((entry, index) => entry !== actionCommitments[index])) throw new Error("repair exact approval binding mismatch");
  const approval = Object.freeze({ approvalHash: expectedApprovalHash }); approvalBindings.set(approval, proposal); return approval;
}

export function assertRepairApproval(proposal: RepairCreationProposal | RepairGroupProposal, approval: RepairApproval): void {
  if (approvalBindings.get(approval) !== proposal) throw new Error("repair requires opaque exact validated approval");
}

export function bindRepairCreationApproval(journal: OrdinaryScenarioJournal, creation: RepairCreationProposal, approval: RepairApproval): OrdinaryScenarioJournal {
  assertRepairApproval(creation, approval);
  const value = repairContinuationStorage(journal);
  if (!value || !same(value.creationProposalHash, creation.proposalHash) || value.actions.length !== 1 || value.actions[0]?.id !== "repair-signer-create" || value.actions[0].status !== "proposed") throw new Error("repair creation proposal journal binding mismatch");
  value.creationApprovalHash = approval.approvalHash;
  value.actions[0].status = "approved";
  return journal;
}

export function recordRepairCreationConfirmation(journal: OrdinaryScenarioJournal, creation: RepairCreationProposal, evidenceHash: Hex, transactionHash?: Hex): OrdinaryScenarioJournal {
  if (!HASH.test(evidenceHash) || (transactionHash !== undefined && !HASH.test(transactionHash))) throw new Error("repair creation confirmation evidence is malformed");
  const value = repairContinuationStorage(journal); const action = value?.actions[0];
  if (!value?.creationApprovalHash || !action || action.id !== "repair-signer-create" || (action.status !== "approved" && action.status !== "pending")) throw new Error("repair creation confirmation is not approved or pending");
  action.status = "confirmed"; action.evidenceHash = evidenceHash; if (transactionHash) action.transactionHash = transactionHash; return journal;
}

export function validateRepairCreationSimulation(creation: RepairCreationProposal, result: Hex): true {
  canonicalHex(result, "repair creation simulation result");
  if (result.length !== 66) throw new Error("repair creation simulation must return one canonical address word");
  let returned: Address;
  try { [returned] = decodeAbiParameters([{ type: "address" }], result); } catch { throw new Error("repair creation simulation result is malformed"); }
  if (!same(returned, creation.candidate) || !same(result, `0x${creation.candidate.slice(2).padStart(64, "0")}`)) throw new Error("repair creation simulation returned the wrong signer");
  return true;
}

export function validateRepairCreationReceiptLogs(creation: RepairCreationProposal, logs: readonly Readonly<{ address: Address; data: Hex; topics: readonly Hex[] }>[]): true {
  const created = logs.filter(log => same(log.address, creation.factory)).flatMap(log => { try { if (log.topics.length === 0) return []; const decoded = decodeEventLog({ abi: FACTORY_CREATED_ABI, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]], strict: true }); return decoded.eventName === "Created" ? [decoded.args] : []; } catch { return []; } });
  if (created.length !== 1) throw new Error("repair creation requires one exact factory Created event"); const event = created[0]!;
  if (!same(event.signer, creation.candidate) || event.x !== BigInt(creation.x) || event.y !== BigInt(creation.y) || event.verifiers !== BigInt(creation.verifiers)) throw new Error("repair factory Created event fields mismatch"); return true;
}

export function loadRepairCreationProposal(serialized: string, expectedProposalHash: Hex, domain: RepairExecutionDomain = PRODUCTION_REPAIR_EXECUTION_DOMAIN): RepairCreationProposal {
  assertDomain(domain);
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("repair creation proposal must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("repair creation proposal must be an object");
  const value = parsed as Record<string, unknown>; const { proposalHash, ...base } = value;
  const predecessor = value.predecessor as RepairPredecessorBinding | undefined;
  if (proposalHash !== expectedProposalHash || publicHash(base) !== expectedProposalHash || value.schemaVersion !== 1 || value.scope !== "repair-signer-create-v1" || value.authorization !== "NONE" || value.chainId !== domain.chainId || !predecessor || !["terminal-first38-v1", "expired-hashless-continuation-v1", "usdc-period-successor-v1"].includes(predecessor.kind) || predecessor.actionCount !== (predecessor.kind === "terminal-first38-v1" ? 38 : 41) || value.originalActionCount !== predecessor.actionCount || value.prefixHash !== predecessor.prefixHash || !HASH.test(predecessor.observerEvidenceHash) || (predecessor.kind === "terminal-first38-v1" ? predecessor.certificateHash !== null || predecessor.continuationProposalHash !== null || predecessor.continuationApprovalHash !== null || predecessor.observerIdentityHash !== null : !HASH.test(predecessor.certificateHash ?? "") || !HASH.test(predecessor.continuationProposalHash ?? "") || !HASH.test(predecessor.continuationApprovalHash ?? "") || !HASH.test(predecessor.observerIdentityHash ?? "")) || (predecessor.kind === "usdc-period-successor-v1" && (!predecessor.effectivePeriod || !predecessor.rawNativeSpend || !predecessor.rawUsdcSpend)) || !same(String(value.candidate), domain.candidate) || !same(String(value.factory), domain.factory) || !same(String(value.bindingHash), domain.bindingHash) || value.creationCalldata === undefined || value.preRotationBlockNumber === undefined || !HASH.test(String(value.preRotationBlockHash))) throw new Error("repair creation proposal identity or fixed fields mismatch");
  const proposal = Object.freeze(value) as unknown as RepairCreationProposal;
  const start = predecessor.kind === "terminal-first38-v1" ? ["14", "6", "6"] : ["15", "7", "7"];
  const expectedDependency = predecessor.kind === "usdc-period-successor-v1" ? "usdc-successor-queue-ready-execute" : "usdc-queue-ready-execute";
  if (!HASH.test(proposal.originalIdentityHash) || !HASH.test(proposal.currentTopologyEvidenceHash) || !proposal.baseline || !same(proposal.funder, domain.recipient) || proposal.action.id !== "repair-signer-create" || proposal.action.kind !== "factory-create" || JSON.stringify(proposal.action.dependsOn) !== JSON.stringify([expectedDependency]) || proposal.action.safeNonceBefore !== start[0] || proposal.action.safeNonceAfter !== start[0] || proposal.action.delayQueueNonceBefore !== start[1] || proposal.action.delayQueueNonceAfter !== start[1] || proposal.action.delayTxNonceBefore !== start[2] || proposal.action.delayTxNonceAfter !== start[2] || proposal.action.gasLimitCap !== "740292" || proposal.action.maxFeePerGasCap !== "1000000" || proposal.action.maxPriorityFeePerGasCap !== "1000000" || keccak256(proposal.creationCalldata) !== proposal.action.requestDataHash || !same(proposal.action.requestDataHash, domain.creationCalldataHash)) throw new Error("repair creation proposal action mismatch");
  return proposal;
}

export function loadRepairGroupProposal(serialized: string, expectedProposalHash: Hex, domain: RepairExecutionDomain = PRODUCTION_REPAIR_EXECUTION_DOMAIN): RepairGroupProposal {
  assertDomain(domain);
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("repair group proposal must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("repair group proposal must be an object");
  const value = parsed as Record<string, unknown>; const { proposalHash, ...base } = value;
  const timing = value.repairQueueTiming as Record<string, unknown> | undefined; const repair = value.repair as Record<string, unknown> | undefined;
  const predecessor = value.predecessor as RepairPredecessorBinding | undefined; const rebased = predecessor?.kind === "expired-hashless-continuation-v1" || predecessor?.kind === "usdc-period-successor-v1"; const startSafe = rebased ? 15 : 14; const startQueue = rebased ? 7 : 6; const startTx = rebased ? 7 : 6;
  if (proposalHash !== expectedProposalHash || publicHash(base) !== expectedProposalHash || value.schemaVersion !== 1 || value.scope !== "repair-tail-group-v1" || value.authorization !== "NONE" || value.chainId !== domain.chainId || !predecessor || value.prefixHash !== predecessor.prefixHash || (predecessor.kind === "usdc-period-successor-v1" ? value.establishedEffectivePeriod !== predecessor.effectivePeriod : value.establishedEffectivePeriod !== undefined) || !same(String(value.candidate), domain.candidate) || !same(String(value.oldSecondary), domain.oldSecondary) || !same(String(value.recipient), domain.recipient) || !same(String(repair?.guard), String(value.guard)) || repair?.role !== 1 || !same(String(repair?.expectedOld), domain.oldSecondary) || !same(String(repair?.replacement), domain.candidate) || !same(String(repair?.previousOwner), ZERO) || repair?.threshold !== "1" || repair?.proofHash !== domain.proofHash || !HASH.test(String(repair?.assertionHash)) || !same(String(repair?.maintenance), domain.maintenance) || !HASH.test(String(repair?.maintenanceCalldataHash)) || timing?.source !== "CANONICAL_RECEIPT_CREATED_AT_ONLY" || timing.queueNonce !== String(startQueue) || timing.cooldownSeconds !== "120" || timing.expirationSeconds !== "600" || !HASH.test(String(timing.queueFingerprint)) || !value.baseline || !Array.isArray(value.actions) || value.actions.length !== 6) throw new Error("repair group proposal identity or closed action map mismatch");
  const expected = [
    ["repair-queue", "safe-queue", "pre-rotation", String(startSafe), String(startSafe + 1), String(startQueue), String(startQueue + 1), String(startTx), String(startTx), "delayed-queued"],
    ["repair-ready-execute", "delay-execute", "pre-rotation", String(startSafe + 1), String(startSafe + 1), String(startQueue + 1), String(startQueue + 1), String(startTx), String(startTx + 1), "delayed-executed"],
    ["post-rotation-old-secondary-rejection", "signed-rejection", "post-rotation", String(startSafe + 1), String(startSafe + 1), String(startQueue + 1), String(startQueue + 1), String(startTx + 1), String(startTx + 1), "none"],
    ["post-rotation-new-secondary-queue", "safe-queue", "post-rotation", String(startSafe + 1), String(startSafe + 2), String(startQueue + 1), String(startQueue + 2), String(startTx + 1), String(startTx + 1), "delayed-queued"],
    ["post-rotation-proof-cancel", "safe-cancel", "post-rotation", String(startSafe + 2), String(startSafe + 3), String(startQueue + 2), String(startQueue + 2), String(startTx + 1), String(startTx + 2), "delayed-cancelled"],
    ["final-freeze", "safe-freeze", "post-rotation", String(startSafe + 3), String(startSafe + 4), String(startQueue + 2), String(startQueue + 2), String(startTx + 2), String(startTx + 2), "none"],
  ] as const;
  for (let index = 0; index < expected.length; index++) { const action = value.actions[index] as Record<string, unknown>; const row = expected[index]!; const expectedGas = index === 1 ? "1000000" : "2000000"; if (action.id !== row[0] || action.kind !== row[1] || action.policyPhase !== row[2] || action.safeNonceBefore !== row[3] || action.safeNonceAfter !== row[4] || action.delayQueueNonceBefore !== row[5] || action.delayQueueNonceAfter !== row[6] || action.delayTxNonceBefore !== row[7] || action.delayTxNonceAfter !== row[8] || action.alert !== row[9] || action.gasLimitCap !== expectedGas || action.maxFeePerGasCap !== "1000000" || action.maxPriorityFeePerGasCap !== "1000000" || !HASH.test(String(action.commitment)) || !HASH.test(String(action.requestDataHash))) throw new Error("repair group proposal identity or closed action map mismatch"); }
  const proposal = Object.freeze(value) as unknown as RepairGroupProposal;
  if (!same(proposal.repairQueueTiming.queueFingerprint, proposal.actions[0]!.queueFingerprint ?? "") || !same(proposal.actions[2]!.safeTxHash ?? "", proposal.actions[3]!.safeTxHash ?? "")) throw new Error("repair group proposal identity or closed action map mismatch");
  return proposal;
}

export function assertRepairActionState(proposal: RepairGroupProposal, action: RepairActionReview, state: RepairCanonicalState, phase: "before" | "after", domain: RepairExecutionDomain = PRODUCTION_REPAIR_EXECUTION_DOMAIN): void {
  assertDomain(domain);
  const expectedSafe = BigInt(phase === "before" ? action.safeNonceBefore : action.safeNonceAfter);
  const expectedQueue = BigInt(phase === "before" ? action.delayQueueNonceBefore : action.delayQueueNonceAfter);
  const expectedTx = BigInt(phase === "before" ? action.delayTxNonceBefore : action.delayTxNonceAfter);
  if (state.chainId !== domain.chainId || state.safeNonce !== expectedSafe || state.delayQueueNonce !== expectedQueue || state.delayTxNonce !== expectedTx || !state.observerReady || !same(state.candidateBindingHash, domain.bindingHash) || /^0x0{64}$/i.test(state.candidateRuntimeCodeHash)) throw new Error("repair action canonical state/nonce drift");
  const rotated = action.id === "repair-ready-execute" ? phase === "after" : action.policyPhase === "post-rotation";
  if (!same(state.safeContractSecondary, rotated ? proposal.candidate : proposal.oldSecondary) || !same(state.policyHash, rotated ? proposal.afterPolicyHash : proposal.beforePolicyHash)) throw new Error("repair action signer/policy phase drift");
  const shouldBeFrozen = action.id === "final-freeze" && phase === "after";
  if (state.frozen !== shouldBeFrozen) throw new Error("repair action frozen state drift");
  if (action.id === "post-rotation-old-secondary-rejection" || action.id === "post-rotation-new-secondary-queue") {
    const anchor = BigInt(proposal.periodAnchor);
    if (state.blockTimestamp < anchor) throw new Error("repair canonical timestamp precedes period anchor");
    const effectiveWindow = anchor + ((state.blockTimestamp - anchor) / 86_400n) * 86_400n;
    const approvedEffectivePeriod = proposal.establishedEffectivePeriod ?? proposal.establishedNativeWindow;
    if (state.nativeWindow.toString() !== proposal.establishedNativeWindow || effectiveWindow.toString() !== approvedEffectivePeriod || (proposal.establishedEffectivePeriod !== undefined && state.usdcWindow.toString() !== approvedEffectivePeriod)) throw new Error("repair period rollover requires new review");
  }
}

export function assertRepairCreationState(proposal: RepairCreationProposal, state: RepairCanonicalState, candidateMustExist: boolean, domain: RepairExecutionDomain = PRODUCTION_REPAIR_EXECUTION_DOMAIN): void {
  assertDomain(domain);
  if (state.chainId !== domain.chainId || state.safeNonce.toString() !== proposal.baseline.safeNonce || state.delayQueueNonce.toString() !== proposal.baseline.delayQueueNonce || state.delayTxNonce.toString() !== proposal.baseline.delayTxNonce || !same(state.safeContractSecondary, proposal.baseline.safeContractSecondary) || !same(state.policyHash, proposal.baseline.policyHash) || state.frozen || state.nativeWindow.toString() !== proposal.baseline.nativeWindow || state.nativeBaseSpent.toString() !== proposal.baseline.nativeBaseSpent || state.nativeInstantSpent.toString() !== proposal.baseline.nativeInstantSpent || state.usdcWindow.toString() !== proposal.baseline.usdcWindow || state.usdcBaseSpent.toString() !== proposal.baseline.usdcBaseSpent || state.usdcInstantSpent.toString() !== proposal.baseline.usdcInstantSpent || state.nativeBalance.toString() !== proposal.baseline.nativeBalance || state.usdcBalance.toString() !== proposal.baseline.usdcBalance || !state.observerReady) throw new Error("repair creation canonical pre-sign state changed");
  const deployed = !/^0x0{64}$/i.test(state.candidateRuntimeCodeHash);
  if (deployed !== candidateMustExist || (deployed && !same(state.candidateBindingHash, proposal.bindingHash))) throw new Error("repair creation candidate binding state changed");
  if (proposal.predecessor.kind === "usdc-period-successor-v1") {
    const anchor = BigInt(proposal.periodAnchor), approved = BigInt(proposal.predecessor.effectivePeriod!);
    if (state.blockTimestamp < anchor || anchor + ((state.blockTimestamp - anchor) / 86_400n) * 86_400n !== approved || state.usdcWindow !== approved) throw new Error("repair USDC successor effective period changed");
  }
}

export function assertRepairBaselineUnchanged(proposal: RepairGroupProposal, state: RepairCanonicalState): void {
  const baseline = proposal.baseline;
  if (state.nativeWindow.toString() !== baseline.nativeWindow || state.nativeBaseSpent.toString() !== baseline.nativeBaseSpent || state.nativeInstantSpent.toString() !== baseline.nativeInstantSpent || state.usdcWindow.toString() !== baseline.usdcWindow || state.usdcBaseSpent.toString() !== baseline.usdcBaseSpent || state.usdcInstantSpent.toString() !== baseline.usdcInstantSpent || state.nativeBalance.toString() !== baseline.nativeBalance || state.usdcBalance.toString() !== baseline.usdcBalance) throw new Error("repair tail balance/counter drift");
  if (proposal.establishedEffectivePeriod !== undefined) {
    const anchor = BigInt(proposal.periodAnchor), approved = BigInt(proposal.establishedEffectivePeriod);
    if (state.blockTimestamp < anchor || anchor + ((state.blockTimestamp - anchor) / 86_400n) * 86_400n !== approved || state.usdcWindow !== approved) throw new Error("repair USDC successor effective period changed");
  }
}

export function assertRepairQueueTiming(proposal: RepairGroupProposal, evidence: RepairQueueTimingEvidence, state: RepairCanonicalState): void {
  const timing = proposal.repairQueueTiming;
  if (timing.source !== "CANONICAL_RECEIPT_CREATED_AT_ONLY" || timing.queueNonce !== proposal.actions[0]!.delayQueueNonceBefore || !same(evidence.queueFingerprint, timing.queueFingerprint) || evidence.readyAt !== evidence.createdAt + BigInt(timing.cooldownSeconds) || evidence.expiresAt !== evidence.readyAt + BigInt(timing.expirationSeconds)) throw new Error("repair canonical queue timing evidence mismatch");
  if (state.blockTimestamp < evidence.readyAt) throw new Error("repair queue cooldown is not ready");
  if (state.blockTimestamp >= evidence.expiresAt) throw new Error("repair queue approval expired");
}

export function recoverCanonicalRepairCalldata(proposal: RepairGroupProposal, source: Readonly<{ safeTransactionData: Hex; transactionHash: Hex; canonical: boolean }>): Readonly<{ transactionHash: Hex; maintenanceCalldataHash: Hex; safeTransactionDataHash: Hex; maintenanceCalldata: Hex }> {
  if (!source.canonical || !HASH.test(source.transactionHash)) throw new Error("repair recovery requires canonical transaction evidence");
  let decoded: { functionName: "execTransactionFromModule"; args: readonly [Address, bigint, Hex, number] }; try { decoded = decodeFunctionData({ abi: DELAY_MODULE_ABI, data: source.safeTransactionData }) as typeof decoded; } catch { throw new Error("canonical repair queue calldata is malformed"); }
  if (decoded.functionName !== "execTransactionFromModule") throw new Error("canonical repair queue selector mismatch");
  const maintenanceCalldata = decoded.args[2]; validateTransientRepairQueue(proposal, source.safeTransactionData, maintenanceCalldata);
  return Object.freeze({ transactionHash: source.transactionHash, maintenanceCalldataHash: keccak256(maintenanceCalldata), safeTransactionDataHash: keccak256(source.safeTransactionData), maintenanceCalldata });
}

export function repairContinuationStorage(journal: OrdinaryScenarioJournal): RepairContinuationStorage | undefined {
  return (journal as OrdinaryScenarioJournal & { repairContinuation?: RepairContinuationStorage }).repairContinuation;
}

export function repairLiveJournal(journal: OrdinaryScenarioJournal): LiveJournal { return journal.liveJournal; }

export function repairOriginalIdentityHash(proposal: OrdinaryScenarioProposal): Hex {
  return publicHash({ planHash: proposal.planHash, safe: proposal.safe, guard: proposal.guard, delay: proposal.delay, primarySigner: proposal.primarySigner, safeContractSecondary: proposal.safeContractSecondary, ecdsaSecondary: proposal.ecdsaSecondary, originalTopologyEvidenceHash: proposal.topologyEvidenceHash });
}
