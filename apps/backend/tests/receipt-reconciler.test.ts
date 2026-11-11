import { afterEach, describe, expect, it, vi } from "vitest";
import { startReceiptReconciler } from "../src/receipt-reconciler";
import { SubmissionJournal } from "../src/journal";
import { PwaSubmissionService } from "../src/vault";

afterEach(() => vi.useRealTimers());

describe("automatic receipt reconciliation worker", () => {
  it("starts immediately, never overlaps, and waits twelve seconds after completion before retrying", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sweep = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined);
    const worker = startReceiptReconciler(sweep);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(sweep).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sweep).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(11_999);
      expect(sweep).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally { release(); await worker.stop(); }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("logs only a generic failure and retries without persisting an invented terminal result", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const sweep = vi.fn().mockRejectedValueOnce(new Error("https://secret.invalid/key account secret-123")).mockResolvedValue(undefined);
    const worker = startReceiptReconciler(sweep, { log });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toMatchObject({ level: "warn", code: "receipt_reconciliation_failed", stage: "receipt-reconciliation" });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|https|account/);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally { await worker.stop(); }
  });

  it("drains an active sweep on stop and never schedules more work", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sweep = vi.fn(() => gate);
    const worker = startReceiptReconciler(sweep);
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stop = worker.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopped).toBe(false);
    release();
    await stop;
    await worker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(true);
  });

  it("shares an ongoing manual status check and drains the exact durable receipt before shutdown", async () => {
    const hash = `0x${"12".repeat(32)}` as const;
    const journal = new SubmissionJournal();
    journal.prepare("pending", hash);
    journal.markSubmitting("pending", hash);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reconcile = vi.fn(async () => {
      await gate;
      return { status: "confirmed" as const, transactionHash: hash, blockNumber: 12n, blockHash: hash };
    });
    const broadcast = vi.fn();
    const service = new PwaSubmissionService({ journal, reconcile, broadcast, verifyApproval: vi.fn(), revalidate: vi.fn(), deriveOuterHash: vi.fn() });
    const manual = service.status("pending");
    const worker = startReceiptReconciler(async () => {
      for (const entry of journal.listPending()) await service.status(entry.id);
    });
    await Promise.resolve();
    let stopped = false;
    const stop = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(journal.get("pending")).toMatchObject({ state: "submitting", outerTransactionHash: hash });
    release();
    await Promise.all([stop, manual]);
    expect(journal.listPending()).toEqual([]);
    expect(journal.get("pending")).toMatchObject({ state: "confirmed", receipt: { transactionHash: hash, blockNumber: 12n, blockHash: hash } });
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(hash);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
