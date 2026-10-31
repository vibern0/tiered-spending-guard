import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddressEqual,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { AssetSpendState } from "../config/policy";
import { classifyAction } from "../policy/classify";
import { buildCancellationTransaction, buildExecutionTransaction, buildQueueTransaction, queueFingerprint } from "../queue/delay";
import { SAFE_TX_TYPES, type SafeTxMessage } from "../signers/types";
import { canonicalSubmissionJson, snapshotPreparedPwaIntent } from "../transport/validate";
import type { PreparedDirectPwaIntent, PreparedPwaIntent, PreparedSignedPwaIntent, PwaQueueBinding, SimulationEvidence } from "../transport/types";
import { PWA_RECIPIENT, SEPOLIA_CHAIN_ID, SEPOLIA_USDC_ADDRESS } from "./profile";
import { isVerifiedPwaProvisioningResult, type PwaProvisioningResult } from "./provisioning";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ERC20_ABI = parseAbi(["function transfer(address,uint256) returns (bool)"]);
const DELAY_ABI = parseAbi(["function skipExpired()"]);
const HASH = /^0x[0-9a-fA-F]{64}$/;

export type TransferIntent = Readonly<{ kind: "transfer"; recipient: Address; amount: bigint }>;
export type CancelQueuedIntent = Readonly<{ kind: "cancel-queued"; queueNonce: bigint; queueFingerprint: Hex }>;
export type ExecuteReadyIntent = Readonly<{ kind: "execute-ready"; queueNonce: bigint; queueFingerprint: Hex }>;
export type SkipExpiredIntent = Readonly<{ kind: "skip-expired"; queueNonce: bigint; queueFingerprint: Hex }>;
export type PwaIntent = TransferIntent | CancelQueuedIntent | ExecuteReadyIntent | SkipExpiredIntent;

export type VerifiedPwaQueueItem = PwaQueueBinding & Readonly<{ safe: Address; delay: Address }>;
export type VerifiedPwaSnapshot = Readonly<{
  formatVersion: 1;
  chainId: typeof SEPOLIA_CHAIN_ID;
  blockNumber: bigint;
  blockHash: Hex;
  timestamp: bigint;
  deploymentsHash: Hex;
  policyHash: Hex;
  safe: Address;
  guard: Address;
  delay: Address;
  usdc: Address;
  recipient: Address;
  primaryPasskey: Address;
  secondaryPasskey: Address;
  safeNonce: bigint;
  spendState: AssetSpendState;
  limits: Readonly<{ basePerTransaction: bigint; baseDailyLimit: bigint; stepUpPerTransaction: bigint; instantDailyLimit: bigint }>;
  cooldownSeconds: bigint;
  expirationSeconds: bigint;
  queueHeadNonce: bigint;
  queueTailNonce: bigint;
  queueHead: VerifiedPwaQueueItem | null;
}>;

export type PwaSnapshotReader = Readonly<{
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<Readonly<{ number: bigint; hash: Hex | null; timestamp: bigint }>>;
  readAt(blockNumber: bigint): Promise<Omit<VerifiedPwaSnapshot, "formatVersion" | "chainId" | "blockNumber" | "blockHash" | "timestamp">>;
}>;

export type PwaSimulationClient = Readonly<{
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<Readonly<{ number: bigint; hash: Hex | null }>>;
  call(input: Readonly<{ account: Address; to: Address; value: bigint; data: Hex; blockNumber: bigint }>): Promise<Readonly<{ data?: Hex }>>;
}>;

const verifiedSnapshots = new WeakSet<object>();
const preparedIntents = new WeakSet<object>();

function same(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }

function assertSnapshot(snapshot: VerifiedPwaSnapshot): void {
  if (snapshot.formatVersion !== 1 || snapshot.chainId !== SEPOLIA_CHAIN_ID || snapshot.blockNumber < 0n || snapshot.timestamp < 0n || !HASH.test(snapshot.blockHash) || !HASH.test(snapshot.deploymentsHash) || !HASH.test(snapshot.policyHash)) throw new Error("invalid verified PWA snapshot identity");
  if (!isAddressEqual(snapshot.usdc, SEPOLIA_USDC_ADDRESS) || !isAddressEqual(snapshot.recipient, PWA_RECIPIENT)) throw new Error("verified PWA snapshot does not match fixed USDC/recipient profile");
  if (snapshot.limits.basePerTransaction !== 1_000_000n || snapshot.limits.baseDailyLimit !== 1_000_000n || snapshot.limits.stepUpPerTransaction !== 3_000_000n || snapshot.limits.instantDailyLimit !== 3_000_000n || snapshot.cooldownSeconds !== 120n || snapshot.expirationSeconds !== 600n) throw new Error("verified PWA snapshot does not match fixed X/Y/Z profile");
  if (snapshot.safeNonce < 0n || snapshot.queueHeadNonce < 0n || snapshot.queueTailNonce < snapshot.queueHeadNonce) throw new Error("verified PWA snapshot nonce is invalid");
  if (snapshot.spendState.window < 0n || snapshot.spendState.baseSpent < 0n || snapshot.spendState.instantSpent < snapshot.spendState.baseSpent || snapshot.spendState.baseSpent > snapshot.limits.baseDailyLimit || snapshot.spendState.instantSpent > snapshot.limits.instantDailyLimit) throw new Error("verified PWA snapshot spend state is invalid");
  if ((snapshot.queueHead === null) !== (snapshot.queueHeadNonce === snapshot.queueTailNonce)) throw new Error("verified PWA queue head presence mismatch");
  if (snapshot.queueHead) {
    const item = snapshot.queueHead;
    if (!isAddressEqual(item.safe, snapshot.safe) || !isAddressEqual(item.delay, snapshot.delay) || item.queueNonce !== snapshot.queueHeadNonce || item.operation !== 0 || item.readyAt !== item.createdAt + snapshot.cooldownSeconds || item.expiresAt !== item.readyAt + snapshot.expirationSeconds || queueFingerprint(item) !== item.queueFingerprint) throw new Error("verified PWA queue head binding mismatch");
  }
}

function freezeSnapshot(snapshot: VerifiedPwaSnapshot): VerifiedPwaSnapshot {
  const value = Object.freeze({
    ...snapshot,
    safe: getAddress(snapshot.safe), guard: getAddress(snapshot.guard), delay: getAddress(snapshot.delay), usdc: getAddress(snapshot.usdc), recipient: getAddress(snapshot.recipient), primaryPasskey: getAddress(snapshot.primaryPasskey), secondaryPasskey: getAddress(snapshot.secondaryPasskey),
    spendState: Object.freeze({ ...snapshot.spendState }), limits: Object.freeze({ ...snapshot.limits }),
    queueHead: snapshot.queueHead ? Object.freeze({ ...snapshot.queueHead, safe: getAddress(snapshot.queueHead.safe), delay: getAddress(snapshot.queueHead.delay), to: getAddress(snapshot.queueHead.to) }) : null,
  });
  assertSnapshot(value);
  verifiedSnapshots.add(value);
  return value;
}

export async function captureVerifiedPwaSnapshot(vault: PwaProvisioningResult, blockNumber: bigint, reader: PwaSnapshotReader): Promise<VerifiedPwaSnapshot> {
  if (!isVerifiedPwaProvisioningResult(vault)) throw new Error("verified PWA provisioning result is required for snapshot capture");
  const before = await reader.getBlock({ blockNumber });
  if (before.number !== blockNumber || !before.hash) throw new Error("PWA snapshot block is unavailable");
  const state = await reader.readAt(blockNumber);
  const after = await reader.getBlock({ blockNumber });
  if (after.number !== blockNumber || !after.hash || !same(before.hash, after.hash)) throw new Error("PWA snapshot block reorg detected");
  const snapshot = freezeSnapshot({ ...state, formatVersion: 1, chainId: SEPOLIA_CHAIN_ID, blockNumber, blockHash: before.hash, timestamp: before.timestamp });
  if (!isAddressEqual(snapshot.safe, vault.safe) || !isAddressEqual(snapshot.guard, vault.guard) || !isAddressEqual(snapshot.delay, vault.delay) || !isAddressEqual(snapshot.usdc, vault.usdc) || !isAddressEqual(snapshot.primaryPasskey, vault.primaryPasskey) || !isAddressEqual(snapshot.secondaryPasskey, vault.secondaryPasskey) || !same(snapshot.deploymentsHash, vault.deploymentsHash) || !same(snapshot.policyHash, vault.policyHash)) throw new Error("PWA snapshot does not match verified provisioning/topology evidence");
  return snapshot;
}

export function brandVerifiedPwaSnapshotForTestsOnly(snapshot: VerifiedPwaSnapshot): VerifiedPwaSnapshot {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") throw new Error("test-only PWA snapshot branding is disabled outside tests");
  return freezeSnapshot(snapshot);
}

function snapshotHash(snapshot: VerifiedPwaSnapshot): Hex {
  return keccak256(stringToHex(canonicalSubmissionJson(snapshot)));
}

function exactIntentKeys(intent: PwaIntent): void {
  const expected = intent.kind === "transfer" ? ["kind", "recipient", "amount"] : ["kind", "queueNonce", "queueFingerprint"];
  const actual = Object.keys(intent);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) throw new Error("PWA intent contains an unsupported field");
}

function transferData(recipient: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [recipient, amount] });
}

function safeTx(snapshot: VerifiedPwaSnapshot, to: Address, data: Hex): SafeTxMessage {
  return Object.freeze({ to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: snapshot.safeNonce });
}

function signed(snapshot: VerifiedPwaSnapshot, kind: PreparedSignedPwaIntent["kind"], to: Address, data: Hex, amount: bigint, approvals: PreparedSignedPwaIntent["requiredApprovals"], queue: PwaQueueBinding | null): PreparedSignedPwaIntent {
  const transaction = safeTx(snapshot, to, data);
  const prepared = Object.freeze({
    version: 1 as const, kind, snapshotHash: snapshotHash(snapshot), chainId: SEPOLIA_CHAIN_ID,
    blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash, timestamp: snapshot.timestamp, deploymentsHash: snapshot.deploymentsHash, policyHash: snapshot.policyHash,
    safe: snapshot.safe, guard: snapshot.guard, delay: snapshot.delay, asset: snapshot.usdc, recipient: snapshot.recipient, amount,
    expectedSpend: Object.freeze({ ...snapshot.spendState }), queue, requiredApprovals: approvals, safeTx: transaction,
    safeTxHash: hashTypedData({ domain: { chainId: SEPOLIA_CHAIN_ID, verifyingContract: snapshot.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: transaction }),
  });
  snapshotPreparedPwaIntent(prepared);
  preparedIntents.add(prepared);
  return prepared;
}

function head(snapshot: VerifiedPwaSnapshot, intent: CancelQueuedIntent | ExecuteReadyIntent | SkipExpiredIntent): VerifiedPwaQueueItem {
  const item = snapshot.queueHead;
  if (!item || intent.queueNonce !== snapshot.queueHeadNonce || intent.queueNonce !== item.queueNonce) throw new Error("intent does not bind the executable queue head");
  if (!same(intent.queueFingerprint, item.queueFingerprint)) throw new Error("intent queue fingerprint mismatch");
  return item;
}

function queueBinding(item: VerifiedPwaQueueItem): PwaQueueBinding {
  return Object.freeze({ queueNonce: item.queueNonce, queueFingerprint: item.queueFingerprint, to: item.to, value: item.value, data: item.data, operation: item.operation, createdAt: item.createdAt, readyAt: item.readyAt, expiresAt: item.expiresAt });
}

function direct(snapshot: VerifiedPwaSnapshot, kind: PreparedDirectPwaIntent["kind"], item: VerifiedPwaQueueItem, data: Hex): PreparedDirectPwaIntent {
  const prepared = Object.freeze({
    version: 1 as const, kind, snapshotHash: snapshotHash(snapshot), chainId: SEPOLIA_CHAIN_ID,
    blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash, timestamp: snapshot.timestamp, deploymentsHash: snapshot.deploymentsHash, policyHash: snapshot.policyHash,
    safe: snapshot.safe, guard: snapshot.guard, delay: snapshot.delay, asset: snapshot.usdc, recipient: snapshot.recipient,
    amount: decodeTransferAmount(item.data), queue: queueBinding(item), requiredApprovals: Object.freeze([]) as readonly [], call: Object.freeze({ to: snapshot.delay, value: 0n as const, data, operation: 0 as const }),
  });
  snapshotPreparedPwaIntent(prepared);
  preparedIntents.add(prepared);
  return prepared;
}

function decodeTransferAmount(data: Hex): bigint {
  if (!data.toLowerCase().startsWith("0xa9059cbb") || data.length !== 138) throw new Error("queue head is not an exact USDC transfer");
  return BigInt(`0x${data.slice(74)}`);
}

export function preparePwaIntent(snapshot: VerifiedPwaSnapshot, intent: PwaIntent): PreparedPwaIntent {
  if (!verifiedSnapshots.has(snapshot)) throw new Error("verified snapshot is required");
  exactIntentKeys(intent);
  if (intent.kind === "transfer") {
    if (!isAddressEqual(intent.recipient, snapshot.recipient)) throw new Error("transfer recipient does not match the fixed profile");
    if (intent.amount <= 0n) throw new Error("transfer amount must be positive");
    const data = transferData(snapshot.recipient, intent.amount);
    const policy = { chainId: SEPOLIA_CHAIN_ID, safe: snapshot.safe, passkey: snapshot.primaryPasskey, primary: snapshot.primaryPasskey, ecdsaSecondary: ZERO, secondaries: [{ address: snapshot.secondaryPasskey, role: "secondary" as const, kind: "safe-contract" as const, enabled: true }], secondaryProfile: "contract-only" as const, delay: snapshot.delay, periodSeconds: 86400 as const, periodAnchor: 0n, cooldownSeconds: Number(snapshot.cooldownSeconds), expirationSeconds: Number(snapshot.expirationSeconds), assets: [{ token: snapshot.usdc, ...snapshot.limits, recipients: [snapshot.recipient] }] };
    const action = { to: snapshot.usdc, value: 0n, data, operation: 0 as const, signer: snapshot.primaryPasskey };
    const withoutSecondary = classifyAction(policy, action, snapshot.spendState, snapshot.timestamp, false);
    if (withoutSecondary === "base") return signed(snapshot, "base-transfer", snapshot.usdc, data, intent.amount, Object.freeze(["primary"]), null);
    const withSecondary = classifyAction(policy, action, snapshot.spendState, snapshot.timestamp, true);
    if (withSecondary === "step-up") return signed(snapshot, "step-up-transfer", snapshot.usdc, data, intent.amount, Object.freeze(["primary", "secondary"]), null);
    const queueItem = Object.freeze({ queueNonce: snapshot.queueTailNonce, queueFingerprint: queueFingerprint({ safe: snapshot.safe, delay: snapshot.delay, to: snapshot.usdc, value: 0n, data, operation: 0, queueNonce: snapshot.queueTailNonce }), to: snapshot.usdc, value: 0n, data, operation: 0 as const, createdAt: 0n, readyAt: 0n, expiresAt: 0n });
    const queueTransaction = buildQueueTransaction({ safe: snapshot.safe, delay: snapshot.delay, to: snapshot.usdc, value: 0n, data, operation: 0, queueNonce: snapshot.queueTailNonce });
    return signed(snapshot, "queue-transfer", queueTransaction.to, queueTransaction.data, intent.amount, Object.freeze(["primary", "secondary"]), queueItem);
  }
  const item = head(snapshot, intent);
  if (!isAddressEqual(item.to, snapshot.usdc)) throw new Error("queue head token is not the fixed USDC asset");
  const amount = decodeTransferAmount(item.data);
  const encodedRecipient = getAddress(`0x${item.data.slice(34, 74)}`);
  if (!isAddressEqual(encodedRecipient, snapshot.recipient) || amount <= 0n) throw new Error("queue head transfer does not match the fixed recipient");
  if (intent.kind === "cancel-queued") {
    const cancellation = buildCancellationTransaction(snapshot.delay, item.queueNonce + 1n);
    return signed(snapshot, "cancel-queued", cancellation.to, cancellation.data, amount, Object.freeze(["primary", "secondary"]), queueBinding(item));
  }
  if (intent.kind === "execute-ready") {
    if (snapshot.timestamp < item.readyAt) throw new Error("Delay cooldown has not elapsed");
    if (snapshot.timestamp > item.expiresAt) throw new Error("Delay queue item expired");
    return direct(snapshot, "execute-ready", item, buildExecutionTransaction(item).data);
  }
  if (snapshot.timestamp <= item.expiresAt) throw new Error("Delay queue item is not expired");
  return direct(snapshot, "skip-expired", item, encodeFunctionData({ abi: DELAY_ABI, functionName: "skipExpired" }));
}

export function assertSamePreparedPwaIntent(expected: PreparedPwaIntent, actual: unknown): void {
  const snapshot = snapshotPreparedPwaIntent(actual);
  if (canonicalSubmissionJson(expected) !== canonicalSubmissionJson(snapshot)) throw new Error("prepared PWA intent mutated");
}

export async function simulatePwaIntent(prepared: PreparedPwaIntent, client: PwaSimulationClient): Promise<SimulationEvidence> {
  if (!preparedIntents.has(prepared)) throw new Error("reviewed prepared PWA intent is required");
  const before = await client.getBlock({ blockNumber: prepared.blockNumber });
  if (before.number !== prepared.blockNumber || !before.hash || !same(before.hash, prepared.blockHash)) throw new Error("PWA simulation snapshot block mismatch or reorg");
  const call = "safeTx" in prepared ? { account: prepared.safe, to: prepared.safeTx.to, value: prepared.safeTx.value, data: prepared.safeTx.data, blockNumber: prepared.blockNumber } : { account: prepared.safe, to: prepared.call.to, value: prepared.call.value, data: prepared.call.data, blockNumber: prepared.blockNumber };
  const callHash = keccak256(stringToHex(canonicalSubmissionJson(call)));
  let output: Readonly<{ data?: Hex }> | undefined;
  let reason: string | undefined;
  try { output = await client.call(call); } catch (error) { reason = error instanceof Error ? error.message : "simulation reverted"; }
  const after = await client.getBlock({ blockNumber: prepared.blockNumber });
  if (after.number !== prepared.blockNumber || !after.hash || !same(after.hash, prepared.blockHash)) throw new Error("PWA simulation snapshot block changed");
  return Object.freeze(reason ? { ok: false, blockNumber: prepared.blockNumber, blockHash: prepared.blockHash, callHash, reason } : { ok: true, blockNumber: prepared.blockNumber, blockHash: prepared.blockHash, callHash, returnData: output?.data ?? "0x" });
}
