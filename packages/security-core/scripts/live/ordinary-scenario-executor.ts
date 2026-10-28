import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { decodeFunctionData, hashTypedData, isAddress, keccak256, parseTransaction, recoverAddress, recoverTransactionAddress, type Address, type Hex } from "viem";
import { sha256 } from "../plan-deployment";
import { hashHistoricalPrefix } from "./ordinary-scenario-hashless-certificate";
import {
  assertExpiredHashlessContinuationLineage,
  assertExpiredHashlessContinuationAuthorization,
  type ExpiredHashlessContinuationAction,
  type ExpiredHashlessContinuationApproval,
  type ExpiredHashlessContinuationProposal,
  type HashlessContinuationStorage,
} from "./ordinary-scenario-hashless-continuation";
import { SAFE_TX_TYPES } from "../../src/signers/types";
import {
  PHASE_OUTLAY_LIMIT,
  liveIntentHash,
  submitLiveIntent,
  type JournalEntry,
  type LiveContext,
  type LiveIntent,
  type LiveJournal,
  type LiveReceipt,
} from "./submission";

const CHAIN_ID = 11155111;
const APPROVED_HASHLESS_PREFIX = "0x299d8cf298cf0a905046e4fbe569c44c2329b54207e159db551d41fee1dbb83d" as Hex;
export type OrdinaryScenarioProposalDomain = Readonly<{ chainId: number }>;
const ordinaryScenarioDomainBrands = new WeakSet<object>();
export function validateOrdinaryScenarioProposalDomain(domain: OrdinaryScenarioProposalDomain, verifyCanonicalProfile: (domain: OrdinaryScenarioProposalDomain) => true): OrdinaryScenarioProposalDomain {
  if (!Number.isSafeInteger(domain.chainId) || domain.chainId <= 0 || verifyCanonicalProfile(domain) !== true) throw new Error("ordinary scenario proposal domain is not canonically verified");
  const branded = Object.freeze({ chainId: domain.chainId }); ordinaryScenarioDomainBrands.add(branded); return branded;
}
export const PRODUCTION_ORDINARY_SCENARIO_DOMAIN = validateOrdinaryScenarioProposalDomain({ chainId: CHAIN_ID }, () => true);
const assertOrdinaryDomain = (domain: OrdinaryScenarioProposalDomain): void => { if (!ordinaryScenarioDomainBrands.has(domain)) throw new Error("ordinary scenario proposal domain is not canonically verified"); };
const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SIGNED_DECIMAL = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const PERIOD_SECONDS = 86_400n;
const COOLDOWN_SECONDS = 120n;
const EXPIRATION_SECONDS = 600n;
const NATIVE_X = 10_000_000_000_000n;
const NATIVE_Y = 30_000_000_000_000n;
const USDC_X = 10_000_000n;
const USDC_Y = 30_000_000n;
const INITIAL_USDC = 20_000_000n;
const RECYCLED_STEP_UP_USDC = 10_000_000n;
const RECYCLED_DELAYED_USDC = 1_000_000n;
const GROSS_USDC = 31_000_000n;
const ERC1271_MAGIC = "0x1626ba7e";
const ECDSA_SECONDARY_SIGNATURE_TYPE_HASH = "0xc3d042548a46ef9078620b2d3fe7e21f006a7ecf29ab9b2807d4bdbbc41cecf0" as Hex;
const SAFE_ABI = [{ type: "function", name: "execTransaction", stateMutability: "payable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "signatures", type: "bytes" }], outputs: [{ type: "bool" }] }] as const;
const ERC20_ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }, { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const DELAY_MODULE_ABI = [{ type: "function", name: "execTransactionFromModule", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }], outputs: [{ type: "bool" }] }] as const;
const DELAY_ABI = [{ type: "function", name: "executeNextTx", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }] }, { type: "function", name: "skipExpired", stateMutability: "nonpayable", inputs: [] }, { type: "function", name: "setTxNonce", stateMutability: "nonpayable", inputs: [{ type: "uint256" }] }] as const;

type ActionDescriptor = Readonly<{ id: string; kind: string; asset: "native" | "USDC"; safeNonce?: bigint; signerRoles: readonly string[]; dependsOn: readonly string[]; transaction: "safe" | "public"; queue: boolean }>;
const ACTION_DESCRIPTOR_ROWS = `
native-funding|funding|native|-|funder|-
usdc-funding|funding|USDC|-|funder|native-funding
native-base-x|base-transfer|native|0|primary-passkey|native-funding
native-step-up-contract|step-up-transfer|native|1|primary-passkey,safe-contract-secondary|native-base-x
native-step-up-ecdsa|step-up-transfer|native|2|primary-passkey,legacy-ecdsa-secondary|native-step-up-contract
native-direct-overspend-rejection|expected-direct-rejection|native|3|primary-passkey,safe-contract-secondary|native-step-up-ecdsa
native-replay-rejection|expected-replay-rejection|native|0|replay previously reviewed signed envelope only in later executor|native-base-x
native-unsupported-path-rejection|expected-unsupported-rejection|native|3|primary-passkey,safe-contract-secondary|native-step-up-ecdsa
native-queue-cancel|queue-proposal|native|3|primary-passkey,safe-contract-secondary|native-step-up-ecdsa
native-queue-cancel-early-rejection|expected-early-rejection|native|-|-|native-queue-cancel
native-queue-cancel-action|queue-cancellation|native|4|primary-passkey,safe-contract-secondary|native-queue-cancel
native-queue-cancelled-execution-rejection|expected-cancelled-rejection|native|-|-|native-queue-cancel-action
native-queue-expiry|queue-proposal|native|5|primary-passkey,safe-contract-secondary|native-queue-cancel-action
native-queue-expiry-early-rejection|expected-early-rejection|native|-|-|native-queue-expiry
native-queue-expiry-skip|queue-expiry|native|-|-|native-queue-expiry
native-queue-expired-execution-rejection|expected-expired-rejection|native|-|-|native-queue-expiry-skip
native-queue-execute|queue-proposal|native|6|primary-passkey,safe-contract-secondary|native-queue-expiry-skip
native-queue-execute-early-rejection|expected-early-rejection|native|-|-|native-queue-execute
native-queue-ready-execute|ready-delay-execution|native|-|-|native-queue-execute-early-rejection
usdc-base-x|base-transfer|USDC|7|primary-passkey|usdc-funding,native-queue-ready-execute
usdc-step-up-contract|step-up-transfer|USDC|8|primary-passkey,safe-contract-secondary|usdc-base-x
usdc-recycle-topup-step-up|controlled-recipient-recycled-funding|USDC|-|funder|usdc-step-up-contract
usdc-step-up-ecdsa|step-up-transfer|USDC|9|primary-passkey,legacy-ecdsa-secondary|usdc-recycle-topup-step-up
usdc-direct-overspend-rejection|expected-direct-rejection|USDC|10|primary-passkey,safe-contract-secondary|usdc-step-up-ecdsa
usdc-replay-rejection|expected-replay-rejection|USDC|7|replay previously reviewed signed envelope only in later executor|usdc-base-x
usdc-unsupported-path-rejection|expected-unsupported-rejection|USDC|10|primary-passkey,safe-contract-secondary|usdc-step-up-ecdsa
usdc-recycle-topup-delayed|controlled-recipient-recycled-funding|USDC|-|funder|usdc-step-up-ecdsa
usdc-queue-cancel|queue-proposal|USDC|10|primary-passkey,safe-contract-secondary|usdc-recycle-topup-delayed
usdc-queue-cancel-early-rejection|expected-early-rejection|USDC|-|-|usdc-queue-cancel
usdc-queue-cancel-action|queue-cancellation|USDC|11|primary-passkey,safe-contract-secondary|usdc-queue-cancel
usdc-queue-cancelled-execution-rejection|expected-cancelled-rejection|USDC|-|-|usdc-queue-cancel-action
usdc-queue-expiry|queue-proposal|USDC|12|primary-passkey,safe-contract-secondary|usdc-queue-cancel-action
usdc-queue-expiry-early-rejection|expected-early-rejection|USDC|-|-|usdc-queue-expiry
usdc-queue-expiry-skip|queue-expiry|USDC|-|-|usdc-queue-expiry
usdc-queue-expired-execution-rejection|expected-expired-rejection|USDC|-|-|usdc-queue-expiry-skip
usdc-queue-execute|queue-proposal|USDC|13|primary-passkey,safe-contract-secondary|usdc-queue-expiry-skip
usdc-queue-execute-early-rejection|expected-early-rejection|USDC|-|-|usdc-queue-execute
usdc-queue-ready-execute|ready-delay-execution|USDC|-|-|usdc-queue-execute-early-rejection`;
const QUEUE_KINDS = new Set(["queue-proposal", "expected-early-rejection", "expected-cancelled-rejection", "queue-expiry", "expected-expired-rejection", "ready-delay-execution"]);
const ACTION_DESCRIPTOR_LIST: readonly ActionDescriptor[] = ACTION_DESCRIPTOR_ROWS.trim().split("\n").map((row) => { const [id, kind, asset, nonce, roles, dependencies] = row.split("|"); return Object.freeze({ id: id!, kind: kind!, asset: asset as "native" | "USDC", safeNonce: nonce === "-" ? undefined : BigInt(nonce!), signerRoles: roles === "-" ? [] : roles!.split(","), dependsOn: dependencies === "-" ? [] : dependencies!.split(","), transaction: nonce === "-" ? "public" : "safe", queue: QUEUE_KINDS.has(kind!) }); });
const ACTION_DESCRIPTORS = new Map<string, ActionDescriptor>(ACTION_DESCRIPTOR_LIST.map((descriptor) => [descriptor.id, descriptor]));

const SUPPORTED_KINDS = new Set([
  "funding", "controlled-recipient-recycled-funding", "base-transfer", "step-up-transfer", "queue-proposal", "queue-cancellation",
  "queue-expiry", "ready-delay-execution", "expected-direct-rejection", "expected-replay-rejection", "expected-unsupported-rejection",
  "expected-early-rejection", "expected-cancelled-rejection", "expected-expired-rejection",
]);
const REJECTION_KINDS = new Set([
  "expected-direct-rejection", "expected-replay-rejection", "expected-unsupported-rejection", "expected-early-rejection",
  "expected-cancelled-rejection", "expected-expired-rejection",
]);
const PUBLIC_REJECTION_KINDS = new Set(["expected-early-rejection", "expected-cancelled-rejection", "expected-expired-rejection"]);
const SAFE_SUCCESS_KINDS = new Set(["base-transfer", "step-up-transfer", "queue-proposal", "queue-cancellation"]);
const DELAY_SUCCESS_KINDS = new Set(["queue-expiry", "ready-delay-execution"]);
const EXCLUDED_KINDS = new Set([
  "conditional-factory-signer-creation", "delayed-contract-secondary-repair", "delayed-contract-secondary-repair-execution",
  "expected-old-secondary-rejection", "post-rotation-usability-queue", "post-rotation-proof-cancellation", "emergency-freeze",
]);
const EXCLUDED_IDS = new Set([
  "repair-signer-create", "repair-queue", "repair-ready-execute", "post-rotation-old-secondary-rejection",
  "post-rotation-new-secondary-queue", "post-rotation-proof-cancel", "final-freeze",
]);
const ALLOWED_IDS = new Set([
  "native-funding", "usdc-funding", "native-base-x", "native-step-up-contract", "native-step-up-ecdsa",
  "native-direct-overspend-rejection", "native-replay-rejection", "native-unsupported-path-rejection",
  "native-queue-cancel", "native-queue-cancel-early-rejection", "native-queue-cancel-action", "native-queue-cancelled-execution-rejection",
  "native-queue-expiry", "native-queue-expiry-early-rejection", "native-queue-expiry-skip", "native-queue-expired-execution-rejection",
  "native-queue-execute", "native-queue-execute-early-rejection", "native-queue-ready-execute",
  "usdc-base-x", "usdc-step-up-contract", "usdc-recycle-topup-step-up", "usdc-step-up-ecdsa",
  "usdc-direct-overspend-rejection", "usdc-replay-rejection", "usdc-unsupported-path-rejection", "usdc-recycle-topup-delayed",
  "usdc-queue-cancel", "usdc-queue-cancel-early-rejection", "usdc-queue-cancel-action", "usdc-queue-cancelled-execution-rejection",
  "usdc-queue-expiry", "usdc-queue-expiry-early-rejection", "usdc-queue-expiry-skip", "usdc-queue-expired-execution-rejection",
  "usdc-queue-execute", "usdc-queue-execute-early-rejection", "usdc-queue-ready-execute",
]);

type SpendState = Readonly<{ window: bigint; baseSpent: bigint; instantSpent: bigint }>;
export type QueueState = Readonly<{ queueNonce: bigint; fingerprint: Hex; createdAt: bigint; status: "queued" | "cancelled" | "expired" | "executed"; to: Address; value: bigint; data: Hex; operation: 0 }>;
export type DependencyEvidence = Readonly<{ actionId: string; transactionHash?: Hex; blockHash?: Hex; evidenceHash: Hex }>;
export type OrdinaryEvidenceBasis =
  | Readonly<{ kind: "current-head" }>
  | Readonly<{ kind: "queue-receipt"; proposalActionId: string; transactionHash: Hex }>
  | Readonly<{ kind: "receipt-poststate"; actionId: string; transactionHash: Hex; blockNumber: bigint; blockHash: Hex }>;

export type CanonicalOrdinaryScenarioState = Readonly<{
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestamp: bigint;
  evidenceBasis: OrdinaryEvidenceBasis;
  planHash: Hex;
  topologyEvidenceHash: Hex;
  publicIdentitiesHash: Hex;
  observerReady: boolean;
  observerEvidenceHash: Hex;
  outerNonce: number;
  funderNativeBalance: bigint;
  safeNativeBalance: bigint;
  funderUsdcBalance: bigint;
  safeUsdcBalance: bigint;
  safeNonce: bigint;
  delayQueueNonce: bigint;
  delayTxNonce: bigint;
  nativeSpend: SpendState;
  usdcSpend: SpendState;
  queue?: QueueState;
  dependencies: DependencyEvidence[];
  fees: Readonly<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}>;

type ControlledState = Readonly<{
  safeNativeBalance: string;
  funderUsdcBalance: string;
  safeUsdcBalance: string;
  safeNonce: string;
  delayQueueNonce: string;
  delayTxNonce: string;
  nativeBaseSpent: string;
  nativeInstantSpent: string;
  usdcBaseSpent: string;
  usdcInstantSpent: string;
  queueStatus: "EMPTY" | "QUEUED_CONDITIONAL" | "CANCELLED_CONDITIONAL" | "EXPIRED_CONDITIONAL" | "EXECUTED_CONDITIONAL";
  queueNonce: string | null;
  queueFingerprint: Hex | null;
}>;

type ReviewedSafeTransaction = Readonly<{ to: Address; value: bigint; data: Hex; operation: 0; safeNonce: bigint; safeTxHash: Hex; safeTxGas: 0n; baseGas: 0n; gasPrice: 0n; gasToken: Address; refundReceiver: Address }>;

export type OrdinaryScenarioActionScope = Readonly<{
  id: string;
  kind: string;
  asset: "native" | "USDC" | "control";
  expectedOutcome: "success" | "rejection";
  signerRoles: readonly string[];
  dependsOn: readonly string[];
  commitment: Hex;
  gasLimitCap: bigint;
  maxFeePerGasCap: bigint;
  maxPriorityFeePerGasCap: bigint;
  before: ControlledState;
  after: ControlledState;
  safeTxHash?: Hex;
  safeTransaction?: ReviewedSafeTransaction;
  publicTransaction?: Readonly<{ to: Address; value: bigint; data: Hex }>;
  queue?: Readonly<{ queueNonce: bigint; fingerprint: Hex; monitoringFingerprint: Hex; to: Address; value: bigint; data: Hex; operation: 0 }>;
}>;

export type OrdinaryScenarioProposal = Readonly<{
  schemaVersion: 1;
  authorization: "NONE";
  chainId: number;
  proposalHash: Hex;
  reviewPackageHash: Hex;
  reviewArtifactBytesHash: Hex;
  planHash: Hex;
  topologyEvidenceHash: Hex;
  baselineEvidenceHash: Hex;
  publicIdentitiesHash: Hex;
  observerEvidenceHash: Hex;
  safe: Address;
  guard: Address;
  delay: Address;
  funder: Address;
  usdc: Address;
  recipient: Address;
  primarySigner: Address;
  safeContractSecondary: Address;
  ecdsaSecondary: Address;
  periodSeconds: "86400";
  periodAnchor: "0";
  cooldownSeconds: "120";
  expirationSeconds: "600";
  limits: Readonly<{ nativeX: string; nativeY: string; usdcX: string; usdcY: string }>;
  inventory: Readonly<{ initialUsdcUnits: string; recycledStepUpUsdcUnits: string; recycledDelayedUsdcUnits: string; grossUsdcUnits: string }>;
  baselineActualCostWei: string;
  phaseLimitWei: string;
  actions: readonly OrdinaryScenarioActionScope[];
}>;

export type OrdinaryScenarioApproval = Readonly<{ approvalHash: Hex }>;
type ApprovalBinding = Readonly<{ proposal: OrdinaryScenarioProposal; actions: readonly OrdinaryScenarioActionScope[]; actionCount: number; maximumApprovedReservation: bigint }>;
const approvalBindings = new WeakMap<object, ApprovalBinding>();

export type OrdinaryScenarioActionStatus = "materialized" | "signed-simulated" | "outer-pending" | "confirmed" | "rejection-proved" | "reverted" | "stopped";
export type OrdinaryScenarioActionRecord = {
  id: string;
  commitment: Hex;
  status: OrdinaryScenarioActionStatus;
  materializationHash?: Hex;
  finalOuterMaterialization?: Readonly<{
    hash: Hex;
    proposalHash: Hex;
    actionCommitment: Hex;
    outerNonce: number;
    gas: string;
    gasEstimate: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    pinnedBlockNumber: string;
    pinnedBlockHash: Hex;
    approvedContinuationReservationWei: string;
    remainingReservationWei: string;
  }>;
  prestateHash?: Hex;
  outerNonce?: number;
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  requestHash?: Hex;
  signatureBundleHash?: Hex | null;
  signedCalldataHash?: Hex;
  simulationEvidenceHash?: Hex;
  intentHash?: Hex;
  transactionHash?: Hex;
  outerTo?: Address;
  outerValue?: string;
  outerDataHash?: Hex;
  evidenceHash?: Hex;
  receipt?: LiveReceipt;
  queueCreatedAt?: string;
  establishedWindow?: string;
  funderNativeBefore?: string;
  funderNativeAfter?: string;
  ourPrincipalDelta?: string;
  ourReceiptGasCost?: string;
  externalFunderDelta?: string;
  externalFunderDeltaClassification?: "unrelated/shared-funder activity";
};

export type OrdinaryScenarioJournal = {
  schemaVersion: 1;
  chainId: number;
  reviewPackageHash: Hex;
  proposalHash: Hex;
  approvalHash: Hex;
  funder: Address;
  liveJournal: LiveJournal;
  actions: OrdinaryScenarioActionRecord[];
  hashlessContinuation?: HashlessContinuationStorage;
  repairContinuation?: {
    schemaVersion: 1;
    prefixHash: Hex;
    originalActionCount: 38;
    cumulativeActualCostWei: string;
    creationProposalHash: Hex;
    creationApprovalHash?: Hex;
    groupProposalHash?: Hex;
    groupApprovalHash?: Hex;
    actions: Array<{ id: string; commitment: Hex; status: "proposed" | "approved" | "pending" | "confirmed" | "rejection-proved" | "stopped"; transactionHash?: Hex; evidenceHash?: Hex }>;
  };
};

export type OrdinaryScenarioExecutionView =
  | Readonly<{ kind: "original-ordinary-v1"; proposal: OrdinaryScenarioProposal }>
  | Readonly<{ kind: "expired-hashless-continuation-v1"; original: OrdinaryScenarioProposal; continuation: ExpiredHashlessContinuationProposal; proposal: OrdinaryScenarioProposal }>;
const executionViews = new WeakSet<object>();

export function createOriginalOrdinaryScenarioExecutionView(proposal: OrdinaryScenarioProposal): OrdinaryScenarioExecutionView {
  const view = deepFreeze({ kind: "original-ordinary-v1" as const, proposal }); executionViews.add(view); return view;
}

export function resolveOrdinaryScenarioExecutionProposal(value: OrdinaryScenarioProposal | OrdinaryScenarioExecutionView): OrdinaryScenarioProposal {
  if ("kind" in value) {
    if (!executionViews.has(value)) throw new Error("ordinary scenario execution view is not closed");
    return value.proposal;
  }
  return value;
}

const continuationQueueStatus = (status: string): ControlledState["queueStatus"] => {
  if (status === "EXPIRED") return "QUEUED_CONDITIONAL";
  if (status === "EXPIRED_SKIPPED") return "EXPIRED_CONDITIONAL";
  if (status === "QUEUED") return "QUEUED_CONDITIONAL";
  if (status === "EXECUTED") return "EXECUTED_CONDITIONAL";
  if (status === "EMPTY" || status === "QUEUED_CONDITIONAL" || status === "CANCELLED_CONDITIONAL" || status === "EXPIRED_CONDITIONAL" || status === "EXECUTED_CONDITIONAL") return status;
  throw new Error("continuation queue status is unsupported");
};

function continuationState(value: ExpiredHashlessContinuationAction["before"]): ControlledState {
  return {
    safeNativeBalance: value.safeNativeBalance, funderUsdcBalance: value.funderUsdcBalance, safeUsdcBalance: value.safeUsdcBalance,
    safeNonce: value.safeNonce, delayQueueNonce: value.delayQueueNonce, delayTxNonce: value.delayTxNonce,
    nativeBaseSpent: value.nativeBaseSpent, nativeInstantSpent: value.nativeInstantSpent, usdcBaseSpent: value.usdcBaseSpent, usdcInstantSpent: value.usdcInstantSpent,
    queueStatus: continuationQueueStatus(value.queueStatus), queueNonce: value.queueNonce, queueFingerprint: value.queueFingerprint,
  };
}

function continuationScope(action: ExpiredHashlessContinuationAction): OrdinaryScenarioActionScope {
  const safeTransaction: ReviewedSafeTransaction | undefined = action.safeTransaction && action.safeTxHash ? {
    to: action.safeTransaction.to, value: BigInt(action.safeTransaction.value), data: action.safeTransaction.data, operation: 0 as const,
    safeNonce: BigInt(action.safeTransaction.nonce), safeTxHash: action.safeTxHash, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
    gasToken: action.safeTransaction.gasToken, refundReceiver: action.safeTransaction.refundReceiver,
  } : undefined;
  return deepFreeze({
    id: action.id, kind: action.kind, asset: action.asset, expectedOutcome: action.expectedOutcome, signerRoles: [...action.signerRoles], dependsOn: [...action.dependsOn], commitment: action.commitment,
    gasLimitCap: BigInt(action.gasLimitCap), maxFeePerGasCap: BigInt(action.maxFeePerGasCap), maxPriorityFeePerGasCap: BigInt(action.maxPriorityFeePerGasCap),
    before: continuationState(action.before), after: continuationState(action.after),
    ...(safeTransaction ? { safeTxHash: action.safeTxHash!, safeTransaction } : { publicTransaction: { to: action.transaction.to, value: BigInt(action.transaction.value), data: action.transaction.data } }),
    ...(action.queue ? { queue: { queueNonce: BigInt(action.queue.queueNonce), fingerprint: action.queue.fingerprint, monitoringFingerprint: action.queue.monitoringFingerprint, to: action.queue.to, value: BigInt(action.queue.value), data: action.queue.data, operation: 0 as const } } : {}),
  });
}

export function createExpiredHashlessContinuationExecutionView(original: OrdinaryScenarioProposal, continuation: ExpiredHashlessContinuationProposal, approval?: ExpiredHashlessContinuationApproval): OrdinaryScenarioExecutionView {
  assertExpiredHashlessContinuationLineage(original, continuation);
  if (approval !== undefined) assertExpiredHashlessContinuationAuthorization(continuation, approval);
  const continuationActions = continuation.actions.map(continuationScope);
  const proposal = deepFreeze({ ...original, proposalHash: continuation.proposalHash, observerEvidenceHash: continuation.observer.probeEvidenceHash, actions: [...original.actions.slice(0, 18), ...continuationActions] });
  const view = deepFreeze({ kind: "expired-hashless-continuation-v1" as const, original, continuation, proposal }); executionViews.add(view); return view;
}

export type OrdinaryScenarioStore = Readonly<{
  load(): OrdinaryScenarioJournal;
  save(journal: OrdinaryScenarioJournal): void;
  close?(): void;
}>;

export type PreparedOrdinaryAction = Readonly<{
  liveIntent: LiveIntent;
  requestHash: Hex;
  signerRolesHash: Hex;
  signedCalldataHash: Hex;
  signatureBundleHash: Hex | null;
  transientSignedCalldata: Hex;
  replaySource?: Readonly<{ actionId: string; safeTxHash: Hex; safeNonce: bigint }>;
  transientSignedOuterTransaction?: Hex;
}>;
export type SignedSimulationEvidence = Readonly<{ blockNumber: bigint; blockHash: Hex; success: boolean; gasEstimate: bigint; resultHash: Hex }>;
export type RejectionEvidence = Readonly<{ blockNumber: bigint; blockHash: Hex; success: false; revertDataHash: Hex; postState: CanonicalOrdinaryScenarioState }>;
export type ConfirmationEffect =
  | Readonly<{ kind: "native-funding"; to: Address; amount: bigint }>
  | Readonly<{ kind: "erc20-funding"; token: Address; from: Address; to: Address; amount: bigint }>
  | Readonly<{ kind: "safe-execution"; safeTxHash: Hex; queueCreatedAt?: bigint; queueFingerprint?: Hex }>
  | Readonly<{ kind: "delay-lifecycle"; lifecycle: "expired" | "executed"; fingerprint: Hex; createdAt: bigint }>;
export type ConfirmationEvidence = Readonly<{ postState: CanonicalOrdinaryScenarioState; effect: ConfirmationEffect; observerEvidenceHash: Hex | null }>;

export type OrdinaryScenarioExecutionContext = Readonly<{
  readState(action: OrdinaryScenarioActionScope, phase: "pre-private" | "pre-outer"): Promise<CanonicalOrdinaryScenarioState>;
  materialize(action: OrdinaryScenarioActionScope, state: CanonicalOrdinaryScenarioState): Promise<PreparedOrdinaryAction>;
  simulate(action: OrdinaryScenarioActionScope, prepared: PreparedOrdinaryAction, state: CanonicalOrdinaryScenarioState): Promise<SignedSimulationEvidence>;
  proveRejection(action: OrdinaryScenarioActionScope, state: CanonicalOrdinaryScenarioState, prepared?: PreparedOrdinaryAction): Promise<RejectionEvidence>;
  recoverPending(action: OrdinaryScenarioActionScope, record: OrdinaryScenarioActionRecord): Promise<LiveIntent>;
  recoverReplay(action: OrdinaryScenarioActionScope, source: OrdinaryScenarioActionRecord, state: CanonicalOrdinaryScenarioState): Promise<PreparedOrdinaryAction>;
  verifyContractSignature(signer: Address, safeTxHash: Hex, signature: Hex, blockNumber: bigint): Promise<Hex>;
  confirm(action: OrdinaryScenarioActionScope, entry: JournalEntry, record: OrdinaryScenarioActionRecord): Promise<ConfirmationEvidence>;
  live: Omit<LiveContext, "verify" | "persist">;
}>;

export type OrdinaryScenarioExecutionResult =
  | Readonly<{ status: "PENDING" | "CONFIRMED" | "REJECTION_PROVED" | "REVERTED" | "COMPLETE"; actionId?: string }>
  | Readonly<{ status: "WAITING"; actionId: string; nextCanonicalTime: bigint }>;

const rawSha256 = (value: string): Hex => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
const publicValue = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(publicValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)]));
};
const publicHash = (value: unknown): Hex => sha256(publicValue(value)) as Hex;
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const bytes = (value: Hex): Uint8Array => Uint8Array.from(Buffer.from(value.slice(2), "hex"));
const sliceHex = (value: Uint8Array, start: number, end: number): Hex => `0x${Buffer.from(value.slice(start, end)).toString("hex")}` as Hex;
const uintWord = (value: Uint8Array, start: number): bigint => BigInt(sliceHex(value, start, start + 32));
const addressWord = (value: Uint8Array, start: number): Address => `0x${Buffer.from(value.slice(start + 12, start + 32)).toString("hex")}` as Address;
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const array = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
};
const decimal = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`);
  return BigInt(value);
};
const hash = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a hash`);
  return value as Hex;
};
const address = (value: unknown, label: string): Address => {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) throw new Error(`${label} must be an address`);
  return value as Address;
};
const hex = (value: unknown, label: string): Hex => {
  if (typeof value !== "string" || !HEX.test(value)) throw new Error(`${label} must be canonical hex bytes`);
  return value as Hex;
};
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} has unknown or missing fields`);
};
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
};

function actionControlledState(value: Record<string, unknown>, side: "before" | "after", delayQueueNonce: bigint, delayTxNonce: bigint): ControlledState {
  exactKeys(value, ["stateAvailability", "futureStateStatus", "principalBalances", "nativeFunderGasAccounting", "nonces", "counters", "queue"], "action expected state");
  const principal = record(value.principalBalances, "action expected principal balances");
  exactKeys(principal, ["nativeFunderBefore", "nativeFunderAfter", "nativeSafeBefore", "nativeSafeAfter", "usdcFunderBefore", "usdcFunderAfter", "usdcSafeBefore", "usdcSafeAfter"], "action expected principal balances");
  const nonces = record(record(value.nonces, "action expected nonces")[side], `action expected ${side} nonces`);
  exactKeys(record(value.nonces, "action expected nonces"), ["before", "after"], "action expected nonces");
  exactKeys(nonces, ["funder", "safe", "delay"], `action expected ${side} nonces`);
  const counters = record(record(value.counters, "action expected counters")[side], `action expected ${side} counters`);
  exactKeys(record(value.counters, "action expected counters"), ["before", "after", "fundingNeverResetsCounters"], "action expected counters");
  exactKeys(counters, ["native", "USDC"], `action expected ${side} counters`);
  const native = record(counters.native, `action expected ${side} native counters`);
  const usdcState = record(counters.USDC, `action expected ${side} USDC counters`);
  exactKeys(native, ["baseSpent", "instantSpent"], `action expected ${side} native counters`);
  exactKeys(usdcState, ["baseSpent", "instantSpent"], `action expected ${side} USDC counters`);
  const queue = record(record(value.queue, "action expected queue")[side], `action expected ${side} queue`);
  exactKeys(record(value.queue, "action expected queue"), ["before", "after"], "action expected queue");
  exactKeys(queue, ["status", "queueNonce", "fingerprint"], `action expected ${side} queue`);
  exactKeys(record(value.nativeFunderGasAccounting, "action expected funder gas accounting"), ["beforeExpression", "afterExpression", "cumulativeProposedGasCapAfterWei", "minimumAfterAtProposedCapsWei"], "action expected funder gas accounting");
  const queueStatus = queue.status;
  if (queueStatus !== "EMPTY" && queueStatus !== "QUEUED_CONDITIONAL" && queueStatus !== "CANCELLED_CONDITIONAL" && queueStatus !== "EXPIRED_CONDITIONAL" && queueStatus !== "EXECUTED_CONDITIONAL") throw new Error(`action expected ${side} queue status mismatch`);
  const queueNonceValue = queue.queueNonce === null ? null : decimal(queue.queueNonce, `action expected ${side} queue nonce`).toString();
  const queueFingerprint = queue.fingerprint === null ? null : hash(queue.fingerprint, `action expected ${side} queue fingerprint`);
  if ((queueStatus === "EMPTY") !== (queueNonceValue === null && queueFingerprint === null) || (queueStatus !== "EMPTY" && (queueNonceValue === null || queueFingerprint === null))) throw new Error(`action expected ${side} queue identity mismatch`);
  return deepFreeze({
    safeNativeBalance: decimal(principal[side === "before" ? "nativeSafeBefore" : "nativeSafeAfter"], "safe native balance").toString(),
    funderUsdcBalance: decimal(principal[side === "before" ? "usdcFunderBefore" : "usdcFunderAfter"], "funder USDC balance").toString(),
    safeUsdcBalance: decimal(principal[side === "before" ? "usdcSafeBefore" : "usdcSafeAfter"], "Safe USDC balance").toString(),
    safeNonce: decimal(nonces.safe, "Safe nonce").toString(),
    delayQueueNonce: delayQueueNonce.toString(), delayTxNonce: delayTxNonce.toString(),
    nativeBaseSpent: decimal(native.baseSpent, "native base spent").toString(), nativeInstantSpent: decimal(native.instantSpent, "native instant spent").toString(),
    usdcBaseSpent: decimal(usdcState.baseSpent, "USDC base spent").toString(), usdcInstantSpent: decimal(usdcState.instantSpent, "USDC instant spent").toString(),
    queueStatus, queueNonce: queueNonceValue, queueFingerprint,
  });
}

function validateActionShape(value: unknown, index: number): Record<string, unknown> {
  const action = record(value, `action ${index}`);
  const keys = ["id", "kind", "asset", "dependsOn", "status", "expectedOutcome", "signerRoles", "proposedGasAndFee", "expectedTransition", "expectedState", "observerAlert"];
  for (const optional of ["safeTransaction", "publicTransaction", "queue", "timing"]) if (action[optional] !== undefined) keys.push(optional);
  exactKeys(action, keys, `action ${index}`);
  return action;
}

type SemanticIdentity = Readonly<{ safe: Address; delay: Address; usdc: Address; recipient: Address }>;
function decodeCall(abi: readonly object[], data: Hex, label: string): ReturnType<typeof decodeFunctionData> {
  try { return decodeFunctionData({ abi, data }); } catch { throw new Error(`${label} calldata mismatch`); }
}
function assertQueueTuple(args: readonly unknown[], queue: NonNullable<OrdinaryScenarioActionScope["queue"]>, label: string): void {
  if (!same(args[0] as string, queue.to) || args[1] !== queue.value || !same(args[2] as string, queue.data) || args[3] !== queue.operation) throw new Error(`${label} queue tuple mismatch`);
}
function validateActionSemantics(scope: OrdinaryScenarioActionScope, identity: SemanticIdentity, descriptor: ActionDescriptor, queueBefore: bigint, chainId: number): void {
  if (scope.safeTransaction) {
    const tx = scope.safeTransaction;
    if (descriptor.safeNonce === undefined || tx.safeNonce !== descriptor.safeNonce) throw new Error(`${scope.id} fixed Safe nonce mismatch`);
    const recomputed = hashTypedData({ domain: { chainId, verifyingContract: identity.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { to: tx.to, value: tx.value, data: tx.data, operation: tx.operation, safeTxGas: tx.safeTxGas, baseGas: tx.baseGas, gasPrice: tx.gasPrice, gasToken: tx.gasToken, refundReceiver: tx.refundReceiver, nonce: tx.safeNonce } });
    if (!same(recomputed, tx.safeTxHash)) throw new Error(`${scope.id} reviewed Safe hash mismatch`);
    if (scope.kind === "base-transfer" || scope.kind === "step-up-transfer" || scope.kind === "expected-direct-rejection" || scope.kind === "expected-replay-rejection") {
      const amount = scope.kind === "expected-direct-rejection" ? 1n : scope.asset === "native" ? NATIVE_X : USDC_X;
      if (scope.asset === "native") { if (!same(tx.to, identity.recipient) || tx.value !== amount || tx.data !== "0x") throw new Error(`${scope.id} native transfer semantic mismatch`); }
      else { const decoded = decodeCall(ERC20_ABI, tx.data, scope.id); if (!same(tx.to, identity.usdc) || tx.value !== 0n || decoded.functionName !== "transfer" || !same(decoded.args[0] as string, identity.recipient) || decoded.args[1] !== amount) throw new Error(`${scope.id} token transfer semantic mismatch`); }
    } else if (scope.kind === "expected-unsupported-rejection") {
      const decoded = decodeCall(ERC20_ABI, tx.data, scope.id); if (!same(tx.to, identity.usdc) || tx.value !== 0n || decoded.functionName !== "approve" || !same(decoded.args[0] as string, identity.recipient) || decoded.args[1] !== 1n) throw new Error(`${scope.id} unsupported-path semantic mismatch`);
    } else if (scope.kind === "queue-proposal") {
      const decoded = decodeCall(DELAY_MODULE_ABI, tx.data, scope.id); if (!same(tx.to, identity.delay) || tx.value !== 0n || decoded.functionName !== "execTransactionFromModule" || !scope.queue) throw new Error(`${scope.id} queue proposal semantic mismatch`); assertQueueTuple(decoded.args, scope.queue, scope.id);
    } else if (scope.kind === "queue-cancellation") {
      const decoded = decodeCall(DELAY_ABI, tx.data, scope.id); if (!same(tx.to, identity.delay) || tx.value !== 0n || decoded.functionName !== "setTxNonce" || decoded.args[0] !== queueBefore) throw new Error(`${scope.id} queue cancellation semantic mismatch`);
    } else throw new Error(`${scope.id} unsupported Safe action semantic`);
  } else if (scope.kind === "funding" || scope.kind === "controlled-recipient-recycled-funding") {
    if (!scope.publicTransaction) throw new Error(`${scope.id} funding transaction is missing`);
    if (scope.asset === "native") { if (!same(scope.publicTransaction.to, identity.safe) || scope.publicTransaction.value !== 30_000_000_000_001n || scope.publicTransaction.data !== "0x") throw new Error(`${scope.id} native funding semantic mismatch`); }
    else { const amount = scope.id === "usdc-funding" ? INITIAL_USDC : scope.id === "usdc-recycle-topup-step-up" ? RECYCLED_STEP_UP_USDC : RECYCLED_DELAYED_USDC; const decoded = decodeCall(ERC20_ABI, scope.publicTransaction.data, scope.id); if (!same(scope.publicTransaction.to, identity.usdc) || scope.publicTransaction.value !== 0n || decoded.functionName !== "transfer" || !same(decoded.args[0] as string, identity.safe) || decoded.args[1] !== amount) throw new Error(`${scope.id} USDC funding semantic mismatch`); }
  } else {
    if (!scope.publicTransaction || !scope.queue || !same(scope.publicTransaction.to, identity.delay) || scope.publicTransaction.value !== 0n) throw new Error(`${scope.id} Delay public semantic mismatch`);
    const decoded = decodeCall(DELAY_ABI, scope.publicTransaction.data, scope.id);
    if (scope.kind === "queue-expiry") { if (decoded.functionName !== "skipExpired") throw new Error(`${scope.id} expiry selector mismatch`); }
    else { if (decoded.functionName !== "executeNextTx") throw new Error(`${scope.id} execution selector mismatch`); assertQueueTuple(decoded.args, scope.queue, scope.id); }
  }
}

function snapshotAction(action: Record<string, unknown>, index: number, queueBefore: bigint, txBefore: bigint, identity: SemanticIdentity, chainId: number): { scope: OrdinaryScenarioActionScope; queueAfter: bigint; txAfter: bigint } {
  const id = text(action.id, `action ${index} id`); const kind = text(action.kind, `${id} kind`);
  if (!ALLOWED_IDS.has(id) || !SUPPORTED_KINDS.has(kind)) throw new Error(`ordinary scenario contains unknown action ${id}`);
  if (action.status !== "CONDITIONAL_NOT_RUN") throw new Error(`supported action ${id} is not reviewable`);
  const expectedOutcome = action.expectedOutcome;
  if (expectedOutcome !== (REJECTION_KINDS.has(kind) ? "rejection" : "success")) throw new Error(`${id} expected outcome mismatch`);
  const asset = action.asset;
  if (asset !== "native" && asset !== "USDC" && asset !== "control") throw new Error(`${id} asset mismatch`);
  const dependsOn = array(action.dependsOn, `${id} dependencies`).map((entry, dependency) => text(entry, `${id} dependency ${dependency}`));
  const signerRoles = array(action.signerRoles, `${id} signer roles`).map((entry, role) => text(entry, `${id} signer role ${role}`));
  const descriptor = ACTION_DESCRIPTORS.get(id);
  if (!descriptor || descriptor.kind !== kind || descriptor.asset !== asset || JSON.stringify(descriptor.dependsOn) !== JSON.stringify(dependsOn) || JSON.stringify(descriptor.signerRoles) !== JSON.stringify(signerRoles)) throw new Error(`${id} closed action descriptor mismatch`);
  const hasSafe = action.safeTransaction !== undefined; const hasPublic = action.publicTransaction !== undefined; const hasQueue = action.queue !== undefined; const hasTiming = action.timing !== undefined;
  if ((descriptor.transaction === "safe") !== hasSafe || (descriptor.transaction === "public") !== hasPublic || hasSafe === hasPublic || descriptor.queue !== hasQueue || descriptor.queue !== hasTiming) throw new Error(`${id} exact transaction shape mismatch`);
  const caps = record(action.proposedGasAndFee, `${id} caps`);
  exactKeys(caps, ["gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "liveEstimated", "preSendEstimateRequired"], `${id} caps`);
  const gasLimitCap = decimal(caps.gasLimit, `${id} gas cap`); const maxFeePerGasCap = decimal(caps.maxFeePerGas, `${id} max fee cap`); const maxPriorityFeePerGasCap = decimal(caps.maxPriorityFeePerGas, `${id} priority fee cap`);
  if (gasLimitCap <= 0n || maxFeePerGasCap <= 0n || maxPriorityFeePerGasCap > maxFeePerGasCap || caps.liveEstimated !== false || caps.preSendEstimateRequired !== true) throw new Error(`${id} gas and fee caps are invalid`);
  let safeTxHash: Hex | undefined; let safeTransaction: ReviewedSafeTransaction | undefined; let publicTransaction: OrdinaryScenarioActionScope["publicTransaction"];
  if (action.safeTransaction !== undefined) {
    const transaction = record(action.safeTransaction, `${id} Safe transaction`);
    exactKeys(transaction, ["to", "value", "data", "operation", "safeNonce", "safeTxHash", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver"], `${id} Safe transaction`);
    if (transaction.operation !== 0 || decimal(transaction.safeTxGas, `${id} safeTxGas`) !== 0n || decimal(transaction.baseGas, `${id} baseGas`) !== 0n || decimal(transaction.gasPrice, `${id} gasPrice`) !== 0n || !same(address(transaction.gasToken, `${id} gas token`), ZERO) || !same(address(transaction.refundReceiver, `${id} refund receiver`), ZERO)) throw new Error(`${id} Safe refund or operation fields are not fixed`);
    safeTransaction = deepFreeze({ to: address(transaction.to, `${id} Safe target`), value: decimal(transaction.value, `${id} Safe value`), data: hex(transaction.data, `${id} Safe calldata`), operation: 0, safeNonce: decimal(transaction.safeNonce, `${id} Safe nonce`), safeTxHash: hash(transaction.safeTxHash, `${id} Safe hash`), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO }); safeTxHash = safeTransaction.safeTxHash;
  }
  if (action.publicTransaction !== undefined) {
    const transaction = record(action.publicTransaction, `${id} public transaction`);
    exactKeys(transaction, kind === "funding" || kind === "controlled-recipient-recycled-funding" ? ["to", "value", "data", "operation", "funderNonce", "safeNonce", "safeTxHash"] : ["to", "value", "data", "operation", "safeNonce", "safeTxHash", "outerTransactionNonce"], `${id} public transaction`);
    publicTransaction = deepFreeze({ to: address(transaction.to, `${id} public target`), value: decimal(transaction.value, `${id} public value`), data: hex(transaction.data, `${id} public calldata`) });
    if (transaction.operation !== 0) throw new Error(`${id} public operation mismatch`);
  }
  let queue: OrdinaryScenarioActionScope["queue"];
  if (action.queue !== undefined) {
    const item = record(action.queue, `${id} queue`);
    exactKeys(item, ["queueNonce", "queueFingerprint", "monitoringFingerprint", "to", "value", "data", "operation"], `${id} queue`);
    queue = deepFreeze({ queueNonce: decimal(item.queueNonce, `${id} queue nonce`), fingerprint: hash(item.queueFingerprint, `${id} queue fingerprint`), monitoringFingerprint: hash(item.monitoringFingerprint, `${id} monitoring fingerprint`), to: address(item.to, `${id} queue target`), value: decimal(item.value, `${id} queue value`), data: hex(item.data, `${id} queue data`), operation: item.operation === 0 ? 0 : (() => { throw new Error(`${id} queue operation mismatch`); })() });
    const expectedItemNonce = kind === "queue-proposal" ? queueBefore : queueBefore - 1n;
    if (expectedItemNonce < 0n || queue.queueNonce !== expectedItemNonce) throw new Error(`${id} fixed Delay queue nonce mismatch`);
    const timing = record(action.timing, `${id} timing`);
    exactKeys(timing, ["source", "createdAt", "readyAt", "expiresAt", "cooldownSeconds", "expirationSeconds", "status", "revalidateFromCanonicalReceipt"], `${id} timing`);
    if (timing.source !== "FUTURE_CANONICAL_QUEUE_RECEIPT_BLOCK" || timing.createdAt !== null || timing.readyAt !== null || timing.expiresAt !== null || decimal(timing.cooldownSeconds, `${id} cooldown`) !== COOLDOWN_SECONDS || decimal(timing.expirationSeconds, `${id} expiration`) !== EXPIRATION_SECONDS || timing.revalidateFromCanonicalReceipt !== true) throw new Error(`${id} canonical queue timing rule mismatch`);
  }
  const expectedState = record(action.expectedState, `${id} expected state`);
  const before = actionControlledState(expectedState, "before", queueBefore, txBefore);
  let queueAfter = queueBefore; let txAfter = txBefore;
  if (kind === "queue-proposal") queueAfter += 1n;
  if (kind === "queue-cancellation" || kind === "queue-expiry" || kind === "ready-delay-execution") txAfter += 1n;
  const after = actionControlledState(expectedState, "after", queueAfter, txAfter);
  if (safeTxHash && BigInt(after.safeNonce) !== BigInt(before.safeNonce) + (expectedOutcome === "success" ? 1n : 0n)) throw new Error(`${id} fixed Safe nonce progression mismatch`);
  if (!safeTxHash && BigInt(after.safeNonce) !== BigInt(before.safeNonce)) throw new Error(`${id} unexpectedly changes Safe nonce`);
  const scope: OrdinaryScenarioActionScope = deepFreeze({ id, kind, asset: asset as OrdinaryScenarioActionScope["asset"], expectedOutcome: expectedOutcome as "success" | "rejection", signerRoles, dependsOn, commitment: sha256(action) as Hex, gasLimitCap, maxFeePerGasCap, maxPriorityFeePerGasCap, before, after, safeTxHash, safeTransaction, publicTransaction, queue });
  validateActionSemantics(scope, identity, descriptor, queueBefore, chainId);
  return { scope, queueAfter, txAfter };
}

export function createOrdinaryScenarioProposal(serializedReview: string, expected: Readonly<{ expectedPackageHash: Hex; expectedArtifactBytesHash: Hex }>, domain: OrdinaryScenarioProposalDomain = PRODUCTION_ORDINARY_SCENARIO_DOMAIN): OrdinaryScenarioProposal {
  assertOrdinaryDomain(domain);
  if (!HASH.test(expected.expectedPackageHash) || !HASH.test(expected.expectedArtifactBytesHash)) throw new Error("ordinary scenario expected review hashes are invalid");
  if (Buffer.byteLength(serializedReview, "utf8") > 4_000_000) throw new Error("ordinary scenario review artifact is too large");
  if (!same(rawSha256(serializedReview), expected.expectedArtifactBytesHash)) throw new Error("ordinary scenario review artifact bytes hash mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(serializedReview); } catch { throw new Error("ordinary scenario review artifact must be JSON"); }
  const report = record(parsed, "ordinary scenario review");
  exactKeys(report, ["schemaVersion", "status", "authorization", "chainId", "planHash", "topologyEvidenceHash", "baselineEvidenceHash", "snapshot", "publicIdentities", "requiredInventory", "blockers", "actions", "phaseAccounting", "finalRevalidation", "signed", "broadcast", "liveEstimated"], "ordinary scenario review");
  if (!same(sha256(report), expected.expectedPackageHash)) throw new Error("ordinary scenario review package hash mismatch");
  if (report.schemaVersion !== 1 || report.authorization !== "NONE" || report.chainId !== domain.chainId.toString() || (report.status !== "BLOCKED" && report.status !== "READY_FOR_HUMAN_REVIEW") || report.signed !== false || report.broadcast !== false || report.liveEstimated !== false) throw new Error("ordinary scenario review boundary mismatch");
  const reportPlanHash = hash(report.planHash, "ordinary scenario plan hash"); const topologyEvidenceHash = hash(report.topologyEvidenceHash, "ordinary scenario topology hash"); const baselineEvidenceHash = hash(report.baselineEvidenceHash, "ordinary scenario baseline hash");
  const identities = record(report.publicIdentities, "ordinary scenario public identities");
  exactKeys(identities, ["safe", "guard", "delay", "maintenance", "signers", "runtimeCodeHashes", "observer", "repair"], "ordinary scenario public identities");
  const snapshot = record(report.snapshot, "ordinary scenario snapshot"); const balances = record(snapshot.balances, "ordinary scenario balances"); const funderBalance = record(balances.funder, "ordinary scenario funder balance");
  exactKeys(snapshot, ["blockNumber", "blockHash", "blockTimestamp", "safeNonce", "funderNonce", "delayNonce", "balances", "counters", "token"], "ordinary scenario snapshot");
  exactKeys(balances, ["funder", "safe", "recipient"], "ordinary scenario balances");
  for (const name of ["funder", "safe", "recipient"] as const) exactKeys(record(balances[name], `ordinary scenario ${name} balance`), ["address", "nativeWei", "usdcUnits"], `ordinary scenario ${name} balance`);
  const safeAddress = address(identities.safe, "ordinary scenario Safe"); const guardAddress = address(identities.guard, "ordinary scenario guard"); const delayAddress = address(identities.delay, "ordinary scenario Delay"); const funderAddress = address(identities.funder ?? funderBalance.address, "ordinary scenario funder");
  const recipientAddress = address(record(balances.recipient, "ordinary scenario recipient balance").address, "ordinary scenario recipient");
  if (!same(recipientAddress, funderAddress)) throw new Error("ordinary scenario controlled recipient must equal funder");
  const token = record(snapshot.token, "ordinary scenario token"); const usdcAddress = address(token.address, "ordinary scenario USDC");
  exactKeys(token, ["address", "name", "symbol", "decimals"], "ordinary scenario token");
  if (token.symbol !== "USDC" || token.decimals !== 6) throw new Error("ordinary scenario USDC metadata mismatch");
  const inventory = record(report.requiredInventory, "ordinary scenario inventory");
  exactKeys(inventory, ["nativeWei", "usdcUnits", "initialExternalUsdcUnits", "grossUsdcFundingUnits", "explanation"], "ordinary scenario inventory");
  if (decimal(inventory.initialExternalUsdcUnits, "initial USDC") !== INITIAL_USDC || decimal(inventory.grossUsdcFundingUnits, "gross USDC") !== GROSS_USDC || decimal(inventory.usdcUnits, "required USDC") !== GROSS_USDC || decimal(inventory.nativeWei, "required native") !== 30_000_000_000_001n) throw new Error("ordinary scenario fixed 20/10/1 inventory mismatch");
  const phase = record(report.phaseAccounting, "ordinary scenario phase accounting"); const phaseLimit = decimal(phase.phaseLimitWei, "phase ceiling"); const baselineActual = decimal(phase.prerequisiteAndSafeActualCostWei, "baseline actual cost"); const maximumGross = decimal(phase.maximumGrossPhaseOutlayWei, "maximum gross phase outlay");
  exactKeys(phase, ["phaseLimitWei", "prerequisiteAndSafeActualCostWei", "nativeFundingValueWei", "nativeSafeTransferPrincipalWei", "grossUsdcFundingUnits", "proposedGasReservationWei", "maximumGrossPhaseOutlayWei", "proposedCapsOnly", "signedSimulationOrEstimateStatus"], "ordinary scenario phase accounting");
  if (phaseLimit !== PHASE_OUTLAY_LIMIT || maximumGross > phaseLimit) throw new Error("ordinary scenario phase ceiling mismatch");
  const observer = record(identities.observer, "ordinary scenario observer"); const observerEvidenceHash = hash(observer.probeEvidenceHash, "ordinary scenario observer evidence");
  exactKeys(observer, ["kind", "publicId", "independentFromProposer", "endpointHash", "probeEvidenceHash", "actualActivityAlerts"], "ordinary scenario observer");
  const signers = record(identities.signers, "ordinary scenario signers"); exactKeys(signers, ["primary", "safeContractSecondary", "ecdsaSecondary"], "ordinary scenario signers");
  for (const name of ["primary", "safeContractSecondary", "ecdsaSecondary"] as const) exactKeys(record(signers[name], `ordinary scenario ${name}`), ["address", "kind", "available", "source"], `ordinary scenario ${name}`);
  const primarySigner = address(record(signers.primary, "ordinary scenario primary signer").address, "ordinary scenario primary signer address");
  const safeContractSecondary = address(record(signers.safeContractSecondary, "ordinary scenario safe-contract secondary").address, "ordinary scenario safe-contract secondary address");
  const ecdsaSecondary = address(record(signers.ecdsaSecondary, "ordinary scenario ECDSA secondary").address, "ordinary scenario ECDSA secondary address");
  const runtimeIdentities = record(identities.runtimeCodeHashes, "ordinary scenario runtime identities");
  exactKeys(runtimeIdentities, ["safe", "guard", "delay", "maintenance", "primary", "safeContractSecondary", "ecdsaSecondary", "replacementContractSecondary"], "ordinary scenario runtime identities");
  exactKeys(record(identities.repair, "ordinary scenario repair proposal"), ["formatVersion", "scope", "chainId", "factory", "verifiers", "address", "x", "y", "observedRuntime", "deployed", "signed", "broadcast"], "ordinary scenario repair proposal");
  for (const [index, counterValue] of array(snapshot.counters, "ordinary scenario counters").entries()) exactKeys(record(counterValue, `ordinary scenario counter ${index}`), ["token", "window", "baseSpent", "instantSpent"], `ordinary scenario counter ${index}`);
  for (const [index, blockerValue] of array(report.blockers, "ordinary scenario blockers").entries()) exactKeys(record(blockerValue, `ordinary scenario blocker ${index}`), ["code", "detail"], `ordinary scenario blocker ${index}`);
  const finalRevalidation = record(report.finalRevalidation, "ordinary scenario final revalidation");
  exactKeys(finalRevalidation, ["blockHashRechecked", "safeNonceRechecked", "delayNonceRechecked", "countersRechecked", "balancesRechecked", "runtimeIdentitiesRechecked"], "ordinary scenario final revalidation");
  if (Object.values(finalRevalidation).some((value) => value !== true)) throw new Error("ordinary scenario final revalidation is incomplete");
  const publicIdentitiesHash = sha256(runtimeIdentities) as Hex;
  const actionValues = array(report.actions, "ordinary scenario actions"); const actions: OrdinaryScenarioActionScope[] = [];
  if (actionValues.length <= ACTION_DESCRIPTOR_LIST.length) throw new Error("ordinary scenario exact ordered 38-action predecessor list is incomplete");
  const sourceIds = actionValues.slice(0, ACTION_DESCRIPTOR_LIST.length).map((value, index) => text(record(value, `action ${index}`).id, `action ${index} id`));
  if (new Set(sourceIds).size !== ACTION_DESCRIPTOR_LIST.length || sourceIds.some((id, index) => id !== ACTION_DESCRIPTOR_LIST[index]!.id)) throw new Error("ordinary scenario exact ordered 38-action predecessor list mismatch");
  const boundary = record(actionValues[ACTION_DESCRIPTOR_LIST.length], "ordinary scenario repair boundary");
  if (!EXCLUDED_IDS.has(text(boundary.id, "ordinary scenario repair boundary id"))) throw new Error("ordinary scenario repair boundary must follow the exact predecessor list");
  const seen = new Set<string>(); let excluded = false; let queueNonce = 0n; let txNonce = 0n;
  for (let index = 0; index < actionValues.length; index++) {
    const current = validateActionShape(actionValues[index], index); const id = text(current.id, `action ${index} id`); const kind = text(current.kind, `${id} kind`);
    if (EXCLUDED_IDS.has(id) || EXCLUDED_KINDS.has(kind)) {
      excluded = true;
      if (!EXCLUDED_IDS.has(id) || !EXCLUDED_KINDS.has(kind)) throw new Error(`ordinary scenario contains unknown excluded action ${id}`);
      if (id === "repair-signer-create" && current.status !== "BLOCKED_INPUT") throw new Error("excluded action cannot enter the approved predecessor prefix");
      continue;
    }
    if (excluded) throw new Error(`ordinary scenario supported action appears after excluded repair boundary: ${id}`);
    const snap = snapshotAction(current, index, queueNonce, txNonce, { safe: safeAddress, delay: delayAddress, usdc: usdcAddress, recipient: recipientAddress }, domain.chainId);
    if (snap.scope.dependsOn.some((dependency) => !seen.has(dependency))) throw new Error(`${id} dependency is missing or out of order`);
    seen.add(id); actions.push(snap.scope); queueNonce = snap.queueAfter; txNonce = snap.txAfter;
  }
  if (actions.length === 0 || !excluded) throw new Error("ordinary scenario exact pre-repair predecessor prefix is incomplete");
  const base = {
    schemaVersion: 1 as const, authorization: "NONE" as const, chainId: domain.chainId,
    reviewPackageHash: expected.expectedPackageHash, reviewArtifactBytesHash: expected.expectedArtifactBytesHash, planHash: reportPlanHash,
    topologyEvidenceHash, baselineEvidenceHash, publicIdentitiesHash, observerEvidenceHash, safe: safeAddress, guard: guardAddress, delay: delayAddress, funder: funderAddress, usdc: usdcAddress, recipient: recipientAddress, primarySigner, safeContractSecondary, ecdsaSecondary,
    periodSeconds: PERIOD_SECONDS.toString() as "86400", periodAnchor: "0" as const, cooldownSeconds: COOLDOWN_SECONDS.toString() as "120", expirationSeconds: EXPIRATION_SECONDS.toString() as "600",
    limits: deepFreeze({ nativeX: NATIVE_X.toString(), nativeY: NATIVE_Y.toString(), usdcX: USDC_X.toString(), usdcY: USDC_Y.toString() }),
    inventory: deepFreeze({ initialUsdcUnits: INITIAL_USDC.toString(), recycledStepUpUsdcUnits: RECYCLED_STEP_UP_USDC.toString(), recycledDelayedUsdcUnits: RECYCLED_DELAYED_USDC.toString(), grossUsdcUnits: GROSS_USDC.toString() }),
    baselineActualCostWei: baselineActual.toString(), phaseLimitWei: phaseLimit.toString(), actions: deepFreeze(actions),
  };
  return deepFreeze({ ...base, proposalHash: publicHash(base) });
}

export function loadOrdinaryScenarioApproval(proposal: OrdinaryScenarioProposal, serializedApproval: string, expected: Readonly<{ expectedProposalHash: Hex; expectedPackageHash: Hex; expectedApprovalHash: Hex }>): OrdinaryScenarioApproval {
  if (!same(proposal.proposalHash, expected.expectedProposalHash) || !same(proposal.reviewPackageHash, expected.expectedPackageHash)) throw new Error("ordinary scenario independently supplied proposal/package hash mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(serializedApproval); } catch { throw new Error("ordinary scenario approval must be JSON"); }
  const document = record(parsed, "ordinary scenario approval");
  exactKeys(document, ["schemaVersion", "scope", "authorization", "chainId", "proposalHash", "reviewPackageHash", "reviewArtifactBytesHash", "planHash", "approvedActions", "derivations", "phaseLimitWei", "maxBroadcastAttempts"], "ordinary scenario approval");
  const approvalHash = sha256(document) as Hex;
  if (!same(approvalHash, expected.expectedApprovalHash)) throw new Error("ordinary scenario approval hash mismatch");
  if (document.schemaVersion !== 1 || document.scope !== "bounded-ordinary-matrix-v1" || document.authorization !== "EXPLICIT_GROUP_APPROVAL" || document.chainId !== proposal.chainId || document.maxBroadcastAttempts !== 1 || !same(text(document.proposalHash, "approval proposal hash"), proposal.proposalHash) || !same(text(document.reviewPackageHash, "approval package hash"), proposal.reviewPackageHash) || !same(text(document.reviewArtifactBytesHash, "approval bytes hash"), proposal.reviewArtifactBytesHash) || !same(text(document.planHash, "approval plan hash"), proposal.planHash) || decimal(document.phaseLimitWei, "approval phase ceiling") !== PHASE_OUTLAY_LIMIT) throw new Error("ordinary scenario approval binding mismatch");
  const derivations = record(document.derivations, "ordinary scenario derivations");
  exactKeys(derivations, ["outerEoaNonce", "fees", "gas", "queueTiming", "safeNonce", "delayQueueNonce", "delayTxNonce"], "ordinary scenario derivations");
  if (derivations.outerEoaNonce !== "CURRENT_ONLY" || derivations.fees !== "AT_OR_BELOW_ACTION_CAPS" || derivations.gas !== "SIGNED_SIMULATION_AT_OR_BELOW_ACTION_CAP" || derivations.queueTiming !== "CANONICAL_RECEIPT_CREATED_AT_ONLY" || derivations.safeNonce !== "FIXED" || derivations.delayQueueNonce !== "FIXED" || derivations.delayTxNonce !== "FIXED") throw new Error("ordinary scenario derivation scope mismatch");
  const approved = array(document.approvedActions, "ordinary scenario approved actions");
  if (approved.length === 0 || approved.length > proposal.actions.length) throw new Error("ordinary scenario approved action scope is invalid");
  let maximumApprovedReservation = BigInt(proposal.baselineActualCostWei);
  for (let index = 0; index < approved.length; index++) {
    const item = record(approved[index], `approved action ${index}`); exactKeys(item, ["id", "commitment"], `approved action ${index}`);
    const scope = proposal.actions[index]!;
    if (item.id !== scope.id || !same(hash(item.commitment, `${scope.id} approved commitment`), scope.commitment)) throw new Error(`ordinary scenario approval action mismatch for ${scope.id}`);
    if (scope.expectedOutcome === "success") maximumApprovedReservation += scope.gasLimitCap * scope.maxFeePerGasCap + nativePrincipal(scope);
  }
  if (maximumApprovedReservation > PHASE_OUTLAY_LIMIT) throw new Error("ordinary scenario approved phase outlay exceeds ceiling");
  const approval = deepFreeze({ approvalHash }); approvalBindings.set(approval, deepFreeze({ proposal, actions: proposal.actions, actionCount: approved.length, maximumApprovedReservation }));
  return approval;
}

function nativePrincipal(action: OrdinaryScenarioActionScope): bigint {
  if (action.id === "native-funding") return 30_000_000_000_001n;
  if (action.asset === "native" && action.expectedOutcome === "success" && (action.kind === "base-transfer" || action.kind === "step-up-transfer" || action.kind === "ready-delay-execution")) {
    if (action.kind === "ready-delay-execution") return action.queue?.value ?? 0n;
    return action.id === "native-base-x" || action.id.startsWith("native-step-up-") ? NATIVE_X : 0n;
  }
  return 0n;
}

export function createOrdinaryScenarioJournal(proposal: OrdinaryScenarioProposal, approval: OrdinaryScenarioApproval, funder: Address): OrdinaryScenarioJournal {
  const binding = approvalBindings.get(approval);
  if (!binding || binding.proposal !== proposal) throw new Error("ordinary scenario journal requires exact validated approval");
  if (!same(funder, proposal.funder)) throw new Error("ordinary scenario journal funder mismatch");
  return { schemaVersion: 1, chainId: proposal.chainId, reviewPackageHash: proposal.reviewPackageHash, proposalHash: proposal.proposalHash, approvalHash: approval.approvalHash, funder, liveJournal: { chainId: proposal.chainId, funder, entries: [] }, actions: [] };
}

function journalMatches(journal: OrdinaryScenarioJournal, proposal: OrdinaryScenarioProposal, approval: OrdinaryScenarioApproval): void {
  if (journal.schemaVersion !== 1 || journal.chainId !== proposal.chainId || !same(journal.reviewPackageHash, proposal.reviewPackageHash) || !same(journal.proposalHash, proposal.proposalHash) || !same(journal.approvalHash, approval.approvalHash) || !same(journal.funder, proposal.funder) || journal.liveJournal.chainId !== proposal.chainId || !same(journal.liveJournal.funder, proposal.funder)) throw new Error("ordinary scenario atomic journal identity mismatch");
}

function controlledState(state: CanonicalOrdinaryScenarioState): ControlledState {
  const queueStatus = state.queue ? ({ queued: "QUEUED_CONDITIONAL", cancelled: "CANCELLED_CONDITIONAL", expired: "EXPIRED_CONDITIONAL", executed: "EXECUTED_CONDITIONAL" } as const)[state.queue.status] : "EMPTY";
  return { safeNativeBalance: state.safeNativeBalance.toString(), funderUsdcBalance: state.funderUsdcBalance.toString(), safeUsdcBalance: state.safeUsdcBalance.toString(), safeNonce: state.safeNonce.toString(), delayQueueNonce: state.delayQueueNonce.toString(), delayTxNonce: state.delayTxNonce.toString(), nativeBaseSpent: state.nativeSpend.baseSpent.toString(), nativeInstantSpent: state.nativeSpend.instantSpent.toString(), usdcBaseSpent: state.usdcSpend.baseSpent.toString(), usdcInstantSpent: state.usdcSpend.instantSpent.toString(), queueStatus, queueNonce: state.queue?.queueNonce.toString() ?? null, queueFingerprint: state.queue?.fingerprint ?? null };
}

function assertControlledState(actual: CanonicalOrdinaryScenarioState, expected: ControlledState, label: string): void {
  if (JSON.stringify(controlledState(actual)) !== JSON.stringify(expected)) throw new Error(`ordinary scenario ${label} controlled state drift`);
}

function assertQueueBinding(action: OrdinaryScenarioActionScope, proposal: OrdinaryScenarioProposal, journal: OrdinaryScenarioJournal, state: CanonicalOrdinaryScenarioState): void {
  if (action.before.queueStatus === "EMPTY") {
    if (state.queue !== undefined) throw new Error("ordinary scenario unexpected queue head");
    return;
  }
  const queue = state.queue;
  if (!queue || action.before.queueNonce === null || action.before.queueFingerprint === null) throw new Error("ordinary scenario required queue head is missing");
  const reviewed = proposal.actions.find((candidate) => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce.toString() === action.before.queueNonce && same(candidate.queue.fingerprint, action.before.queueFingerprint!));
  if (!reviewed?.queue || !same(queue.to, reviewed.queue.to) || queue.value !== reviewed.queue.value || !same(queue.data, reviewed.queue.data) || queue.operation !== reviewed.queue.operation) throw new Error("ordinary scenario queue tuple drift");
  const receiptRecord = [...journal.actions].reverse().find((entry) => entry.id === reviewed.id && entry.status === "confirmed");
  if (!receiptRecord?.queueCreatedAt || queue.createdAt.toString() !== receiptRecord.queueCreatedAt) throw new Error("ordinary scenario queue createdAt is not bound to proposal receipt");
}

function assertFreshState(action: OrdinaryScenarioActionScope, proposal: OrdinaryScenarioProposal, journal: OrdinaryScenarioJournal, state: CanonicalOrdinaryScenarioState, phase: "pre-private" | "pre-outer", requiredNativeWindow?: bigint): void {
  if (state.chainId !== CHAIN_ID || !HASH.test(state.blockHash) || state.blockNumber < 0n || state.blockTimestamp <= 0n) throw new Error("ordinary scenario canonical block is invalid");
  if (action.kind !== "expected-early-rejection") {
    if (state.evidenceBasis.kind !== "current-head") throw new Error("ordinary scenario signing and success actions require current-head evidence");
  } else {
    const basis = state.evidenceBasis;
    if (basis.kind !== "queue-receipt") throw new Error("ordinary scenario early rejection requires queue-receipt evidence");
    const proposalRecord = journal.actions.find((entry) => entry.id === basis.proposalActionId && entry.status === "confirmed");
    const reviewed = proposal.actions.find((entry) => entry.id === basis.proposalActionId && entry.kind === "queue-proposal");
    if (!reviewed?.queue || !action.queue || reviewed.queue.queueNonce !== action.queue.queueNonce || !same(reviewed.queue.fingerprint, action.queue.fingerprint) || !proposalRecord?.receipt || !proposalRecord.transactionHash || !same(proposalRecord.transactionHash, basis.transactionHash) || !same(proposalRecord.receipt.transactionHash, basis.transactionHash) || proposalRecord.receipt.blockNumber !== state.blockNumber || !same(proposalRecord.receipt.blockHash, state.blockHash) || proposalRecord.queueCreatedAt !== state.blockTimestamp.toString()) throw new Error("ordinary scenario queue-receipt evidence does not bind the confirmed proposal archive");
  }
  if (!same(state.planHash, proposal.planHash) || !same(state.topologyEvidenceHash, proposal.topologyEvidenceHash) || !same(state.publicIdentitiesHash, proposal.publicIdentitiesHash)) throw new Error("ordinary scenario topology/runtime/policy drift");
  if (!state.observerReady || !same(state.observerEvidenceHash, proposal.observerEvidenceHash)) throw new Error("ordinary scenario observer is not ready");
  if (requiredNativeWindow !== undefined) {
    const periodAnchor = BigInt(proposal.periodAnchor);
    if (state.blockTimestamp < periodAnchor) throw new Error("ordinary scenario native canonical timestamp precedes period anchor");
    const effectiveWindow = periodAnchor + ((state.blockTimestamp - periodAnchor) / PERIOD_SECONDS) * PERIOD_SECONDS;
    if (state.nativeSpend.window !== requiredNativeWindow || effectiveWindow !== requiredNativeWindow) throw new Error("ordinary scenario native period rollover requires new review");
  }
  assertControlledState(state, action.before, phase);
  assertQueueBinding(action, proposal, journal, state);
  if (!Number.isSafeInteger(state.outerNonce) || state.outerNonce < 0) throw new Error("ordinary scenario current outer nonce is invalid");
  if (state.fees.maxFeePerGas <= 0n || state.fees.maxFeePerGas > action.maxFeePerGasCap || state.fees.maxPriorityFeePerGas < 0n || state.fees.maxPriorityFeePerGas > action.maxPriorityFeePerGasCap || state.fees.maxPriorityFeePerGas > state.fees.maxFeePerGas) throw new Error("ordinary scenario current fees exceed approval");
  for (const dependency of action.dependsOn) {
    const terminal = journal.actions.find((entry) => entry.id === dependency);
    const evidence = state.dependencies.find((entry) => entry.actionId === dependency);
    if (!terminal || (terminal.status !== "confirmed" && terminal.status !== "rejection-proved") || !terminal.evidenceHash || !evidence || !same(evidence.evidenceHash, terminal.evidenceHash) || (terminal.transactionHash && (!evidence.transactionHash || !same(evidence.transactionHash, terminal.transactionHash)))) throw new Error(`ordinary scenario dependency evidence mismatch for ${dependency}`);
  }
  const established = [...journal.actions].reverse().find((entry) => entry.establishedWindow !== undefined && entry.id.startsWith(action.asset === "native" ? "native-" : "usdc-"));
  if (established) {
    const storedWindow = action.asset === "native" ? state.nativeSpend.window : state.usdcSpend.window;
    const periodAnchor = BigInt(proposal.periodAnchor);
    if (state.blockTimestamp < periodAnchor) throw new Error(`ordinary scenario ${action.asset} canonical timestamp precedes period anchor`);
    const effectiveWindow = periodAnchor + ((state.blockTimestamp - periodAnchor) / PERIOD_SECONDS) * PERIOD_SECONDS;
    if (storedWindow.toString() !== established.establishedWindow || effectiveWindow.toString() !== established.establishedWindow) throw new Error(`ordinary scenario ${action.asset} period rollover requires new review`);
  }
}

function approvedRemainingReservation(proposal: OrdinaryScenarioProposal, binding: ApprovalBinding, journal: OrdinaryScenarioJournal): bigint {
  let total = 0n;
  for (let index = 0; index < binding.actionCount; index++) {
    const scope = binding.actions[index]!; if (scope.expectedOutcome !== "success") continue;
    const existing = journal.actions.find((entry) => entry.id === scope.id);
    if (existing?.status === "confirmed" || existing?.status === "reverted") continue;
    if (existing?.status === "outer-pending") {
      const live = journal.liveJournal.entries.find((entry) => entry.id === scope.id); total += live?.reserved ?? (scope.gasLimitCap * scope.maxFeePerGasCap + nativePrincipal(scope));
    } else total += scope.gasLimitCap * scope.maxFeePerGasCap + nativePrincipal(scope);
  }
  return total;
}

function queueTimes(action: OrdinaryScenarioActionScope, proposal: OrdinaryScenarioProposal, journal: OrdinaryScenarioJournal, state: CanonicalOrdinaryScenarioState): { createdAt: bigint; readyAt: bigint; expiresAt: bigint } | undefined {
  if (!action.queue) return undefined;
  const queue = state.queue;
  const requiredStatus = action.kind === "expected-cancelled-rejection" ? "cancelled" : action.kind === "expected-expired-rejection" ? "expired" : "queued";
  if (!queue || queue.status !== requiredStatus || queue.queueNonce !== action.queue.queueNonce || !same(queue.fingerprint, action.queue.fingerprint) || !same(queue.to, action.queue.to) || queue.value !== action.queue.value || !same(queue.data, action.queue.data) || queue.operation !== action.queue.operation) throw new Error("ordinary scenario exact queue head drift");
  const proposalAction = proposal.actions.find((candidate) => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce === queue.queueNonce && same(candidate.queue.fingerprint, queue.fingerprint));
  const proposalRecord = proposalAction && journal.actions.find((entry) => entry.id === proposalAction.id && entry.status === "confirmed");
  if (!proposalRecord?.queueCreatedAt || proposalRecord.queueCreatedAt !== queue.createdAt.toString()) throw new Error("ordinary scenario queue time is not canonical proposal receipt time");
  const createdAt = queue.createdAt; return { createdAt, readyAt: createdAt + COOLDOWN_SECONDS, expiresAt: createdAt + COOLDOWN_SECONDS + EXPIRATION_SECONDS };
}

function timingGate(action: OrdinaryScenarioActionScope, proposal: OrdinaryScenarioProposal, journal: OrdinaryScenarioJournal, state: CanonicalOrdinaryScenarioState): OrdinaryScenarioExecutionResult | undefined {
  if (action.kind === "queue-proposal") return undefined;
  const timing = queueTimes(action, proposal, journal, state); if (!timing) return undefined;
  if (action.kind === "ready-delay-execution") {
    if (state.blockTimestamp < timing.readyAt) return { status: "WAITING", actionId: action.id, nextCanonicalTime: timing.readyAt };
    if (state.blockTimestamp > timing.expiresAt) throw new Error("ordinary scenario ready execution is canonically expired");
  }
  if (action.kind === "queue-expiry" && state.blockTimestamp <= timing.expiresAt) return { status: "WAITING", actionId: action.id, nextCanonicalTime: timing.expiresAt + 1n };
  if (action.kind === "expected-early-rejection" && state.blockTimestamp >= timing.readyAt) throw new Error("ordinary scenario early rejection window elapsed");
  if (action.kind === "expected-cancelled-rejection" && state.queue?.status !== "cancelled") throw new Error("ordinary scenario cancelled rejection lacks canonical cancellation");
  if (action.kind === "expected-expired-rejection" && state.queue?.status !== "expired") throw new Error("ordinary scenario expired rejection lacks canonical expiry");
  return undefined;
}

async function contractSignatureAt(signatures: Uint8Array, slot: number, slots: number): Promise<{ signer: Address; payload: Hex; offset: number; end: number }> {
  const start = slot * 65;
  if (signatures.length < slots * 65 || signatures[start + 64] !== 0) throw new Error("ordinary scenario malformed Safe contract signature");
  const signer = addressWord(signatures, start); const offsetValue = uintWord(signatures, start + 32);
  if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ordinary scenario Safe signature offset overflow");
  const offset = Number(offsetValue);
  if (offset < slots * 65 || offset + 32 > signatures.length) throw new Error("ordinary scenario malformed Safe contract signature offset");
  const lengthValue = uintWord(signatures, offset); if (lengthValue === 0n || lengthValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ordinary scenario empty or oversized Safe contract signature");
  const end = offset + 32 + Number(lengthValue); if (end > signatures.length) throw new Error("ordinary scenario truncated Safe contract signature");
  return { signer, payload: sliceHex(signatures, offset + 32, end), offset, end };
}

async function validateActualSafeSignatures(action: OrdinaryScenarioActionScope, proposal: OrdinaryScenarioProposal, prepared: PreparedOrdinaryAction, signaturesHex: Hex, state: CanonicalOrdinaryScenarioState, context: OrdinaryScenarioExecutionContext): Promise<void> {
  const signatures = bytes(signaturesHex);
  const source = prepared.replaySource ? proposal.actions.find((candidate) => candidate.id === prepared.replaySource!.actionId) : action;
  if (!source) throw new Error("ordinary scenario replay source action is unknown");
  const roles = source.signerRoles;
  const primary = await contractSignatureAt(signatures, 0, roles.includes("safe-contract-secondary") ? 2 : 1);
  if (!same(primary.signer, proposal.primarySigner) || !same(await context.verifyContractSignature(primary.signer, action.safeTxHash!, primary.payload, state.blockNumber), ERC1271_MAGIC)) throw new Error("ordinary scenario primary Safe signature is invalid");
  if (roles.length === 1 && roles[0] === "primary-passkey") {
    if (primary.offset !== 65 || primary.end !== signatures.length) throw new Error("ordinary scenario primary signature layout mismatch");
    return;
  }
  if (roles.includes("safe-contract-secondary")) {
    const secondary = await contractSignatureAt(signatures, 1, 2);
    if (primary.offset !== 130 || secondary.offset !== primary.end || secondary.end !== signatures.length || !same(secondary.signer, proposal.safeContractSecondary) || !same(await context.verifyContractSignature(secondary.signer, action.safeTxHash!, secondary.payload, state.blockNumber), ERC1271_MAGIC)) throw new Error("ordinary scenario safe-contract secondary signature is invalid");
    return;
  }
  if (roles.includes("legacy-ecdsa-secondary")) {
    if (primary.offset !== 65 || signatures.length < primary.end + 64) throw new Error("ordinary scenario ECDSA secondary signature layout mismatch");
    const lengthOffset = signatures.length - 64; const typeOffset = signatures.length - 32; const payloadLength = uintWord(signatures, lengthOffset);
    if (payloadLength === 0n || payloadLength > BigInt(Number.MAX_SAFE_INTEGER) || primary.end + Number(payloadLength) + 64 !== signatures.length || !same(sliceHex(signatures, typeOffset, signatures.length), ECDSA_SECONDARY_SIGNATURE_TYPE_HASH)) throw new Error("ordinary scenario ECDSA secondary envelope mismatch");
    const ecdsaSignature = sliceHex(signatures, primary.end, primary.end + Number(payloadLength));
    const recovered = await recoverAddress({ hash: action.safeTxHash!, signature: ecdsaSignature });
    if (!same(recovered, proposal.ecdsaSecondary)) throw new Error("ordinary scenario ECDSA secondary signer mismatch");
    return;
  }
  throw new Error("ordinary scenario reviewed Safe signer roles are unsupported");
}

async function validatePrepared(action: OrdinaryScenarioActionScope, proposal: OrdinaryScenarioProposal, prepared: PreparedOrdinaryAction, state: CanonicalOrdinaryScenarioState, context: OrdinaryScenarioExecutionContext): Promise<void> {
  const intent = prepared.liveIntent;
  const replay = prepared.replaySource !== undefined;
  if (intent.id !== action.id || (!replay && intent.nonce !== state.outerNonce) || intent.gas <= 0n || intent.gas > action.gasLimitCap || (!replay && intent.maxFeePerGas !== state.fees.maxFeePerGas) || (!replay && intent.maxPriorityFeePerGas !== state.fees.maxPriorityFeePerGas) || intent.maxFeePerGas > action.maxFeePerGasCap || intent.maxPriorityFeePerGas > action.maxPriorityFeePerGasCap || intent.value < 0n || !HASH.test(prepared.requestHash) || !same(prepared.signerRolesHash, publicHash(action.signerRoles)) || !HASH.test(prepared.signedCalldataHash) || (prepared.signatureBundleHash !== null && !HASH.test(prepared.signatureBundleHash)) || !HEX.test(prepared.transientSignedCalldata) || !same(keccak256(prepared.transientSignedCalldata), prepared.signedCalldataHash)) throw new Error("ordinary scenario materialized action exceeds approval");
  if (!same(intent.data, prepared.transientSignedCalldata) || !same(keccak256(intent.data), prepared.signedCalldataHash)) throw new Error("ordinary scenario live intent calldata differs from validated transient calldata");
  if (action.kind === "funding" || action.kind === "controlled-recipient-recycled-funding" || DELAY_SUCCESS_KINDS.has(action.kind)) {
    const expected = action.publicTransaction;
    if (!expected || !intent.to || !same(intent.to, expected.to) || intent.value !== expected.value || !same(intent.data, expected.data)) throw new Error("ordinary scenario materialized public transaction changed");
  }
  if (action.safeTransaction) {
    if (!intent.to || !same(intent.to, proposal.safe) || intent.value !== 0n || !same(prepared.requestHash, action.safeTxHash!)) throw new Error("ordinary scenario Safe outer transaction changed");
    let decoded: ReturnType<typeof decodeFunctionData>;
    try { decoded = decodeFunctionData({ abi: SAFE_ABI, data: prepared.transientSignedCalldata }); } catch { throw new Error("ordinary scenario outer calldata is not Safe execTransaction"); }
    if (decoded.functionName !== "execTransaction") throw new Error("ordinary scenario outer calldata selector mismatch");
    const args = decoded.args as readonly [Address, bigint, Hex, number, bigint, bigint, bigint, Address, Address, Hex]; const reviewed = action.safeTransaction;
    if (!same(args[0], reviewed.to) || args[1] !== reviewed.value || !same(args[2], reviewed.data) || args[3] !== reviewed.operation || args[4] !== reviewed.safeTxGas || args[5] !== reviewed.baseGas || args[6] !== reviewed.gasPrice || !same(args[7], reviewed.gasToken) || !same(args[8], reviewed.refundReceiver)) throw new Error("ordinary scenario decoded Safe tuple drift");
    const recomputed = hashTypedData({ domain: { chainId: CHAIN_ID, verifyingContract: proposal.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { to: args[0], value: args[1], data: args[2], operation: args[3] as 0, safeTxGas: args[4], baseGas: args[5], gasPrice: args[6], gasToken: args[7], refundReceiver: args[8], nonce: reviewed.safeNonce } });
    if (!same(recomputed, reviewed.safeTxHash) || prepared.signatureBundleHash === null || !same(prepared.signatureBundleHash, keccak256(args[9]))) throw new Error("ordinary scenario decoded Safe hash or signature bundle mismatch");
    if (prepared.replaySource && (!same(prepared.replaySource.safeTxHash, reviewed.safeTxHash) || prepared.replaySource.safeNonce !== reviewed.safeNonce)) throw new Error("ordinary scenario replay source digest or nonce mismatch");
    await validateActualSafeSignatures(action, proposal, prepared, args[9], state, context);
  }
}

function expectedEffect(action: OrdinaryScenarioActionScope, proposal: OrdinaryScenarioProposal, effect: ConfirmationEffect): void {
  if (action.id === "native-funding") {
    if (effect.kind !== "native-funding" || !same(effect.to, proposal.safe) || effect.amount !== 30_000_000_000_001n) throw new Error("ordinary scenario native funding receipt effect mismatch");
    return;
  }
  if (action.kind === "funding" || action.kind === "controlled-recipient-recycled-funding") {
    const amount = action.id === "usdc-funding" ? INITIAL_USDC : action.id === "usdc-recycle-topup-step-up" ? RECYCLED_STEP_UP_USDC : RECYCLED_DELAYED_USDC;
    if (effect.kind !== "erc20-funding" || !same(effect.token, proposal.usdc) || !same(effect.from, proposal.funder) || !same(effect.to, proposal.safe) || effect.amount !== amount) throw new Error("ordinary scenario USDC funding receipt effect mismatch");
    return;
  }
  if (SAFE_SUCCESS_KINDS.has(action.kind)) {
    if (effect.kind !== "safe-execution" || !action.safeTxHash || !same(effect.safeTxHash, action.safeTxHash)) throw new Error("ordinary scenario exact Safe ExecutionSuccess mismatch");
    if (action.kind === "queue-proposal" && (!action.queue || effect.queueCreatedAt === undefined || !effect.queueFingerprint || !same(effect.queueFingerprint, action.queue.fingerprint))) throw new Error("ordinary scenario canonical queue receipt mismatch");
    return;
  }
  if (DELAY_SUCCESS_KINDS.has(action.kind)) {
    const lifecycle = action.kind === "queue-expiry" ? "expired" : "executed";
    if (effect.kind !== "delay-lifecycle" || effect.lifecycle !== lifecycle || !action.queue || !same(effect.fingerprint, action.queue.fingerprint)) throw new Error("ordinary scenario exact Delay lifecycle mismatch");
    return;
  }
  throw new Error("ordinary scenario unsupported success effect");
}

function nextAction(binding: ApprovalBinding, journal: OrdinaryScenarioJournal): OrdinaryScenarioActionScope | undefined {
  const approvedIds = new Set(binding.actions.slice(0, binding.actionCount).map(action => action.id));
  const records = journal.actions.filter(entry => approvedIds.has(entry.id));
  for (let index = 0; index < binding.actionCount; index++) {
    const scope = binding.actions[index]!; const existing = records[index];
    if (!existing) return scope;
    if (existing.id !== scope.id || !same(existing.commitment, scope.commitment)) throw new Error("ordinary scenario action journal order mismatch");
    if (existing.status === "confirmed" || existing.status === "rejection-proved") {
      if (!existing.evidenceHash || (existing.status === "confirmed" && !existing.transactionHash)) throw new Error("ordinary scenario terminal journal evidence is incomplete");
      continue;
    }
    if (!["materialized", "signed-simulated", "outer-pending", "reverted", "stopped"].includes(existing.status)) throw new Error("ordinary scenario action journal status mismatch");
    return scope;
  }
  return undefined;
}

async function resumePending(action: OrdinaryScenarioActionScope, proposal: OrdinaryScenarioProposal, journal: OrdinaryScenarioJournal, store: OrdinaryScenarioStore, context: OrdinaryScenarioExecutionContext, recordEntry: OrdinaryScenarioActionRecord): Promise<OrdinaryScenarioExecutionResult> {
  if (!recordEntry.transactionHash || !recordEntry.intentHash || recordEntry.outerNonce === undefined || !recordEntry.gas || !recordEntry.maxFeePerGas || !recordEntry.maxPriorityFeePerGas || !recordEntry.outerDataHash || !recordEntry.outerValue) throw new Error("ordinary scenario pending record is incomplete");
  const intent = await context.recoverPending(action, recordEntry);
  if (intent.nonce !== recordEntry.outerNonce || intent.gas.toString() !== recordEntry.gas || intent.maxFeePerGas.toString() !== recordEntry.maxFeePerGas || intent.maxPriorityFeePerGas.toString() !== recordEntry.maxPriorityFeePerGas || intent.value.toString() !== recordEntry.outerValue || !same(keccak256(intent.data), recordEntry.outerDataHash) || !same(liveIntentHash(intent, proposal.funder), recordEntry.intentHash)) throw new Error("ordinary scenario recovered pending envelope mismatch");
  const live: LiveContext = { ...context.live, verify: async () => { throw new Error("pending action cannot request a new outer signature"); }, persist: async (updated) => { journal.liveJournal = updated; store.save(journal); } };
  const entry = await submitLiveIntent(intent, journal.liveJournal, live);
  if (entry.status === "pending") return { status: "PENDING", actionId: action.id };
  recordEntry.receipt = entry.receipt;
  if (entry.status === "reverted") { recordEntry.status = "reverted"; recordEntry.evidenceHash = publicHash(entry.receipt); store.save(journal); return { status: "REVERTED", actionId: action.id }; }
  if (!entry.receipt) throw new Error("ordinary scenario successful receipt is missing");
  const confirmation = await context.confirm(action, entry, recordEntry);
  assertControlledState(confirmation.postState, action.after, "post-receipt"); expectedEffect(action, proposal, confirmation.effect);
  if (confirmation.postState.blockNumber !== entry.receipt.blockNumber || !same(confirmation.postState.blockHash, entry.receipt.blockHash)) throw new Error("ordinary scenario poststate is not pinned to canonical receipt");
  const poststateBasis = confirmation.postState.evidenceBasis;
  if (poststateBasis.kind !== "receipt-poststate" || poststateBasis.actionId !== action.id || !same(poststateBasis.transactionHash, entry.receipt.transactionHash) || poststateBasis.blockNumber !== entry.receipt.blockNumber || !same(poststateBasis.blockHash, entry.receipt.blockHash)) throw new Error("ordinary scenario confirmation requires exact receipt-poststate evidence basis");
  const alertProducing = action.kind === "step-up-transfer" || action.kind === "queue-proposal" || action.kind === "queue-cancellation" || action.kind === "queue-expiry" || action.kind === "ready-delay-execution";
  if (alertProducing ? confirmation.observerEvidenceHash === null || !HASH.test(confirmation.observerEvidenceHash) : confirmation.observerEvidenceHash !== null) throw new Error("ordinary scenario confirmation observer evidence mismatch");
  if (action.kind === "queue-proposal") {
    if (confirmation.effect.kind !== "safe-execution" || confirmation.effect.queueCreatedAt === undefined || !action.queue || !confirmation.postState.queue || confirmation.postState.queue.status !== "queued" || !same(confirmation.postState.queue.to, action.queue.to) || confirmation.postState.queue.value !== action.queue.value || !same(confirmation.postState.queue.data, action.queue.data) || confirmation.postState.queue.operation !== action.queue.operation || confirmation.effect.queueCreatedAt !== confirmation.postState.blockTimestamp || confirmation.postState.queue.createdAt !== confirmation.postState.blockTimestamp) throw new Error("ordinary scenario queue tuple/createdAt must equal canonical proposal receipt block");
  } else if (DELAY_SUCCESS_KINDS.has(action.kind)) {
    if (confirmation.effect.kind !== "delay-lifecycle" || !confirmation.postState.queue || confirmation.effect.createdAt !== confirmation.postState.queue.createdAt) throw new Error("ordinary scenario Delay lifecycle createdAt mismatch");
  }
  recordEntry.status = "confirmed"; recordEntry.evidenceHash = publicHash({ receipt: entry.receipt, effect: confirmation.effect, poststate: controlledState(confirmation.postState), basis: poststateBasis, observerEvidenceHash: confirmation.observerEvidenceHash });
  if (confirmation.effect.kind === "safe-execution" && confirmation.effect.queueCreatedAt !== undefined) recordEntry.queueCreatedAt = confirmation.effect.queueCreatedAt.toString();
  if (action.kind === "base-transfer") {
    const anchor = BigInt(proposal.periodAnchor);
    if (confirmation.postState.blockTimestamp < anchor) throw new Error("ordinary scenario first base transfer predates period anchor");
    const derived = anchor + ((confirmation.postState.blockTimestamp - anchor) / PERIOD_SECONDS) * PERIOD_SECONDS;
    const actual = action.asset === "native" ? confirmation.postState.nativeSpend.window : confirmation.postState.usdcSpend.window;
    if (actual !== derived) throw new Error("ordinary scenario first base transfer window derivation mismatch");
    recordEntry.establishedWindow = derived.toString();
  }
  const gasCost = entry.receipt.gasUsed * entry.receipt.effectiveGasPrice; const principalDelta = action.id === "native-funding" ? -30_000_000_000_001n : action.asset === "native" && (action.kind === "base-transfer" || action.kind === "step-up-transfer" || action.kind === "ready-delay-execution") ? nativePrincipal(action) : 0n;
  const before = BigInt(recordEntry.funderNativeBefore ?? "0"); const after = confirmation.postState.funderNativeBalance; const external = after - before - principalDelta + gasCost;
  recordEntry.funderNativeAfter = after.toString(); recordEntry.ourPrincipalDelta = principalDelta.toString(); recordEntry.ourReceiptGasCost = gasCost.toString(); recordEntry.externalFunderDelta = external.toString(); recordEntry.externalFunderDeltaClassification = "unrelated/shared-funder activity";
  store.save(journal); return { status: "CONFIRMED", actionId: action.id };
}

export async function executeOrdinaryScenarioAction(proposal: OrdinaryScenarioProposal, approval: OrdinaryScenarioApproval | undefined, store: OrdinaryScenarioStore, context: OrdinaryScenarioExecutionContext): Promise<OrdinaryScenarioExecutionResult> {
  if (!approval) throw new Error("ordinary scenario requires explicit group approval");
  const binding = approvalBindings.get(approval);
  if (!binding || binding.proposal !== proposal) throw new Error("ordinary scenario requires exact opaque validated approval");
  return executeResolvedOrdinaryScenarioAction(proposal, binding, store, context, journal => journalMatches(journal, proposal, approval));
}

async function executeResolvedOrdinaryScenarioAction(proposal: OrdinaryScenarioProposal, binding: ApprovalBinding, store: OrdinaryScenarioStore, context: OrdinaryScenarioExecutionContext, validateJournal: (journal: OrdinaryScenarioJournal) => void, continuationReservation?: string, requiredNativeWindow?: bigint): Promise<OrdinaryScenarioExecutionResult> {
  const journal = store.load(); validateJournal(journal);
  const action = nextAction(binding, journal); if (!action) return { status: "COMPLETE" };
  const existing = journal.actions.find((entry) => entry.id === action.id);
  if (existing?.status === "reverted") return { status: "REVERTED", actionId: action.id };
  if (existing?.status === "stopped" || existing?.status === "materialized" || existing?.status === "signed-simulated") throw new Error("ordinary scenario interrupted before durable outer hash; approved attempt is stopped");
  if (existing?.status === "outer-pending") return resumePending(action, proposal, journal, store, context, existing);
  if (journal.liveJournal.entries.some((entry) => entry.status === "pending")) throw new Error("ordinary scenario must reconcile pending hash before materializing another action");
  const state = await context.readState(action, "pre-private"); assertFreshState(action, proposal, journal, state, "pre-private", requiredNativeWindow);
  const wait = timingGate(action, proposal, journal, state); if (wait) return wait;
  const remaining = approvedRemainingReservation(proposal, binding, journal);
  if (BigInt(proposal.baselineActualCostWei) + remaining > PHASE_OUTLAY_LIMIT) throw new Error("ordinary scenario package phase accounting exceeds approval");
  if (state.funderNativeBalance < remaining) throw new Error("ordinary scenario shared funder cannot cover current and outstanding approved reservations");
  const recordEntry: OrdinaryScenarioActionRecord = { id: action.id, commitment: action.commitment, status: "materialized", materializationHash: publicHash({ action: action.commitment, outerNonce: state.outerNonce, fees: state.fees, blockNumber: state.blockNumber.toString(), blockHash: state.blockHash }), prestateHash: publicHash({ controlled: controlledState(state), dependencies: state.dependencies, queue: state.queue }), outerNonce: state.outerNonce, maxFeePerGas: state.fees.maxFeePerGas.toString(), maxPriorityFeePerGas: state.fees.maxPriorityFeePerGas.toString(), funderNativeBefore: state.funderNativeBalance.toString() };
  journal.actions.push(recordEntry); store.save(journal);
  if (action.expectedOutcome === "rejection") {
    let prepared: PreparedOrdinaryAction | undefined;
    if (action.kind === "expected-replay-rejection") {
      const sourceId = action.dependsOn[0]; const source = sourceId === undefined ? undefined : journal.actions.find((entry) => entry.id === sourceId && entry.status === "confirmed");
      if (!source?.transactionHash) throw new Error("ordinary scenario replay source receipt is unavailable");
      prepared = await context.recoverReplay(action, source, state);
      if (!prepared.replaySource || prepared.replaySource.actionId !== source.id) throw new Error("ordinary scenario replay did not recover the canonical source envelope");
      const rawOuter = prepared.transientSignedOuterTransaction;
      if (!rawOuter || !/^0x02[0-9a-f]+$/i.test(rawOuter)) throw new Error("ordinary scenario replay signed outer transaction is missing");
      let outer: ReturnType<typeof parseTransaction>; let sender: Address;
      try { outer = parseTransaction(rawOuter); sender = await recoverTransactionAddress({ serializedTransaction: rawOuter as `0x02${string}` }); } catch { throw new Error("ordinary scenario replay signed outer transaction is malformed"); }
      if (!same(keccak256(rawOuter), source.transactionHash) || !same(sender, proposal.funder) || outer.type !== "eip1559" || outer.chainId !== CHAIN_ID || source.outerNonce === undefined || !source.gas || !source.maxFeePerGas || !source.maxPriorityFeePerGas || !source.outerTo || !source.outerValue || !source.outerDataHash || outer.nonce !== source.outerNonce || outer.gas?.toString() !== source.gas || outer.maxFeePerGas?.toString() !== source.maxFeePerGas || outer.maxPriorityFeePerGas?.toString() !== source.maxPriorityFeePerGas || !outer.to || !same(outer.to, source.outerTo) || (outer.value ?? 0n).toString() !== source.outerValue || !same(keccak256(outer.data ?? "0x"), source.outerDataHash)) throw new Error("ordinary scenario replay signed outer transaction does not match the confirmed source");
      if (prepared.liveIntent.nonce !== source.outerNonce || prepared.liveIntent.gas.toString() !== source.gas || prepared.liveIntent.maxFeePerGas.toString() !== source.maxFeePerGas || prepared.liveIntent.maxPriorityFeePerGas.toString() !== source.maxPriorityFeePerGas || !prepared.liveIntent.to || !same(prepared.liveIntent.to, source.outerTo) || prepared.liveIntent.value.toString() !== source.outerValue || !same(keccak256(prepared.liveIntent.data), source.outerDataHash)) throw new Error("ordinary scenario replay source envelope mismatch");
      recordEntry.transactionHash = source.transactionHash;
    } else if (!PUBLIC_REJECTION_KINDS.has(action.kind)) prepared = await context.materialize(action, state);
    if (prepared) {
      await validatePrepared(action, proposal, prepared, state, context);
      recordEntry.requestHash = prepared.requestHash; recordEntry.signatureBundleHash = prepared.signatureBundleHash; recordEntry.signedCalldataHash = prepared.signedCalldataHash; recordEntry.outerDataHash = keccak256(prepared.liveIntent.data);
      if (prepared.replaySource) recordEntry.outerNonce = prepared.liveIntent.nonce;
      store.save(journal);
    }
    const evidence = await context.proveRejection(action, state, prepared);
    if (evidence.success !== false || evidence.blockNumber !== state.blockNumber || !same(evidence.blockHash, state.blockHash) || !HASH.test(evidence.revertDataHash)) throw new Error("ordinary scenario expected rejection evidence is missing");
    assertControlledState(evidence.postState, action.before, "rejection unchanged");
    if (evidence.postState.blockNumber !== state.blockNumber || !same(evidence.postState.blockHash, state.blockHash) || JSON.stringify(evidence.postState.evidenceBasis) !== JSON.stringify(state.evidenceBasis)) throw new Error("ordinary scenario rejection evidence is not canonical");
    const basis = state.evidenceBasis.kind === "queue-receipt" ? "queue-receipt-block" : "current-head";
    recordEntry.status = "rejection-proved"; recordEntry.evidenceHash = sha256({ basis, blockNumber: evidence.blockNumber.toString(), blockHash: evidence.blockHash, revertDataHash: evidence.revertDataHash, state: controlledState(evidence.postState) }) as Hex; store.save(journal);
    return { status: "REJECTION_PROVED", actionId: action.id };
  }
  const prepared = await context.materialize(action, state); await validatePrepared(action, proposal, prepared, state, context);
  const simulation = await context.simulate(action, prepared, state);
  if (!simulation.success || simulation.blockNumber !== state.blockNumber || !same(simulation.blockHash, state.blockHash) || simulation.gasEstimate <= 0n || simulation.gasEstimate > prepared.liveIntent.gas || simulation.gasEstimate > action.gasLimitCap || !HASH.test(simulation.resultHash)) throw new Error("ordinary scenario exact signed simulation failed or exceeded cap");
  if (continuationReservation !== undefined) {
    const facts = { proposalHash: proposal.proposalHash, actionCommitment: action.commitment, outerNonce: prepared.liveIntent.nonce, gas: prepared.liveIntent.gas.toString(), gasEstimate: simulation.gasEstimate.toString(), maxFeePerGas: prepared.liveIntent.maxFeePerGas.toString(), maxPriorityFeePerGas: prepared.liveIntent.maxPriorityFeePerGas.toString(), pinnedBlockNumber: state.blockNumber.toString(), pinnedBlockHash: state.blockHash, approvedContinuationReservationWei: continuationReservation, remainingReservationWei: remaining.toString() };
    recordEntry.finalOuterMaterialization = Object.freeze({ hash: publicHash(facts), ...facts });
  }
  recordEntry.status = "signed-simulated"; recordEntry.requestHash = prepared.requestHash; recordEntry.signatureBundleHash = prepared.signatureBundleHash; recordEntry.signedCalldataHash = prepared.signedCalldataHash; recordEntry.simulationEvidenceHash = sha256({ ...simulation, blockNumber: simulation.blockNumber.toString(), gasEstimate: simulation.gasEstimate.toString() }) as Hex; recordEntry.gas = prepared.liveIntent.gas.toString(); recordEntry.outerTo = prepared.liveIntent.to; recordEntry.outerValue = prepared.liveIntent.value.toString(); recordEntry.outerDataHash = keccak256(prepared.liveIntent.data); store.save(journal);
  const live: LiveContext = {
    ...context.live,
    verify: async () => {
      const fresh = await context.readState(action, "pre-outer"); assertFreshState(action, proposal, journal, fresh, "pre-outer", requiredNativeWindow);
      if (fresh.outerNonce !== prepared.liveIntent.nonce || fresh.fees.maxFeePerGas !== prepared.liveIntent.maxFeePerGas || fresh.fees.maxPriorityFeePerGas !== prepared.liveIntent.maxPriorityFeePerGas || fresh.funderNativeBalance < approvedRemainingReservation(proposal, binding, journal)) throw new Error("ordinary scenario outer signing preflight drift");
    },
    persist: async (updated) => {
      journal.liveJournal = updated; const entry = updated.entries.find((value) => value.id === action.id);
      if (entry) { recordEntry.status = "outer-pending"; recordEntry.intentHash = entry.intentHash; recordEntry.transactionHash = entry.transactionHash; }
      store.save(journal);
    },
  };
  const entry = await submitLiveIntent(prepared.liveIntent, journal.liveJournal, live);
  if (entry.status !== "pending") throw new Error("ordinary scenario new submission returned unexpected terminal state");
  return { status: "PENDING", actionId: action.id };
}

export async function executeExpiredHashlessContinuationAction(original: OrdinaryScenarioProposal, continuation: ExpiredHashlessContinuationProposal, approval: ExpiredHashlessContinuationApproval | undefined, store: OrdinaryScenarioStore, context: OrdinaryScenarioExecutionContext): Promise<OrdinaryScenarioExecutionResult> {
  if (!approval) throw new Error("expired hashless continuation explicit approval is required");
  assertExpiredHashlessContinuationAuthorization(continuation, approval);
  const view = createExpiredHashlessContinuationExecutionView(original, continuation, approval);
  const sourceStore: OrdinaryScenarioStore = {
    load: () => {
      const source = store.load();
      assertHashlessContinuationJournal(source, original, continuation, approval);
      const progressed = source.hashlessContinuation!.actions.filter((entry): entry is OrdinaryScenarioActionRecord => entry.status !== "approved");
      return structuredClone({ ...source, actions: [...source.actions.slice(0, 18), ...progressed] });
    },
    save: projected => {
      const source = store.load();
      assertHashlessContinuationJournal(source, original, continuation, approval);
      const progressed = new Map(projected.actions.slice(18).map(entry => [entry.id, entry]));
      for (const prior of source.hashlessContinuation!.actions) {
        if (prior.status === "approved") continue;
        const next = progressed.get(prior.id); if (!next) throw new Error("hashless continuation projected progress cannot be removed or reset");
        for (const [key, value] of Object.entries(prior)) if (key !== "status" && key !== "receipt" && JSON.stringify((next as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value)) throw new Error(`hashless continuation projected fixed field ${key} changed or was deleted`);
        const transitions: Record<string, readonly string[]> = { materialized: ["materialized", "signed-simulated", "rejection-proved", "stopped"], "signed-simulated": ["signed-simulated", "outer-pending", "stopped"], "outer-pending": ["outer-pending", "confirmed", "reverted"], confirmed: ["confirmed"], reverted: ["reverted"], "rejection-proved": ["rejection-proved"], stopped: ["stopped"] };
        if (!transitions[prior.status]?.includes(next.status) || (prior.receipt !== undefined && publicHash(prior.receipt) !== publicHash(next.receipt))) throw new Error("hashless continuation projected progress regressed");
      }
      source.hashlessContinuation!.actions.splice(0, source.hashlessContinuation!.actions.length, ...continuation.actions.map(action => progressed.get(action.id) ?? { id: action.id, commitment: action.commitment, status: "approved" as const }));
      source.liveJournal = projected.liveJournal;
      assertHashlessContinuationJournal(source, original, continuation, approval);
      store.save(source);
    },
  };
  const proposal = { ...view.proposal, baselineActualCostWei: (BigInt(continuation.reservation.originalActualGasCostWei) + BigInt(continuation.reservation.originalPrincipalWei)).toString() };
  const binding: ApprovalBinding = { proposal, actions: continuation.actions.map(continuationScope), actionCount: continuation.actions.length, maximumApprovedReservation: BigInt(continuation.reservation.maximumCumulativeOutlayWei) };
  const guardedContext: OrdinaryScenarioExecutionContext = { ...context, readState: async (action, phase) => { const state = await context.readState(action, phase); if (state.outerNonce <= 809) throw new Error("continuation outer nonce must be greater than historical nonce 809"); return state; } };
  return executeResolvedOrdinaryScenarioAction(proposal, binding, sourceStore, guardedContext, journal => {
    if (journal.actions.some(entry => entry.id === "native-queue-ready-execute")) throw new Error("immutable hashless source row is not executable");
  }, continuation.reservation.continuationMaximumReservationWei, 1_793_145_600n);
}

function assertHashlessContinuationJournal(journal: OrdinaryScenarioJournal, original: OrdinaryScenarioProposal, continuation: ExpiredHashlessContinuationProposal, approval: ExpiredHashlessContinuationApproval): void {
  const attached = journal.hashlessContinuation;
  if (!attached || journal.actions.length !== 19 || journal.liveJournal.entries.length < 10 || hashHistoricalPrefix(journal) !== continuation.historicalPrefixHash) throw new Error("hashless continuation historical 19/10 prefix mismatch");
  if (journal.proposalHash !== original.proposalHash || journal.approvalHash !== continuation.source.originalApprovalHash || journal.approvalHash === approval.approvalHash || attached.historicalActionCount !== 19 || attached.historicalLiveEntryCount !== 10 || attached.historicalPrefixHash !== continuation.historicalPrefixHash || attached.originalProposalHash !== continuation.originalProposalHash || attached.certificateHash !== continuation.certificateHash || attached.proposalHash !== continuation.proposalHash || attached.approvalHash !== approval.approvalHash || attached.cumulativeContinuationReservationWei !== continuation.reservation.continuationMaximumReservationWei || publicHash(attached.source) !== publicHash(continuation.source) || attached.actions.length !== 22 || attached.actionCommitments.length !== 22) throw new Error("hashless continuation journal authority mismatch");
  for (let index = 0; index < continuation.actions.length; index++) {
    const expected = continuation.actions[index]!; const actual = attached.actions[index]!;
    if (actual.id !== expected.id || actual.commitment !== expected.commitment) throw new Error("hashless continuation action lineage mismatch");
    if (actual.status !== "approved" && actual.finalOuterMaterialization) {
      const final = actual.finalOuterMaterialization;
      if (final.proposalHash !== continuation.proposalHash || final.actionCommitment !== expected.commitment || final.outerNonce !== actual.outerNonce || final.gas !== actual.gas || final.maxFeePerGas !== actual.maxFeePerGas || final.maxPriorityFeePerGas !== actual.maxPriorityFeePerGas || BigInt(final.gas) > BigInt(expected.gasLimitCap) || BigInt(final.maxFeePerGas) > BigInt(expected.maxFeePerGasCap) || BigInt(final.maxPriorityFeePerGas) > BigInt(expected.maxPriorityFeePerGasCap) || final.approvedContinuationReservationWei !== continuation.reservation.continuationMaximumReservationWei) throw new Error("hashless continuation final outer materialization binding mismatch");
    }
    if (actual.status !== "approved" && expected.expectedOutcome === "success" && actual.status !== "materialized" && !actual.finalOuterMaterialization) throw new Error("hashless continuation final outer materialization is missing");
  }
}

function encodeJournal(journal: OrdinaryScenarioJournal): string {
  return `${JSON.stringify(journal, (_, value) => typeof value === "bigint" ? value.toString() : value)}\n`;
}

function decodeReceipt(value: unknown): LiveReceipt | undefined {
  if (value === undefined) return undefined; const receipt = record(value, "scenario receipt");
  exactKeys(receipt, ["transactionHash", "status", "gasUsed", "effectiveGasPrice", "blockNumber", "blockHash"], "scenario receipt");
  return { transactionHash: hash(receipt.transactionHash, "receipt transaction hash"), status: receipt.status === "success" || receipt.status === "reverted" ? receipt.status : (() => { throw new Error("scenario receipt status mismatch"); })(), gasUsed: decimal(receipt.gasUsed, "receipt gas used"), effectiveGasPrice: decimal(receipt.effectiveGasPrice, "receipt effective gas price"), blockNumber: decimal(receipt.blockNumber, "receipt block number"), blockHash: hash(receipt.blockHash, "receipt block hash") };
}

function decodeFinalOuterMaterialization(value: unknown): OrdinaryScenarioActionRecord["finalOuterMaterialization"] {
  if (value === undefined) return undefined;
  const item = record(value, "final outer materialization");
  exactKeys(item, ["hash", "proposalHash", "actionCommitment", "outerNonce", "gas", "gasEstimate", "maxFeePerGas", "maxPriorityFeePerGas", "pinnedBlockNumber", "pinnedBlockHash", "approvedContinuationReservationWei", "remainingReservationWei"], "final outer materialization");
  if (typeof item.outerNonce !== "number" || !Number.isSafeInteger(item.outerNonce) || item.outerNonce <= 809) throw new Error("final outer nonce must be a safe integer greater than 809");
  const facts = {
    proposalHash: hash(item.proposalHash, "final proposal hash"), actionCommitment: hash(item.actionCommitment, "final action commitment"),
    outerNonce: item.outerNonce, gas: decimal(item.gas, "final gas").toString(), gasEstimate: decimal(item.gasEstimate, "final gas estimate").toString(),
    maxFeePerGas: decimal(item.maxFeePerGas, "final max fee").toString(), maxPriorityFeePerGas: decimal(item.maxPriorityFeePerGas, "final priority fee").toString(),
    pinnedBlockNumber: decimal(item.pinnedBlockNumber, "final pinned block").toString(), pinnedBlockHash: hash(item.pinnedBlockHash, "final pinned block hash"),
    approvedContinuationReservationWei: decimal(item.approvedContinuationReservationWei, "final approved reservation").toString(), remainingReservationWei: decimal(item.remainingReservationWei, "final remaining reservation").toString(),
  };
  if (BigInt(facts.gas) <= 0n || BigInt(facts.gasEstimate) <= 0n || BigInt(facts.gasEstimate) > BigInt(facts.gas) || BigInt(facts.maxFeePerGas) <= 0n || BigInt(facts.maxPriorityFeePerGas) > BigInt(facts.maxFeePerGas)) throw new Error("final outer materialization bounds are invalid");
  const expected = publicHash(facts); if (!same(hash(item.hash, "final outer materialization hash"), expected)) throw new Error("final outer materialization hash mismatch");
  return { hash: expected, ...facts };
}

function decodeJournal(serialized: string, identity: Readonly<{ proposalHash: Hex; approvalHash: Hex; funder: Address }>, domain: OrdinaryScenarioProposalDomain): OrdinaryScenarioJournal {
  assertOrdinaryDomain(domain);
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("ordinary scenario journal must be JSON"); }
  const value = record(parsed, "ordinary scenario journal");
  exactKeys(value, ["schemaVersion", "chainId", "reviewPackageHash", "proposalHash", "approvalHash", "funder", "liveJournal", "actions", ...(value.repairContinuation === undefined ? [] : ["repairContinuation"]), ...(value.hashlessContinuation === undefined ? [] : ["hashlessContinuation"])], "ordinary scenario journal");
  const live = record(value.liveJournal, "embedded live journal");
  exactKeys(live, ["chainId", "funder", "entries"], "embedded live journal");
  if (value.schemaVersion !== 1 || value.chainId !== domain.chainId || live.chainId !== domain.chainId) throw new Error("ordinary scenario persisted journal chain mismatch");
  const entries = array(live.entries, "embedded live entries").map((raw, index) => {
    const entry = record(raw, `embedded live entry ${index}`); const receipt = decodeReceipt(entry.receipt);
    exactKeys(entry, receipt ? ["id", "intentHash", "transactionHash", "nonce", "reserved", "status", "receipt"] : ["id", "intentHash", "transactionHash", "nonce", "reserved", "status"], `embedded live entry ${index}`);
    const status = entry.status; if (status !== "pending" && status !== "success" && status !== "reverted") throw new Error("embedded live entry status mismatch");
    return { id: text(entry.id, "live entry id"), intentHash: hash(entry.intentHash, "live entry intent hash"), transactionHash: hash(entry.transactionHash, "live entry transaction hash"), nonce: Number(decimal(String(entry.nonce), "live entry nonce")), reserved: decimal(entry.reserved, "live entry reservation"), status, receipt } as JournalEntry;
  });
  const actions = array(value.actions, "scenario action records").map((raw, index) => {
    const entry = record(raw, `scenario action record ${index}`) as OrdinaryScenarioActionRecord;
    if (typeof entry.id !== "string" || !HASH.test(String(entry.commitment))) throw new Error("scenario action record identity mismatch");
    if (!["materialized", "signed-simulated", "outer-pending", "confirmed", "rejection-proved", "reverted", "stopped"].includes(entry.status)) throw new Error("scenario action record status mismatch");
    const allowed = new Set(["id", "commitment", "status", "materializationHash", "finalOuterMaterialization", "prestateHash", "outerNonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "requestHash", "signatureBundleHash", "signedCalldataHash", "simulationEvidenceHash", "intentHash", "transactionHash", "outerTo", "outerValue", "outerDataHash", "evidenceHash", "receipt", "queueCreatedAt", "establishedWindow", "funderNativeBefore", "funderNativeAfter", "ourPrincipalDelta", "ourReceiptGasCost", "externalFunderDelta", "externalFunderDeltaClassification"]);
    if (Object.keys(entry).some((key) => !allowed.has(key))) throw new Error("scenario action record has unknown fields");
    if (entry.receipt) entry.receipt = decodeReceipt(entry.receipt);
    if (entry.finalOuterMaterialization !== undefined) entry.finalOuterMaterialization = decodeFinalOuterMaterialization(entry.finalOuterMaterialization);
    return entry;
  });
  let repairContinuation: OrdinaryScenarioJournal["repairContinuation"];
  if (value.repairContinuation !== undefined) {
    const repair = record(value.repairContinuation, "repair continuation");
    const optional = ["creationApprovalHash", "groupProposalHash", "groupApprovalHash"].filter(key => repair[key] !== undefined);
    exactKeys(repair, ["schemaVersion", "prefixHash", "originalActionCount", "cumulativeActualCostWei", "creationProposalHash", "actions", ...optional], "repair continuation");
    const repairActions: NonNullable<OrdinaryScenarioJournal["repairContinuation"]>["actions"] = array(repair.actions, "repair continuation actions").map((raw, index) => {
      const action = record(raw, `repair continuation action ${index}`); const optionalAction = ["transactionHash", "evidenceHash"].filter(key => action[key] !== undefined);
      exactKeys(action, ["id", "commitment", "status", ...optionalAction], `repair continuation action ${index}`);
      const status = action.status; if (status !== "proposed" && status !== "approved" && status !== "pending" && status !== "confirmed" && status !== "rejection-proved" && status !== "stopped") throw new Error("repair continuation action status mismatch");
      return { id: text(action.id, "repair continuation action id"), commitment: hash(action.commitment, "repair continuation commitment"), status: status as "proposed" | "approved" | "pending" | "confirmed" | "rejection-proved" | "stopped", transactionHash: action.transactionHash === undefined ? undefined : hash(action.transactionHash, "repair continuation transaction hash"), evidenceHash: action.evidenceHash === undefined ? undefined : hash(action.evidenceHash, "repair continuation evidence hash") };
    });
    const repairIds = [...EXCLUDED_IDS];
    if (repair.schemaVersion !== 1 || decimal(String(repair.originalActionCount), "repair continuation prefix count") !== 38n || repairActions.length > 7 || repairActions.some((entry, index) => entry.id !== repairIds[index])) throw new Error("repair continuation header mismatch");
    repairContinuation = { schemaVersion: 1, prefixHash: hash(repair.prefixHash, "repair continuation prefix hash"), originalActionCount: 38, cumulativeActualCostWei: decimal(repair.cumulativeActualCostWei, "repair continuation cumulative cost").toString(), creationProposalHash: hash(repair.creationProposalHash, "repair creation proposal hash"), creationApprovalHash: repair.creationApprovalHash === undefined ? undefined : hash(repair.creationApprovalHash, "repair creation approval hash"), groupProposalHash: repair.groupProposalHash === undefined ? undefined : hash(repair.groupProposalHash, "repair group proposal hash"), groupApprovalHash: repair.groupApprovalHash === undefined ? undefined : hash(repair.groupApprovalHash, "repair group approval hash"), actions: repairActions };
  }
  let hashlessContinuation: HashlessContinuationStorage | undefined;
  if (value.hashlessContinuation !== undefined) {
    const continuation = record(value.hashlessContinuation, "hashless continuation");
    exactKeys(continuation, ["schemaVersion", "recoveryKind", "source", "historicalActionCount", "historicalLiveEntryCount", "historicalPrefixHash", "originalProposalHash", "certificateHash", "proposalHash", "approvalHash", "actionCommitments", "cumulativeContinuationReservationWei", "actions"], "hashless continuation");
    if (continuation.schemaVersion !== 1 || continuation.recoveryKind !== "FIRST38_NATIVE_READY_HASHLESS_EXPIRED_V1" || continuation.historicalActionCount !== 19 || continuation.historicalLiveEntryCount !== 10) throw new Error("hashless continuation header mismatch");
    const source = record(continuation.source, "hashless continuation source");
    exactKeys(source, ["originalReviewPackageHash", "originalProposalHash", "originalReviewArtifactBytesHash", "originalApprovalHash", "historicalActionCount", "historicalLiveEntryCount", "historicalPrefixHash", "stoppedRow"], "hashless continuation source");
    const stopped = record(source.stoppedRow, "hashless continuation stopped row");
    exactKeys(stopped, ["id", "commitment", "materializationHash", "prestateHash", "requestHash", "signatureBundleHash", "signedCalldataHash", "simulationEvidenceHash", "outerDataHash", "outerNonce"], "hashless continuation stopped row");
    if (source.historicalActionCount !== 19 || source.historicalLiveEntryCount !== 10 || stopped.id !== "native-queue-ready-execute" || stopped.signatureBundleHash !== null || stopped.outerNonce !== 809) throw new Error("hashless continuation source constants mismatch");
    for (const key of ["originalReviewPackageHash", "originalProposalHash", "originalReviewArtifactBytesHash", "originalApprovalHash", "historicalPrefixHash"] as const) hash(source[key], `hashless source ${key}`);
    for (const key of ["commitment", "materializationHash", "prestateHash", "requestHash", "signedCalldataHash", "simulationEvidenceHash", "outerDataHash"] as const) hash(stopped[key], `hashless stopped ${key}`);
    const commitments = array(continuation.actionCommitments, "hashless commitments").map((raw, index) => { const item = record(raw, `hashless commitment ${index}`); exactKeys(item, ["id", "commitment"], `hashless commitment ${index}`); return { id: text(item.id, "hashless commitment id"), commitment: hash(item.commitment, "hashless commitment") }; });
    const continuationActions = array(continuation.actions, "hashless actions").map((raw, index) => {
      const rawItem = record(raw, `hashless action ${index}`);
      if (typeof rawItem.id !== "string" || !HASH.test(String(rawItem.commitment))) throw new Error("hashless action identity mismatch");
      if (rawItem.status === "approved") { exactKeys(rawItem, ["id", "commitment", "status"], `hashless action ${index}`); return rawItem as unknown as Readonly<{ id: string; commitment: Hex; status: "approved" }>; }
      const item = rawItem as unknown as OrdinaryScenarioActionRecord;
      if (!["materialized", "signed-simulated", "outer-pending", "confirmed", "rejection-proved", "reverted", "stopped"].includes(item.status)) throw new Error("hashless action status mismatch");
      const allowed = new Set(["id", "commitment", "status", "materializationHash", "finalOuterMaterialization", "prestateHash", "outerNonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "requestHash", "signatureBundleHash", "signedCalldataHash", "simulationEvidenceHash", "intentHash", "transactionHash", "outerTo", "outerValue", "outerDataHash", "evidenceHash", "receipt", "queueCreatedAt", "establishedWindow", "funderNativeBefore", "funderNativeAfter", "ourPrincipalDelta", "ourReceiptGasCost", "externalFunderDelta", "externalFunderDeltaClassification"]);
      if (Object.keys(item).some(key => !allowed.has(key))) throw new Error("hashless action has unknown fields");
      for (const key of ["materializationHash", "prestateHash", "requestHash", "signedCalldataHash", "simulationEvidenceHash", "intentHash", "transactionHash", "outerDataHash", "evidenceHash"] as const) if (item[key] !== undefined) hash(item[key], `hashless action ${key}`);
      if (item.signatureBundleHash !== undefined && item.signatureBundleHash !== null) hash(item.signatureBundleHash, "hashless action signature bundle hash");
      for (const key of ["gas", "maxFeePerGas", "maxPriorityFeePerGas", "outerValue", "queueCreatedAt", "establishedWindow", "funderNativeBefore", "funderNativeAfter", "ourPrincipalDelta", "ourReceiptGasCost"] as const) if (item[key] !== undefined) decimal(item[key], `hashless action ${key}`);
      if (item.externalFunderDelta !== undefined && (typeof item.externalFunderDelta !== "string" || !SIGNED_DECIMAL.test(item.externalFunderDelta))) throw new Error("hashless action externalFunderDelta must be a canonical signed decimal string");
      if (item.outerNonce !== undefined && (!Number.isSafeInteger(item.outerNonce) || item.outerNonce <= 809)) throw new Error("hashless action outer nonce is invalid");
      if (item.outerTo !== undefined) address(item.outerTo, "hashless action outer target");
      if (item.externalFunderDeltaClassification !== undefined && item.externalFunderDeltaClassification !== "unrelated/shared-funder activity") throw new Error("hashless action external funder classification mismatch");
      if (item.receipt) item.receipt = decodeReceipt(item.receipt);
      if (item.finalOuterMaterialization !== undefined) item.finalOuterMaterialization = decodeFinalOuterMaterialization(item.finalOuterMaterialization);
      return item;
    });
    if (continuation.schemaVersion !== 1 || continuation.recoveryKind !== "FIRST38_NATIVE_READY_HASHLESS_EXPIRED_V1" || continuation.historicalActionCount !== 19 || continuation.historicalLiveEntryCount !== 10 || commitments.length !== 22 || continuationActions.length !== 22 || commitments.some((entry, index) => entry.id !== continuationActions[index]!.id || entry.commitment !== continuationActions[index]!.commitment)) throw new Error("hashless continuation header or catalog mismatch");
    hashlessContinuation = { schemaVersion: 1, recoveryKind: "FIRST38_NATIVE_READY_HASHLESS_EXPIRED_V1", source: continuation.source as HashlessContinuationStorage["source"], historicalActionCount: 19, historicalLiveEntryCount: 10, historicalPrefixHash: hash(continuation.historicalPrefixHash, "hashless prefix hash"), originalProposalHash: hash(continuation.originalProposalHash, "hashless original proposal hash"), certificateHash: hash(continuation.certificateHash, "hashless certificate hash"), proposalHash: hash(continuation.proposalHash, "hashless proposal hash"), approvalHash: hash(continuation.approvalHash, "hashless approval hash"), actionCommitments: commitments, cumulativeContinuationReservationWei: decimal(continuation.cumulativeContinuationReservationWei, "hashless reservation").toString(), actions: continuationActions };
  }
  if (repairContinuation !== undefined && hashlessContinuation !== undefined) throw new Error("hashless and repair continuation coexistence is unsupported");
  const journal: OrdinaryScenarioJournal = { schemaVersion: 1, chainId: domain.chainId, reviewPackageHash: hash(value.reviewPackageHash, "journal package hash"), proposalHash: hash(value.proposalHash, "journal proposal hash"), approvalHash: hash(value.approvalHash, "journal approval hash"), funder: address(value.funder, "journal funder"), liveJournal: { chainId: domain.chainId, funder: address(live.funder, "embedded funder"), entries }, actions, repairContinuation, hashlessContinuation };
  if (hashlessContinuation && (actions.length !== 19 || entries.length < 10 || !same(hashHistoricalPrefix(journal), APPROVED_HASHLESS_PREFIX))) throw new Error("hashless continuation fixed historical prefix mismatch");
  if (!same(journal.proposalHash, identity.proposalHash) || !same(journal.approvalHash, identity.approvalHash) || !same(journal.funder, identity.funder)) throw new Error("ordinary scenario persisted journal identity mismatch");
  return journal;
}

/** One lock and one fsynced replacement own both coordinator state and the embedded LiveJournal. */
export function createOrdinaryScenarioStore(path: string, identity: Readonly<{ proposalHash: Hex; approvalHash: Hex; funder: Address }>, initial: () => OrdinaryScenarioJournal, domain: OrdinaryScenarioProposalDomain = PRODUCTION_ORDINARY_SCENARIO_DOMAIN): OrdinaryScenarioStore {
  assertOrdinaryDomain(domain);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPrefix = `${basename(path)}.`;
  if (readdirSync(dirname(path)).some(name => name.startsWith(temporaryPrefix) && name.endsWith(".tmp"))) throw new Error("ordinary scenario unresolved temporary journal exists");
  const lockPath = `${path}.lock`; let lock: number | undefined;
  try { lock = openSync(lockPath, "wx", 0o600); writeFileSync(lock, `${process.pid}\n`, "utf8"); fsyncSync(lock); } catch { throw new Error("ordinary scenario writer lock unavailable"); }
  const canonical = (journal: OrdinaryScenarioJournal): OrdinaryScenarioJournal => decodeJournal(encodeJournal(journal), identity, domain);
  let current: OrdinaryScenarioJournal;
  try { current = existsSync(path) ? decodeJournal(readFileSync(path, "utf8"), identity, domain) : canonical(initial()); }
  catch (error) { if (lock !== undefined) closeSync(lock); lock = undefined; unlinkSync(lockPath); throw error; }
  if (current.chainId !== domain.chainId || current.liveJournal.chainId !== domain.chainId) { closeSync(lock); lock = undefined; unlinkSync(lockPath); throw new Error("ordinary scenario initial journal chain mismatch"); }
  const assertFixedPrefix = (journal: OrdinaryScenarioJournal): void => { if (journal.hashlessContinuation && (journal.actions.length !== 19 || journal.liveJournal.entries.length < 10 || !same(hashHistoricalPrefix(journal), APPROVED_HASHLESS_PREFIX))) throw new Error("hashless continuation fixed historical prefix mismatch"); };
  assertFixedPrefix(current);
  const assertFixedFields = (prior: Record<string, unknown>, next: Record<string, unknown>, mutable: ReadonlySet<string>, label: string): void => {
    for (const [key, value] of Object.entries(prior)) if (!mutable.has(key) && JSON.stringify(next[key]) !== JSON.stringify(value)) throw new Error(`${label} fixed field ${key} changed or was deleted`);
  };
  const actionTransitions: Record<string, ReadonlySet<string>> = {
    approved: new Set(["approved", "materialized"]), materialized: new Set(["materialized", "signed-simulated", "rejection-proved", "stopped"]),
    "signed-simulated": new Set(["signed-simulated", "outer-pending", "stopped"]), "outer-pending": new Set(["outer-pending", "confirmed", "reverted"]),
    confirmed: new Set(["confirmed"]), reverted: new Set(["reverted"]), "rejection-proved": new Set(["rejection-proved"]), stopped: new Set(["stopped"]),
  };
  const assertActionProgress = (prior: { id: string; commitment: Hex; status: string } & Record<string, unknown>, next: { id: string; commitment: Hex; status: string } & Record<string, unknown>, label: string): void => {
    if (prior.id !== next.id || prior.commitment !== next.commitment || !actionTransitions[prior.status]?.has(next.status)) throw new Error(`${label} action removal, reordering, identity drift, or status regression`);
    assertFixedFields(prior, next, new Set(["status", "receipt"]), label);
    if (prior.receipt !== undefined && publicHash(prior.receipt) !== publicHash(next.receipt)) throw new Error(`${label} receipt changed or was deleted`);
  };
  const assertMonotonic = (prior: OrdinaryScenarioJournal, next: OrdinaryScenarioJournal): void => {
    if (next.actions.length < prior.actions.length) throw new Error("ordinary scenario action history was truncated");
    prior.actions.forEach((entry, index) => assertActionProgress(entry as typeof entry & Record<string, unknown>, next.actions[index] as typeof entry & Record<string, unknown>, "ordinary scenario"));
    if (next.liveJournal.entries.length < prior.liveJournal.entries.length) throw new Error("ordinary scenario live journal was truncated");
    prior.liveJournal.entries.forEach((entry, index) => {
      const candidate = next.liveJournal.entries[index]; if (!candidate || candidate.id !== entry.id || candidate.intentHash !== entry.intentHash || candidate.transactionHash !== entry.transactionHash || candidate.nonce !== entry.nonce) throw new Error("ordinary scenario live entry was removed or reordered");
      const allowed = entry.status === "pending" ? new Set(["pending", "success", "reverted"]) : new Set([entry.status]); if (!allowed.has(candidate.status)) throw new Error("ordinary scenario live entry status regressed");
      if ((entry.status !== "pending" || candidate.status === "pending") && entry.reserved !== candidate.reserved) throw new Error("ordinary scenario live reservation changed outside pending reconciliation");
      if (candidate.status !== "pending" && candidate.receipt === undefined) throw new Error("ordinary scenario terminal live entry is missing its receipt");
      if (entry.receipt !== undefined && publicHash(entry.receipt) !== publicHash(candidate.receipt)) throw new Error("ordinary scenario live receipt changed or was deleted");
    });
    if (prior.hashlessContinuation) {
      if (!next.hashlessContinuation) throw new Error("hashless continuation cannot be deleted");
      const { actions: priorActions, ...priorHeader } = prior.hashlessContinuation; const { actions: nextActions, ...nextHeader } = next.hashlessContinuation;
      if (JSON.stringify(priorHeader) !== JSON.stringify(nextHeader) || nextActions.length !== priorActions.length) throw new Error("hashless continuation immutable header or catalog changed");
      priorActions.forEach((entry, index) => assertActionProgress(entry as typeof entry & Record<string, unknown>, nextActions[index] as typeof entry & Record<string, unknown>, "hashless continuation"));
    }
  };
  const save = (journal: OrdinaryScenarioJournal): void => {
    if (lock === undefined) throw new Error("ordinary scenario writer lock is closed");
    if (journal.chainId !== domain.chainId || journal.liveJournal.chainId !== domain.chainId || !same(journal.proposalHash, identity.proposalHash) || !same(journal.approvalHash, identity.approvalHash) || !same(journal.funder, identity.funder)) throw new Error("ordinary scenario store identity mismatch");
    assertFixedPrefix(journal);
    const candidate = canonical(journal); assertMonotonic(current, candidate);
    const temporary = `${path}.${process.pid}.tmp`; const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, encodeJournal(candidate), "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path); const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
    current = candidate;
  };
  const close = (): void => { if (lock === undefined) return; closeSync(lock); lock = undefined; unlinkSync(lockPath); };
  return Object.freeze({ load: () => { assertFixedPrefix(current); return canonical(current); }, save, close });
}
