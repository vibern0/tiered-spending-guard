import { describe, expect, it } from "vitest";
import { mergeBackendHistory, type HistoryRecord } from "./backend-history";
import type { ActivityItem } from "./activity-model";
const hash = `0x${"11".repeat(32)}` as const;
const address = `0x${"22".repeat(20)}` as const;
const record: HistoryRecord = {
  id: "confirmed",
  kind: "transfer",
  transactionHash: hash,
  blockNumber: 9n,
  blockHash: hash,
  logIndex: 0,
  timestamp: 100,
  direction: "in",
  amount: 9007199254740993n,
  counterparty: address,
};
const local: ActivityItem = {
  id: "local",
  direction: "out",
  amount: 1n,
  address,
  counterparty: address,
  lane: "base",
  status: "submitting",
  createdAt: 1,
  txHash: hash,
  approvers: [],
  fingerprint: "local",
};
describe("backend history projection", () => {
  it("shows outside-app deposits with exact bigint amounts and seconds converted to milliseconds", () => {
    expect(mergeBackendHistory([record], [], [], 110)[0]).toMatchObject({
      direction: "in",
      amount: 9007199254740993n,
      createdAt: 100000,
      status: "executed",
    });
  });
  it("replaces the same local outer hash with confirmed history", () => {
    expect(mergeBackendHistory([record], [], [local], 110)).toHaveLength(1);
  });
  it("preserves live queue controls when a confirmed proposal has the same fingerprint", () => {
    const queue = {
      ...local,
      id: "queue",
      lane: "delayed" as const,
      txHash: hash,
      status: "queued" as const,
      queueNonce: 0,
      earliestExecution: 200000,
    };
    const rows = mergeBackendHistory(
      [{ ...record, lane: "delayed", status: "queued", queueFingerprint: hash, queueNonce: 0n }],
      [queue],
      [],
      110,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "queue",
      queueNonce: 0,
      txHash: hash,
      earliestExecution: 200000,
    });
  });
  it("keeps lifecycle events and failed unrelated attempts distinct and labels self transfers", () => {
    const { txHash: _txHash, ...unmined } = local;
    const rows = mergeBackendHistory(
      [
        { ...record, direction: "self" },
        { ...record, id: "cancel", kind: "cancel", logIndex: 1 },
      ],
      [],
      [{ ...unmined, status: "failed" }],
      110,
    );
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === "confirmed")?.direction).toBe("self");
  });
});

it("keeps one expired proposal with live skip controls and removes a queue resolved outside the app", () => {
  const queue: ActivityItem = {
    ...local,
    id: "queue",
    queueNonce: 0,
    lane: "delayed",
    status: "expired",
  };
  expect(
    mergeBackendHistory(
      [{ ...record, status: "expired", lane: "delayed", queueFingerprint: hash, queueNonce: 0n }],
      [queue],
      [],
      110,
    ),
  ).toHaveLength(1);
  const cancelled = mergeBackendHistory(
    [{ ...record, kind: "cancel", status: "cancelled", queueFingerprint: hash, queueNonce: 0n }],
    [queue],
    [],
    110,
  );
  expect(cancelled.map((item) => item.id)).toEqual(["confirmed"]);
});

it("shows unresolved outcomes without retaining stale live queue controls", () => {
  const queue: ActivityItem = {
    ...local,
    id: "queue",
    queueNonce: 0,
    lane: "delayed",
    status: "queued",
  };
  const rows = mergeBackendHistory(
    [{ ...record, status: "unresolved", queueFingerprint: hash, queueNonce: 0n }],
    [queue],
    [],
    110,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "unresolved" });
  expect(rows[0]?.queueNonce).toBeUndefined();
});
