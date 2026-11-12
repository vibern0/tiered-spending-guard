import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { PwaProvisioningSuccessor } from "@tiered-spending-guard/security-core/pwa";
import { describe, expect, it } from "vitest";
import {
  appendManagedPwaSuccessor,
  loadManagedPwaSuccessors,
  mergePwaSuccessors,
} from "../src/managed-successors";

const deployer = `0x${"11".repeat(20)}` as Address;
const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const first: PwaProvisioningSuccessor = {
  formatVersion: 1,
  scope: "sepolia-pwa-provisioning-successor",
  chainId: 11155111,
  originalPackageHash: hash("a"),
  confirmedPrefixLength: 2,
  consumedTransactions: [{ nonce: 2n, transactionHash: hash("b") }],
  expectedNextNonce: 3n,
};
const next: PwaProvisioningSuccessor = {
  ...first,
  consumedTransactions: [...first.consumedTransactions, { nonce: 3n, transactionHash: hash("c") }],
  expectedNextNonce: 4n,
};
const location = () =>
  join(mkdtempSync(join(tmpdir(), "pwa-managed-successors-")), "provisioning.json");

describe("backend-managed public successor lineage", () => {
  it("merges exact extensions of committed lineage across restart and rejects divergent histories", () => {
    expect(mergePwaSuccessors([first], [first])).toEqual([first]);
    expect(mergePwaSuccessors([first], [next])).toEqual([next]);
    expect(() => mergePwaSuccessors([next], [first])).toThrow(/lineage/);
    expect(() =>
      mergePwaSuccessors(
        [first],
        [
          {
            ...next,
            consumedTransactions: [
              { nonce: 2n, transactionHash: hash("d") },
              next.consumedTransactions[1]!,
            ],
          },
        ],
      ),
    ).toThrow(/lineage/);
  });
  it("retains append-only history, selects its longest exact extension and deduplicates retries", () => {
    const path = location();
    expect(loadManagedPwaSuccessors(path, deployer)).toEqual([]);
    appendManagedPwaSuccessor(path, deployer, first);
    const originalBytes = readFileSync(`${path}.successors.json`, "utf8");
    appendManagedPwaSuccessor(path, deployer, first);
    expect(readFileSync(`${path}.successors.json`, "utf8")).toBe(originalBytes);
    appendManagedPwaSuccessor(path, deployer, next);
    expect(loadManagedPwaSuccessors(path, deployer)).toEqual([next]);
    const stored = JSON.parse(readFileSync(`${path}.successors.json`, "utf8"));
    expect(stored.records).toHaveLength(2);
    expect(stored.records[0]).toEqual(JSON.parse(originalBytes).records[0]);
  });

  it("rejects conflicting lineage, role-prefix edits and a different payer without replacing records", () => {
    const path = location();
    appendManagedPwaSuccessor(path, deployer, first);
    const before = readFileSync(`${path}.successors.json`, "utf8");
    for (const bad of [
      {
        ...next,
        consumedTransactions: [
          { nonce: 2n, transactionHash: hash("d") },
          next.consumedTransactions[1]!,
        ],
      },
      { ...next, confirmedPrefixLength: 1 as const },
    ]) {
      expect(() => appendManagedPwaSuccessor(path, deployer, bad)).toThrow(/lineage/);
    }
    expect(() => loadManagedPwaSuccessors(path, `0x${"22".repeat(20)}`)).toThrow(/identity/);
    expect(readFileSync(`${path}.successors.json`, "utf8")).toBe(before);
  });

  it("rejects malformed records and unknown fields", () => {
    const path = location();
    appendManagedPwaSuccessor(path, deployer, first);
    const stored = JSON.parse(readFileSync(`${path}.successors.json`, "utf8"));
    stored.records[0].verified = true;
    writeFileSync(`${path}.successors.json`, JSON.stringify(stored));
    expect(() => loadManagedPwaSuccessors(path, deployer)).toThrow();
  });
});
