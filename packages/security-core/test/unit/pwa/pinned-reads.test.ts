import { expect } from "chai";
import { parseAbi, type Address, type Hex } from "viem";
import * as reads from "../../../src/pwa/pinned-reads";

const address = `0x${"11".repeat(20)}` as Address;
const other = `0x${"22".repeat(20)}` as Address;
const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
function fixture() {
  let calls = 0;
  const count = async () => { calls++; return BigInt(calls); };
  const client = {
    getBytecode: async (_: unknown) => { calls++; return "0x6000" as Hex; },
    getStorageAt: async (_: unknown) => { calls++; return `0x${"00".repeat(32)}` as Hex; },
    getTransactionCount: count,
    readContract: count,
    getBlock: count,
    getChainId: count,
    getBlockNumber: count,
  };
  return { client, calls: () => calls };
}
describe("provider-local pinned read scope", () => {
  it("deduplicates concurrent and repeated exact explicit-block reads", async () => {
    const f = fixture(), scoped = reads.createPinnedReadScope(f.client, 10n);
    const request = { address, abi, functionName: "balanceOf", args: [other], blockNumber: 10n };
    expect(await Promise.all([scoped.readContract(request), scoped.readContract({ ...request }), scoped.readContract(request)])).to.deep.equal([1n, 1n, 1n]);
    expect(await scoped.readContract(request)).to.equal(1n);
    expect(f.calls()).to.equal(1);
    await Promise.all([scoped.getBytecode({ address, blockNumber: 10n }), scoped.getBytecode({ address, blockNumber: 10n })]);
    await Promise.all([scoped.getStorageAt({ address, slot: "0x01", blockNumber: 10n }), scoped.getStorageAt({ address, slot: "0x01", blockNumber: 10n })]);
    await Promise.all([scoped.getTransactionCount({ address, blockNumber: 10n }), scoped.getTransactionCount({ address, blockNumber: 10n })]);
    expect(f.calls()).to.equal(4);
  });
  it("separates providers, collections, blocks, addresses, calldata and storage slots", async () => {
    const a = fixture(), b = fixture();
    const one = reads.createPinnedReadScope(a.client, 10n), two = reads.createPinnedReadScope(b.client, 10n);
    const request = { address, abi, functionName: "balanceOf", args: [other], blockNumber: 10n };
    await one.readContract(request); await two.readContract(request);
    await reads.createPinnedReadScope(a.client, 10n).readContract(request);
    await one.readContract({ ...request, address: other });
    await one.readContract({ ...request, args: [address] });
    await one.readContract({ ...request, blockNumber: 11n });
    await one.getStorageAt({ address, slot: "0x01", blockNumber: 10n });
    await one.getStorageAt({ address, slot: "0x02", blockNumber: 10n });
    expect(a.calls()).to.equal(7); expect(b.calls()).to.equal(1);
  });
  it("never caches unpinned/latest/pending reads or chain/head/block anchors", async () => {
    const f = fixture(), scoped = reads.createPinnedReadScope(f.client, 10n);
    for (let i = 0; i < 2; i++) {
      await scoped.readContract({ address, abi, functionName: "balanceOf", args: [other] });
      await scoped.getTransactionCount({ address, blockTag: "latest" });
      await scoped.getTransactionCount({ address, blockTag: "pending" });
      await scoped.getBlock({ blockNumber: 10n }); await scoped.getChainId(); await scoped.getBlockNumber();
    }
    expect(f.calls()).to.equal(12);
  });
  it("ignores unrelated ABI entries but keeps distinct return decoding isolated", async () => {
    const f = fixture(), scoped = reads.createPinnedReadScope(f.client, 10n);
    const request = { address, functionName: "balanceOf", args: [other], blockNumber: 10n };
    expect(await scoped.readContract({ ...request, abi })).to.equal(1n);
    expect(await scoped.readContract({ ...request, abi: [...abi, ...parseAbi(["function nonce() view returns (uint256)"])] })).to.equal(1n);
    expect(await scoped.readContract({ ...request, abi: parseAbi(["function balanceOf(address) view returns (bytes32)"]) })).to.equal(2n);
  });
  it("evicts a rejected read so failure cannot poison a later retry", async () => {
    const f = fixture(); let first = true;
    const client = { ...f.client, readContract: async (input: unknown) => { if (first) { first = false; throw Error("unavailable"); } return f.client.readContract(input); } };
    const scoped = reads.createPinnedReadScope(client, 10n);
    const input = { address, abi, functionName: "balanceOf", args: [other], blockNumber: 10n };
    await expect(scoped.readContract(input)).to.be.rejectedWith("unavailable");
    expect(await scoped.readContract(input)).to.equal(1n);
  });
});
