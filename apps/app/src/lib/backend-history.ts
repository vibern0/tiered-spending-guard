import type { Address, Hex } from "viem";
import type { ActivityItem } from "./activity-model";

export type HistoryRecord = Readonly<{
  id: string;
  kind: "transfer" | "recipient-addition" | "cancel" | "execute" | "skip" | "unsupported";
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  logIndex: number;
  timestamp: number;
  direction: "in" | "out" | "self";
  amount: bigint;
  counterparty: Address;
  lane?: "base" | "step-up" | "delayed" | "blocked";
  queueNonce?: bigint;
  queueFingerprint?: Hex;
  readyAt?: number;
  expiresAt?: number;
  status?: "queued" | "executed" | "cancelled" | "expired" | "unresolved";
}>;
export type HistoryPage = Readonly<{
  items: readonly HistoryRecord[];
  nextCursor?: string;
  observedAt: number;
  indexedThrough?: bigint;
}>;

/** History observes confirmed events. Only the live verified queue supplies execution controls. */
export function mergeBackendHistory(
  records: readonly HistoryRecord[],
  queue: readonly ActivityItem[],
  local: readonly ActivityItem[],
  observedAt: number,
): ActivityItem[] {
  const confirmedHashes = new Set(records.map((record) => record.transactionHash.toLowerCase()));
  const matchesQueue = (record: HistoryRecord, item: ActivityItem) =>
    Boolean(
      record.queueFingerprint &&
      item.txHash?.toLowerCase() === record.queueFingerprint.toLowerCase() &&
      item.queueNonce !== undefined &&
      BigInt(item.queueNonce) === record.queueNonce,
    );
  const activeQueue = queue.filter(
    (item) =>
      !records.some(
        (record) =>
          matchesQueue(record, item) &&
          (record.status === "cancelled" ||
            record.status === "executed" ||
            record.status === "unresolved"),
      ),
  );
  const rows: ActivityItem[] = records
    .filter(
      (record) =>
        !(
          (record.status === "queued" || record.status === "expired") &&
          activeQueue.some((item) => matchesQueue(record, item))
        ),
    )
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      proposal: record.readyAt !== undefined,
      direction: record.direction,
      amount: record.amount,
      counterparty: record.counterparty,
      address: record.counterparty,
      lane: record.lane ?? "blocked",
      status: record.status ?? "executed",
      createdAt: record.timestamp * 1000,
      ...(record.readyAt === undefined ? {} : { earliestExecution: record.readyAt * 1000 }),
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt * 1000 }),
      canonicalNow: observedAt * 1000,
      txHash: record.transactionHash,
      approvers: [],
      fingerprint: record.queueFingerprint ?? record.transactionHash,
    }));
  return [
    ...rows,
    ...activeQueue,
    ...local.filter((item) => !item.txHash || !confirmedHashes.has(item.txHash.toLowerCase())),
  ].sort((left, right) => right.createdAt - left.createdAt);
}
