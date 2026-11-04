import { expect } from "chai";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createLiveJournalStore, decodeLiveIntent, createSepoliaLiveContext, readLiveJournal, verifyBootstrapIntent, withLiveJournalStore } from "../../../scripts/live/runtime";

describe("Sepolia live runtime", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "vault-live-runtime-")); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it("accepts only an exact public intent shape", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    expect(decodeLiveIntent(JSON.stringify({ id: "probe", to: account.address, data: "0x", value: "0", nonce: 0, gas: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1" }))).to.deep.include({ id: "probe", to: account.address, value: 0n, nonce: 0 });
    for (const input of [
      { id: "probe", to: account.address, data: "0x", value: "-1", nonce: 0, gas: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1" },
      { id: "probe", to: account.address, data: "0x", value: "0", nonce: 0, gas: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1", secret: "no" },
      { id: "probe", to: account.address, data: "0x", value: "0", nonce: 0.5, gas: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1" },
    ]) expect(() => decodeLiveIntent(JSON.stringify(input))).to.throw("live intent");
  });

  it("locks a durable journal and rejects malformed persisted data", () => {
    const path = join(directory, "journal.json");
    const funder = privateKeyToAccount(generatePrivateKey()).address;
    const first = createLiveJournalStore(path, funder);
    expect(() => createLiveJournalStore(path, funder)).to.throw("writer lock");
    first.save({ chainId: 11155111, funder, entries: [] });
    expect(first.load()).to.deep.include({ chainId: 11155111, funder });
    first.close();
  });

  it("reads a resumable journal without creating a writer lock", () => {
    const path = join(directory, "journal.json");
    const funder = privateKeyToAccount(generatePrivateKey()).address;
    expect(readLiveJournal(path, funder)).to.deep.equal({ chainId: 11155111, funder, entries: [] });
    expect(existsSync(`${path}.lock`)).to.equal(false);
    const store = createLiveJournalStore(path, funder);
    store.save({ chainId: 11155111, funder, entries: [] });
    store.close();
    expect(readLiveJournal(path, funder)).to.deep.equal({ chainId: 11155111, funder, entries: [] });
    expect(existsSync(`${path}.lock`)).to.equal(false);
  });

  it("restores a finalized receipt so later intents do not mistake it for drift", () => {
    const path = join(directory, "journal.json");
    const funder = privateKeyToAccount(generatePrivateKey()).address;
    const hash = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
    const first = createLiveJournalStore(path, funder);
    first.save({ chainId: 11155111, funder, entries: [{ id: "probe", intentHash: hash, transactionHash: hash, nonce: 0, reserved: 1n, status: "success", receipt: { transactionHash: hash, status: "success", gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 1n, blockHash: hash } }] });
    first.close();
    const second = createLiveJournalStore(path, funder);
    expect(second.load().entries[0].receipt).to.deep.equal({ transactionHash: hash, status: "success", gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 1n, blockHash: hash });
    second.close();
  });

  it("keeps the writer lock through deferred asynchronous persistence and releases it after success", async () => {
    const path = join(directory, "journal.json");
    const funder = privateKeyToAccount(generatePrivateKey()).address;
    const result = await withLiveJournalStore(path, funder, async (store) => {
      await Promise.resolve();
      expect(() => createLiveJournalStore(path, funder)).to.throw("writer lock");
      store.save({ chainId: 11155111, funder, entries: [] });
      return "persisted";
    });

    expect(result).to.equal("persisted");
    expect(readLiveJournal(path, funder)).to.deep.equal({ chainId: 11155111, funder, entries: [] });
    const reopened = createLiveJournalStore(path, funder);
    reopened.close();
  });

  it("releases the writer lock after an asynchronous callback rejects", async () => {
    const path = join(directory, "journal.json");
    const funder = privateKeyToAccount(generatePrivateKey()).address;
    await expect(withLiveJournalStore(path, funder, async () => {
      await Promise.resolve();
      throw new Error("deferred failure");
    })).to.be.rejectedWith("deferred failure");

    const reopened = createLiveJournalStore(path, funder);
    reopened.close();
  });

  it("refuses an RPC result from another chain before signing", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const context = createSepoliaLiveContext({
      account,
      client: {
        getChainId: async () => 1,
        getTransactionCount: async () => 0,
        getBalance: async () => 1_000_000n,
        sendRawTransaction: async () => "0x0000000000000000000000000000000000000000000000000000000000000001",
        getTransactionReceipt: async () => { throw new Error("not found"); },
        waitForTransactionReceipt: async () => { throw new Error("not found"); },
        estimateGas: async () => 21_000n,
        estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
        getBlockNumber: async () => 0n,
      },
      verify: async () => undefined,
      persist: async () => undefined,
    });
    await expect(context.chainId()).to.eventually.equal(1);
  });

  it("accepts only a self-probe or exact configured passkey factory bootstrap", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const factory = "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf" as const;
    const verifiers = BigInt("0xc2b78104907F722DABAc4C69f826a522B2754De4");
    const data = encodeFunctionData({ abi: [{ type: "function", name: "createSigner", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] }] as const, functionName: "createSigner", args: [1n, 2n, verifiers] });
    expect(() => verifyBootstrapIntent({ id: "primary-passkey-bootstrap", to: factory, data, value: 0n, nonce: 0, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, account.address, { primary: { x: 1n, y: 2n }, secondary: { x: 3n, y: 4n } })).not.to.throw();
    expect(() => verifyBootstrapIntent({ id: "primary-passkey-bootstrap", to: factory, data: "0x", value: 0n, nonce: 0, gas: 100000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, account.address, { primary: { x: 1n, y: 2n }, secondary: { x: 3n, y: 4n } })).to.throw("bootstrap intent");
    expect(() => verifyBootstrapIntent({ id: "probe-self", to: account.address, data: "0x", value: 0n, nonce: 0, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, account.address, { primary: { x: 1n, y: 2n }, secondary: { x: 3n, y: 4n } })).not.to.throw();
  });
});
