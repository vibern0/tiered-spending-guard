import { expect } from "chai";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, linkSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("recovers only a dead local PID lock and preserves pending durable transaction hashes", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const path = join(directory, "journal.json");
    const funder = privateKeyToAccount(generatePrivateKey()).address;
    const hash = `0x${"11".repeat(32)}` as const;
    const first = createLiveJournalStore(path, funder);
    first.save({ chainId: 11155111, funder, entries: [{ id: "probe", intentHash: hash, transactionHash: hash, nonce: 9, reserved: 1n, status: "pending" }] });
    first.close();
    const original = readFileSync(path, "utf8");
    writeFileSync(`${path}.lock`, `${child.pid}\n`);
    const recovered = createLiveJournalStore(path, funder);
    try {
      expect(recovered.load().entries[0]).to.include({ transactionHash: hash, nonce: 9, status: "pending" });
      expect(readFileSync(path, "utf8")).to.equal(original);
      expect(() => createLiveJournalStore(path, funder)).to.throw(/writer lock/);
    } finally { recovered.close(); }
  });

  it("never removes live, malformed, or permission-unknown PID locks", () => {
    const path = join(directory, "journal.json");
    const funder = privateKeyToAccount(generatePrivateKey()).address;
    for (const contents of [`${process.pid}\n`, "0\n", "-1\n", "999999999999999999999\n", "123", "00123\n", "123\nextra", ""]) {
      writeFileSync(`${path}.lock`, contents);
      expect(() => createLiveJournalStore(path, funder)).to.throw(/writer lock/);
      expect(readFileSync(`${path}.lock`, "utf8")).to.equal(contents);
      unlinkSync(`${path}.lock`);
    }
    const originalKill = process.kill;
    try {
      process.kill = (() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }) as typeof process.kill;
      writeFileSync(`${path}.lock`, "123\n");
      expect(() => createLiveJournalStore(path, funder)).to.throw(/writer lock/);
      expect(readFileSync(`${path}.lock`, "utf8")).to.equal("123\n");
    } finally { process.kill = originalKill; }
  });

  it("reclaims a dead recovery alias but preserves an active claimant", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const path = join(directory, "journal.json"), lock = `${path}.lock`;
    const funder = privateKeyToAccount(generatePrivateKey()).address;
    writeFileSync(lock, `${child.pid}\n`);
    const liveClaim = `${lock}.recovery.${process.pid}.00000000-0000-4000-8000-000000000000`;
    linkSync(lock, liveClaim);
    expect(() => createLiveJournalStore(path, funder)).to.throw(/writer lock/);
    expect(readFileSync(lock, "utf8")).to.equal(`${child.pid}\n`);
    unlinkSync(liveClaim);
    const deadClaim = `${lock}.recovery.${child.pid}.00000000-0000-4000-8000-000000000000`;
    linkSync(lock, deadClaim);
    const recovered = createLiveJournalStore(path, funder);
    recovered.close();
    expect(existsSync(deadClaim)).to.equal(false);
  });

  it("does not unlink a newly acquired lock when stale recovery identity changes", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const path = join(directory, "journal.json"), lock = `${path}.lock`;
    const funder = privateKeyToAccount(generatePrivateKey()).address;
    writeFileSync(lock, `${child.pid}\n`);
    const originalKill = process.kill;
    let probes = 0;
    try {
      process.kill = ((pid: number) => {
        if (pid === child.pid) {
          if (++probes === 2) { unlinkSync(lock); writeFileSync(lock, `${process.pid}\n`); }
          throw Object.assign(new Error("dead"), { code: "ESRCH" });
        }
        return originalKill(pid, 0);
      }) as typeof process.kill;
      expect(() => createLiveJournalStore(path, funder)).to.throw(/writer lock/);
      expect(readFileSync(lock, "utf8")).to.equal(`${process.pid}\n`);
    } finally { process.kill = originalKill; }
  });

  it("serializes simultaneous stale-lock recovery across actual local processes", async function () {
    this.timeout(20_000);
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((done) => dead.once("exit", () => done()));
    const lock = join(directory, "concurrent.lock");
    writeFileSync(lock, `${dead.pid}\n`);
    const runtime = resolve("scripts/live/runtime.ts");
    const loader = require.resolve("ts-node/register/transpile-only");
    const script = `
      const fs = require("node:fs");
      const { acquireLocalWriterLease } = require(${JSON.stringify(runtime)});
      const lock = ${JSON.stringify(lock)};
      let attempts = 0;
      function run() {
        let lease;
        try { lease = acquireLocalWriterLease(lock); }
        catch {
          if (++attempts < 20) return setTimeout(run, 10);
          return process.exit(2);
        }
        try { fs.closeSync(fs.openSync(lock + ".active", "wx")); }
        catch { lease.close(); return process.exit(3); }
        setTimeout(() => { fs.unlinkSync(lock + ".active"); lease.close(); process.exit(0); }, 40);
      }
      process.on("message", run);
      process.stdout.write("READY\\n");
    `;
    const children = Array.from({ length: 4 }, () => spawn(process.execPath, ["-r", loader, "-e", script], { stdio: ["ignore", "pipe", "pipe", "ipc"] }));
    const exits = children.map(child => new Promise<number | null>((done) => child.once("exit", done)));
    await Promise.all(children.map(child => new Promise<void>((done, reject) => {
      child.stdout!.once("data", () => done());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("recovery child exited before ready")));
    })));
    for (const child of children) child.send({ start: true });
    const statuses = await Promise.all(exits);
    expect(statuses.filter(status => status === 0).length).to.be.greaterThan(0);
    expect(statuses.every(status => status === 0 || status === 2), `unexpected child exit: ${statuses}`).to.equal(true);
    expect(existsSync(lock)).to.equal(false);
    expect(existsSync(`${lock}.active`)).to.equal(false);
  });

  it("releases its unexposed lease after transient lock-write or fsync failure", () => {
    const filesystem = require("node:fs") as typeof import("node:fs");
    const path = join(directory, "journal.json"), lock = `${path}.lock`;
    const funder = privateKeyToAccount(generatePrivateKey()).address;
    for (const method of ["writeFileSync", "fsyncSync"] as const) {
      const original = filesystem[method];
      try {
        (filesystem as any)[method] = () => { throw Object.assign(new Error("transient I/O failure"), { code: "EIO" }); };
        expect(() => createLiveJournalStore(path, funder)).to.throw(/writer lock/);
      } finally { (filesystem as any)[method] = original; }
      expect(existsSync(lock), method).to.equal(false);
      const next = createLiveJournalStore(path, funder);
      next.close();
    }
  });

  it("preserves a replacement lock when unexposed lease initialization fails", () => {
    const filesystem = require("node:fs") as typeof import("node:fs");
    const path = join(directory, "journal.json"), lock = `${path}.lock`;
    const funder = privateKeyToAccount(generatePrivateKey()).address;
    const original = filesystem.fsyncSync;
    try {
      filesystem.fsyncSync = () => { unlinkSync(lock); writeFileSync(lock, `${process.pid}\n`); throw Object.assign(new Error("I/O failure after replacement"), { code: "EIO" }); };
      expect(() => createLiveJournalStore(path, funder)).to.throw(/writer lock/);
    } finally { filesystem.fsyncSync = original; }
    expect(readFileSync(lock, "utf8")).to.equal(`${process.pid}\n`);
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
