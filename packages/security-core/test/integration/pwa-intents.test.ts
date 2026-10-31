import { expect } from "chai";
import { getAddress, type Hex } from "viem";
import {
  assertSamePreparedPwaIntent,
  brandVerifiedPwaSnapshotForTestsOnly,
  captureVerifiedPwaSnapshot,
  preparePwaIntent,
  simulatePwaIntent,
  type VerifiedPwaSnapshot,
} from "../../src/pwa/intents";
import { queueFingerprint } from "../../src/queue/delay";
import { PWA_RECIPIENT, SEPOLIA_USDC_ADDRESS } from "../../src/pwa/profile";
import { brandPwaProvisioningResultForTestsOnly } from "../../src/pwa/provisioning";

const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function snapshot(): VerifiedPwaSnapshot {
  process.env.NODE_ENV = "test";
  const safe = a(1), delay = a(3), usdc = SEPOLIA_USDC_ADDRESS, recipient = PWA_RECIPIENT;
  const data = `0xa9059cbb${recipient.slice(2).padStart(64, "0")}${(4_000_000n).toString(16).padStart(64, "0")}`.toLowerCase() as Hex;
  const item = { safe, delay, to: usdc, value: 0n, data, operation: 0 as const, queueNonce: 4n };
  return brandVerifiedPwaSnapshotForTestsOnly(Object.freeze({
    formatVersion: 1, chainId: 11155111, blockNumber: 100n, blockHash: h(100), timestamp: 1_000n,
    deploymentsHash: h(101), policyHash: h(102), safe, guard: a(2), delay, usdc, recipient,
    primaryPasskey: a(4), secondaryPasskey: a(5), safeNonce: 9n,
    spendState: { window: 0n, baseSpent: 0n, instantSpent: 0n }, limits: { basePerTransaction: 1_000_000n, baseDailyLimit: 1_000_000n, stepUpPerTransaction: 3_000_000n, instantDailyLimit: 3_000_000n },
    cooldownSeconds: 120n, expirationSeconds: 600n, queueHeadNonce: 4n, queueTailNonce: 5n,
    queueHead: { ...item, queueFingerprint: queueFingerprint(item), createdAt: 800n, readyAt: 920n, expiresAt: 1_520n },
  }));
}

describe("PWA intent simulation boundary", () => {
  it("captures all state at one block and rejects a block-hash change", async () => {
    const expected = snapshot();
    const vault = brandPwaProvisioningResultForTestsOnly({ chainId: 11155111, safe: expected.safe, guard: expected.guard, delay: expected.delay, primaryPasskey: expected.primaryPasskey, secondaryPasskey: expected.secondaryPasskey, usdc: expected.usdc, deploymentsHash: expected.deploymentsHash, policyHash: expected.policyHash, setupReceipt: { transactionHash: h(200), blockNumber: 99n }, topologyReportHash: h(201) });
    const { formatVersion: _formatVersion, chainId: _chainId, blockNumber: _blockNumber, blockHash: _blockHash, timestamp: _timestamp, ...state } = expected;
    const calls: string[] = [];
    const captured = await captureVerifiedPwaSnapshot(vault, 100n, {
      async getBlock({ blockNumber }) { calls.push("block"); return { number: blockNumber, hash: h(100), timestamp: 1_000n }; },
      async readAt(blockNumber) { calls.push(`read:${blockNumber}`); return state; },
    });
    expect(captured.blockHash).to.equal(h(100));
    expect(calls).to.deep.equal(["block", "read:100", "block"]);
    const wrongVault = brandPwaProvisioningResultForTestsOnly({ ...vault, policyHash: h(999) });
    await expect(captureVerifiedPwaSnapshot(wrongVault, 100n, { async getBlock({ blockNumber }) { return { number: blockNumber, hash: h(100), timestamp: 1_000n }; }, async readAt() { return state; } })).to.be.rejectedWith(/provisioning|topology/i);
    let read = 0;
    await expect(captureVerifiedPwaSnapshot(vault, 100n, {
      async getBlock({ blockNumber }) { read += 1; return { number: blockNumber, hash: read === 1 ? h(100) : h(999), timestamp: 1_000n }; },
      async readAt() { return state; },
    })).to.be.rejectedWith(/reorg/i);
  });

  it("simulates at the snapshot block and rechecks the same canonical block hash without exposing broadcast", async () => {
    const prepared = preparePwaIntent(snapshot(), { kind: "execute-ready", queueNonce: 4n, queueFingerprint: snapshot().queueHead!.queueFingerprint });
    const calls: string[] = [];
    const evidence = await simulatePwaIntent(prepared, {
      async getBlock({ blockNumber }) { calls.push(`block:${blockNumber}`); return { number: blockNumber, hash: h(100) }; },
      async call(input) { calls.push(`call:${input.blockNumber}`); return { data: "0x" as Hex }; },
    });
    expect(evidence.ok).to.equal(true);
    expect(calls).to.deep.equal(["block:100", "call:100", "block:100"]);
    expect(evidence).not.to.have.any.keys("broadcast", "transactionHash", "rawTransaction");
  });

  it("records early/reverting eth_call evidence and rejects reorgs or any prepared-field mutation", async () => {
    const ready = preparePwaIntent(snapshot(), { kind: "execute-ready", queueNonce: 4n, queueFingerprint: snapshot().queueHead!.queueFingerprint });
    const failed = await simulatePwaIntent(ready, {
      async getBlock({ blockNumber }) { return { number: blockNumber, hash: h(100) }; },
      async call() { throw new Error("execution reverted: cooldown"); },
    });
    expect(failed).to.deep.include({ ok: false, reason: "execution reverted: cooldown" });
    const prepared = preparePwaIntent(snapshot(), { kind: "transfer", recipient: snapshot().recipient, amount: 1_000_000n });
    await expect(simulatePwaIntent(prepared, {
      async getBlock({ blockNumber }) { return { number: blockNumber, hash: h(999) }; }, async call() { return { data: "0x" as Hex }; },
    })).to.be.rejectedWith(/block|reorg/i);

    const fields = ["safe", "delay", "asset", "recipient", "amount", "timestamp", "snapshotHash", "blockHash", "policyHash", "deploymentsHash", "safeTxHash"] as const;
    for (const field of fields) expect(() => assertSamePreparedPwaIntent(prepared, { ...prepared, [field]: field === "amount" ? prepared.amount + 1n : field === "timestamp" ? prepared.timestamp + 1n : field.endsWith("Hash") ? h(999) : a(99) })).to.throw(/mutated|prepared/i);
    expect(() => assertSamePreparedPwaIntent(prepared, { ...prepared, signature: h(1) })).to.throw(/mutated|prepared/i);
    expect(() => assertSamePreparedPwaIntent(prepared, { ...prepared, safeTx: { ...prepared.safeTx, operation: 1 } })).to.throw(/mutated|prepared/i);
    expect(() => assertSamePreparedPwaIntent(prepared, { ...prepared, safeTx: { ...prepared.safeTx, data: "0x" } })).to.throw(/mutated|prepared/i);
    expect(() => assertSamePreparedPwaIntent(prepared, { ...prepared, safeTx: { ...prepared.safeTx, nonce: prepared.safeTx.nonce + 1n } })).to.throw(/mutated|prepared/i);

    expect(() => assertSamePreparedPwaIntent(ready, { ...ready, queue: { ...ready.queue, queueFingerprint: h(999) } })).to.throw(/fingerprint|mutated|prepared/i);
    expect(() => assertSamePreparedPwaIntent(ready, { ...ready, call: { ...ready.call, operation: 1 } })).to.throw(/call|mutated|prepared/i);
    expect(() => assertSamePreparedPwaIntent(ready, { ...ready, call: { ...ready.call, data: "0x" } })).to.throw(/mutated|prepared/i);
  });
});
