import { expect } from "chai";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, keccak256, parseAbi, parseAbiItem, toHex } from "viem";
import {
  decodeGuardLog,
  guardEventAbi,
  verifyGuardBinding,
  type MonitoringIdentity,
} from "../../../src/monitoring/guard-events";
import { monitoringLog } from "../../helpers/monitoring";

const identity: MonitoringIdentity = {
  chainId: 31337,
  safe: getAddress("0x0000000000000000000000000000000000000001"),
  guard: getAddress("0x0000000000000000000000000000000000000002"),
  delay: getAddress("0x0000000000000000000000000000000000000003"),
  confirmations: 2,
};

function log(name: "TransferAuthorized" | "AuthorizationUsed", args: readonly unknown[], overrides = {}) {
  const item = parseAbiItem(name === "TransferAuthorized"
    ? "event TransferAuthorized(uint8 tier,address token,address recipient,uint256 amount,uint256 baseSpent,uint256 instantSpent,uint256 window)"
    : "event AuthorizationUsed(uint8 tier,address token,address recipient,uint256 amount,uint256 baseSpent,uint256 instantSpent,uint256 window)");
  const encoded = { topics: encodeEventTopics({ abi: [item], eventName: name, args: args as never }), data: encodeAbiParameters([
    { type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
  ], args as never) };
  return monitoringLog(identity.guard, identity.chainId, encoded.topics as `0x${string}`[], encoded.data, {
    blockHash: keccak256(toHex("block")),
    transactionHash: keccak256(toHex("tx")),
    ...overrides,
  });
}

describe("guard activity decoding", () => {
  const token = getAddress("0x0000000000000000000000000000000000000004");
  const recipient = getAddress("0x0000000000000000000000000000000000000005");
  const transfer = encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [recipient, 25n] });
  const binding = { readSafeTransaction: async () => ({ safe: identity.safe, to: token, value: 0n, data: transfer, operation: 0, nonce: 9n }), readSpendState: async (_token: typeof token, _blockNumber: bigint) => ({ baseSpent: 7n, instantSpent: 25n, window: 1n }) };

  it("decodes only confirmed step-up authorizations and preserves X/Y state", async () => {
    const result = await decodeGuardLog(log("TransferAuthorized", [1, token, recipient, 25n, 7n, 25n, 1n]), identity, 12n, binding);
    expect(result).to.deep.include({ kind: "step-up-executed", amount: 25n, baseSpent: 7n, instantSpent: 25n, window: 1n });
  });

  it("suppresses base events and unconfirmed logs", async () => {
    expect(await decodeGuardLog(log("TransferAuthorized", [0, identity.safe, identity.safe, 1n, 1n, 1n, 1n]), identity, 12n, binding)).to.equal(undefined);
    expect(await decodeGuardLog(log("TransferAuthorized", [1, identity.safe, identity.safe, 1n, 1n, 1n, 1n]), identity, 10n, binding)).to.equal(undefined);
  });

  it("ignores an unrelated guard event only when its exact signature is unknown", async () => {
    const unrelated = parseAbiItem("event PolicyConfigured(address token)");
    const topics = encodeEventTopics({ abi: [unrelated], eventName: "PolicyConfigured", args: { token } });
    expect(await decodeGuardLog(monitoringLog(identity.guard, identity.chainId, topics as `0x${string}`[], "0x", { blockHash: keccak256(toHex("block")), transactionHash: keccak256(toHex("other")) }), identity, 12n, binding)).to.equal(undefined);
  });

  it("fails closed on wrong identity, malformed data, and a mismatched transaction binding", async () => {
    await expect(decodeGuardLog(log("TransferAuthorized", [1, identity.safe, identity.safe, 1n, 1n, 1n, 1n], { address: identity.delay }), identity, 12n, binding)).to.be.rejectedWith(/identity/i);
    await expect(decodeGuardLog({ ...log("TransferAuthorized", [1, identity.safe, identity.safe, 1n, 1n, 1n, 1n]), data: "0x12" }, identity, 12n, binding)).to.be.rejectedWith(/malformed/i);
    expect(await decodeGuardLog(log("AuthorizationUsed", [1, identity.safe, identity.safe, 1n, 1n, 1n, 1n]), identity, 12n, binding)).to.equal(undefined);
  });

  it("requires read-only transaction and counter revalidation before notification", async () => {
    const result = await decodeGuardLog(log("TransferAuthorized", [1, token, recipient, 25n, 7n, 25n, 1n]), identity, 12n, binding);
    const tx = { to: token, value: 0n, data: transfer, operation: 0 };
    const expected = { safe: identity.safe, ...tx, nonce: 9n };
    await expect(verifyGuardBinding(result!, { expectedTransaction: expected, ...binding }, identity, 10n)).to.be.fulfilled;
    await expect(verifyGuardBinding(result!, { expectedTransaction: expected, readSafeTransaction: async () => ({ safe: identity.safe, ...tx, value: 1n, nonce: 9n }), readSpendState: binding.readSpendState }, identity, 10n)).to.be.rejectedWith(/binding/i);
  });

  it("reads counters at the event block instead of suppressing a valid prior event with latest state", async () => {
    const blocks: bigint[] = [];
    const blockHashes: `0x${string}`[] = [];
    const transactionBlocks: bigint[] = [];
    const eventBinding = { ...binding, readSafeTransaction: async (_hash: `0x${string}`, blockNumber: bigint, blockHash?: `0x${string}`) => { transactionBlocks.push(blockNumber); if(blockHash)blockHashes.push(blockHash); return binding.readSafeTransaction(); }, readSpendState: async (_token: typeof token, blockNumber: bigint) => { blocks.push(blockNumber); return { baseSpent: 7n, instantSpent: 25n, window: 1n }; } };
    await decodeGuardLog(log("TransferAuthorized", [1, token, recipient, 25n, 7n, 25n, 1n]), identity, 20n, eventBinding);
    expect(blocks).to.deep.equal([10n]);
    expect(transactionBlocks).to.deep.equal([10n]);
    expect(blockHashes).to.deep.equal([keccak256(toHex("block"))]);
  });

  it("requires a Safe transaction binding that includes the configured outer Safe recipient", async () => {
    const wrongOuterSafe = { ...binding, readSafeTransaction: async () => ({ safe: identity.delay, to: token, value: 0n, data: transfer, operation: 0, nonce: 9n }) };
    await expect(decodeGuardLog(log("TransferAuthorized", [1, token, recipient, 25n, 7n, 25n, 1n]), identity, 12n, wrongOuterSafe)).to.be.rejectedWith(/Safe|binding/i);
  });
});
