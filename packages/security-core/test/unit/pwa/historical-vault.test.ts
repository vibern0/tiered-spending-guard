import { expect } from "chai";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import * as pwa from "../../../src/pwa";
import { OFFICIAL_DEPLOYMENT_REGISTRY } from "../../../src/config/deployments";
import { liveIntentHash, type LiveJournal } from "../../../scripts/live/submission";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const code = (n: number) => `0x60${n.toString(16).padStart(2, "0")}` as Hex;
const hash = (n: number) => keccak256(code(n));
const zero = address(0);
const sentinel = address(1);
const deployer = address(2);
const ids = ["primary-signer", "secondary-signer", "setup-helper", "guard", "delay", "maintenance", "safe-proxy"] as const;
const deps = OFFICIAL_DEPLOYMENT_REGISTRY[11155111]!;
const signerAbi = [{ name: "createSigner", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] }] as const;
const guardSlot = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const moduleSlot = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947";
const word = (a: Address) => `0x${a.slice(2).padStart(64, "0")}` as Hex;

function plan(successor: boolean): pwa.PwaProvisioningPlan {
  const transactions = ids.map((id, i) => {
    const data = i < 2 ? encodeFunctionData({ abi: signerAbi, functionName: "createSigner", args: [BigInt(10 + i), BigInt(20 + i), BigInt(deps.passkeySignerVerifier.address!)] }) : code(40 + i);
    return { id, description: id, nonce: BigInt(10 + i + (successor && i > 0 ? 1 : 0)), to: i < 2 ? deps.passkeySignerFactory.address! : zero, value: 0n, operation: 0, data, expectedCreatedAddress: address(i < 2 || !successor ? 100 + i : 200 + i), creationCodeHash: keccak256(data), expectedRuntimeCodeHash: hash(100 + i) };
  });
  const safe = transactions[6]!.expectedCreatedAddress;
  const guard = transactions[3]!.expectedCreatedAddress;
  const delay = transactions[4]!.expectedCreatedAddress;
  return {
    formatVersion: 1, chainId: 11155111, deployer, safe, guard, delay, primaryPasskey: address(100), secondaryPasskey: address(101), usdc: address(250), deploymentsHash: hash(230), policyHash: hash(231), planHash: hash(successor ? 232 : 233),
    transactions,
    vaultPlan: { safeProxySaltNonce: 0n, review: {
      owners: [address(100)], threshold: 1, fallbackHandler: zero, paymentToken: zero, payment: "0", paymentReceiver: zero,
      transactionGuard: guard, moduleGuard: guard, modules: [delay], safeContractSecondary: address(101), ecdsaSecondary: zero,
      periodAnchor: "0", policyHash: hash(231),
      delay: { owner: safe, avatar: safe, target: safe, cooldownSeconds: 120, expirationSeconds: 3600 },
      assets: [{ token: address(250), basePerTransaction: "100", stepUpPerTransaction: "1000", baseDailyLimit: "100", instantDailyLimit: "1000", recipients: [deployer] }],
    } },
  } as unknown as pwa.PwaProvisioningPlan;
}

function fixture() {
  process.env.NODE_ENV = "test";
  const original = plan(false);
  const completed = plan(true);
  const directory = mkdtempSync(join(tmpdir(), "historical-pwa-"));
  pwa.writePwaProvisioningReview(original, directory);
  pwa.writePwaProvisioningReview(completed, directory);
  const receipts = completed.transactions.map((_t, i) => ({ transactionHash: hash(30 + i), status: "success" as const, gasUsed: 90_000n, effectiveGasPrice: 1_000_000_000n, blockNumber: 90n + BigInt(i), blockHash: hash(60 + i) }));
  const journal: LiveJournal = { chainId: 11155111, funder: deployer, entries: completed.transactions.map((t, i) => ({ id: `pwa-${t.id}`, nonce: Number(t.nonce), status: "success", transactionHash: hash(30 + i), receipt: receipts[i], reserved: 90_000_000_000_000n, intentHash: liveIntentHash({ id: `pwa-${t.id}`, ...(t.to === zero ? {} : { to: t.to }), data: t.data, value: t.value, nonce: Number(t.nonce), gas: 100_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }, deployer) })) };
  const successor = pwa.loadPwaProvisioningSuccessor({ formatVersion: 1, scope: "sepolia-pwa-provisioning-successor", chainId: 11155111, originalPackageHash: pwa.provisioningPackageHash(original), confirmedPrefixLength: 1, consumedTransactions: [{ nonce: "11", transactionHash: hash(240) }], expectedNextNonce: "12" });
  const registry = { 11155111: Object.fromEntries(Object.entries(deps).map(([key, value], i) => [key, { ...value, runtimeCodeHash: hash(150 + i) }])) };
  const dependencyCodes = new Map(Object.values(deps).map((d, i) => [d.address!.toLowerCase(), code(150 + i)]));
  const makeClient = (source: string) => ({
    source,
    async getChainId() { return 11155111; },
    async getBlockNumber() { return 110n; },
    async getBlock({ blockNumber }: { blockNumber: bigint }) { return { number: blockNumber, hash: blockNumber >= 90n && blockNumber <= 96n ? hash(60 + Number(blockNumber - 90n)) : hash(80) }; },
    async getTransactionCount() { return 30n; },
    async getTransaction({ hash: requested }: { hash: Hex }) {
      if (requested === hash(240)) return { hash: requested, chainId: 11155111, type: "eip1559" as const, from: deployer, to: address(245), nonce: 11, value: 0n, input: code(245), gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
      const i = receipts.findIndex(r => r.transactionHash === requested);
      if (i < 0) return null;
      const t = completed.transactions[i]!;
      return { hash: requested, chainId: 11155111, type: "eip1559" as const, from: deployer, to: t.to === zero ? null : t.to, nonce: Number(t.nonce), value: t.value, input: t.data, gas: 100_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    },
    async getTransactionReceipt({ hash: requested }: { hash: Hex }) { return requested === hash(240) ? { transactionHash: requested, status: "success" as const, gasUsed: 21_000n, effectiveGasPrice: 1n, blockNumber: 80n, blockHash: hash(80) } : receipts.find(r => r.transactionHash === requested) ?? null; },
    async getBytecode({ address: target }: { address: Address; blockNumber?: bigint }) {
      const i = completed.transactions.findIndex(t => t.expectedCreatedAddress.toLowerCase() === target.toLowerCase());
      return i >= 0 ? code(100 + i) : dependencyCodes.get(target.toLowerCase());
    },
    async getStorageAt({ slot, blockNumber }: { address: Address; slot: Hex; blockNumber?: bigint }) {
      expect(blockNumber).to.equal(110n);
      return word(slot === guardSlot || slot === moduleSlot ? completed.guard : zero);
    },
    async readContract({ address: target, functionName, args, blockNumber }: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> {
      expect(blockNumber).to.equal(110n);
      const safe = completed.safe;
      const values: Record<string, unknown> = { maintenance: completed.transactions[5]!.expectedCreatedAddress, safe, delay: completed.delay, masterCopy: deps.safeSingleton.address, VERSION: deps.safeSingleton.version, getOwners: [address(100)], getThreshold: 1n, config: [safe, address(100), zero, completed.delay, 86400n, 0n], safeContractSecondary: [address(101), 0, true], ecdsaSecondary: [zero, 1, false], policyHash: hash(231), getConfiguredTokens: [address(250)], assetPolicy: [100n, 1000n, 100n, 1000n], getPolicyRecipients: [deployer], spendState: [0n, 10n, 20n], owner: safe, avatar: safe, target: safe, txCooldown: 120n, txExpiration: 3600n };
      if (functionName === "getSigner") return args?.[0] === 10n ? address(100) : address(101);
      if (functionName === "getModulesPaginated") return [[target === completed.safe ? completed.delay : completed.safe], sentinel];
      if (!(functionName in values)) throw new Error(`unexpected historical read ${functionName}`);
      return values[functionName];
    },
    async call() { throw new Error("historical restoration must not reconstruct current artifacts"); },
  });
  return {
    input: { reviewDirectory: directory, journal, providers: [makeClient("a"), makeClient("b")] as const, relay: makeClient("relay"), successors: [successor] },
    options: { anchor: { originalPackageHash: pwa.provisioningPackageHash(original), completedPackageHash: pwa.provisioningPackageHash(completed), profileVersion: "sepolia-pwa-phase-one-allowlisted-v1" }, registry },
    completed,
    bytes: () => readdirSync(directory).sort().map(name => readFileSync(join(directory, name), "utf8")),
  };
}

describe("completed historical PWA vault compatibility", () => {
  it("restores exact historical evidence as a distinct read-only record without rewriting packages", async () => {
    const f = fixture();
    const before = f.bytes();
    const result = await pwa.resolveCompletedHistoricalPwaVaultForTestsOnly(f.input, f.options);
    expect(result?.mode).to.equal("read-only");
    expect(result?.safe).to.equal(address(206));
    expect(result?.policy.recipientMode).to.equal("all-lanes-allowlisted");
    expect(result?.evidence.packageHash).to.equal(f.options.anchor.completedPackageHash);
    expect(pwa.isVerifiedPwaProvisioningResult(result)).to.equal(false);
    expect(f.bytes()).to.deep.equal(before);
  });

  it("never recognizes arbitrary packages through the production registry", async () => {
    const f = fixture();
    expect(await pwa.resolveCompletedHistoricalPwaVault(f.input)).to.equal(undefined);
  });

  it("rejects edited package contents instead of trusting a pinned filename or wrapper hash", async () => {
    const f = fixture();
    const path = join(f.input.reviewDirectory, readdirSync(f.input.reviewDirectory)[0]!);
    const document = JSON.parse(readFileSync(path, "utf8"));
    document.review.policy.assets[0].baseDailyLimit = "101";
    writeFileSync(path, JSON.stringify(document));
    await expect(pwa.resolveCompletedHistoricalPwaVaultForTestsOnly(f.input, f.options)).to.be.rejectedWith(/package hash mismatch/i);
  });

  it("rejects incomplete, pending, changed-cost, and changed-intent histories", async () => {
    for (const mutation of [
      (j: LiveJournal) => { j.entries.pop(); },
      (j: LiveJournal) => { j.entries[6]!.status = "pending"; },
      (j: LiveJournal) => { j.entries[6]!.reserved += 1n; },
      (j: LiveJournal) => { j.entries[6]!.intentHash = hash(241); },
    ]) {
      const f = fixture(); mutation(f.input.journal);
      await expect(pwa.resolveCompletedHistoricalPwaVaultForTestsOnly(f.input, f.options)).to.be.rejected;
    }
  });

  it("rejects changed runtime, canonical receipt, or provider nonce evidence", async () => {
    const f = fixture();
    for (const altered of [
      { ...f.input.providers[1], async getBytecode() { return code(249); } },
      { ...f.input.providers[1], async getTransactionReceipt({ hash: h }: { hash: Hex }) { const r = await f.input.providers[1].getTransactionReceipt({ hash: h }); return r ? { ...r, blockHash: hash(249) } : null; } },
      { ...f.input.providers[1], async getTransactionCount() { return 31n; } },
    ]) await expect(pwa.resolveCompletedHistoricalPwaVaultForTestsOnly({ ...f.input, providers: [f.input.providers[0], altered] }, f.options)).to.be.rejected;
  });

  it("rejects changed owner, policy, secondary, limits, recipients, and Delay topology", async () => {
    const changes: Record<string, unknown> = { getSigner: address(249), getOwners: [address(249)], policyHash: hash(249), safeContractSecondary: [address(101), 0, false], assetPolicy: [100n, 1000n, 101n, 1000n], getPolicyRecipients: [address(249)], owner: address(249), txCooldown: 0n, getModulesPaginated: [[address(249)], sentinel] };
    for (const [name, value] of Object.entries(changes)) {
      const f = fixture();
      const altered = { ...f.input.providers[1], async readContract(args: Parameters<typeof f.input.providers[1]["readContract"]>[0]) { return args.functionName === name ? value : f.input.providers[1].readContract(args); } };
      await expect(pwa.resolveCompletedHistoricalPwaVaultForTestsOnly({ ...f.input, providers: [f.input.providers[0], altered] }, f.options)).to.be.rejected;
    }
  });

  it("rejects changed guard storage and canonical snapshot blocks", async () => {
    const f = fixture();
    const storage = { ...f.input.providers[1], async getStorageAt() { return word(zero); } };
    const block = { ...f.input.providers[1], async getBlock({ blockNumber }: { blockNumber: bigint }) { const b = await f.input.providers[1].getBlock({ blockNumber }); return blockNumber === 110n ? { ...b, hash: hash(249) } : b; } };
    for (const altered of [storage, block]) await expect(pwa.resolveCompletedHistoricalPwaVaultForTestsOnly({ ...f.input, providers: [f.input.providers[0], altered] }, f.options)).to.be.rejected;
  });

  it("rejects a reorg after topology reads and divergent but individually bounded counters", async () => {
    const f = fixture();
    let commonBlockReads = 0;
    const reorged = { ...f.input.providers[1], async getBlock({ blockNumber }: { blockNumber: bigint }) { const block = await f.input.providers[1].getBlock({ blockNumber }); return blockNumber === 110n && ++commonBlockReads > 1 ? { ...block, hash: hash(249) } : block; } };
    await expect(pwa.resolveCompletedHistoricalPwaVaultForTestsOnly({ ...f.input, providers: [f.input.providers[0], reorged] }, f.options)).to.be.rejectedWith(/snapshot block changed/i);
    const divergent = { ...f.input.providers[1], async readContract(args: Parameters<typeof f.input.providers[1]["readContract"]>[0]) { return args.functionName === "spendState" ? [0n, 11n, 21n] : f.input.providers[1].readContract(args); } };
    await expect(pwa.resolveCompletedHistoricalPwaVaultForTestsOnly({ ...f.input, providers: [f.input.providers[0], divergent] }, f.options)).to.be.rejectedWith(/providers disagree on spending state/i);
  });

  it("fails closed on missing topology reads and changed official dependency code", async () => {
    const f = fixture();
    const missing = { ...f.input.providers[1], async readContract() { throw new Error("missing historical RPC evidence"); } };
    await expect(pwa.resolveCompletedHistoricalPwaVaultForTestsOnly({ ...f.input, providers: [f.input.providers[0], missing] }, f.options)).to.be.rejectedWith(/missing historical RPC evidence/);
    const changed = { ...f.input.providers[1], async getBytecode(args: Parameters<typeof f.input.providers[1]["getBytecode"]>[0]) { return args.address.toLowerCase() === deps.safeSingleton.address!.toLowerCase() ? code(249) : f.input.providers[1].getBytecode(args); } };
    await expect(pwa.resolveCompletedHistoricalPwaVaultForTestsOnly({ ...f.input, providers: [f.input.providers[0], changed] }, f.options)).to.be.rejectedWith(/safeSingleton runtime code hash mismatch/i);
  });
});
