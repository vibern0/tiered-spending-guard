import { expect } from "chai";
import { getAddress } from "viem";
import { ActivityLedger, FileActivityStore, InMemoryActivityStore, type ActivityLogKey } from "../../../src/monitoring/ledger";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ActivityAlert } from "../../../src/monitoring/notifier";

const alert: ActivityAlert = {
  kind: "delayed-queued",
  chainId: 31337,
  safe: getAddress("0x0000000000000000000000000000000000000001"),
  delay: getAddress("0x0000000000000000000000000000000000000002"),
  transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
  blockNumber: 5n,
  logIndex: 0,
  queueNonce: 1n,
  queueFingerprint: "0x0000000000000000000000000000000000000000000000000000000000000001",
  createdAt: 5n,
  to: getAddress("0x0000000000000000000000000000000000000003"),
  value: 0n,
  data: "0x",
  operation: 0,
};
const key = (blockHash: string): ActivityLogKey => ({ chainId: 31337, blockHash: blockHash as `0x${string}`, transactionHash: alert.transactionHash, logIndex: 0 });

describe("monitoring ledger", () => {
  const evidence = { channel: "webhook" as const, httpStatus: 204, payloadHash: "0x0de6e25d93f1f09fdf15d869b88ad878940b0f7b3d2d93878542b2cd47cf3382" as const, deliveredAt: "2026-10-27T12:00:00.000Z" };
  it("persists a cursor and emits each confirmed log once", () => {
    const store = new InMemoryActivityStore();
    const ledger = new ActivityLedger(store);
    expect(ledger.accept(key("0x0000000000000000000000000000000000000000000000000000000000000005"), alert)).to.equal(true);
    expect(ledger.accept(key("0x0000000000000000000000000000000000000000000000000000000000000005"), alert)).to.equal(false);
    expect(store.load().cursor?.blockNumber).to.equal(5n);
    const restarted = new ActivityLedger(store);
    expect(restarted.accept(key("0x0000000000000000000000000000000000000000000000000000000000000005"), alert)).to.equal(false);
  });

  it("removes a reorged record and permits the replacement log", () => {
    const store = new InMemoryActivityStore();
    const ledger = new ActivityLedger(store);
    const oldKey = key("0x0000000000000000000000000000000000000000000000000000000000000005");
    const newKey = key("0x0000000000000000000000000000000000000000000000000000000000000006");
    ledger.accept(oldKey, alert);
    expect(ledger.remove(oldKey)).to.deep.equal(alert);
    expect(ledger.accept(newKey, { ...alert, blockNumber: 6n })).to.equal(true);
  });

  it("atomically persists and reloads cursor and records across process restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-monitor-"));
    try {
      const store = new FileActivityStore(join(dir, "ledger.json"));
      const ledger = new ActivityLedger(store);
      ledger.accept(key("0x0000000000000000000000000000000000000000000000000000000000000005"), alert);
      store.close?.();
      const restartedStore = new FileActivityStore(join(dir, "ledger.json"));
      const restarted = new ActivityLedger(restartedStore);
      expect(restarted.records()).to.have.length(1);
      expect(restarted.cursor()?.blockHash).to.equal("0x0000000000000000000000000000000000000000000000000000000000000005");
      expect(restarted.pending()).to.have.length(1);
      const pending = restarted.pending()[0].alert;
      expect(pending.kind).to.equal("delayed-queued");
      if (pending.kind !== "delayed-queued") throw new Error("unexpected alert kind");
      expect(pending.blockNumber).to.equal(5n);
      expect(pending.queueNonce).to.equal(1n);
      expect(pending.createdAt).to.equal(5n);
      restarted.markDelivered(key("0x0000000000000000000000000000000000000000000000000000000000000005"), { ...evidence, payloadHash: restarted.payloadHash(pending) });
      restartedStore.close?.();
      const deliveredStore = new FileActivityStore(join(dir, "ledger.json"));
      const delivered = new ActivityLedger(deliveredStore);
      expect(delivered.pending()).to.have.length(0);
      expect(delivered.delivery(key("0x0000000000000000000000000000000000000000000000000000000000000005"))).to.deep.include({ channel: "webhook", httpStatus: 204 });
      deliveredStore.close?.();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("persists pending before delivery and retries it after a failed notification", () => {
    const store = new InMemoryActivityStore();
    const ledger = new ActivityLedger(store);
    const k = key("0x0000000000000000000000000000000000000000000000000000000000000005");
    expect(ledger.accept(k, alert)).to.equal(true);
    expect(ledger.pending()).to.have.length(1);
    expect(ledger.accept(k, alert)).to.equal(false);
    ledger.markDelivered(k, { ...evidence, payloadHash: ledger.payloadHash(alert) });
    expect(ledger.pending()).to.have.length(0);
  });

  it("keeps pending delivery when evidence is absent or bound to another payload", () => {
    const ledger = new ActivityLedger(new InMemoryActivityStore());
    const k = key("0x0000000000000000000000000000000000000000000000000000000000000005");
    ledger.accept(k, alert);
    expect(() => ledger.markDelivered(k, undefined as never)).to.throw(/evidence/i);
    expect(() => ledger.markDelivered(k, evidence)).to.throw(/payload/i);
    expect(ledger.pending()).to.have.length(1);
  });

  it("rejects malformed persisted alert bigint and safe-integer fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-monitor-malformed-"));
    try {
      const path = join(dir, "ledger.json");
      const id = `31337:${alert.transactionHash}:0:0x${"05".padStart(64,"0")}`;
      for (const malformed of [
        { ...alert, blockNumber: 5 },
        { ...alert, queueNonce: "not-an-integer" },
        { ...alert, operation: 1.5 },
      ]) {
        writeFileSync(path, JSON.stringify({ records: { [id]: malformed }, outbox: { [id]: malformed } }, (_, value) => typeof value === "bigint" ? value.toString() : value));
        const store = new FileActivityStore(path);
        expect(() => new ActivityLedger(store)).to.throw(/malformed|invalid/i);
        store.close();
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects delivery evidence whose payload hash no longer matches the durable record", () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-monitor-evidence-"));
    const path = join(dir, "ledger.json");
    try {
      const recordId = `31337:${alert.transactionHash}:0:0x${"05".padStart(64,"0")}`;
      writeFileSync(path, JSON.stringify({ records: { [recordId]: alert }, outbox: {}, deliveries: { [recordId]: evidence } }, (_, value) => typeof value === "bigint" ? value.toString() : value));
      const store = new FileActivityStore(path);
      expect(() => new ActivityLedger(store)).to.throw(/payload mismatch/i);
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails closed when a second file ledger writer is opened", () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-monitor-lock-"));
    try {
      const path = join(dir, "ledger.json");
      const first = new FileActivityStore(path);
      expect(() => new FileActivityStore(path)).to.throw(/lock|writer/i);
      first.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reconciles records against canonical block hashes before replay", () => {
    const store = new InMemoryActivityStore();
    const ledger = new ActivityLedger(store);
    const old = key("0x0000000000000000000000000000000000000000000000000000000000000005");
    ledger.accept(old, alert);
    expect(ledger.reconcileCanonical(31337, () => "0x0000000000000000000000000000000000000000000000000000000000000006")).to.equal(1);
    expect(ledger.records()).to.have.length(0);
  });
});
