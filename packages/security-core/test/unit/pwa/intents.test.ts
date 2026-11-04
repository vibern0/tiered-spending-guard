import { expect } from "chai";
import { decodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import {
  brandVerifiedPwaSnapshotForTestsOnly,
  preparePwaIntent,
  type VerifiedPwaSnapshot,
} from "../../../src/pwa/intents";
import { queueFingerprint } from "../../../src/queue/delay";
import { PWA_RECIPIENT, SEPOLIA_USDC_ADDRESS } from "../../../src/pwa/profile";

const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const TRANSFER_ABI = parseAbi(["function transfer(address,uint256)"]);
const DELAY_ABI = parseAbi(["function execTransactionFromModule(address,uint256,bytes,uint8)", "function executeNextTx(address,uint256,bytes,uint8)", "function setTxNonce(uint256)", "function skipExpired()"]);

const usdc = SEPOLIA_USDC_ADDRESS;
const recipient = PWA_RECIPIENT;
const safe = a(1);
const delay = a(3);

function queue(createdAt = 800n) {
  const data = `0xa9059cbb${recipient.slice(2).padStart(64, "0")}${(4_000_000n).toString(16).padStart(64, "0")}`.toLowerCase() as Hex;
  return { safe, delay, to: usdc, value: 0n, data, operation: 0 as const, queueNonce: 4n, queueFingerprint: queueFingerprint({ safe, delay, to: usdc, value: 0n, data, operation: 0, queueNonce: 4n }), createdAt, readyAt: createdAt + 120n, expiresAt: createdAt + 720n };
}

function snapshot(overrides: Partial<VerifiedPwaSnapshot> = {}): VerifiedPwaSnapshot {
  process.env.NODE_ENV = "test";
  return brandVerifiedPwaSnapshotForTestsOnly(Object.freeze({
    formatVersion: 2, chainId: 11155111, blockNumber: 100n, blockHash: h(100), timestamp: 1_000n,
    deploymentsHash: h(101), policyHash: h(102), safe, guard: a(2), delay, usdc, baseRecipientMode: "any-valid-address", elevatedRecipients: [recipient],
    primaryPasskey: a(4), secondaryPasskey: a(5), safeNonce: 9n,
    spendState: Object.freeze({ window: 0n, baseSpent: 0n, instantSpent: 0n }),
    limits: Object.freeze({ basePerTransaction: 1_000_000n, baseDailyLimit: 1_000_000n, stepUpPerTransaction: 3_000_000n, instantDailyLimit: 3_000_000n }),
    cooldownSeconds: 120n, expirationSeconds: 600n, queueHeadNonce: 4n, queueTailNonce: 5n, queueHead: Object.freeze(queue()),
    ...overrides,
  }));
}

describe("closed PWA intents", () => {
  it("builds exact X, Y, and Z transfer lanes", () => {
    const base = preparePwaIntent(snapshot(), { kind: "transfer", recipient, amount: 1_000_000n });
    expect(base.kind).to.equal("base-transfer");
    expect(base.requiredApprovals).to.deep.equal(["primary"]);

    const stepUp = preparePwaIntent(snapshot({ spendState: { window: 0n, baseSpent: 1_000_000n, instantSpent: 1_000_000n } }), { kind: "transfer", recipient, amount: 2_000_000n });
    expect(stepUp.kind).to.equal("step-up-transfer");
    expect(stepUp.requiredApprovals).to.deep.equal(["primary", "secondary"]);

    const delayed = preparePwaIntent(snapshot(), { kind: "transfer", recipient, amount: 4_000_000n });
    expect(delayed.kind).to.equal("queue-transfer");
    expect(delayed.requiredApprovals).to.deep.equal(["primary", "secondary"]);
    expect(delayed.safeTx.to).to.equal(delay);
    const outer = decodeFunctionData({ abi: DELAY_ABI, data: delayed.safeTx.data });
    expect(outer.functionName).to.equal("execTransactionFromModule");
    expect(outer.args[0]).to.equal(usdc);
    const inner = decodeFunctionData({ abi: TRANSFER_ABI, data: outer.args[2] });
    expect(inner.functionName).to.equal("transfer");
    expect(inner.args).to.deep.equal([recipient, 4_000_000n]);
  });

  it("builds exact head cancellation, ready execution, and expired skipping", () => {
    const head = queue();
    const binding = { queueNonce: head.queueNonce, queueFingerprint: head.queueFingerprint } as const;
    const cancel = preparePwaIntent(snapshot(), { kind: "cancel-queued", ...binding });
    expect(cancel.kind).to.equal("cancel-queued");
    expect(cancel.requiredApprovals).to.deep.equal(["primary", "secondary"]);
    expect(decodeFunctionData({ abi: DELAY_ABI, data: cancel.safeTx.data })).to.deep.include({ functionName: "setTxNonce", args: [5n] });

    const execute = preparePwaIntent(snapshot(), { kind: "execute-ready", ...binding });
    expect(execute.kind).to.equal("execute-ready");
    expect(execute.requiredApprovals).to.deep.equal([]);
    expect(decodeFunctionData({ abi: DELAY_ABI, data: execute.call.data }).functionName).to.equal("executeNextTx");

    expect(() => preparePwaIntent(snapshot({ timestamp: 1_700n }), { kind: "execute-ready", ...binding })).to.throw(/expired/i);
    const skip = preparePwaIntent(snapshot({ timestamp: 1_700n }), { kind: "skip-expired", ...binding });
    expect(skip.kind).to.equal("skip-expired");
    expect(decodeFunctionData({ abi: DELAY_ABI, data: skip.call.data }).functionName).to.equal("skipExpired");
    expect(() => preparePwaIntent(snapshot({ timestamp: 850n }), { kind: "execute-ready", ...binding })).to.throw(/cooldown/i);
    expect(() => preparePwaIntent(snapshot(), { kind: "skip-expired", ...binding })).to.throw(/not expired/i);
  });

  it("permits arbitrary base recipients but requires elevated membership for step-up and delayed lanes", () => {
    expect(preparePwaIntent(snapshot(), { kind: "transfer", recipient: a(99), amount: 1n }).kind).to.equal("base-transfer");
    expect(() => preparePwaIntent(snapshot(), { kind: "transfer", recipient: a(99), amount: 2_000_000n })).to.throw(/elevated allowlisted/i);
  });

  it("builds a hash-bound delayed recipient addition with both approvals", () => {
    const candidate = a(99);
    const prepared = preparePwaIntent(snapshot(), { kind: "add-recipient", recipient: candidate });
    expect(prepared.kind).to.equal("add-recipient");
    expect(prepared.requiredApprovals).to.deep.equal(["primary", "secondary"]);
    expect(prepared.recipient).to.equal(candidate);
    expect(prepared.safeTx.to).to.equal(delay);
    const outer = decodeFunctionData({ abi: DELAY_ABI, data: prepared.safeTx.data });
    expect(outer.functionName).to.equal("execTransactionFromModule");
    expect(outer.args[0]).to.equal(a(2));
    const repair = decodeFunctionData({ abi: parseAbi(["function repairPolicy(bytes32,address,uint256,uint256,uint256,uint256,address[],uint8)"]), data: outer.args[2] });
    expect(repair.functionName).to.equal("repairPolicy");
    expect(repair.args).to.deep.equal([h(102), usdc, 1_000_000n, 3_000_000n, 1_000_000n, 3_000_000n, [recipient, candidate], 1]);
    expect(() => preparePwaIntent(snapshot(), { kind: "add-recipient", recipient })).to.throw(/already elevated/i);
    expect(() => preparePwaIntent(snapshot(), { kind: "add-recipient", recipient: candidate, calldata: "0x" } as never)).to.throw(/unsupported field/i);
  });

  it("rejects invalid amount, stale queue identity, direct above-Y forcing, and caller-shaped snapshots", () => {
    expect(() => preparePwaIntent(snapshot(), { kind: "transfer", recipient, amount: 0n })).to.throw(/amount/i);
    expect(() => preparePwaIntent(snapshot(), { kind: "execute-ready", queueNonce: 5n, queueFingerprint: queue().queueFingerprint })).to.throw(/head|queue/i);
    expect(() => preparePwaIntent(snapshot(), { kind: "execute-ready", queueNonce: 4n, queueFingerprint: h(999) })).to.throw(/fingerprint/i);
    expect(() => preparePwaIntent({ ...snapshot() } as VerifiedPwaSnapshot, { kind: "transfer", recipient, amount: 1n })).to.throw(/verified snapshot/i);
  });
});
