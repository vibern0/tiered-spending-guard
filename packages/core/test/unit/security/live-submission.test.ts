import { expect } from "chai";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { submitLiveIntent, PHASE_OUTLAY_LIMIT, type LiveContext, type LiveIntent, type LiveJournal } from "../../../../sdk/src/live/submission";

const account = privateKeyToAccount(generatePrivateKey());
const funder = account.address;
const signIntent = (value: LiveIntent) => account.signTransaction({ chainId: 11155111, type: "eip1559", to: value.to, data: value.data, value: value.value, nonce: value.nonce, gas: value.gas, maxFeePerGas: value.maxFeePerGas, maxPriorityFeePerGas: value.maxPriorityFeePerGas });
const intent: LiveIntent = { id: "base-native", to: funder, data: "0x", value: 1n, nonce: 0, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
function fixture() {
  const journal: LiveJournal = { chainId: 11155111, funder, entries: [] };
  const calls: string[] = [];
  const context: LiveContext = {
    funder, chainId: async () => 11155111, nonce: async () => 0, balance: async () => PHASE_OUTLAY_LIMIT,
    verify: async () => { calls.push("verify"); },
    sign: async value => { calls.push("sign"); return signIntent(value); },
    persist: async () => { calls.push("persist"); },
    broadcast: async raw => { calls.push("broadcast"); return keccak256(raw); },
    receipt: async () => undefined,
  };
  return { journal, context, calls };
}
describe("bounded Sepolia submission journal", () => {
  it("persists the locally computed transaction hash before broadcasting", async () => {
    const f = fixture();
    const entry = await submitLiveIntent(intent, f.journal, f.context);
    expect(entry.transactionHash).to.equal(keccak256(await signIntent(intent)));
    expect(entry.reserved).to.equal(21001n);
    expect(f.calls.indexOf("persist")).to.be.lessThan(f.calls.indexOf("broadcast"));
    expect(f.journal.entries).to.have.length(1);
  });
  it("never re-signs or re-broadcasts an uncertain submission on resume", async () => {
    const f = fixture();
    const context = { ...f.context, broadcast: async () => { throw new Error("secret-bearing provider failure"); } };
    await expect(submitLiveIntent(intent, f.journal, context)).to.be.rejectedWith("submission outcome unknown");
    f.calls.length = 0;
    const entry = await submitLiveIntent(intent, f.journal, context);
    expect(entry.status).to.equal("pending");
    expect(f.calls).not.to.include("sign");
    expect(f.calls).not.to.include("broadcast");
  });
  it("blocks wrong chain, nonce drift, budget exhaustion and failed verification before signing", async () => {
    for (const overrides of [
      { chainId: async () => 1 }, { nonce: async () => 1 },
      { balance: async () => 0n }, { verify: async () => { throw new Error("topology mismatch"); } },
    ]) {
      const f = fixture();
      await expect(submitLiveIntent(intent, f.journal, { ...f.context, ...overrides })).to.be.rejected;
      expect(f.calls).not.to.include("sign");
    }
    const f = fixture();
    await expect(submitLiveIntent({ ...intent, value: PHASE_OUTLAY_LIMIT }, f.journal, f.context)).to.be.rejectedWith("outlay limit");
    expect(f.calls).not.to.include("sign");
  });
  it("binds resume to the original intent and funder", async () => {
    const f = fixture();
    await submitLiveIntent(intent, f.journal, f.context);
    await expect(submitLiveIntent({ ...intent, value: 2n }, f.journal, f.context)).to.be.rejectedWith("intent changed");
    await expect(submitLiveIntent(intent, { ...f.journal, funder: "0x00000000000000000000000000000000000000b2" }, f.context)).to.be.rejectedWith("journal identity");
  });
  it("records reverted receipts as failures and reconciles actual gas expense", async () => {
    const f = fixture();
    await submitLiveIntent(intent, f.journal, f.context);
    const entry = await submitLiveIntent(intent, f.journal, { ...f.context, receipt: async hash => ({ transactionHash: hash, status: "reverted", gasUsed: 20000n, effectiveGasPrice: 1n, blockNumber: 4n, blockHash: keccak256("0x44") }) });
    expect(entry.status).to.equal("reverted");
    expect(entry.reserved).to.equal(20000n);
  });
  it("restores the full reservation when a previously observed receipt disappears", async () => {
    const f = fixture();
    await submitLiveIntent(intent, f.journal, f.context);
    await submitLiveIntent(intent, f.journal, { ...f.context, receipt: async hash => ({ transactionHash: hash, status: "reverted", gasUsed: 20000n, effectiveGasPrice: 1n, blockNumber: 4n, blockHash: keccak256("0x44") }) });
    await submitLiveIntent(intent, f.journal, f.context);
    expect(f.journal.entries[0].status).to.equal("pending");
    expect(f.journal.entries[0].reserved).to.equal(21001n);
    expect(f.journal.entries[0].receipt).to.equal(undefined);
  });
  it("reconciles prior receipts before permitting another submission", async () => {
    const f = fixture();
    await submitLiveIntent(intent, f.journal, f.context);
    await submitLiveIntent(intent, f.journal, { ...f.context, receipt: async hash => ({ transactionHash: hash, status: "success", gasUsed: 20000n, effectiveGasPrice: 1n, blockNumber: 4n, blockHash: keccak256("0x44") }) });
    f.calls.length = 0;
    await expect(submitLiveIntent({ ...intent, id: "next", nonce: 1 }, f.journal, { ...f.context, nonce: async () => 1 })).to.be.rejectedWith("prior receipt changed");
    expect(f.calls).not.to.include("sign");
  });
  it("snapshots the intent before any asynchronous preflight work", async () => {
    const f = fixture();
    const mutable = { ...intent };
    let signedValue: bigint | undefined;
    await submitLiveIntent(mutable, f.journal, { ...f.context, verify: async () => { mutable.value = PHASE_OUTLAY_LIMIT + 1n; }, sign: async value => { signedValue = value.value; return signIntent(value); } });
    expect(signedValue).to.equal(1n);
  });
  it("rejects signer bytes that do not match the checked intent", async () => {
    for (const changes of [{ value: 2n }, { nonce: 2 }, { to: undefined }, { data: "0x1234" as const }, { gas: 22000n }, { maxFeePerGas: 2n }, { maxPriorityFeePerGas: 0n }]) {
      const f = fixture();
      await expect(submitLiveIntent(intent, f.journal, { ...f.context, sign: async value => signIntent({ ...value, ...changes }) })).to.be.rejectedWith("signed transaction mismatch");
      expect(f.calls).not.to.include("broadcast");
      expect(f.journal.entries).to.have.length(0);
    }
    const f = fixture();
    await expect(submitLiveIntent(intent, f.journal, { ...f.context, sign: async () => "0x1234" })).to.be.rejectedWith("signed transaction mismatch");
    for (const signer of [
      async (value: LiveIntent) => account.signTransaction({ ...value, chainId: 1, type: "eip1559" }),
      async (value: LiveIntent) => privateKeyToAccount(generatePrivateKey()).signTransaction({ ...value, chainId: 11155111, type: "eip1559" }),
      async (value: LiveIntent) => account.signTransaction({ ...value, chainId: 11155111, type: "eip1559", accessList: [{ address: funder, storageKeys: [] }] }),
    ]) {
      const f = fixture();
      await expect(submitLiveIntent(intent, f.journal, { ...f.context, sign: signer })).to.be.rejectedWith("signed transaction mismatch");
      expect(f.calls).not.to.include("broadcast");
    }
  });
});
