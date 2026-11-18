import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { assertValidVaultPolicy, type AssetSpendState, type VaultPolicy } from "../config/policy";
import { policyHash as computePolicyHash } from "../topology/build";
import { queueFingerprint } from "../queue/delay";
import type { PreparedPwaIntent, PwaQueueBinding } from "../transport/types";
import { assertSamePreparedPwaIntent, decodePwaRecipientRepair } from "./intents";
import { SEPOLIA_CHAIN_ID, SEPOLIA_USDC_ADDRESS } from "./profile";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const PROCESS_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SOURCE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_ABI = parseAbi([
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)",
  "event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash,uint256 payment)",
]);
const GUARD_ABI = parseAbi([
  "event TransferAuthorized(uint8 tier,address token,address recipient,uint256 amount,uint256 baseSpent,uint256 instantSpent,uint256 window)",
]);
const TOKEN_ABI = parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const DELAY_ABI = parseAbi([
  "event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)",
  "event TxNonceSet(uint256 nonce)",
]);

export type PwaObservedQueue = Readonly<PwaQueueBinding & { safe: Address; delay: Address }>;
export type PwaObservedState = Readonly<{
  policy: VaultPolicy;
  safeNonce: bigint;
  queueHeadNonce: bigint;
  queueTailNonce: bigint;
  safeUsdcBalance: bigint;
  recipientUsdcBalance: bigint;
  spendState: AssetSpendState;
  queueHead: PwaObservedQueue | null;
  deploymentsHash: Hex;
  policyHash: Hex;
  topologyReportHash: Hex;
}>;

export type PwaObserverLog = Readonly<{
  address: Address;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
  topics: readonly Hex[];
  data: Hex;
  removed?: boolean;
}>;

export type PwaObserverReceipt = Readonly<{
  transactionHash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
  logs: readonly PwaObserverLog[];
}>;

export type PwaObserverTransaction = Readonly<{
  hash: Hex;
  to: Address | null;
  value: bigint;
  input: Hex;
}>;

export type PwaObserverClient = Readonly<{
  source: string;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(input: Readonly<{ hash: Hex }>): Promise<PwaObserverReceipt | null>;
  getTransaction(input: Readonly<{ hash: Hex }>): Promise<PwaObserverTransaction | null>;
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<Readonly<{ number: bigint; hash: Hex | null; timestamp: bigint }>>;
  readStateAt(blockNumber: bigint): Promise<PwaObservedState>;
}>;

export type PwaObserverIdentity = Readonly<{
  processId: string;
  executableHash: Hex;
  startedAt: string;
}>;

export type PwaObserverBinding = Readonly<{
  intent: PreparedPwaIntent;
  profileHash: Hex;
  topologyReportHash: Hex;
  confirmations: number;
  observer: PwaObserverIdentity;
  clients: readonly [PwaObserverClient, PwaObserverClient];
}>;

export type PwaObserverRecord = Readonly<{
  formatVersion: 1;
  scope: "sepolia-pwa-receipt-observation";
  kind: PreparedPwaIntent["kind"];
  chainId: typeof SEPOLIA_CHAIN_ID;
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  confirmations: number;
  safe: Address;
  guard: Address;
  delay: Address;
  usdc: Address;
  amount: string;
  profileHash: Hex;
  deploymentsHash: Hex;
  policyHash: Hex;
  topologyReportHash: Hex;
  outerEnvelopeHash: Hex;
  beforeStateHash: Hex;
  afterStateHash: Hex;
  observer: PwaObserverIdentity;
  sources: readonly [string, string];
  notificationDelivery: "not-claimed";
  observedAt: string;
  recordHash: Hex;
}>;

export type UnsignedPwaObserverRecord = Readonly<Omit<PwaObserverRecord, "recordHash">>;

export type PwaEvidenceManifest = Readonly<{
  formatVersion: 1;
  scope: "sepolia-pwa-phase-one-evidence";
  notificationDelivery: "not-claimed";
  records: readonly Readonly<{
    file: string;
    sha256: Hex;
    kind: PreparedPwaIntent["kind"];
    transactionHash: Hex;
    observerProcessId: string;
  }>[];
  manifestHash: Hex;
}>;

type Observation = Readonly<{
  latestBlock: bigint;
  receipt: PwaObserverReceipt;
  transaction: PwaObserverTransaction;
  block: Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>;
  before: PwaObservedState;
  after: PwaObservedState;
}>;

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function canonical(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (typeof item === "bigint") return item.toString();
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) output[key] = visit((item as Record<string, unknown>)[key]);
      return output;
    }
    return item;
  };
  return JSON.stringify(visit(value));
}

function contentHash(value: unknown): Hex {
  return keccak256(stringToHex(canonical(value)));
}

function assertHash(value: unknown, label: string): asserts value is Hex {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} is invalid`);
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) throw new Error(`${label} contains an unsupported field`);
}

function assertObserverIdentity(identity: PwaObserverIdentity): void {
  assertExactKeys(identity, ["processId", "executableHash", "startedAt"], "observer identity");
  if (!PROCESS_ID.test(identity.processId)) throw new Error("observer process identity is invalid");
  assertHash(identity.executableHash, "observer executable hash");
  if (!Number.isFinite(Date.parse(identity.startedAt))) throw new Error("observer start time is invalid");
}

function assertReadOnlyClient(client: PwaObserverClient): void {
  const prototype = Object.getPrototypeOf(client);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("read-only observer client must be a plain capability object");
  assertExactKeys(client, ["source", "getBlockNumber", "getTransactionReceipt", "getTransaction", "getBlock", "readStateAt"], "read-only observer client");
  if (typeof client.source !== "string" || !SOURCE_ID.test(client.source)) throw new Error("observer source must be an opaque public identifier");
  for (const method of ["getBlockNumber", "getTransactionReceipt", "getTransaction", "getBlock", "readStateAt"] as const) {
    if (typeof client[method] !== "function") throw new Error("read-only observer client method is missing");
  }
}

function assertStateIdentity(state: PwaObservedState, binding: PwaObserverBinding, after = false): void {
  for (const [value, label] of [[state.deploymentsHash, "deployments"], [state.policyHash, "policy"], [state.topologyReportHash, "topology report"]] as const) assertHash(value, label);
  const maintenanceExecution = after && binding.intent.kind === "execute-ready" && isAddressEqual(binding.intent.queue.to, binding.intent.guard);
  if (!same(state.deploymentsHash, binding.intent.deploymentsHash) || (!maintenanceExecution && !same(state.policyHash, binding.intent.policyHash)) || !same(state.topologyReportHash, binding.topologyReportHash)) throw new Error("observer topology/profile state mismatch");
  assertValidVaultPolicy(state.policy);
  const policy = state.policy, asset = policy.assets[0];
  if (computePolicyHash(policy) !== state.policyHash || policy.chainId !== SEPOLIA_CHAIN_ID || !isAddressEqual(policy.safe, binding.intent.safe) || !isAddressEqual(policy.delay, binding.intent.delay) || policy.secondaryProfile !== "contract-only" || policy.periodSeconds !== 86400 || policy.periodAnchor !== 0n || policy.cooldownSeconds !== 120 || policy.expirationSeconds !== 600 || policy.assets.length !== 1 || !asset || !isAddressEqual(asset.token, binding.intent.asset) || asset.baseRecipientMode !== "any-valid-address" || asset.basePerTransaction !== 1_000_000n || asset.stepUpPerTransaction !== 3_000_000n || asset.baseDailyLimit !== 1_000_000n || asset.instantDailyLimit !== 3_000_000n) throw new Error("observer verified policy projection mismatch");
  if ([state.safeNonce, state.queueHeadNonce, state.queueTailNonce, state.safeUsdcBalance, state.recipientUsdcBalance, state.spendState.window, state.spendState.baseSpent, state.spendState.instantSpent].some((value) => value < 0n)) throw new Error("observer state contains a negative value");
  if (state.queueTailNonce < state.queueHeadNonce) throw new Error("observer queue state is invalid");
  if ((state.queueHead === null) !== (state.queueHeadNonce === state.queueTailNonce)) throw new Error("observer queue head presence mismatch");
  if (state.queueHead) {
    const item = state.queueHead;
    if (!isAddressEqual(item.safe, binding.intent.safe) || !isAddressEqual(item.delay, binding.intent.delay) || item.queueNonce !== state.queueHeadNonce || item.operation !== 0 || item.readyAt !== item.createdAt + 120n || item.expiresAt !== item.readyAt + 600n || !same(item.queueFingerprint, queueFingerprint(item))) throw new Error("observer queue binding mismatch");
  }
}

async function observeClient(client: PwaObserverClient, binding: PwaObserverBinding, receiptHash: Hex): Promise<Observation> {
  assertReadOnlyClient(client);
  const latestBlock = await client.getBlockNumber();
  const receipt = await client.getTransactionReceipt({ hash: receiptHash });
  if (!receipt) throw new Error("observer receipt is missing");
  if (!same(receipt.transactionHash, receiptHash) || receipt.status !== "success") throw new Error("observer receipt failed or mismatched");
  if (receipt.blockNumber < 1n || latestBlock < receipt.blockNumber || latestBlock - receipt.blockNumber + 1n < BigInt(binding.confirmations)) throw new Error("observer receipt lacks required confirmations");
  const firstBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (firstBlock.number !== receipt.blockNumber || !firstBlock.hash || !same(firstBlock.hash, receipt.blockHash)) throw new Error("observer receipt block is not canonical");
  const transaction = await client.getTransaction({ hash: receiptHash });
  if (!transaction || !same(transaction.hash, receiptHash)) throw new Error("observer transaction envelope is missing");
  const before = await client.readStateAt(receipt.blockNumber - 1n);
  const after = await client.readStateAt(receipt.blockNumber);
  assertStateIdentity(before, binding);
  assertStateIdentity(after, binding, true);
  const secondBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (secondBlock.number !== firstBlock.number || !secondBlock.hash || !same(secondBlock.hash, firstBlock.hash) || secondBlock.timestamp !== firstBlock.timestamp) throw new Error("observer receipt block reorg detected");
  for (const log of receipt.logs) {
    if (log.removed || log.blockNumber !== receipt.blockNumber || !same(log.blockHash, receipt.blockHash) || !same(log.transactionHash, receiptHash)) throw new Error("observer receipt contains a reorged log");
  }
  return Object.freeze({ latestBlock, receipt, transaction, block: Object.freeze({ number: firstBlock.number, hash: firstBlock.hash, timestamp: firstBlock.timestamp }), before, after });
}

function decodeLog(log: PwaObserverLog, abi: readonly unknown[]): Readonly<{ eventName: string; args: readonly unknown[] }> | undefined {
  try {
    const decoded = decodeEventLog({ abi, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]] }) as unknown as { eventName: string; args: readonly unknown[] | Record<string, unknown> };
    return Object.freeze({ eventName: decoded.eventName, args: Array.isArray(decoded.args) ? decoded.args : Object.values(decoded.args) });
  } catch {
    return undefined;
  }
}

function assertSafeEnvelope(intent: PreparedPwaIntent, observation: Observation): void {
  if (!("safeTx" in intent)) {
    if (!observation.transaction.to || !isAddressEqual(observation.transaction.to, intent.call.to) || observation.transaction.value !== intent.call.value || observation.transaction.input.toLowerCase() !== intent.call.data.toLowerCase()) throw new Error("observer direct Delay envelope mismatch");
    return;
  }
  if (!observation.transaction.to || !isAddressEqual(observation.transaction.to, intent.safe) || observation.transaction.value !== 0n) throw new Error("observer Safe outer envelope mismatch");
  let decoded: ReturnType<typeof decodeFunctionData>;
  try { decoded = decodeFunctionData({ abi: SAFE_ABI, data: observation.transaction.input }); } catch { throw new Error("observer Safe outer envelope is malformed"); }
  if (decoded.functionName !== "execTransaction") throw new Error("observer Safe outer envelope selector mismatch");
  const args = decoded.args as readonly unknown[];
  const tx = intent.safeTx;
  if (args.length !== 10 || !isAddressEqual(args[0] as Address, tx.to) || args[1] !== tx.value || String(args[2]).toLowerCase() !== tx.data.toLowerCase() || args[3] !== tx.operation || args[4] !== tx.safeTxGas || args[5] !== tx.baseGas || args[6] !== tx.gasPrice || !isAddressEqual(args[7] as Address, tx.gasToken) || !isAddressEqual(args[8] as Address, tx.refundReceiver) || typeof args[9] !== "string" || args[9] === "0x") throw new Error("observer Safe outer envelope fields mismatch");
  let success = 0;
  let failure = 0;
  for (const log of observation.receipt.logs.filter((item) => isAddressEqual(item.address, intent.safe))) {
    const event = decodeLog(log, SAFE_ABI);
    if (!event || (event.eventName !== "ExecutionSuccess" && event.eventName !== "ExecutionFailure")) continue;
    if (!same(String(event.args[0]), intent.safeTxHash)) continue;
    if (event.eventName === "ExecutionSuccess") success += 1;
    else failure += 1;
  }
  if (failure !== 0) throw new Error("observer detected inner Safe execution failure");
  if (success !== 1) throw new Error("observer Safe success event mismatch");
}

function assertUnchanged(left: PwaObservedState, right: PwaObservedState, fields: readonly (keyof PwaObservedState)[], label: string): void {
  for (const field of fields) if (canonical(left[field]) !== canonical(right[field])) throw new Error(`observer ${label} effect mismatch: ${field}`);
}

function assertTransferEvent(intent: PreparedPwaIntent, observation: Observation, expectedTier: number): void {
  const matches = observation.receipt.logs.filter((log) => isAddressEqual(log.address, intent.guard)).map((log) => decodeLog(log, GUARD_ABI)).filter((event) => event?.eventName === "TransferAuthorized");
  if (matches.length !== 1) throw new Error("observer transfer event mismatch");
  const args = matches[0]!.args;
  if (Number(args[0]) !== expectedTier || !isAddressEqual(args[1] as Address, intent.asset) || !isAddressEqual(args[2] as Address, intent.recipient) || args[3] !== intent.amount || args[4] !== observation.after.spendState.baseSpent || args[5] !== observation.after.spendState.instantSpent || args[6] !== observation.after.spendState.window) throw new Error("observer transfer event/effect mismatch");
}

function assertTransferBalances(intent: PreparedPwaIntent, observation: Observation): void {
  const { before, after } = observation;
  if (!isAddressEqual(intent.safe, intent.recipient)) {
    if (after.safeUsdcBalance !== before.safeUsdcBalance - intent.amount || after.recipientUsdcBalance !== before.recipientUsdcBalance + intent.amount) throw new Error("observer transfer balance effect mismatch");
    return;
  }
  if (before.safeUsdcBalance !== before.recipientUsdcBalance || after.safeUsdcBalance !== after.recipientUsdcBalance || after.safeUsdcBalance !== before.safeUsdcBalance) throw new Error("observer self-transfer balance alias mismatch");
  const events = observation.receipt.logs.filter(log => isAddressEqual(log.address, intent.asset)).map(log => decodeLog(log, TOKEN_ABI)).filter(event => event?.eventName === "Transfer");
  if (events.length !== 1) throw new Error("observer self-transfer token event mismatch");
  const args = events[0]!.args;
  if (!isAddressEqual(args[0] as Address, intent.safe) || !isAddressEqual(args[1] as Address, intent.safe) || args[2] !== intent.amount) throw new Error("observer self-transfer token event mismatch");
}

function assertEffects(intent: PreparedPwaIntent, observation: Observation): void {
  const before = observation.before;
  const after = observation.after;
  const signed = "safeTx" in intent;
  const maintenance = intent.kind === "execute-ready" && isAddressEqual(intent.queue.to, intent.guard) ? decodePwaRecipientRepair(intent.queue.data) : null;
  if (!maintenance) assertUnchanged(before, after, ["policy", "policyHash"], "policy");
  if (signed && (before.safeNonce !== intent.safeTx.nonce || after.safeNonce !== before.safeNonce + 1n)) throw new Error("observer Safe nonce effect mismatch");
  if (!signed && after.safeNonce !== before.safeNonce) throw new Error("observer permissionless execution changed Safe nonce");
  if (intent.kind === "base-transfer" || intent.kind === "step-up-transfer") {
    assertTransferBalances(intent, observation);
    const anchor = before.policy.periodAnchor, seconds = BigInt(before.policy.periodSeconds);
    if (observation.block.timestamp < anchor) throw new Error("observer transfer precedes the period anchor");
    const window = anchor + ((observation.block.timestamp - anchor) / seconds) * seconds;
    if (before.spendState.window < anchor || (before.spendState.window - anchor) % seconds !== 0n || before.spendState.window > window) throw new Error("observer transfer counter window is invalid or future");
    const sameWindow = before.spendState.window === window;
    const expectedBase = (sameWindow ? before.spendState.baseSpent : 0n) + (intent.kind === "base-transfer" ? intent.amount : 0n);
    const expectedInstant = (sameWindow ? before.spendState.instantSpent : 0n) + intent.amount;
    if (after.spendState.window !== window || after.spendState.baseSpent !== expectedBase || after.spendState.instantSpent !== expectedInstant) throw new Error("observer transfer counter effect mismatch");
    assertUnchanged(before, after, ["queueHeadNonce", "queueTailNonce", "queueHead"], "transfer queue");
    assertTransferEvent(intent, observation, intent.kind === "base-transfer" ? 0 : 1);
    return;
  }
  if (intent.kind === "queue-transfer" || intent.kind === "add-recipient") {
    assertUnchanged(before, after, ["safeUsdcBalance", "recipientUsdcBalance", "spendState", "queueHeadNonce"], "queue proposal");
    if (before.queueTailNonce !== intent.queue!.queueNonce || after.queueTailNonce !== before.queueTailNonce + 1n) throw new Error("observer queue proposal state effect mismatch");
    const item = { ...intent.queue!, createdAt: observation.block.timestamp };
    if (before.queueHead) assertUnchanged(before, after, ["queueHead"], "queue proposal existing head");
    else if (!after.queueHead || after.queueHead.queueNonce !== item.queueNonce || !same(after.queueHead.queueFingerprint, item.queueFingerprint) || after.queueHead.createdAt !== item.createdAt || !isAddressEqual(after.queueHead.to, item.to) || after.queueHead.data.toLowerCase() !== item.data.toLowerCase() || after.queueHead.value !== item.value || after.queueHead.operation !== item.operation) throw new Error("observer queue proposal head mismatch");
    if (item.queueNonce !== intent.queue!.queueNonce || !same(item.queueFingerprint, intent.queue!.queueFingerprint) || !isAddressEqual(item.to, intent.queue!.to) || item.value !== intent.queue!.value || item.data.toLowerCase() !== intent.queue!.data.toLowerCase() || item.operation !== intent.queue!.operation || item.createdAt !== observation.block.timestamp) throw new Error("observer queue proposal tuple effect mismatch");
    const events = observation.receipt.logs.filter((log) => isAddressEqual(log.address, intent.delay)).map((log) => decodeLog(log, DELAY_ABI)).filter((event) => event?.eventName === "TransactionAdded");
    if (events.length !== 1) throw new Error("observer queue event mismatch");
    const args = events[0]!.args;
    if (args[0] !== item.queueNonce || !same(String(args[1]), item.queueFingerprint) || !isAddressEqual(args[2] as Address, item.to) || args[3] !== item.value || String(args[4]).toLowerCase() !== item.data.toLowerCase() || Number(args[5]) !== item.operation) throw new Error("observer queue event/effect mismatch");
    return;
  }
  const queue = intent.queue;
  if (!queue) throw new Error("observer lifecycle queue binding is missing");
  if (!before.queueHead || before.queueHead.queueNonce !== queue.queueNonce || !same(before.queueHead.queueFingerprint, queue.queueFingerprint)) throw new Error("observer stale queue prestate");
  assertUnchanged(before, after, ["spendState"], "delayed counter");
  if (intent.kind === "cancel-queued") {
    assertUnchanged(before, after, ["safeUsdcBalance", "recipientUsdcBalance", "queueTailNonce"], "cancellation");
    if (after.queueHeadNonce !== queue.queueNonce + 1n) throw new Error("observer cancellation queue effect mismatch");
    const events = observation.receipt.logs.filter((log) => isAddressEqual(log.address, intent.delay)).map((log) => decodeLog(log, DELAY_ABI)).filter((event) => event?.eventName === "TxNonceSet");
    if (events.length !== 1 || events[0]!.args[0] !== queue.queueNonce + 1n) throw new Error("observer cancellation event mismatch");
    return;
  }
  if (intent.kind === "execute-ready") {
    if (observation.block.timestamp < queue.readyAt || observation.block.timestamp >= queue.expiresAt) throw new Error("observer delayed execution is outside its ready interval");
    if (after.queueHeadNonce !== queue.queueNonce + 1n || after.queueTailNonce !== before.queueTailNonce) throw new Error("observer execution queue effect mismatch");
    if (maintenance) {
      assertUnchanged(before, after, ["safeUsdcBalance", "recipientUsdcBalance"], "recipient repair balances");
      const originalRecipients = before.policy.assets[0]!.recipients;
      if (!same(maintenance.expectedPolicyHash, before.policyHash) || maintenance.recipients.length !== originalRecipients.length + 1 || originalRecipients.some((recipient, index) => !isAddressEqual(recipient, maintenance.recipients[index]!)) || !isAddressEqual(maintenance.recipient, intent.recipient) || intent.amount !== 0n) throw new Error("observer recipient repair policy prestate mismatch");
      const expected = { ...before.policy, assets: [{ ...before.policy.assets[0]!, recipients: maintenance.recipients }] };
      if (canonical(after.policy) !== canonical(expected) || !same(after.policyHash, computePolicyHash(expected))) throw new Error("observer recipient repair policy effect mismatch");
    } else assertTransferBalances(intent, observation);
    return;
  }
  if (intent.kind === "skip-expired") {
    assertUnchanged(before, after, ["safeUsdcBalance", "recipientUsdcBalance", "queueTailNonce"], "expired skip");
    if (observation.block.timestamp <= queue.expiresAt || before.queueTailNonce !== queue.queueNonce + 1n || after.queueHeadNonce !== queue.queueNonce + 1n || after.queueHead !== null) throw new Error("observer expired skip queue effect mismatch");
    return;
  }
  throw new Error("observer intent effect is unsupported");
}

function assertBinding(binding: PwaObserverBinding): void {
  if ("notificationDelivery" in (binding as object)) throw new Error("observer cannot claim notification delivery");
  assertExactKeys(binding, ["intent", "profileHash", "topologyReportHash", "confirmations", "observer", "clients"], "observer binding");
  assertHash(binding.profileHash, "profile hash");
  assertHash(binding.topologyReportHash, "topology report hash");
  if (!Number.isInteger(binding.confirmations) || binding.confirmations < 1) throw new Error("observer confirmation depth is invalid");
  assertObserverIdentity(binding.observer);
  if (!Array.isArray(binding.clients) || binding.clients.length !== 2 || binding.clients[0].source === binding.clients[1].source) throw new Error("two independent observer sources are required");
  assertSamePreparedPwaIntent(binding.intent, binding.intent);
  if (binding.intent.chainId !== SEPOLIA_CHAIN_ID || !isAddressEqual(binding.intent.asset, SEPOLIA_USDC_ADDRESS)) throw new Error("observer intent is outside the PWA profile");
}

export async function observePwaReceipt(binding: PwaObserverBinding, receiptHash: Hex): Promise<PwaObserverRecord> {
  assertBinding(binding);
  assertHash(receiptHash, "receipt hash");
  const observations = await Promise.all(binding.clients.map((client) => observeClient(client, binding, receiptHash))) as [Observation, Observation];
  const comparable = ({ latestBlock: _latestBlock, ...observation }: Observation) => observation;
  if (canonical(comparable(observations[0])) !== canonical(comparable(observations[1]))) throw new Error("independent observer RPC views disagree");
  const observation = observations[0];
  assertSafeEnvelope(binding.intent, observation);
  assertEffects(binding.intent, observation);
  const base = Object.freeze({
    formatVersion: 1 as const,
    scope: "sepolia-pwa-receipt-observation" as const,
    kind: binding.intent.kind,
    chainId: SEPOLIA_CHAIN_ID,
    transactionHash: receiptHash,
    blockNumber: observation.receipt.blockNumber.toString(),
    blockHash: observation.receipt.blockHash,
    confirmations: binding.confirmations,
    safe: getAddress(binding.intent.safe),
    guard: getAddress(binding.intent.guard),
    delay: getAddress(binding.intent.delay),
    usdc: getAddress(binding.intent.asset),
    amount: binding.intent.amount.toString(),
    profileHash: binding.profileHash,
    deploymentsHash: binding.intent.deploymentsHash,
    policyHash: binding.intent.policyHash,
    topologyReportHash: binding.topologyReportHash,
    outerEnvelopeHash: contentHash(observation.transaction),
    beforeStateHash: contentHash(observation.before),
    afterStateHash: contentHash(observation.after),
    observer: Object.freeze({ ...binding.observer }),
    sources: Object.freeze([binding.clients[0].source, binding.clients[1].source] as const),
    notificationDelivery: "not-claimed" as const,
    observedAt: new Date().toISOString(),
  });
  return finalizePwaObserverRecord(base);
}

export function finalizePwaObserverRecord(record: UnsignedPwaObserverRecord): PwaObserverRecord {
  return Object.freeze({ ...record, recordHash: contentHash(record) });
}

const RECORD_KEYS = ["formatVersion", "scope", "kind", "chainId", "transactionHash", "blockNumber", "blockHash", "confirmations", "safe", "guard", "delay", "usdc", "amount", "profileHash", "deploymentsHash", "policyHash", "topologyReportHash", "outerEnvelopeHash", "beforeStateHash", "afterStateHash", "observer", "sources", "notificationDelivery", "observedAt", "recordHash"] as const;
const KINDS = new Set<PreparedPwaIntent["kind"]>(["base-transfer", "step-up-transfer", "queue-transfer", "add-recipient", "cancel-queued", "execute-ready", "skip-expired"]);

function parseRecord(value: unknown): PwaObserverRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("observer record must be an object");
  const item = value as Record<string, unknown>;
  assertExactKeys(item, RECORD_KEYS, "observer record");
  if (item.formatVersion !== 1 || item.scope !== "sepolia-pwa-receipt-observation" || item.chainId !== SEPOLIA_CHAIN_ID || typeof item.kind !== "string" || !KINDS.has(item.kind as PreparedPwaIntent["kind"])) throw new Error("observer record identity is invalid");
  for (const key of ["transactionHash", "blockHash", "profileHash", "deploymentsHash", "policyHash", "topologyReportHash", "outerEnvelopeHash", "beforeStateHash", "afterStateHash", "recordHash"] as const) assertHash(item[key], `observer record ${key}`);
  for (const key of ["blockNumber", "amount"] as const) if (typeof item[key] !== "string" || !DECIMAL.test(item[key] as string)) throw new Error(`observer record ${key} is invalid`);
  for (const key of ["safe", "guard", "delay", "usdc"] as const) if (typeof item[key] !== "string") throw new Error(`observer record ${key} is invalid`); else getAddress(item[key] as string);
  if (!Number.isInteger(item.confirmations) || Number(item.confirmations) < 1) throw new Error("observer record confirmation depth is invalid");
  if (item.notificationDelivery !== "not-claimed") throw new Error("observer record cannot claim notification delivery");
  if (typeof item.observedAt !== "string" || !Number.isFinite(Date.parse(item.observedAt))) throw new Error("observer record observation time is invalid");
  assertObserverIdentity(item.observer as PwaObserverIdentity);
  if (!Array.isArray(item.sources) || item.sources.length !== 2 || item.sources.some((source) => typeof source !== "string" || !SOURCE_ID.test(source)) || item.sources[0] === item.sources[1]) throw new Error("observer record lacks independent opaque sources");
  const { recordHash, ...base } = item;
  if (!same(recordHash as string, contentHash(base))) throw new Error("observer record hash mismatch");
  return Object.freeze({ ...(item as unknown as PwaObserverRecord), observer: Object.freeze({ ...(item.observer as PwaObserverIdentity) }), sources: Object.freeze([item.sources[0], item.sources[1]] as [string, string]) });
}

export function serializePwaObserverRecord(record: PwaObserverRecord): string {
  return `${canonical(parseRecord(record))}\n`;
}

function sha256Hex(bytes: string): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
}

function assertPublicRecordShape(value: unknown): void {
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (typeof item === "string" && (/\b(?:https?|wss?):\/\//i.test(item) || /(?:api[-_]?key|access[-_]?token|secret|password|credential)=/i.test(item))) throw new Error("evidence record contains a secret-bearing endpoint value");
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (/assertion|signature|credential|private|secret|mnemonic|seed|pin|rpc|sign|write|broadcast|authority/i.test(key)) throw new Error(`evidence record contains authority-shaped field: ${key}`);
      visit(child);
    }
  };
  visit(value);
}

export function packagePwaEvidence(inputDirectory: string, outputDirectory: string): PwaEvidenceManifest {
  if (!existsSync(inputDirectory) || !lstatSync(inputDirectory).isDirectory()) throw new Error("evidence input directory is missing");
  if (existsSync(outputDirectory)) throw new Error("evidence output directory already exists");
  const files = readdirSync(inputDirectory).sort();
  if (files.length === 0 || files.some((file) => basename(file) !== file || !/^[A-Za-z0-9._-]+\.json$/.test(file))) throw new Error("evidence input files are invalid");
  const validated = files.map((file) => {
    const path = join(inputDirectory, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error("evidence input must be a bounded regular file");
    const bytes = readFileSync(path, "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(bytes); } catch { throw new Error("evidence input is not valid JSON"); }
    assertPublicRecordShape(parsed);
    const record = parseRecord(parsed);
    return Object.freeze({ file, bytes: serializePwaObserverRecord(record), record });
  });
  const reference = validated[0].record;
  const coherentKeys = ["chainId", "safe", "guard", "delay", "usdc", "profileHash", "deploymentsHash", "policyHash", "topologyReportHash", "confirmations"] as const;
  const seenTransactions = new Set<string>();
  for (const { record } of validated) {
    for (const key of coherentKeys) if (canonical(record[key]) !== canonical(reference[key])) throw new Error(`evidence records mix incompatible ${key}`);
    if (record.observer.processId !== reference.observer.processId || !same(record.observer.executableHash, reference.observer.executableHash) || canonical(record.sources) !== canonical(reference.sources)) throw new Error("evidence records mix observer identities or sources");
    const transaction = record.transactionHash.toLowerCase();
    if (seenTransactions.has(transaction)) throw new Error("evidence records contain a duplicate transaction");
    seenTransactions.add(transaction);
  }
  const records = Object.freeze(validated.map(({ file, bytes, record }) => Object.freeze({ file, sha256: sha256Hex(bytes), kind: record.kind, transactionHash: record.transactionHash, observerProcessId: record.observer.processId })));
  const base = Object.freeze({ formatVersion: 1 as const, scope: "sepolia-pwa-phase-one-evidence" as const, notificationDelivery: "not-claimed" as const, records });
  const manifest = Object.freeze({ ...base, manifestHash: contentHash(base) });
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  for (const item of validated) writeFileSync(join(outputDirectory, item.file), item.bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  writeFileSync(join(outputDirectory, "manifest.json"), `${canonical(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return manifest;
}
