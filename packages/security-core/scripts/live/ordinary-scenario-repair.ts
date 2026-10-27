import { createHash } from "node:crypto";
import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  hashTypedData,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { queueFingerprint, queueMonitoringFingerprint, type DelayQueueItem } from "../../src/queue/delay";
import { SAFE_TX_TYPES } from "../../src/signers/types";
import { passkeySignerBindingHash } from "../../src/topology/evidence";
import { PHASE_OUTLAY_LIMIT, type LiveJournal } from "./submission";
import type { OrdinaryScenarioJournal, OrdinaryScenarioProposal } from "./ordinary-scenario-executor";

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
const safeHash = (safe: Address, nonce: bigint, to: Address, value: bigint, data: Hex, operation: 0 | 1 = 0): Hex => hashTypedData({ domain: { chainId: CHAIN_ID, verifyingContract: safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { to, value, data, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce } });
const canonicalHex = (value: Hex, label: string): void => { if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`${label} must be canonical bytes`); };

export type RepairCanonicalState = Readonly<{
  chainId: number; blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint;
  safeNonce: bigint; delayQueueNonce: bigint; delayTxNonce: bigint;
  safeContractSecondary: Address; candidateRuntimeCodeHash: Hex; candidateBindingHash: Hex;
  policyHash: Hex; frozen: boolean;
  nativeWindow: bigint; nativeBaseSpent: bigint; nativeInstantSpent: bigint;
  nativeBalance: bigint; usdcBalance: bigint; topologyEvidenceHash: Hex; observerReady: boolean;
}>;

export type RepairCreationQuote = Readonly<{
  chainId: number; factory: Address; candidate: Address; x: bigint; y: bigint; verifiers: bigint;
  calldata: Hex; calldataHash: Hex; gasLimitCap: bigint; maxFeePerGasCap: bigint; maxPriorityFeePerGasCap: bigint;
}>;

export type RepairActionReview = Readonly<{
  id: typeof REPAIR_ACTION_IDS[number]; kind: "factory-create" | "safe-queue" | "delay-execute" | "signed-rejection" | "safe-cancel" | "safe-freeze";
  dependsOn: readonly string[]; signerRoles: readonly string[]; policyPhase: "pre-rotation" | "post-rotation";
  safeNonceBefore: string; safeNonceAfter: string; delayQueueNonceBefore: string; delayQueueNonceAfter: string; delayTxNonceBefore: string; delayTxNonceAfter: string;
  commitment: Hex; gasLimitCap: string; maxFeePerGasCap: string; maxPriorityFeePerGasCap: string;
  safeTxHash: Hex | null; requestDataHash: Hex; queueFingerprint: Hex | null; monitoringFingerprint: Hex | null;
  alert: "none" | "delayed-queued" | "delayed-executed" | "delayed-cancelled";
}>;

export type RepairCreationProposal = Readonly<{
  schemaVersion: 1; scope: "repair-signer-create-v1"; authorization: "NONE"; chainId: 11155111;
  proposalHash: Hex; prefixHash: Hex; originalProposalHash: Hex; originalApprovalHash: Hex; originalActionCount: 38;
  cumulativeActualCostWei: string; maximumCumulativeOutlayWei: string; phaseLimitWei: string;
  safe: Address; guard: Address; delay: Address; funder: Address; periodAnchor: string;
  candidate: Address; factory: Address; x: string; y: string; verifiers: string; creationCalldata: Hex; bindingHash: Hex; candidateRuntimeCodeHash: Hex; alreadyDeployed: boolean;
  preRotationBlockNumber: string; preRotationBlockHash: Hex;
  action: RepairActionReview;
}>;

export type RepairFixedFields = Readonly<{ guard: Address; role: 1; expectedOld: Address; replacement: Address; previousOwner: Address; threshold: "1"; proofHash: Hex; assertionHash: Hex; maintenance: Address; maintenanceCalldataHash: Hex }>;
export type RepairGroupProposal = Readonly<{
  schemaVersion: 1; scope: "repair-tail-group-v1"; authorization: "NONE"; chainId: 11155111; proposalHash: Hex;
  prefixHash: Hex; creationProposalHash: Hex; originalProposalHash: Hex; originalApprovalHash: Hex;
  cumulativeActualCostWei: string; maximumCumulativeOutlayWei: string; phaseLimitWei: string;
  safe: Address; delay: Address; guard: Address; candidate: Address; oldSecondary: Address; recipient: Address;
  beforePolicyHash: Hex; afterPolicyHash: Hex; beforeSignerIdentityHash: Hex; afterSignerIdentityHash: Hex;
  periodAnchor: string; establishedNativeWindow: string; repair: RepairFixedFields; actions: readonly RepairActionReview[];
}>;
export type TransientRepairGroup = Readonly<{ assertion: Hex; maintenanceCalldata: Hex; safeTransactionData: Hex }>;
export type PreparedRepairGroup = Readonly<{ proposal: RepairGroupProposal; transient: TransientRepairGroup }>;
export type RepairApproval = Readonly<{ approvalHash: Hex }>;
const approvalBindings = new WeakMap<object, RepairCreationProposal | RepairGroupProposal>();

export type RepairContinuationStorage = {
  schemaVersion: 1; prefixHash: Hex; originalActionCount: 38; cumulativeActualCostWei: string;
  creationProposalHash: Hex; creationApprovalHash?: Hex; groupProposalHash?: Hex; groupApprovalHash?: Hex;
  actions: Array<{ id: typeof REPAIR_ACTION_IDS[number]; commitment: Hex; status: "proposed" | "approved" | "pending" | "confirmed" | "rejection-proved" | "stopped"; transactionHash?: Hex; evidenceHash?: Hex }>;
};

function assertPrefix(input: Readonly<{ proposal: OrdinaryScenarioProposal; journal: OrdinaryScenarioJournal; evidence: readonly { actionId: string; evidenceHash: Hex; transactionHash?: Hex }[] }>): { prefixHash: Hex; cumulative: bigint } {
  if (input.proposal.actions.length !== 38 || input.journal.actions.length !== 38) throw new Error("repair continuation requires the terminal 38-action prefix");
  if (input.journal.proposalHash !== input.proposal.proposalHash || input.journal.reviewPackageHash !== input.proposal.reviewPackageHash || input.journal.chainId !== CHAIN_ID || input.journal.liveJournal.chainId !== CHAIN_ID) throw new Error("repair continuation prefix identity mismatch");
  for (let index = 0; index < 38; index++) {
    const action = input.proposal.actions[index]!; const record = input.journal.actions[index]!; const evidence = input.evidence[index];
    const expectedStatus = action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed";
    if (record.id !== action.id || !same(record.commitment, action.commitment) || record.status !== expectedStatus || !record.evidenceHash || (expectedStatus === "confirmed" && !record.transactionHash) || !evidence || evidence.actionId !== record.id || !same(evidence.evidenceHash, record.evidenceHash) || (record.transactionHash && (!evidence.transactionHash || !same(evidence.transactionHash, record.transactionHash)))) throw new Error("repair continuation canonical prefix evidence mismatch");
  }
  if (input.journal.liveJournal.entries.some(entry => entry.status === "pending" || !entry.receipt)) throw new Error("repair continuation prior journal is pending or uncertain");
  const cumulative = BigInt(input.proposal.baselineActualCostWei) + input.journal.liveJournal.entries.reduce((sum, entry) => sum + entry.reserved, 0n);
  if (cumulative > PHASE_OUTLAY_LIMIT) throw new Error("repair continuation cumulative phase cost exceeds ceiling");
  return { prefixHash: publicHash({ proposalHash: input.proposal.proposalHash, approvalHash: input.journal.approvalHash, actions: input.journal.actions, liveJournal: input.journal.liveJournal }), cumulative };
}

function assertPreRepairState(state: RepairCanonicalState, proposal: OrdinaryScenarioProposal, candidateMustExist: boolean): void {
  if (state.chainId !== CHAIN_ID || state.safeNonce !== 14n || state.delayQueueNonce !== 6n || state.delayTxNonce !== 6n) throw new Error("repair continuation protocol nonce mismatch");
  if (!same(state.safeContractSecondary, OLD_SECONDARY) || !same(state.safeContractSecondary, proposal.safeContractSecondary) || !same(state.policyHash, PRE_ROTATION_POLICY_HASH) || state.frozen || !same(state.topologyEvidenceHash, proposal.topologyEvidenceHash) || !state.observerReady) throw new Error("repair continuation pre-rotation state mismatch");
  const deployed = !/^0x0{64}$/i.test(state.candidateRuntimeCodeHash);
  if (candidateMustExist !== deployed || (deployed && !same(state.candidateBindingHash, REPAIR_BINDING_HASH))) throw new Error("repair continuation candidate runtime/binding mismatch");
}

function quoteAction(quote: RepairCreationQuote): RepairActionReview {
  const base = { id: "repair-signer-create" as const, kind: "factory-create" as const, dependsOn: ["usdc-queue-ready-execute"], signerRoles: ["funder"], policyPhase: "pre-rotation" as const, safeNonceBefore: "14", safeNonceAfter: "14", delayQueueNonceBefore: "6", delayQueueNonceAfter: "6", delayTxNonceBefore: "6", delayTxNonceAfter: "6", gasLimitCap: quote.gasLimitCap.toString(), maxFeePerGasCap: quote.maxFeePerGasCap.toString(), maxPriorityFeePerGasCap: quote.maxPriorityFeePerGasCap.toString(), safeTxHash: null, requestDataHash: quote.calldataHash, queueFingerprint: null, monitoringFingerprint: null, alert: "none" as const };
  return Object.freeze({ ...base, commitment: publicHash(base) });
}

export function createRepairCreationProposal(input: Readonly<{ proposal: OrdinaryScenarioProposal; journal: OrdinaryScenarioJournal; evidence: readonly { actionId: string; evidenceHash: Hex; transactionHash?: Hex }[]; state: RepairCanonicalState; quote: RepairCreationQuote }>): RepairCreationProposal {
  const { prefixHash, cumulative } = assertPrefix(input); assertPreRepairState(input.state, input.proposal, !/^0x0{64}$/i.test(input.state.candidateRuntimeCodeHash));
  const quote = input.quote; canonicalHex(quote.calldata, "repair creation calldata");
  let decoded: ReturnType<typeof decodeFunctionData>; try { decoded = decodeFunctionData({ abi: FACTORY_ABI, data: quote.calldata }); } catch { throw new Error("repair creation calldata mismatch"); }
  const expectedCalldata = encodeFunctionData({ abi: FACTORY_ABI, functionName: "createSigner", args: [quote.x, quote.y, quote.verifiers] });
  if (quote.chainId !== CHAIN_ID || !same(quote.factory, FACTORY) || !same(quote.candidate, CANDIDATE) || quote.verifiers !== VERIFIERS || !same(passkeySignerBindingHash({ factory: quote.factory, x: quote.x, y: quote.y, verifiers: quote.verifiers }), REPAIR_BINDING_HASH) || decoded.functionName !== "createSigner" || !same(expectedCalldata, quote.calldata) || !same(keccak256(quote.calldata), quote.calldataHash) || !same(quote.calldataHash, CREATION_CALLDATA_HASH) || quote.gasLimitCap !== 740292n || quote.maxFeePerGasCap !== 1000000n || quote.maxPriorityFeePerGasCap !== 1000000n) throw new Error("repair creation fixed quote mismatch");
  const action = quoteAction(quote); const maximum = cumulative + quote.gasLimitCap * quote.maxFeePerGasCap;
  if (maximum > PHASE_OUTLAY_LIMIT) throw new Error("repair creation maximum cumulative outlay exceeds ceiling");
  const base = { schemaVersion: 1 as const, scope: "repair-signer-create-v1" as const, authorization: "NONE" as const, chainId: CHAIN_ID as 11155111, prefixHash, originalProposalHash: input.proposal.proposalHash, originalApprovalHash: input.journal.approvalHash, originalActionCount: 38 as const, cumulativeActualCostWei: cumulative.toString(), maximumCumulativeOutlayWei: maximum.toString(), phaseLimitWei: PHASE_OUTLAY_LIMIT.toString(), safe: input.proposal.safe, guard: input.proposal.guard, delay: input.proposal.delay, funder: input.proposal.funder, periodAnchor: input.proposal.periodAnchor, candidate: CANDIDATE, factory: FACTORY, x: quote.x.toString(), y: quote.y.toString(), verifiers: quote.verifiers.toString(), creationCalldata: quote.calldata, bindingHash: REPAIR_BINDING_HASH, candidateRuntimeCodeHash: input.state.candidateRuntimeCodeHash, alreadyDeployed: !/^0x0{64}$/i.test(input.state.candidateRuntimeCodeHash), preRotationBlockNumber: input.state.blockNumber.toString(), preRotationBlockHash: input.state.blockHash, action };
  return Object.freeze({ ...base, proposalHash: publicHash(base) });
}

export function extendJournalForRepair(journal: OrdinaryScenarioJournal, creation: RepairCreationProposal): OrdinaryScenarioJournal {
  const holder = journal as OrdinaryScenarioJournal & { repairContinuation?: RepairContinuationStorage };
  if (holder.repairContinuation) {
    if (!same(holder.repairContinuation.prefixHash, creation.prefixHash) || !same(holder.repairContinuation.creationProposalHash, creation.proposalHash)) throw new Error("repair continuation header drift");
    return journal;
  }
  holder.repairContinuation = { schemaVersion: 1, prefixHash: creation.prefixHash, originalActionCount: 38, cumulativeActualCostWei: creation.cumulativeActualCostWei, creationProposalHash: creation.proposalHash, actions: [{ id: "repair-signer-create", commitment: creation.action.commitment, status: "proposed" }] };
  return journal;
}

function continuation(journal: OrdinaryScenarioJournal, creation: RepairCreationProposal): RepairContinuationStorage {
  const value = (journal as OrdinaryScenarioJournal & { repairContinuation?: RepairContinuationStorage }).repairContinuation;
  if (!value || value.schemaVersion !== 1 || value.originalActionCount !== 38 || !same(value.prefixHash, creation.prefixHash) || !same(value.creationProposalHash, creation.proposalHash) || !value.creationApprovalHash || value.actions[0]?.status !== "confirmed" || !value.actions[0].evidenceHash) throw new Error("repair continuation confirmed creation header is missing or changed");
  return value;
}

function action(input: Omit<RepairActionReview, "commitment">): RepairActionReview { return Object.freeze({ ...input, commitment: publicHash(input) }); }

export function createRepairGroupProposal(input: Readonly<{ creation: RepairCreationProposal; journal: OrdinaryScenarioJournal; state: RepairCanonicalState; maintenance: Address; recipient: Address; assertion: Hex }>): PreparedRepairGroup {
  const header = continuation(input.journal, input.creation); canonicalHex(input.assertion, "replacement assertion");
  if (input.assertion === "0x" || !isAddress(input.maintenance, { strict: true }) || !same(input.creation.candidate, CANDIDATE)) throw new Error("repair group fixed input mismatch");
  if (input.state.chainId !== CHAIN_ID || input.state.safeNonce !== 14n || input.state.delayQueueNonce !== 6n || input.state.delayTxNonce !== 6n || !same(input.state.safeContractSecondary, OLD_SECONDARY) || !same(input.state.policyHash, PRE_ROTATION_POLICY_HASH) || input.state.frozen || !same(input.state.candidateBindingHash, REPAIR_BINDING_HASH) || /^0x0{64}$/i.test(input.state.candidateRuntimeCodeHash) || !input.state.observerReady) throw new Error("repair group preflight state mismatch");
  const guard = input.creation.guard; const safe = input.creation.safe; const delay = input.creation.delay;
  const assertionHash = keccak256(input.assertion);
  const maintenanceCalldata = encodeFunctionData({ abi: REPLACE_ABI, functionName: "replaceSigner", args: [guard, 1, OLD_SECONDARY, CANDIDATE, ZERO, 1n, input.assertion] });
  const repairItem: DelayQueueItem = { safe, delay, to: input.maintenance, value: 0n, data: maintenanceCalldata, operation: 1, queueNonce: 6n };
  const repairQueueData = encodeFunctionData({ abi: DELAY_MODULE_ABI, functionName: "execTransactionFromModule", args: [repairItem.to, repairItem.value, repairItem.data, repairItem.operation] });
  const repairSafeHash = safeHash(safe, 14n, delay, 0n, repairQueueData);
  const proofItem: DelayQueueItem = { safe, delay, to: input.recipient, value: 1n, data: "0x", operation: 0, queueNonce: 7n };
  const proofQueueData = encodeFunctionData({ abi: DELAY_MODULE_ABI, functionName: "execTransactionFromModule", args: [proofItem.to, proofItem.value, proofItem.data, proofItem.operation] });
  const proofSafeHash = safeHash(safe, 15n, delay, 0n, proofQueueData);
  const cancelData = encodeFunctionData({ abi: DELAY_ABI, functionName: "setTxNonce", args: [8n] });
  const cancelSafeHash = safeHash(safe, 16n, delay, 0n, cancelData);
  const freezeData = encodeFunctionData({ abi: GUARD_ABI, functionName: "freeze" });
  const freezeSafeHash = safeHash(safe, 17n, guard, 0n, freezeData);
  const repairFp = queueFingerprint(repairItem); const repairMonitoring = queueMonitoringFingerprint(repairItem); const proofFp = queueFingerprint(proofItem); const proofMonitoring = queueMonitoringFingerprint(proofItem);
  const gas = (cap: bigint) => ({ gasLimitCap: cap.toString(), maxFeePerGasCap: "1000000", maxPriorityFeePerGasCap: "1000000" });
  const actions: RepairActionReview[] = [
    action({ id: "repair-queue", kind: "safe-queue", dependsOn: ["repair-signer-create"], signerRoles: ["primary-passkey", "current-safe-contract-secondary"], policyPhase: "pre-rotation", safeNonceBefore: "14", safeNonceAfter: "15", delayQueueNonceBefore: "6", delayQueueNonceAfter: "7", delayTxNonceBefore: "6", delayTxNonceAfter: "6", ...gas(2000000n), safeTxHash: repairSafeHash, requestDataHash: keccak256(repairQueueData), queueFingerprint: repairFp, monitoringFingerprint: repairMonitoring, alert: "delayed-queued" }),
    action({ id: "repair-ready-execute", kind: "delay-execute", dependsOn: ["repair-queue"], signerRoles: [], policyPhase: "pre-rotation", safeNonceBefore: "15", safeNonceAfter: "15", delayQueueNonceBefore: "7", delayQueueNonceAfter: "7", delayTxNonceBefore: "6", delayTxNonceAfter: "7", ...gas(300000n), safeTxHash: null, requestDataHash: keccak256(encodeFunctionData({ abi: DELAY_ABI, functionName: "executeNextTx", args: [repairItem.to, repairItem.value, repairItem.data, repairItem.operation] })), queueFingerprint: repairFp, monitoringFingerprint: repairMonitoring, alert: "delayed-executed" }),
    action({ id: "post-rotation-old-secondary-rejection", kind: "signed-rejection", dependsOn: ["repair-ready-execute"], signerRoles: ["primary-passkey", "old-safe-contract-secondary"], policyPhase: "post-rotation", safeNonceBefore: "15", safeNonceAfter: "15", delayQueueNonceBefore: "7", delayQueueNonceAfter: "7", delayTxNonceBefore: "7", delayTxNonceAfter: "7", ...gas(2000000n), safeTxHash: proofSafeHash, requestDataHash: keccak256(proofQueueData), queueFingerprint: proofFp, monitoringFingerprint: proofMonitoring, alert: "none" }),
    action({ id: "post-rotation-new-secondary-queue", kind: "safe-queue", dependsOn: ["post-rotation-old-secondary-rejection"], signerRoles: ["primary-passkey", "new-safe-contract-secondary"], policyPhase: "post-rotation", safeNonceBefore: "15", safeNonceAfter: "16", delayQueueNonceBefore: "7", delayQueueNonceAfter: "8", delayTxNonceBefore: "7", delayTxNonceAfter: "7", ...gas(2000000n), safeTxHash: proofSafeHash, requestDataHash: keccak256(proofQueueData), queueFingerprint: proofFp, monitoringFingerprint: proofMonitoring, alert: "delayed-queued" }),
    action({ id: "post-rotation-proof-cancel", kind: "safe-cancel", dependsOn: ["post-rotation-new-secondary-queue"], signerRoles: ["primary-passkey", "new-safe-contract-secondary"], policyPhase: "post-rotation", safeNonceBefore: "16", safeNonceAfter: "17", delayQueueNonceBefore: "8", delayQueueNonceAfter: "8", delayTxNonceBefore: "7", delayTxNonceAfter: "8", ...gas(2000000n), safeTxHash: cancelSafeHash, requestDataHash: keccak256(cancelData), queueFingerprint: proofFp, monitoringFingerprint: proofMonitoring, alert: "delayed-cancelled" }),
    action({ id: "final-freeze", kind: "safe-freeze", dependsOn: ["post-rotation-proof-cancel"], signerRoles: ["primary-passkey", "new-safe-contract-secondary"], policyPhase: "post-rotation", safeNonceBefore: "17", safeNonceAfter: "18", delayQueueNonceBefore: "8", delayQueueNonceAfter: "8", delayTxNonceBefore: "8", delayTxNonceAfter: "8", ...gas(2000000n), safeTxHash: freezeSafeHash, requestDataHash: keccak256(freezeData), queueFingerprint: null, monitoringFingerprint: null, alert: "none" }),
  ];
  const cumulative = BigInt(header.cumulativeActualCostWei); const reservation = actions.filter(value => value.kind !== "signed-rejection").reduce((sum, value) => sum + BigInt(value.gasLimitCap) * BigInt(value.maxFeePerGasCap), 0n);
  if (cumulative + reservation > PHASE_OUTLAY_LIMIT) throw new Error("repair group maximum cumulative outlay exceeds ceiling");
  const fixed: RepairFixedFields = { guard, role: 1, expectedOld: OLD_SECONDARY, replacement: CANDIDATE, previousOwner: ZERO, threshold: "1", proofHash: REPAIR_PROOF_HASH, assertionHash, maintenance: input.maintenance, maintenanceCalldataHash: keccak256(maintenanceCalldata) };
  const base = { schemaVersion: 1 as const, scope: "repair-tail-group-v1" as const, authorization: "NONE" as const, chainId: CHAIN_ID as 11155111, prefixHash: input.creation.prefixHash, creationProposalHash: input.creation.proposalHash, originalProposalHash: input.creation.originalProposalHash, originalApprovalHash: input.creation.originalApprovalHash, cumulativeActualCostWei: cumulative.toString(), maximumCumulativeOutlayWei: (cumulative + reservation).toString(), phaseLimitWei: PHASE_OUTLAY_LIMIT.toString(), safe, delay, guard, candidate: CANDIDATE, oldSecondary: OLD_SECONDARY, recipient: input.recipient, beforePolicyHash: PRE_ROTATION_POLICY_HASH, afterPolicyHash: POST_ROTATION_POLICY_HASH, beforeSignerIdentityHash: publicHash({ primary: "immutable", safeContractSecondary: OLD_SECONDARY }), afterSignerIdentityHash: publicHash({ primary: "immutable", safeContractSecondary: CANDIDATE }), periodAnchor: input.creation.periodAnchor, establishedNativeWindow: input.state.nativeWindow.toString(), repair: fixed, actions: Object.freeze(actions) };
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

export function createRepairPrepareAuthorization(input: Readonly<{ creation: RepairCreationProposal; state: RepairCanonicalState; purpose: "materialize-one-repair-proof" }>) {
  if (input.purpose !== "materialize-one-repair-proof" || input.state.chainId !== CHAIN_ID || !same(input.state.policyHash, PRE_ROTATION_POLICY_HASH) || !same(input.state.candidateBindingHash, REPAIR_BINDING_HASH)) throw new Error("repair prepare authorization binding mismatch");
  const base = { schemaVersion: 1 as const, scope: "repair-proof-prepare-v1" as const, authority: "PREPARE_PROOF_ONLY" as const, chainId: CHAIN_ID as 11155111, candidate: CANDIDATE, proofHash: REPAIR_PROOF_HASH, prefixHash: input.creation.prefixHash, currentPolicyHash: input.state.policyHash, purpose: input.purpose, safeSignatureAuthority: false as const, outerSignatureAuthority: false as const, broadcastAuthority: false as const };
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

export function loadRepairCreationProposal(serialized: string, expectedProposalHash: Hex): RepairCreationProposal {
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("repair creation proposal must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("repair creation proposal must be an object");
  const value = parsed as Record<string, unknown>; const { proposalHash, ...base } = value;
  if (proposalHash !== expectedProposalHash || publicHash(base) !== expectedProposalHash || value.schemaVersion !== 1 || value.scope !== "repair-signer-create-v1" || value.authorization !== "NONE" || value.chainId !== CHAIN_ID || value.originalActionCount !== 38 || value.candidate !== CANDIDATE || value.factory !== FACTORY || value.bindingHash !== REPAIR_BINDING_HASH || value.creationCalldata === undefined || value.preRotationBlockNumber === undefined || !HASH.test(String(value.preRotationBlockHash))) throw new Error("repair creation proposal identity or fixed fields mismatch");
  const proposal = Object.freeze(value) as unknown as RepairCreationProposal;
  if (proposal.action.id !== "repair-signer-create" || proposal.action.kind !== "factory-create" || proposal.action.gasLimitCap !== "740292" || proposal.action.maxFeePerGasCap !== "1000000" || proposal.action.maxPriorityFeePerGasCap !== "1000000" || keccak256(proposal.creationCalldata) !== proposal.action.requestDataHash) throw new Error("repair creation proposal action mismatch");
  return proposal;
}

export function loadRepairGroupProposal(serialized: string, expectedProposalHash: Hex): RepairGroupProposal {
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("repair group proposal must be JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("repair group proposal must be an object");
  const value = parsed as Record<string, unknown>; const { proposalHash, ...base } = value;
  if (proposalHash !== expectedProposalHash || publicHash(base) !== expectedProposalHash || value.schemaVersion !== 1 || value.scope !== "repair-tail-group-v1" || value.authorization !== "NONE" || value.chainId !== CHAIN_ID || value.candidate !== CANDIDATE || value.oldSecondary !== OLD_SECONDARY || !Array.isArray(value.actions) || value.actions.length !== 6 || value.actions.some((entry, index) => (entry as Record<string, unknown>).id !== REPAIR_ACTION_IDS[index + 1])) throw new Error("repair group proposal identity or closed action map mismatch");
  return Object.freeze(value) as unknown as RepairGroupProposal;
}

export function assertRepairActionState(proposal: RepairGroupProposal, action: RepairActionReview, state: RepairCanonicalState, phase: "before" | "after"): void {
  const expectedSafe = BigInt(phase === "before" ? action.safeNonceBefore : action.safeNonceAfter);
  const expectedQueue = BigInt(phase === "before" ? action.delayQueueNonceBefore : action.delayQueueNonceAfter);
  const expectedTx = BigInt(phase === "before" ? action.delayTxNonceBefore : action.delayTxNonceAfter);
  if (state.chainId !== CHAIN_ID || state.safeNonce !== expectedSafe || state.delayQueueNonce !== expectedQueue || state.delayTxNonce !== expectedTx || !state.observerReady || !same(state.candidateBindingHash, REPAIR_BINDING_HASH) || /^0x0{64}$/i.test(state.candidateRuntimeCodeHash)) throw new Error("repair action canonical state/nonce drift");
  const rotated = action.id === "repair-ready-execute" ? phase === "after" : action.policyPhase === "post-rotation";
  if (!same(state.safeContractSecondary, rotated ? proposal.candidate : proposal.oldSecondary) || !same(state.policyHash, rotated ? proposal.afterPolicyHash : proposal.beforePolicyHash)) throw new Error("repair action signer/policy phase drift");
  const shouldBeFrozen = action.id === "final-freeze" && phase === "after";
  if (state.frozen !== shouldBeFrozen) throw new Error("repair action frozen state drift");
  if (action.id === "post-rotation-old-secondary-rejection" || action.id === "post-rotation-new-secondary-queue") {
    const anchor = BigInt(proposal.periodAnchor);
    if (state.blockTimestamp < anchor) throw new Error("repair canonical timestamp precedes period anchor");
    const effectiveWindow = anchor + ((state.blockTimestamp - anchor) / 86_400n) * 86_400n;
    if (state.nativeWindow.toString() !== proposal.establishedNativeWindow || effectiveWindow.toString() !== proposal.establishedNativeWindow) throw new Error("repair native period rollover requires new review");
  }
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
