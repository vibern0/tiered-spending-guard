import { expect } from "chai";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { runPwaObserverCli } from "../../scripts/pwa/observe";
import {
  packagePwaEvidence,
  finalizePwaObserverRecord,
  serializePwaObserverRecord,
  type PwaObserverRecord,
} from "../../src/pwa/observer";

const h = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hex;

function record(overrides: Partial<PwaObserverRecord> = {}): PwaObserverRecord {
  const { recordHash: _ignored, ...fields } = overrides;
  return finalizePwaObserverRecord(Object.freeze({
    formatVersion: 1,
    scope: "sepolia-pwa-receipt-observation",
    kind: "base-transfer",
    chainId: 11155111,
    transactionHash: h(1),
    blockNumber: "100",
    blockHash: h(2),
    confirmations: 6,
    safe: "0x0000000000000000000000000000000000000001",
    guard: "0x0000000000000000000000000000000000000002",
    delay: "0x0000000000000000000000000000000000000003",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    amount: "1000000",
    profileHash: h(3),
    deploymentsHash: h(4),
    policyHash: h(5),
    topologyReportHash: h(6),
    outerEnvelopeHash: h(7),
    beforeStateHash: h(8),
    afterStateHash: h(9),
    observer: Object.freeze({ processId: "observer-process-a", executableHash: h(10), startedAt: "2026-10-31T20:00:00.000Z" }),
    sources: Object.freeze(["provider-a", "provider-b"] as const),
    notificationDelivery: "not-claimed",
    observedAt: "2026-10-31T20:05:00.000Z",
    ...fields,
  }));
}

describe("PWA evidence packaging", () => {
  it("fails closed instead of importing a caller-selected observer module", async () => {
    await expect(runPwaObserverCli(["/tmp/adapter.ts", h(1), "/tmp/record.json"])).to.be.rejectedWith(/disabled|fixed in-repository/i);
  });

  it("packages deterministic public observer records from a separate read-only process", () => {
    const root = mkdtempSync(join(tmpdir(), "pwa-evidence-"));
    const input = join(root, "input");
    const output = join(root, "output");
    try {
      mkdirSync(input);
      writeFileSync(join(input, "base.json"), serializePwaObserverRecord(record()), "utf8");
      const manifest = packagePwaEvidence(input, output);
      expect(manifest).to.include({ formatVersion: 1, scope: "sepolia-pwa-phase-one-evidence", notificationDelivery: "not-claimed" });
      expect(manifest.records).to.have.length(1);
      expect(manifest.records[0]).to.include({ file: "base.json", kind: "base-transfer", transactionHash: h(1), observerProcessId: "observer-process-a" });
      expect(existsSync(join(output, "manifest.json"))).to.equal(true);
      expect(readFileSync(join(output, "base.json"), "utf8")).to.equal(serializePwaObserverRecord(record()));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects notification claims, signing/write-shaped fields, same-source records, and output overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "pwa-evidence-reject-"));
    const input = join(root, "input");
    const output = join(root, "output");
    mkdirSync(input);
    try {
      writeFileSync(join(input, "claim.json"), JSON.stringify({ ...record(), notificationDelivery: "delivered" }), "utf8");
      expect(() => packagePwaEvidence(input, output)).to.throw(/notification/i);
      rmSync(join(input, "claim.json"));

      writeFileSync(join(input, "authority.json"), JSON.stringify({ ...record(), sign: "0xdead" }), "utf8");
      expect(() => packagePwaEvidence(input, output)).to.throw(/authority|sign|field/i);
      rmSync(join(input, "authority.json"));

      writeFileSync(join(input, "same-source.json"), JSON.stringify(record({ sources: ["provider-a", "provider-a"] })), "utf8");
      expect(() => packagePwaEvidence(input, output)).to.throw(/independent|source/i);
      rmSync(join(input, "same-source.json"));

      writeFileSync(join(input, "endpoint.json"), JSON.stringify(record({ sources: ["https://rpc.example/?apiKey=secret", "provider-b"] })), "utf8");
      expect(() => packagePwaEvidence(input, output)).to.throw(/endpoint|source|identifier/i);
      rmSync(join(input, "endpoint.json"));

      writeFileSync(join(input, "base.json"), serializePwaObserverRecord(record()), "utf8");
      packagePwaEvidence(input, output);
      expect(() => packagePwaEvidence(input, output)).to.throw(/exist|output/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate transactions and mixed Safe/profile/topology bundles", () => {
    for (const [name, second] of [
      ["duplicate", record({ observedAt: "2026-10-31T20:06:00.000Z" })],
      ["mixed-safe", record({ transactionHash: h(11), safe: "0x0000000000000000000000000000000000000011" })],
      ["mixed-profile", record({ transactionHash: h(12), profileHash: h(13) })],
      ["mixed-topology", record({ transactionHash: h(14), topologyReportHash: h(15) })],
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `pwa-evidence-${name}-`));
      const input = join(root, "input");
      mkdirSync(input);
      try {
        writeFileSync(join(input, "a.json"), serializePwaObserverRecord(record()), "utf8");
        writeFileSync(join(input, "b.json"), serializePwaObserverRecord(second), "utf8");
        expect(() => packagePwaEvidence(input, join(root, "output"))).to.throw(/duplicate|incompatible|mix/i);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
});
