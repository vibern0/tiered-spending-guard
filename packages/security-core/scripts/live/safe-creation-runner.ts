import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import {
  isReviewedVaultDeploymentPlan,
  planHash,
  type VaultDeploymentPlan,
  type VerifiedVaultPrerequisites,
} from "../../src/topology/build";
import { sha256 } from "../plan-deployment";
import { PHASE_OUTLAY_LIMIT, submitLiveIntent, type LiveContext, type LiveJournal, type LiveReceipt } from "./submission";

const IDS = ["vault-setup-helper", "vault-guard", "vault-delay", "vault-maintenance"] as const;
const FILE = "safe-creation-review.json";
const HASH = /^0x[0-9a-fA-F]{64}$/;
const FORBIDDEN_PUBLIC_KEY = /(?:signature|private|secret|seed|mnemonic|credential|password|pin|rpc)/i;

type PublicPrerequisiteTransaction = Readonly<{
  id: string; hash: Hex; from: Address; to: null; nonce: string; chainId: string; type: string;
  value: string; inputHash: Hex; blockNumber: string; blockHash: Hex; status: string;
  contractAddress: Address; gasUsed: string; effectiveGasPrice: string; actualCostWei: string;
}>;

export type PublicPrerequisiteVerification = Readonly<{
  schemaVersion: number; chainId: string; packageHash: Hex; planHash: Hex; result: string;
  actualCostWei: string; transactions: readonly PublicPrerequisiteTransaction[];
}>;

type QuoteClient = Readonly<{
  chainId(): Promise<number>;
  block(): Promise<Readonly<{ number: bigint; hash: Hex }>>;
  blockHash(number: bigint): Promise<Hex>;
  latestNonce(): Promise<number>;
  pendingNonce(): Promise<number>;
  balance(): Promise<bigint>;
  code(address: Address): Promise<Hex | undefined>;
  transaction(hash: Hex): Promise<Readonly<{ hash: Hex; from: Address; to?: Address; nonce: number; chainId: number; type: "eip1559"; value: bigint; input: Hex }>>;
  receipt(hash: Hex): Promise<LiveReceipt | undefined>;
  estimateGas(transaction: Readonly<{ account: Address; to: Address; data: Hex; value: bigint; nonce: number; blockNumber: bigint }>): Promise<bigint>;
  call(transaction: Readonly<{ account: Address; to: Address; data: Hex; value: bigint; gas: bigint; nonce: number; blockNumber: bigint }>): Promise<unknown>;
  fees(): Promise<Readonly<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; baseFeePerGas: bigint }>>;
}>;

export type SafeCreationReviewReport = Readonly<{
  schemaVersion: 1;
  status: "AWAITING_HUMAN_REVIEW";
  chainId: "11155111";
  planHash: Hex;
  prerequisitePackageHash: Hex;
  prerequisiteVerificationHash: Hex;
  snapshotBlockNumber: string;
  snapshotBlockHash: Hex;
  currentFundingNonce: string;
  latestNonce: string;
  pendingNonce: string;
  balanceWei: string;
  estimatedGas: string;
  gasLimitCap: string;
  maxFeePerGasCap: string;
  maxPriorityFeePerGasCap: string;
  actualPrerequisiteCostWei: string;
  maximumSafeReservationWei: string;
  totalMaximumPhaseOutlayWei: string;
  transaction: Readonly<{ id: "vault-safe"; to: Address; data: Hex; value: "0"; operation: 0; nonce: string; predictedSafe: Address; initializerHash: Hex }>;
  prerequisiteReceipts: readonly Readonly<{ id: string; transactionHash: Hex; blockNumber: string; blockHash: Hex; gasUsed: string; effectiveGasPrice: string; actualCostWei: string }> [];
  exactLimitCallSucceeded: true;
  signed: false;
  broadcast: false;
}>;

export type SafeCreationQuote = Readonly<{ report: SafeCreationReviewReport }>;
export type SafeCreationApproval = Readonly<{ reportHash: Hex }>;
const quotes = new WeakMap<object, VaultDeploymentPlan>();
const approvals = new WeakMap<object, Readonly<{ plan: VaultDeploymentPlan; report: SafeCreationReviewReport }>>();

const decimal = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be a decimal string`);
  return BigInt(value);
};
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const assertNoForbiddenFields = (value: unknown, path = "Safe review package"): void => {
  if (Array.isArray(value)) return value.forEach((child, index) => assertNoForbiddenFields(child, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PUBLIC_KEY.test(key)) throw new Error(`${path}.${key} is forbidden`);
    assertNoForbiddenFields(child, `${path}.${key}`);
  }
};

function validatePrerequisiteProof(plan: VaultDeploymentPlan, verification: PublicPrerequisiteVerification, journal: LiveJournal): bigint {
  if (verification.schemaVersion !== 1 || verification.chainId !== "11155111" || verification.result !== "PASS" || !HASH.test(verification.packageHash) || !same(verification.planHash, planHash(plan))) throw new Error("Safe review prerequisite verification mismatch");
  if (journal.chainId !== 11155111 || !same(journal.funder, plan.deployer) || journal.entries.length !== 4 || verification.transactions.length !== 4) throw new Error("Safe review requires exactly four canonical prerequisite journal entries");
  const steps = Object.values(plan.prerequisites);
  let actual = 0n;
  for (let i = 0; i < 4; i++) {
    const expected = steps[i]!; const proof = verification.transactions[i]!; const entry = journal.entries[i]!; const id = IDS[i]!;
    if (proof.id !== id || entry.id !== id || entry.status !== "success" || !entry.receipt || proof.hash !== entry.transactionHash || entry.receipt.transactionHash !== entry.transactionHash || proof.nonce !== expected.nonce.toString() || entry.nonce !== Number(expected.nonce) || !same(proof.from, plan.deployer) || proof.to !== null || proof.chainId !== "11155111" || proof.type !== "0x2" || proof.value !== "0" || !same(proof.inputHash, keccak256(expected.data)) || !same(proof.contractAddress, expected.expectedCreatedAddress) || proof.status !== "0x1" || proof.blockNumber !== entry.receipt.blockNumber.toString() || !same(proof.blockHash, entry.receipt.blockHash) || proof.gasUsed !== entry.receipt.gasUsed.toString() || proof.effectiveGasPrice !== entry.receipt.effectiveGasPrice.toString()) throw new Error(`Safe review canonical prerequisite mismatch for ${id}`);
    const cost = entry.receipt.gasUsed * entry.receipt.effectiveGasPrice;
    if (proof.actualCostWei !== cost.toString() || entry.reserved !== cost) throw new Error(`Safe review prerequisite accounting mismatch for ${id}`);
    actual += cost;
  }
  if (verification.actualCostWei !== actual.toString()) throw new Error("Safe review prerequisite total mismatch");
  return actual;
}

async function verifyCanonicalReads(plan: VaultDeploymentPlan, verification: PublicPrerequisiteVerification, journal: LiveJournal, client: Pick<QuoteClient, "transaction" | "receipt" | "blockHash">): Promise<void> {
  const steps = Object.values(plan.prerequisites);
  for (let i = 0; i < 4; i++) {
    const proof = verification.transactions[i]!; const entry = journal.entries[i]!; const expected = steps[i]!;
    const [transaction, receipt, canonicalHash] = await Promise.all([client.transaction(entry.transactionHash), client.receipt(entry.transactionHash), client.blockHash(entry.receipt!.blockNumber)]);
    if (!receipt || transaction.hash !== entry.transactionHash || !same(transaction.from, plan.deployer) || transaction.to !== undefined || transaction.nonce !== Number(expected.nonce) || transaction.chainId !== 11155111 || transaction.type !== "eip1559" || transaction.value !== 0n || !same(transaction.input, expected.data) || receipt.transactionHash !== entry.transactionHash || receipt.status !== "success" || receipt.gasUsed !== entry.receipt!.gasUsed || receipt.effectiveGasPrice !== entry.receipt!.effectiveGasPrice || receipt.blockNumber !== entry.receipt!.blockNumber || !same(receipt.blockHash, entry.receipt!.blockHash) || !same(canonicalHash, proof.blockHash)) throw new Error(`Safe review canonical receipt changed for ${IDS[i]}`);
  }
}

export async function collectSafeCreationQuote(plan: VaultDeploymentPlan, verification: PublicPrerequisiteVerification, journal: LiveJournal, client: QuoteClient, caps: Readonly<{ gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>): Promise<SafeCreationQuote> {
  if (!isReviewedVaultDeploymentPlan(plan)) throw new Error("Safe review requires the opaque reviewed deployment plan");
  const actualCost = validatePrerequisiteProof(plan, verification, journal);
  if (await client.chainId() !== 11155111) throw new Error("Safe review requires Ethereum Sepolia");
  await verifyCanonicalReads(plan, verification, journal, client);
  const minimumNonce = plan.startingNonce + 4n;
  const [snapshot, latest, pending, balance, safeCode, fees] = await Promise.all([client.block(), client.latestNonce(), client.pendingNonce(), client.balance(), client.code(plan.safeProxyDeployment.expectedCreatedAddress), client.fees()]);
  if (BigInt(latest) < minimumNonce || latest !== pending) throw new Error("Safe review latest and pending nonce must match at or after the prerequisite DAG");
  if (safeCode && safeCode !== "0x") throw new Error("Safe review predicted Safe is already deployed");
  if (caps.gasLimit <= 0n || caps.maxFeePerGas <= 0n || caps.maxPriorityFeePerGas < 0n || caps.maxPriorityFeePerGas > caps.maxFeePerGas || fees.maxFeePerGas > caps.maxFeePerGas || fees.maxPriorityFeePerGas > caps.maxPriorityFeePerGas || fees.baseFeePerGas > caps.maxFeePerGas) throw new Error("Safe review fee cap invalid or exceeded");
  const tx = { account: plan.deployer, to: plan.safeProxyDeployment.to, data: plan.safeProxyDeployment.data, value: 0n, nonce: latest, blockNumber: snapshot.number };
  const estimatedGas = await client.estimateGas(tx);
  if (estimatedGas <= 0n || estimatedGas > caps.gasLimit) throw new Error("Safe review gas cap exceeded");
  await client.call({ ...tx, gas: caps.gasLimit });
  const reservation = caps.gasLimit * caps.maxFeePerGas;
  const total = actualCost + reservation;
  if (reservation > balance) throw new Error("Safe review balance is below Safe reservation");
  if (total > PHASE_OUTLAY_LIMIT) throw new Error("Safe review phase outlay cap exceeded");
  await verifyCanonicalReads(plan, verification, journal, client);
  const [finalBlockHash, finalLatest, finalPending, finalBalance] = await Promise.all([client.blockHash(snapshot.number), client.latestNonce(), client.pendingNonce(), client.balance()]);
  if (!same(finalBlockHash, snapshot.hash)) throw new Error("Safe review snapshot reorged before finalization");
  if (finalLatest !== latest || finalPending !== pending || finalLatest !== finalPending) throw new Error("Safe review nonce changed before finalization");
  if (finalBalance !== balance || finalBalance < reservation) throw new Error("Safe review balance changed before finalization");
  const report: SafeCreationReviewReport = Object.freeze({
    schemaVersion: 1, status: "AWAITING_HUMAN_REVIEW", chainId: "11155111", planHash: planHash(plan), prerequisitePackageHash: verification.packageHash,
    prerequisiteVerificationHash: sha256(verification) as Hex, snapshotBlockNumber: snapshot.number.toString(), snapshotBlockHash: snapshot.hash,
    currentFundingNonce: String(latest), latestNonce: String(latest), pendingNonce: String(pending), balanceWei: balance.toString(), estimatedGas: estimatedGas.toString(), gasLimitCap: caps.gasLimit.toString(), maxFeePerGasCap: caps.maxFeePerGas.toString(), maxPriorityFeePerGasCap: caps.maxPriorityFeePerGas.toString(), actualPrerequisiteCostWei: actualCost.toString(), maximumSafeReservationWei: reservation.toString(), totalMaximumPhaseOutlayWei: total.toString(),
    transaction: Object.freeze({ id: "vault-safe", to: plan.safeProxyDeployment.to, data: plan.safeProxyDeployment.data, value: "0", operation: 0, nonce: String(latest), predictedSafe: plan.safeProxyDeployment.expectedCreatedAddress, initializerHash: keccak256(plan.safeInitializer) }),
    prerequisiteReceipts: Object.freeze(journal.entries.map(entry => Object.freeze({ id: entry.id, transactionHash: entry.transactionHash, blockNumber: entry.receipt!.blockNumber.toString(), blockHash: entry.receipt!.blockHash, gasUsed: entry.receipt!.gasUsed.toString(), effectiveGasPrice: entry.receipt!.effectiveGasPrice.toString(), actualCostWei: entry.reserved.toString() }))), exactLimitCallSucceeded: true, signed: false, broadcast: false,
  });
  const quote = Object.freeze({ report }); quotes.set(quote, plan); return quote;
}

export function writeSafeCreationReviewPackage(quote: SafeCreationQuote, directory: string): Readonly<{ path: string; packageHash: Hex }> {
  if (!quotes.has(quote)) throw new Error("Safe review writer requires exact opaque quote");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, FILE); const packageHash = sha256(quote.report) as Hex;
  writeFileSync(path, JSON.stringify(quote.report, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return Object.freeze({ path, packageHash });
}

export function loadSafeCreationApproval(plan: VaultDeploymentPlan, verification: PublicPrerequisiteVerification, journal: LiveJournal, directory: string, expectedHash: Hex): SafeCreationApproval {
  if (!isReviewedVaultDeploymentPlan(plan) || !HASH.test(expectedHash)) throw new Error("Safe approval inputs invalid");
  validatePrerequisiteProof(plan, verification, journal);
  let report: SafeCreationReviewReport;
  try { report = JSON.parse(readFileSync(join(directory, FILE), "utf8")); } catch { throw new Error("Safe review package is unreadable"); }
  assertNoForbiddenFields(report);
  const actual = sha256(report) as Hex;
  if (!same(actual, expectedHash)) throw new Error("Safe review package hash mismatch");
  const tx = report.transaction;
  if (report.schemaVersion !== 1 || report.status !== "AWAITING_HUMAN_REVIEW" || report.chainId !== "11155111" || !same(report.planHash, planHash(plan)) || !same(report.prerequisitePackageHash, verification.packageHash) || !same(report.prerequisiteVerificationHash, sha256(verification)) || report.signed !== false || report.broadcast !== false || tx.id !== "vault-safe" || !same(tx.to, plan.safeProxyDeployment.to) || !same(tx.data, plan.safeProxyDeployment.data) || tx.value !== "0" || tx.operation !== 0 || !same(tx.predictedSafe, plan.safeProxyDeployment.expectedCreatedAddress) || !same(tx.initializerHash, keccak256(plan.safeInitializer))) throw new Error("Safe review package does not match exact plan and proof");
  const nonce = decimal(report.currentFundingNonce, "Safe funding nonce");
  if (nonce < plan.startingNonce + 4n || report.latestNonce !== report.currentFundingNonce || report.pendingNonce !== report.currentFundingNonce || tx.nonce !== report.currentFundingNonce) throw new Error("Safe review package nonce binding invalid");
  if (!Array.isArray(report.prerequisiteReceipts) || report.prerequisiteReceipts.length !== 4 || report.prerequisiteReceipts.some((receipt, index) => { const entry = journal.entries[index]!; return receipt.id !== entry.id || receipt.transactionHash !== entry.transactionHash || receipt.blockNumber !== entry.receipt!.blockNumber.toString() || !same(receipt.blockHash, entry.receipt!.blockHash) || receipt.gasUsed !== entry.receipt!.gasUsed.toString() || receipt.effectiveGasPrice !== entry.receipt!.effectiveGasPrice.toString() || receipt.actualCostWei !== entry.reserved.toString(); })) throw new Error("Safe review package prerequisite receipts do not match canonical journal");
  const actualCost = decimal(report.actualPrerequisiteCostWei, "prerequisite cost"); const gas = decimal(report.gasLimitCap, "gas cap"); const fee = decimal(report.maxFeePerGasCap, "fee cap");
  if (actualCost !== decimal(verification.actualCostWei, "verified prerequisite cost") || gas <= 0n || fee <= 0n || decimal(report.maxPriorityFeePerGasCap, "priority cap") > fee || !HASH.test(report.snapshotBlockHash) || report.exactLimitCallSucceeded !== true) throw new Error("Safe review package bounds invalid");
  if (actualCost + gas * fee !== decimal(report.totalMaximumPhaseOutlayWei, "phase total") || decimal(report.maximumSafeReservationWei, "reservation") !== gas * fee || actualCost + gas * fee > PHASE_OUTLAY_LIMIT) throw new Error("Safe review package accounting invalid");
  const approval = Object.freeze({ reportHash: actual }); approvals.set(approval, Object.freeze({ plan, report })); return approval;
}

export type SafeCreationExecutionContext = Readonly<{
  live: LiveContext; journal: LiveJournal;
  latestNonce(): Promise<number>; pendingNonce(): Promise<number>; currentBalance(): Promise<bigint>;
  safeCode(): Promise<Hex | undefined>;
  currentFees(): Promise<Readonly<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; baseFeePerGas: bigint }>>;
  estimateGas(): Promise<bigint>; exactCall(): Promise<unknown>; canonicalBlockHash(blockNumber: bigint): Promise<Hex>;
  verifyBeforeSetup(): Promise<VerifiedVaultPrerequisites>; waitForReceipt(hash: Hex): Promise<void>;
  verifyAfterSetup(): Promise<VerifiedVaultPrerequisites>; verifyTopology(): Promise<Readonly<{ ok: boolean; failures: readonly string[]; checked: readonly string[] }>>;
}>;

export async function executeSafeCreation(plan: VaultDeploymentPlan, approval: SafeCreationApproval, context: SafeCreationExecutionContext): Promise<Readonly<{ status: "SAFE_CREATED_TOPOLOGY_VERIFIED"; receipt: LiveReceipt }>> {
  const bound = approvals.get(approval);
  if (!bound || bound.plan !== plan) throw new Error("Safe execution requires the exact opaque approval");
  const report = bound.report; const nonce = Number(decimal(report.currentFundingNonce, "funding nonce"));
  const gasCap = decimal(report.gasLimitCap, "gas cap"), maxFee = decimal(report.maxFeePerGasCap, "fee cap"), priority = decimal(report.maxPriorityFeePerGasCap, "priority cap"), reservation = decimal(report.maximumSafeReservationWei, "reservation");
  const intent = Object.freeze({ id: "vault-safe", to: plan.safeProxyDeployment.to, data: plan.safeProxyDeployment.data, value: 0n, nonce, gas: gasCap, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority });
  const finish = async (entry: Awaited<ReturnType<typeof submitLiveIntent>>) => {
    if (entry.status === "pending") { await context.waitForReceipt(entry.transactionHash); entry = await submitLiveIntent(intent, context.journal, context.live); }
    if (entry.status !== "success" || !entry.receipt) throw new Error("Safe creation receipt is not successful");
    const after = await context.verifyAfterSetup();
    if (after.stage !== "after-setup" || !same(after.planHash, planHash(plan))) throw new Error("Safe post-setup prerequisite verification failed");
    const topology = await context.verifyTopology();
    if (!topology.ok) throw new Error(`Safe topology verification failed: ${topology.failures.join(", ")}`);
    return Object.freeze({ status: "SAFE_CREATED_TOPOLOGY_VERIFIED" as const, receipt: entry.receipt });
  };
  // A durable exact intent hash is the authority for resume. Once that known
  // transaction lands, pre-setup and empty-code checks must legitimately fail.
  if (context.journal.entries.some(entry => entry.id === "vault-safe")) return finish(await submitLiveIntent(intent, context.journal, context.live));
  const [latest, pending, balance, safeCode, fees, gas, canonical] = await Promise.all([context.latestNonce(), context.pendingNonce(), context.currentBalance(), context.safeCode(), context.currentFees(), context.estimateGas(), context.canonicalBlockHash(decimal(report.snapshotBlockNumber, "snapshot block"))]);
  if (latest !== nonce || pending !== nonce || latest !== pending) throw new Error("Safe execution latest and pending nonce changed");
  if (safeCode && safeCode !== "0x") throw new Error("Safe execution refuses an unknown pre-existing Safe");
  if (!same(canonical, report.snapshotBlockHash)) throw new Error("Safe execution canonical receipt snapshot changed");
  if (gas <= 0n || gas > gasCap) throw new Error("Safe execution gas cap exceeded");
  if (fees.maxFeePerGas > maxFee || fees.maxPriorityFeePerGas > priority || fees.maxPriorityFeePerGas > fees.maxFeePerGas || fees.baseFeePerGas > maxFee) throw new Error("Safe execution fee cap exceeded");
  if (balance < reservation) throw new Error("Safe execution balance below approved reservation");
  for (const receipt of report.prerequisiteReceipts) if (!same(await context.canonicalBlockHash(BigInt(receipt.blockNumber)), receipt.blockHash)) throw new Error("Safe execution canonical receipt changed");
  const before = await context.verifyBeforeSetup();
  if (before.stage !== "before-setup" || !same(before.planHash, planHash(plan))) throw new Error("Safe execution prerequisite topology mismatch");
  await context.exactCall();
  return finish(await submitLiveIntent(intent, context.journal, context.live));
}
