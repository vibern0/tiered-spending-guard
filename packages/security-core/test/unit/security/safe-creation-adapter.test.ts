import { expect } from "chai";
import type { Address, Hex } from "viem";
import { createPinnedSafeReviewClient } from "../../../scripts/live/safe-creation-adapter";

const ADDRESS = "0x0000000000000000000000000000000000000001" as Address;

describe("Safe creation historical review adapter", () => {
  it("pins every plan-reconstruction RPC read to the reviewed historical block", async () => {
    const reads: Array<readonly [string, bigint | undefined]> = [];
    const client = {
      getBytecode: async (args: { blockNumber?: bigint }) => { reads.push(["code", args.blockNumber]); return "0x6000" as Hex; },
      getTransactionCount: async (args: { blockNumber?: bigint }) => { reads.push(["nonce", args.blockNumber]); return 673; },
      readContract: async (args: { blockNumber?: bigint }) => { reads.push(["contract", args.blockNumber]); return "0x6000"; },
      call: async (args: { blockNumber?: bigint }) => { reads.push(["call", args.blockNumber]); return { data: "0x6000" as Hex }; },
    };
    const pinned = createPinnedSafeReviewClient(client, 1234n);
    await pinned.getBytecode({ address: ADDRESS });
    await pinned.getTransactionCount({ address: ADDRESS });
    await pinned.readContract({ address: ADDRESS, abi: [], functionName: "x" });
    await pinned.call({ data: "0x60" });
    expect(reads).to.deep.equal([["code", 1234n], ["nonce", 1234n], ["contract", 1234n], ["call", 1234n]]);
  });
});
