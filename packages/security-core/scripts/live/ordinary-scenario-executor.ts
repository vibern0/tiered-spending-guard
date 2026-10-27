import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isAddress, keccak256, type Address, type Hex } from "viem";
import { sha256 } from "../plan-deployment";
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
const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
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
export type QueueState = Readonly<{ queueNonce: bigint; fingerprint: Hex; createdAt: bigint; status: "queued" | "cancelled" | "expired" | "executed" }>;
export type DependencyEvidence = Readonly<{ actionId: string; transactionHash?: Hex; blockHash?: Hex; evidenceHash: Hex }>;

export type CanonicalOrdinaryScenarioState = Readonly<{
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestamp: bigint;
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
}>;

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
  publicTransaction?: Readonly<{ to: Address; value: bigint; data: Hex }>;
  queue?: Readonly<{ queueNonce: bigint; fingerprint: Hex; monitoringFingerprint: Hex; to: Address; value: bigint; data: Hex; operation: 0 }>;
}>;

export type OrdinaryScenarioProposal = Readonly<{
  schemaVersion: 1;
  authorization: "NONE";
  chainId: 11155111;
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
type ApprovalBinding = Readonly<{ proposal: OrdinaryScenarioProposal; actionCount: number; maximumApprovedReservation: bigint }>;
const approvalBindings = new WeakMap<object, ApprovalBinding>();

export type OrdinaryScenarioActionStatus = "materialized" | "signed-simulated" | "outer-pending" | "confirmed" | "rejection-proved" | "reverted" | "stopped";
export type OrdinaryScenarioActionRecord = {
  id: string;
  commitment: Hex;
  status: OrdinaryScenarioActionStatus;
  materializationHash?: Hex;
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
  chainId: 11155111;
  reviewPackageHash: Hex;
  proposalHash: Hex;
  approvalHash: Hex;
  funder: Address;
  liveJournal: LiveJournal;
  actions: OrdinaryScenarioActionRecord[];
};

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
}>;
export type SignedSimulationEvidence = Readonly<{ blockNumber: bigint; blockHash: Hex; success: boolean; gasEstimate: bigint; resultHash: Hex }>;
export type RejectionEvidence = Readonly<{ blockNumber: bigint; blockHash: Hex; success: false; revertDataHash: Hex; postState: CanonicalOrdinaryScenarioState }>;
export type ConfirmationEffect =
  | Readonly<{ kind: "native-funding"; to: Address; amount: bigint }>
  | Readonly<{ kind: "erc20-funding"; token: Address; from: Address; to: Address; amount: bigint }>
  | Readonly<{ kind: "safe-execution"; safeTxHash: Hex; queueCreatedAt?: bigint; queueFingerprint?: Hex }>
  | Readonly<{ kind: "delay-lifecycle"; lifecycle: "expired" | "executed"; fingerprint: Hex; createdAt: bigint }>;
export type ConfirmationEvidence = Readonly<{ postState: CanonicalOrdinaryScenarioState; effect: ConfirmationEffect }>;

export type OrdinaryScenarioExecutionContext = Readonly<{
  readState(action: OrdinaryScenarioActionScope, phase: "pre-private" | "pre-outer"): Promise<CanonicalOrdinaryScenarioState>;
  materialize(action: OrdinaryScenarioActionScope, state: CanonicalOrdinaryScenarioState): Promise<PreparedOrdinaryAction>;
  simulate(action: OrdinaryScenarioActionScope, prepared: PreparedOrdinaryAction, state: CanonicalOrdinaryScenarioState): Promise<SignedSimulationEvidence>;
  proveRejection(action: OrdinaryScenarioActionScope, state: CanonicalOrdinaryScenarioState, prepared?: PreparedOrdinaryAction): Promise<RejectionEvidence>;
  recoverPending(action: OrdinaryScenarioActionScope, record: OrdinaryScenarioActionRecord): Promise<LiveIntent>;
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
  return deepFreeze({
    safeNativeBalance: decimal(principal[side === "before" ? "nativeSafeBefore" : "nativeSafeAfter"], "safe native balance").toString(),
    funderUsdcBalance: decimal(principal[side === "before" ? "usdcFunderBefore" : "usdcFunderAfter"], "funder USDC balance").toString(),
    safeUsdcBalance: decimal(principal[side === "before" ? "usdcSafeBefore" : "usdcSafeAfter"], "Safe USDC balance").toString(),
    safeNonce: decimal(nonces.safe, "Safe nonce").toString(),
    delayQueueNonce: delayQueueNonce.toString(), delayTxNonce: delayTxNonce.toString(),
    nativeBaseSpent: decimal(native.baseSpent, "native base spent").toString(), nativeInstantSpent: decimal(native.instantSpent, "native instant spent").toString(),
    usdcBaseSpent: decimal(usdcState.baseSpent, "USDC base spent").toString(), usdcInstantSpent: decimal(usdcState.instantSpent, "USDC instant spent").toString(),
  });
}

function validateActionShape(value: unknown, index: number): Record<string, unknown> {
  const action = record(value, `action ${index}`);
  const keys = ["id", "kind", "asset", "dependsOn", "status", "expectedOutcome", "signerRoles", "proposedGasAndFee", "expectedTransition", "expectedState", "observerAlert"];
  for (const optional of ["safeTransaction", "publicTransaction", "queue", "timing"]) if (action[optional] !== undefined) keys.push(optional);
  exactKeys(action, keys, `action ${index}`);
  return action;
}

function snapshotAction(action: Record<string, unknown>, index: number, queueBefore: bigint, txBefore: bigint): { scope: OrdinaryScenarioActionScope; queueAfter: bigint; txAfter: bigint } {
  const id = text(action.id, `action ${index} id`); const kind = text(action.kind, `${id} kind`);
  if (!ALLOWED_IDS.has(id) || !SUPPORTED_KINDS.has(kind)) throw new Error(`ordinary scenario contains unknown action ${id}`);
  if (action.status !== "CONDITIONAL_NOT_RUN") throw new Error(`supported action ${id} is not reviewable`);
  const expectedOutcome = action.expectedOutcome;
  if (expectedOutcome !== (REJECTION_KINDS.has(kind) ? "rejection" : "success")) throw new Error(`${id} expected outcome mismatch`);
  const asset = action.asset;
  if (asset !== "native" && asset !== "USDC" && asset !== "control") throw new Error(`${id} asset mismatch`);
  const dependsOn = array(action.dependsOn, `${id} dependencies`).map((entry, dependency) => text(entry, `${id} dependency ${dependency}`));
  const signerRoles = array(action.signerRoles, `${id} signer roles`).map((entry, role) => text(entry, `${id} signer role ${role}`));
  const caps = record(action.proposedGasAndFee, `${id} caps`);
  exactKeys(caps, ["gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "liveEstimated", "preSendEstimateRequired"], `${id} caps`);
  const gasLimitCap = decimal(caps.gasLimit, `${id} gas cap`); const maxFeePerGasCap = decimal(caps.maxFeePerGas, `${id} max fee cap`); const maxPriorityFeePerGasCap = decimal(caps.maxPriorityFeePerGas, `${id} priority fee cap`);
  if (gasLimitCap <= 0n || maxFeePerGasCap <= 0n || maxPriorityFeePerGasCap > maxFeePerGasCap || caps.liveEstimated !== false || caps.preSendEstimateRequired !== true) throw new Error(`${id} gas and fee caps are invalid`);
  let safeTxHash: Hex | undefined; let publicTransaction: OrdinaryScenarioActionScope["publicTransaction"];
  if (action.safeTransaction !== undefined) {
    const transaction = record(action.safeTransaction, `${id} Safe transaction`);
    exactKeys(transaction, ["to", "value", "data", "operation", "safeNonce", "safeTxHash", "safeTxGas", "baseGas", "gasPrice", "gasToken", "refundReceiver"], `${id} Safe transaction`);
    if (transaction.operation !== 0 || decimal(transaction.safeTxGas, `${id} safeTxGas`) !== 0n || decimal(transaction.baseGas, `${id} baseGas`) !== 0n || decimal(transaction.gasPrice, `${id} gasPrice`) !== 0n || !same(address(transaction.gasToken, `${id} gas token`), ZERO) || !same(address(transaction.refundReceiver, `${id} refund receiver`), ZERO)) throw new Error(`${id} Safe refund or operation fields are not fixed`);
    address(transaction.to, `${id} Safe target`); decimal(transaction.value, `${id} Safe value`); hex(transaction.data, `${id} Safe calldata`); decimal(transaction.safeNonce, `${id} Safe nonce`); safeTxHash = hash(transaction.safeTxHash, `${id} Safe hash`);
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
  return { scope: deepFreeze({ id, kind, asset, expectedOutcome: expectedOutcome as "success" | "rejection", signerRoles, dependsOn, commitment: sha256(action) as Hex, gasLimitCap, maxFeePerGasCap, maxPriorityFeePerGasCap, before, after, safeTxHash, publicTransaction, queue }), queueAfter, txAfter };
}

export function createOrdinaryScenarioProposal(serializedReview: string, expected: Readonly<{ expectedPackageHash: Hex; expectedArtifactBytesHash: Hex }>): OrdinaryScenarioProposal {
  if (!HASH.test(expected.expectedPackageHash) || !HASH.test(expected.expectedArtifactBytesHash)) throw new Error("ordinary scenario expected review hashes are invalid");
  if (Buffer.byteLength(serializedReview, "utf8") > 4_000_000) throw new Error("ordinary scenario review artifact is too large");
  if (!same(rawSha256(serializedReview), expected.expectedArtifactBytesHash)) throw new Error("ordinary scenario review artifact bytes hash mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(serializedReview); } catch { throw new Error("ordinary scenario review artifact must be JSON"); }
  const report = record(parsed, "ordinary scenario review");
  exactKeys(report, ["schemaVersion", "status", "authorization", "chainId", "planHash", "topologyEvidenceHash", "baselineEvidenceHash", "snapshot", "publicIdentities", "requiredInventory", "blockers", "actions", "phaseAccounting", "finalRevalidation", "signed", "broadcast", "liveEstimated"], "ordinary scenario review");
  if (!same(sha256(report), expected.expectedPackageHash)) throw new Error("ordinary scenario review package hash mismatch");
  if (report.schemaVersion !== 1 || report.authorization !== "NONE" || report.chainId !== "11155111" || (report.status !== "BLOCKED" && report.status !== "READY_FOR_HUMAN_REVIEW") || report.signed !== false || report.broadcast !== false || report.liveEstimated !== false) throw new Error("ordinary scenario review boundary mismatch");
  const reportPlanHash = hash(report.planHash, "ordinary scenario plan hash"); const topologyEvidenceHash = hash(report.topologyEvidenceHash, "ordinary scenario topology hash"); const baselineEvidenceHash = hash(report.baselineEvidenceHash, "ordinary scenario baseline hash");
  const identities = record(report.publicIdentities, "ordinary scenario public identities");
  exactKeys(identities, ["safe", "guard", "delay", "maintenance", "signers", "runtimeCodeHashes", "observer", "repair"], "ordinary scenario public identities");
  const snapshot = record(report.snapshot, "ordinary scenario snapshot"); const balances = record(snapshot.balances, "ordinary scenario balances"); const funderBalance = record(balances.funder, "ordinary scenario funder balance");
  exactKeys(snapshot, ["blockNumber", "blockHash", "blockTimestamp", "safeNonce", "funderNonce", "delayNonce", "balances", "counters", "token"], "ordinary scenario snapshot");
  exactKeys(balances, ["funder", "safe", "recipient"], "ordinary scenario balances");
  for (const name of ["funder", "safe", "recipient"] as const) exactKeys(record(balances[name], `ordinary scenario ${name} balance`), ["address", "nativeWei", "usdcUnits"], `ordinary scenario ${name} balance`);
  const safeAddress = address(identities.safe, "ordinary scenario Safe"); const guardAddress = address(identities.guard, "ordinary scenario guard"); const delayAddress = address(identities.delay, "ordinary scenario Delay"); const funderAddress = address(identities.funder ?? funderBalance.address, "ordinary scenario funder");
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
    const snap = snapshotAction(current, index, queueNonce, txNonce);
    if (snap.scope.dependsOn.some((dependency) => !seen.has(dependency))) throw new Error(`${id} dependency is missing or out of order`);
    seen.add(id); actions.push(snap.scope); queueNonce = snap.queueAfter; txNonce = snap.txAfter;
  }
  if (actions.length === 0 || !excluded) throw new Error("ordinary scenario exact pre-repair predecessor prefix is incomplete");
  const base = {
    schemaVersion: 1 as const, authorization: "NONE" as const, chainId: CHAIN_ID as 11155111,
    reviewPackageHash: expected.expectedPackageHash, reviewArtifactBytesHash: expected.expectedArtifactBytesHash, planHash: reportPlanHash,
    topologyEvidenceHash, baselineEvidenceHash, publicIdentitiesHash, observerEvidenceHash, safe: safeAddress, guard: guardAddress, delay: delayAddress, funder: funderAddress, usdc: usdcAddress,
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
  if (document.schemaVersion !== 1 || document.scope !== "bounded-ordinary-matrix-v1" || document.authorization !== "EXPLICIT_GROUP_APPROVAL" || document.chainId !== CHAIN_ID || document.maxBroadcastAttempts !== 1 || !same(text(document.proposalHash, "approval proposal hash"), proposal.proposalHash) || !same(text(document.reviewPackageHash, "approval package hash"), proposal.reviewPackageHash) || !same(text(document.reviewArtifactBytesHash, "approval bytes hash"), proposal.reviewArtifactBytesHash) || !same(text(document.planHash, "approval plan hash"), proposal.planHash) || decimal(document.phaseLimitWei, "approval phase ceiling") !== PHASE_OUTLAY_LIMIT) throw new Error("ordinary scenario approval binding mismatch");
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
  const approval = deepFreeze({ approvalHash }); approvalBindings.set(approval, deepFreeze({ proposal, actionCount: approved.length, maximumApprovedReservation }));
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
  return { schemaVersion: 1, chainId: CHAIN_ID, reviewPackageHash: proposal.reviewPackageHash, proposalHash: proposal.proposalHash, approvalHash: approval.approvalHash, funder, liveJournal: { chainId: CHAIN_ID, funder, entries: [] }, actions: [] };
}

function journalMatches(journal: OrdinaryScenarioJournal, proposal: OrdinaryScenarioProposal, approval: OrdinaryScenarioApproval): void {
  if (journal.schemaVersion !== 1 || journal.chainId !== CHAIN_ID || !same(journal.reviewPackageHash, proposal.reviewPackageHash) || !same(journal.proposalHash, proposal.proposalHash) || !same(journal.approvalHash, approval.approvalHash) || !same(journal.funder, proposal.funder) || journal.liveJournal.chainId !== CHAIN_ID || !same(journal.liveJournal.funder, proposal.funder)) throw new Error("ordinary scenario atomic journal identity mismatch");
}

function controlledState(state: CanonicalOrdinaryScenarioState): ControlledState {
  return { safeNativeBalance: state.safeNativeBalance.toString(), funderUsdcBalance: state.funderUsdcBalance.toString(), safeUsdcBalance: state.safeUsdcBalance.toString(), safeNonce: state.safeNonce.toString(), delayQueueNonce: state.delayQueueNonce.toString(), delayTxNonce: state.delayTxNonce.toString(), nativeBaseSpent: state.nativeSpend.baseSpent.toString(), nativeInstantSpent: state.nativeSpend.instantSpent.toString(), usdcBaseSpent: state.usdcSpend.baseSpent.toString(), usdcInstantSpent: state.usdcSpend.instantSpent.toString() };
}

function assertControlledState(actual: CanonicalOrdinaryScenarioState, expected: ControlledState, label: string): void {
  if (JSON.stringify(controlledState(actual)) !== JSON.stringify(expected)) throw new Error(`ordinary scenario ${label} controlled state drift`);
}

function assertFreshState(action: OrdinaryScenarioActionScope, proposal: OrdinaryScenarioProposal, journal: OrdinaryScenarioJournal, state: CanonicalOrdinaryScenarioState, phase: "pre-private" | "pre-outer"): void {
  if (state.chainId !== CHAIN_ID || !HASH.test(state.blockHash) || state.blockNumber < 0n || state.blockTimestamp <= 0n) throw new Error("ordinary scenario canonical block is invalid");
  if (!same(state.planHash, proposal.planHash) || !same(state.topologyEvidenceHash, proposal.topologyEvidenceHash) || !same(state.publicIdentitiesHash, proposal.publicIdentitiesHash)) throw new Error("ordinary scenario topology/runtime/policy drift");
  if (!state.observerReady || !same(state.observerEvidenceHash, proposal.observerEvidenceHash)) throw new Error("ordinary scenario observer is not ready");
  assertControlledState(state, action.before, phase);
  if (!Number.isSafeInteger(state.outerNonce) || state.outerNonce < 0) throw new Error("ordinary scenario current outer nonce is invalid");
  if (state.fees.maxFeePerGas <= 0n || state.fees.maxFeePerGas > action.maxFeePerGasCap || state.fees.maxPriorityFeePerGas < 0n || state.fees.maxPriorityFeePerGas > action.maxPriorityFeePerGasCap || state.fees.maxPriorityFeePerGas > state.fees.maxFeePerGas) throw new Error("ordinary scenario current fees exceed approval");
  for (const dependency of action.dependsOn) {
    const terminal = journal.actions.find((entry) => entry.id === dependency);
    const evidence = state.dependencies.find((entry) => entry.actionId === dependency);
    if (!terminal || (terminal.status !== "confirmed" && terminal.status !== "rejection-proved") || !terminal.evidenceHash || !evidence || !same(evidence.evidenceHash, terminal.evidenceHash) || (terminal.transactionHash && (!evidence.transactionHash || !same(evidence.transactionHash, terminal.transactionHash)))) throw new Error(`ordinary scenario dependency evidence mismatch for ${dependency}`);
  }
  const established = [...journal.actions].reverse().find((entry) => entry.establishedWindow !== undefined && entry.id.startsWith(action.asset === "native" ? "native-" : "usdc-"));
  if (established) {
    const currentWindow = action.asset === "native" ? state.nativeSpend.window : state.usdcSpend.window;
    if (currentWindow.toString() !== established.establishedWindow) throw new Error(`ordinary scenario ${action.asset} period rollover requires new review`);
  }
}

function approvedRemainingReservation(proposal: OrdinaryScenarioProposal, binding: ApprovalBinding, journal: OrdinaryScenarioJournal): bigint {
  let total = 0n;
  for (let index = 0; index < binding.actionCount; index++) {
    const scope = proposal.actions[index]!; if (scope.expectedOutcome !== "success") continue;
    const existing = journal.actions.find((entry) => entry.id === scope.id);
    if (existing?.status === "confirmed" || existing?.status === "reverted") continue;
    if (existing?.status === "outer-pending") {
      const live = journal.liveJournal.entries.find((entry) => entry.id === scope.id); total += live?.reserved ?? (scope.gasLimitCap * scope.maxFeePerGasCap + nativePrincipal(scope));
    } else total += scope.gasLimitCap * scope.maxFeePerGasCap + nativePrincipal(scope);
  }
  return total;
}

function queueTimes(action: OrdinaryScenarioActionScope, state: CanonicalOrdinaryScenarioState): { createdAt: bigint; readyAt: bigint; expiresAt: bigint } | undefined {
  if (!action.queue) return undefined;
  const queue = state.queue;
  if (!queue || queue.queueNonce !== action.queue.queueNonce || !same(queue.fingerprint, action.queue.fingerprint)) throw new Error("ordinary scenario exact queue state drift");
  const createdAt = queue.createdAt; return { createdAt, readyAt: createdAt + COOLDOWN_SECONDS, expiresAt: createdAt + COOLDOWN_SECONDS + EXPIRATION_SECONDS };
}

function timingGate(action: OrdinaryScenarioActionScope, state: CanonicalOrdinaryScenarioState): OrdinaryScenarioExecutionResult | undefined {
  const timing = queueTimes(action, state); if (!timing) return undefined;
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

function validatePrepared(action: OrdinaryScenarioActionScope, proposal: OrdinaryScenarioProposal, prepared: PreparedOrdinaryAction, state: CanonicalOrdinaryScenarioState): void {
  const intent = prepared.liveIntent;
  if (intent.id !== action.id || intent.nonce !== state.outerNonce || intent.gas <= 0n || intent.gas > action.gasLimitCap || intent.maxFeePerGas !== state.fees.maxFeePerGas || intent.maxPriorityFeePerGas !== state.fees.maxPriorityFeePerGas || intent.value < 0n || !HASH.test(prepared.requestHash) || !same(prepared.signerRolesHash, publicHash(action.signerRoles)) || !HASH.test(prepared.signedCalldataHash) || (prepared.signatureBundleHash !== null && !HASH.test(prepared.signatureBundleHash)) || !HEX.test(prepared.transientSignedCalldata) || !same(keccak256(prepared.transientSignedCalldata), prepared.signedCalldataHash)) throw new Error("ordinary scenario materialized action exceeds approval");
  if (action.kind === "funding" || action.kind === "controlled-recipient-recycled-funding" || DELAY_SUCCESS_KINDS.has(action.kind)) {
    const expected = action.publicTransaction;
    if (!expected || !intent.to || !same(intent.to, expected.to) || intent.value !== expected.value || !same(intent.data, expected.data)) throw new Error("ordinary scenario materialized public transaction changed");
  }
  if (action.safeTxHash && (!intent.to || !same(intent.to, proposal.safe) || intent.value !== 0n || !same(prepared.requestHash, action.safeTxHash))) throw new Error("ordinary scenario Safe outer transaction changed");
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
  for (let index = 0; index < binding.actionCount; index++) {
    const scope = binding.proposal.actions[index]!; const existing = journal.actions[index];
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
  recordEntry.status = "confirmed"; recordEntry.evidenceHash = publicHash({ receipt: entry.receipt, effect: confirmation.effect, poststate: controlledState(confirmation.postState) });
  if (confirmation.effect.kind === "safe-execution" && confirmation.effect.queueCreatedAt !== undefined) recordEntry.queueCreatedAt = confirmation.effect.queueCreatedAt.toString();
  if (action.kind === "base-transfer") {
    const derived = (confirmation.postState.blockTimestamp - BigInt(proposal.periodAnchor)) / PERIOD_SECONDS;
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
  const journal = store.load(); journalMatches(journal, proposal, approval);
  const action = nextAction(binding, journal); if (!action) return { status: "COMPLETE" };
  const existing = journal.actions.find((entry) => entry.id === action.id);
  if (existing?.status === "reverted") return { status: "REVERTED", actionId: action.id };
  if (existing?.status === "stopped" || existing?.status === "materialized" || existing?.status === "signed-simulated") throw new Error("ordinary scenario interrupted before durable outer hash; approved attempt is stopped");
  if (existing?.status === "outer-pending") return resumePending(action, proposal, journal, store, context, existing);
  if (journal.liveJournal.entries.some((entry) => entry.status === "pending")) throw new Error("ordinary scenario must reconcile pending hash before materializing another action");
  const state = await context.readState(action, "pre-private"); assertFreshState(action, proposal, journal, state, "pre-private");
  const wait = timingGate(action, state); if (wait) return wait;
  const remaining = approvedRemainingReservation(proposal, binding, journal);
  if (BigInt(proposal.baselineActualCostWei) + remaining > PHASE_OUTLAY_LIMIT) throw new Error("ordinary scenario package phase accounting exceeds approval");
  if (state.funderNativeBalance < remaining) throw new Error("ordinary scenario shared funder cannot cover current and outstanding approved reservations");
  const recordEntry: OrdinaryScenarioActionRecord = { id: action.id, commitment: action.commitment, status: "materialized", materializationHash: publicHash({ action: action.commitment, outerNonce: state.outerNonce, fees: state.fees, blockNumber: state.blockNumber.toString(), blockHash: state.blockHash }), prestateHash: publicHash({ controlled: controlledState(state), dependencies: state.dependencies, queue: state.queue }), outerNonce: state.outerNonce, maxFeePerGas: state.fees.maxFeePerGas.toString(), maxPriorityFeePerGas: state.fees.maxPriorityFeePerGas.toString(), funderNativeBefore: state.funderNativeBalance.toString() };
  journal.actions.push(recordEntry); store.save(journal);
  if (action.expectedOutcome === "rejection") {
    const prepared = PUBLIC_REJECTION_KINDS.has(action.kind) || action.kind === "expected-replay-rejection" ? undefined : await context.materialize(action, state);
    if (prepared) validatePrepared(action, proposal, prepared, state);
    const evidence = await context.proveRejection(action, state, prepared);
    if (evidence.success !== false || evidence.blockNumber !== state.blockNumber || !same(evidence.blockHash, state.blockHash) || !HASH.test(evidence.revertDataHash)) throw new Error("ordinary scenario expected rejection evidence is missing");
    assertControlledState(evidence.postState, action.before, "rejection unchanged");
    if (evidence.postState.blockNumber !== state.blockNumber || !same(evidence.postState.blockHash, state.blockHash)) throw new Error("ordinary scenario rejection evidence is not canonical");
    recordEntry.status = "rejection-proved"; recordEntry.evidenceHash = sha256({ blockNumber: evidence.blockNumber.toString(), blockHash: evidence.blockHash, revertDataHash: evidence.revertDataHash, state: controlledState(evidence.postState) }) as Hex; store.save(journal);
    return { status: "REJECTION_PROVED", actionId: action.id };
  }
  const prepared = await context.materialize(action, state); validatePrepared(action, proposal, prepared, state);
  const simulation = await context.simulate(action, prepared, state);
  if (!simulation.success || simulation.blockNumber !== state.blockNumber || !same(simulation.blockHash, state.blockHash) || simulation.gasEstimate <= 0n || simulation.gasEstimate > prepared.liveIntent.gas || simulation.gasEstimate > action.gasLimitCap || !HASH.test(simulation.resultHash)) throw new Error("ordinary scenario exact signed simulation failed or exceeded cap");
  recordEntry.status = "signed-simulated"; recordEntry.requestHash = prepared.requestHash; recordEntry.signatureBundleHash = prepared.signatureBundleHash; recordEntry.signedCalldataHash = prepared.signedCalldataHash; recordEntry.simulationEvidenceHash = sha256({ ...simulation, blockNumber: simulation.blockNumber.toString(), gasEstimate: simulation.gasEstimate.toString() }) as Hex; recordEntry.gas = prepared.liveIntent.gas.toString(); recordEntry.outerTo = prepared.liveIntent.to; recordEntry.outerValue = prepared.liveIntent.value.toString(); recordEntry.outerDataHash = keccak256(prepared.liveIntent.data); store.save(journal);
  const live: LiveContext = {
    ...context.live,
    verify: async () => {
      const fresh = await context.readState(action, "pre-outer"); assertFreshState(action, proposal, journal, fresh, "pre-outer");
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

function encodeJournal(journal: OrdinaryScenarioJournal): string {
  return `${JSON.stringify(journal, (_, value) => typeof value === "bigint" ? value.toString() : value)}\n`;
}

function decodeReceipt(value: unknown): LiveReceipt | undefined {
  if (value === undefined) return undefined; const receipt = record(value, "scenario receipt");
  exactKeys(receipt, ["transactionHash", "status", "gasUsed", "effectiveGasPrice", "blockNumber", "blockHash"], "scenario receipt");
  return { transactionHash: hash(receipt.transactionHash, "receipt transaction hash"), status: receipt.status === "success" || receipt.status === "reverted" ? receipt.status : (() => { throw new Error("scenario receipt status mismatch"); })(), gasUsed: decimal(receipt.gasUsed, "receipt gas used"), effectiveGasPrice: decimal(receipt.effectiveGasPrice, "receipt effective gas price"), blockNumber: decimal(receipt.blockNumber, "receipt block number"), blockHash: hash(receipt.blockHash, "receipt block hash") };
}

function decodeJournal(serialized: string, identity: Readonly<{ proposalHash: Hex; approvalHash: Hex; funder: Address }>): OrdinaryScenarioJournal {
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("ordinary scenario journal must be JSON"); }
  const value = record(parsed, "ordinary scenario journal");
  exactKeys(value, ["schemaVersion", "chainId", "reviewPackageHash", "proposalHash", "approvalHash", "funder", "liveJournal", "actions"], "ordinary scenario journal");
  const live = record(value.liveJournal, "embedded live journal");
  exactKeys(live, ["chainId", "funder", "entries"], "embedded live journal");
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
    const allowed = new Set(["id", "commitment", "status", "materializationHash", "prestateHash", "outerNonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "requestHash", "signatureBundleHash", "signedCalldataHash", "simulationEvidenceHash", "intentHash", "transactionHash", "outerTo", "outerValue", "outerDataHash", "evidenceHash", "receipt", "queueCreatedAt", "establishedWindow", "funderNativeBefore", "funderNativeAfter", "ourPrincipalDelta", "ourReceiptGasCost", "externalFunderDelta", "externalFunderDeltaClassification"]);
    if (Object.keys(entry).some((key) => !allowed.has(key))) throw new Error("scenario action record has unknown fields");
    if (entry.receipt) entry.receipt = decodeReceipt(entry.receipt);
    return entry;
  });
  const journal: OrdinaryScenarioJournal = { schemaVersion: 1, chainId: CHAIN_ID, reviewPackageHash: hash(value.reviewPackageHash, "journal package hash"), proposalHash: hash(value.proposalHash, "journal proposal hash"), approvalHash: hash(value.approvalHash, "journal approval hash"), funder: address(value.funder, "journal funder"), liveJournal: { chainId: CHAIN_ID, funder: address(live.funder, "embedded funder"), entries }, actions };
  if (!same(journal.proposalHash, identity.proposalHash) || !same(journal.approvalHash, identity.approvalHash) || !same(journal.funder, identity.funder)) throw new Error("ordinary scenario persisted journal identity mismatch");
  return journal;
}

/** One lock and one fsynced replacement own both coordinator state and the embedded LiveJournal. */
export function createOrdinaryScenarioStore(path: string, identity: Readonly<{ proposalHash: Hex; approvalHash: Hex; funder: Address }>, initial: () => OrdinaryScenarioJournal): OrdinaryScenarioStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const lockPath = `${path}.lock`; let lock: number | undefined;
  try { lock = openSync(lockPath, "wx", 0o600); writeFileSync(lock, `${process.pid}\n`, "utf8"); fsyncSync(lock); } catch { throw new Error("ordinary scenario writer lock unavailable"); }
  let current = existsSync(path) ? decodeJournal(readFileSync(path, "utf8"), identity) : initial();
  const save = (journal: OrdinaryScenarioJournal): void => {
    if (lock === undefined) throw new Error("ordinary scenario writer lock is closed");
    if (!same(journal.proposalHash, identity.proposalHash) || !same(journal.approvalHash, identity.approvalHash) || !same(journal.funder, identity.funder)) throw new Error("ordinary scenario store identity mismatch");
    const temporary = `${path}.${process.pid}.tmp`; const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, encodeJournal(journal), "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path); const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
    current = journal;
  };
  const close = (): void => { if (lock === undefined) return; closeSync(lock); lock = undefined; unlinkSync(lockPath); };
  return Object.freeze({ load: () => current, save, close });
}
