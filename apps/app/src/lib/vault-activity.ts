import { encodeFunctionData, hashTypedData, keccak256, toHex, type Address, type Hex } from "viem";
import { fingerprintOf, type ActivityItem } from "./activity-model";
import type { VaultSnapshot } from "./vault-chain";
import type { SafeExecutionRequest } from "./vault-store";

export type VaultActivityLog = Readonly<{ address: Address; eventName: "TransferAuthorized" | "TransactionAdded" | "TxNonceSet" | "DelayedCancelled" | "DelayedExecuted" | "DelayedExpired"; transactionHash: Hex; logIndex: number; blockTimestamp: number; args: Readonly<Record<string, unknown>> | readonly unknown[] }>;
export type WalletAlert = Readonly<{ code: string; severity: "blocking" | "warning"; message: string }>;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SAFE_TX_TYPES = [
  { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
] as const;
const same = (a: string | undefined, b: string | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const readArg = <T>(args: VaultActivityLog["args"], key: string, index: number): T | undefined => Array.isArray(args) ? args[index] as T | undefined : (args as Readonly<Record<string, unknown>>)[key] as T | undefined;

function queueStatus(createdAt: number, snapshot: VaultSnapshot, now: number): ActivityItem["status"] {
  const cooldown = Number(snapshot.topology?.delay.cooldownSeconds ?? 86_400n) * 1000;
  const expiration = Number(snapshot.topology?.delay.expirationSeconds ?? 0n) * 1000;
  if (expiration > 0 && now >= createdAt + cooldown + expiration) return "expired";
  if (now >= createdAt + cooldown) return "ready";
  return "queued";
}

export function projectVaultActivity(logs: readonly VaultActivityLog[], snapshot: VaultSnapshot, now = Date.now()): ActivityItem[] {
  const seen = new Set<string>(); const result: ActivityItem[] = [];
  for (const log of logs) {
    const identity = `${log.transactionHash}:${log.logIndex}`; if (seen.has(identity)) continue; seen.add(identity);
    if (same(log.address, snapshot.topology?.guard) && log.eventName === "TransferAuthorized") {
      const token = readArg<Address>(log.args, "token", 1); const recipient = readArg<Address>(log.args, "recipient", 2); const amount = readArg<bigint>(log.args, "amount", 3); const tier = Number(readArg<number | bigint>(log.args, "tier", 0));
      if (!same(token, snapshot.usdc?.address) || !recipient || amount === undefined) continue;
      result.push({ id: identity, direction: "out", amount, counterparty: recipient, address: recipient, lane: tier === 0 ? "base" : "step-up", status: "executed", createdAt: log.blockTimestamp * 1000, txHash: log.transactionHash, approvers: tier === 0 ? ["First signer"] : ["First signer", "Second signer"], fingerprint: fingerprintOf([snapshot.chainId, snapshot.safe, recipient, amount, log.transactionHash]) });
      continue;
    }
    if (same(log.address, snapshot.topology?.delay.address) && log.eventName === "TransactionAdded") {
      const queueNonce = readArg<bigint>(log.args, "queueNonce", 0); const recipient = readArg<Address>(log.args, "to", 2); const value = readArg<bigint>(log.args, "value", 3) ?? 0n; const txHash = readArg<Hex>(log.args, "txHash", 1) ?? log.transactionHash;
      if (queueNonce === undefined || !recipient) continue;
      const createdAt = log.blockTimestamp * 1000;
      result.push({ id: identity, direction: "out", amount: value, counterparty: recipient, address: recipient, lane: "delayed", status: queueStatus(createdAt, snapshot, now), createdAt, earliestExecution: createdAt + Number(snapshot.topology?.delay.cooldownSeconds ?? 86_400n) * 1000, expiresAt: createdAt + Number((snapshot.topology?.delay.cooldownSeconds ?? 86_400n) + (snapshot.topology?.delay.expirationSeconds ?? 0n)) * 1000, txHash, queueNonce: Number(queueNonce), approvers: ["First signer", "Second signer"], fingerprint: fingerprintOf([snapshot.chainId, snapshot.safe, snapshot.topology?.delay.address ?? "", queueNonce, txHash]) });
    }
  }
  return result;
}

export function projectAlerts(snapshot: VaultSnapshot): WalletAlert[] {
  const alerts: WalletAlert[] = snapshot.health.map((failure) => ({ code: failure.code, severity: "blocking", message: failure.message }));
  const policy = snapshot.policy; const spend = snapshot.spendState;
  if (policy && spend && policy.instantDailyLimit > 0n && spend.instantSpent * 100n >= policy.instantDailyLimit * 80n) alerts.push({ code: "near-instant-limit", severity: "warning", message: "Instant USDC spending is near its daily limit." });
  if (snapshot.queueItems.some((item) => item.status === "pending")) alerts.push({ code: "queued-delay", severity: "warning", message: "A delayed operation is waiting in the verified Delay queue." });
  return alerts;
}

export type RecipientPolicyRepair = Readonly<{ snapshot: VaultSnapshot; recipient: Address }>;

export async function prepareRecipientPolicyRepair({ snapshot, recipient }: RecipientPolicyRepair): Promise<SafeExecutionRequest> {
  if (!snapshot.writable || snapshot.health.length > 0) throw new Error("vault health checks are blocking policy repair");
  const policy = snapshot.policy; const topology = snapshot.topology;
  if (!policy || !topology) throw new Error("verified USDC policy and Delay topology are required");
  if (recipient === ZERO || policy.recipients.some((entry) => same(entry, recipient))) throw new Error("recipient is already allowlisted or invalid");
  const repair = encodeFunctionData({ abi: [{ name: "repairPolicy", type: "function", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "basePerTx", type: "uint256" }, { name: "stepUpPerTx", type: "uint256" }, { name: "baseDaily", type: "uint256" }, { name: "instantDaily", type: "uint256" }, { name: "recipients", type: "address[]" }], outputs: [] }], functionName: "repairPolicy", args: [policy.token, policy.basePerTransaction, policy.stepUpPerTransaction, policy.baseDailyLimit, policy.instantDailyLimit, [...policy.recipients, recipient]] });
  const data = encodeFunctionData({ abi: [{ name: "execTransactionFromModule", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }], outputs: [{ name: "success", type: "bool" }] }], functionName: "execTransactionFromModule", args: [topology.guard, 0n, repair, 0] });
  const transaction = { to: topology.delay.address, value: 0n, data, operation: 0 as const, nonce: snapshot.safeNonce ?? 0n };
  const safeTxHash = hashTypedData({ domain: { chainId: snapshot.chainId, verifyingContract: snapshot.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { ...transaction, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO } });
  return { idempotencyKey: keccak256(toHex(`${snapshot.safe}:${recipient}:${snapshot.safeNonce?.toString() ?? "0"}`)), safeTxHash, safe: snapshot.safe, chainId: 11155111, transaction };
}
