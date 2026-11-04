import { expect } from "chai";
import { type Address, type Hex } from "viem";
import { loadCommittedPwaProvisioningAutomationPolicy } from "../../../src/pwa/authorization";
import {
  collectPwaProvisioningQuote,
  type PwaProvisioningQuoteClient,
} from "../../../src/pwa/provisioning-quote";
import type { PwaProvisioningTransaction } from "../../../src/pwa/provisioning";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const transaction = Object.freeze({
  id: "setup-helper",
  nonce: 7n,
  to: address(0),
  value: 0n,
  data: "0x1234" as Hex,
  operation: 0 as const,
  description: "setup",
  expectedCreatedAddress: address(8),
  creationCodeHash: hash(9),
  expectedRuntimeCodeHash: hash(10),
}) satisfies PwaProvisioningTransaction;

type ClientOverrides = Partial<Readonly<{
  chainId: number;
  head: bigint;
  blockHash: Hex | null;
  baseFeePerGas: bigint | null;
  gasLimit: bigint;
  nonce: bigint;
  estimate: bigint;
  tip: bigint;
}>>;

function client(source: string, overrides: ClientOverrides = {}): PwaProvisioningQuoteClient {
  const state = {
    chainId: 11155111,
    head: 100n,
    blockHash: hash(100),
    baseFeePerGas: 22n,
    gasLimit: 100_000_000n,
    nonce: 7n,
    estimate: 100n,
    tip: 2n,
    ...overrides,
  };
  return {
    source,
    getChainId: async () => state.chainId,
    getBlockNumber: async () => state.head,
    getBlock: async ({ blockNumber }) => ({ number: blockNumber, hash: state.blockHash, baseFeePerGas: state.baseFeePerGas, gasLimit: state.gasLimit }),
    getTransactionCount: async () => state.nonce,
    estimateGas: async ({ blockNumber, account, to, data, value }) => {
      expect(blockNumber).to.equal(100n);
      expect(account).to.equal(address(1));
      expect(to).to.equal(undefined);
      expect(data).to.equal("0x1234");
      expect(value).to.equal(0n);
      return state.estimate;
    },
    getMaxPriorityFeePerGas: async () => state.tip,
  };
}

function input(overrides: Partial<Parameters<typeof collectPwaProvisioningQuote>[0]> = {}) {
  return {
    transaction,
    deployer: address(1),
    providers: [client("provider-a"), client("provider-b", { head: 102n, estimate: 105n, tip: 3n })] as const,
    relay: client("relay"),
    policy: loadCommittedPwaProvisioningAutomationPolicy(),
    ...overrides,
  };
}

describe("PWA provisioning dual-RPC quote", () => {
  it("pins both estimates to the lower common canonical head", async () => {
    const quote = await collectPwaProvisioningQuote(input());

    expect(quote).to.deep.equal({
      blockNumber: 100n,
      blockHash: hash(100),
      blockGasLimit: 100_000_000n,
      baseFeePerGas: 22n,
      estimates: [100n, 105n],
      priorityFeesPerGas: [2n, 3n],
      providers: ["provider-a", "provider-b"],
    });
  });

  it("rejects wrong chain, noncanonical blocks, excessive lag, nonce drift, and estimate divergence", async () => {
    const failures: Array<readonly [string, Parameters<typeof collectPwaProvisioningQuote>[0]]> = [
      ["chain", input({ providers: [client("a", { chainId: 1 }), client("b")] })],
      ["hash", input({ providers: [client("a"), client("b", { blockHash: hash(101) })] })],
      ["hash", input({ providers: [client("a", { blockHash: null }), client("b", { blockHash: null })] })],
      ["base fee", input({ providers: [client("a", { baseFeePerGas: null }), client("b", { baseFeePerGas: null })] })],
      ["lag", input({ providers: [client("a", { head: 100n }), client("b", { head: 103n })] })],
      ["nonce", input({ providers: [client("a", { nonce: 8n }), client("b")] })],
      ["diverge", input({ providers: [client("a", { estimate: 89n }), client("b", { estimate: 100n })] })],
      ["relay nonce", input({ relay: client("relay", { nonce: 8n }) })],
      ["block hash", input({ relay: client("relay", { blockHash: hash(101) }) })],
    ];

    for (const [message, candidate] of failures) {
      await expect(collectPwaProvisioningQuote(candidate)).to.be.rejectedWith(new RegExp(message, "i"));
    }
  });

  it("identifies the reviewed transaction and observed nonces without exposing provider endpoints", async () => {
    await expect(collectPwaProvisioningQuote(input({
      providers: [client("https://secret-a.invalid/key", { nonce: 8n }), client("https://secret-b.invalid/key")] as const,
    }))).to.be.rejectedWith("provisioning quote nonce mismatch for setup-helper: expected 7, identity provider 1 observed 8, identity provider 2 observed 7");
  });
});
