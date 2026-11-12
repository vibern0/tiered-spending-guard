import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as namespace from "@recent-tx-safe-guard/security-core/pwa";
import type { PwaObserverRecord } from "@recent-tx-safe-guard/security-core/pwa";
import { persistPwaObservation } from "../src/observations";
const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
const evidence = vi.hoisted(() => ({ events: [] as string[], fail: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      evidence.events.push(fs.fstatSync(fd).isDirectory() ? "sync-directory" : "sync-file");
      if (evidence.fail) throw new Error("sync failed");
      fs.fsyncSync(fd);
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      evidence.events.push("publish");
      fs.linkSync(...args);
    },
  };
});
const h = `0x${"ab".repeat(32)}` as Hex;
const a = `0x${"12".repeat(20)}` as Address;
const dirs: string[] = [];
function record(overrides: Partial<PwaObserverRecord> = {}): PwaObserverRecord {
  const base = {
    formatVersion: 1,
    scope: "sepolia-pwa-receipt-observation",
    kind: "base-transfer",
    chainId: 11155111,
    transactionHash: h,
    blockNumber: "20",
    blockHash: h,
    confirmations: 6,
    safe: a,
    guard: a,
    delay: a,
    usdc: a,
    amount: "1",
    profileHash: h,
    deploymentsHash: h,
    policyHash: h,
    topologyReportHash: h,
    outerEnvelopeHash: h,
    beforeStateHash: h,
    afterStateHash: h,
    observer: { processId: "test-observer", executableHash: h, startedAt: "2026-11-05T00:00:00Z" },
    sources: ["provider-a", "provider-b"],
    notificationDelivery: "not-claimed",
    observedAt: "2026-11-05T00:01:00Z",
    ...overrides,
  };
  return {
    ...base,
    recordHash: keccak256(stringToHex(core.canonicalSubmissionJson(base))),
  } as PwaObserverRecord;
}
afterEach(() => {
  evidence.fail = false;
  evidence.events.length = 0;
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "pwa-observations-"));
  dirs.push(dir);
  return dir;
}
describe("durable public receipt observations", () => {
  it("publishes only complete validated evidence and syncs its directory", () => {
    const dir = directory(),
      value = record();
    const path = persistPwaObservation(dir, value);
    expect(evidence.events).toEqual(["sync-file", "publish", "sync-directory"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(value);
  });
  it("leaves no apparently complete record if file sync fails", () => {
    const dir = directory();
    evidence.fail = true;
    expect(() => persistPwaObservation(dir, record())).toThrow(/sync failed/);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("retains valid earlier evidence on repeated reconciliation and rejects corrupt or conflicting records", () => {
    const dir = directory(),
      first = record(),
      path = persistPwaObservation(dir, first),
      bytes = readFileSync(path, "utf8");
    persistPwaObservation(
      dir,
      record({
        observedAt: "2026-11-05T01:00:00Z",
        observer: { ...first.observer, processId: "restarted-observer" },
      }),
    );
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(() => persistPwaObservation(dir, record({ amount: "2" }))).toThrow(/conflict/);
    writeFileSync(path, "{}");
    expect(() => persistPwaObservation(dir, record())).toThrow(/observer/);
  });
});
