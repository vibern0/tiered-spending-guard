import { expect } from "chai";
import { keccak256, serializeTransaction, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brandVaultDeploymentPlanForTestsOnly,
  brandVerifiedVaultPrerequisitesForTestsOnly,
  planHash,
  type VaultDeploymentPlan,
} from "../../../src/topology/build";
import {
  collectSafeCreationQuote,
  executeSafeCreation,
  loadSafeCreationApproval,
  writeSafeCreationReviewPackage,
} from "../../../scripts/live/safe-creation-runner";
import type { LiveContext, LiveJournal, LiveReceipt } from "../../../scripts/live/submission";

process.env.NODE_ENV = "test";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const account = privateKeyToAccount(generatePrivateKey());
const factory = address(99);

function testPlan(): VaultDeploymentPlan {
  const tx = (nonce: bigint, created: Address, data = `0x60${Number(nonce).toString(16).padStart(2, "0")}` as Hex) => ({ description: "test", nonce, to: address(0), value: 0n, operation: 0 as const, data, expectedCreatedAddress: created, creationCodeHash: keccak256(data), expectedRuntimeCodeHash: h(Number(nonce) + 10) });
  return brandVaultDeploymentPlanForTestsOnly(Object.freeze({
    unsigned: true, broadcast: false, chainId: 11155111, deployer: account.address, startingNonce: 673n, safeProxySaltNonce: 7n,
    prerequisites: { setupHelper: tx(673n, address(1)), guard: tx(674n, address(2)), delay: tx(675n, address(3)), maintenance: tx(676n, address(4)) },
    safeProxyDeployment: { ...tx(677n, address(5), "0x12345678"), to: factory },
    safeInitializer: "0xabcd", setupHelperCalldata: "0x1234",
    review: { owners: [address(7)] as const, threshold: 1 as const, fallbackHandler: address(0), paymentToken: address(0), payment: 0n, paymentReceiver: address(0), transactionGuard: address(2), moduleGuard: address(2), modules: [address(3)] as const, safeContractSecondary: address(8), ecdsaSecondary: address(9), assets: [{ token: address(0), basePerTransaction: 1n, stepUpPerTransaction: 2n, baseDailyLimit: 1n, instantDailyLimit: 2n, recipients: [address(10)] }], delay: { owner: address(5), avatar: address(5), target: address(5), upstreamModules: [address(5)] as const, cooldownSeconds: 120, expirationSeconds: 600 }, periodAnchor: 0n, policyHash: h(50), creationCodeHashes: { setupHelper: h(1), guard: h(2), delay: h(3), maintenance: h(4) }, runtimeCodeHashes: { setupHelper: h(11), guard: h(12), delay: h(13), maintenance: h(14) } },
  }));
}

function fixture(value = testPlan()) {
  const receipts = [0, 1, 2, 3].map((i): LiveReceipt => ({ transactionHash: h(i + 100), status: "success", gasUsed: BigInt(100 + i), effectiveGasPrice: 2n, blockNumber: BigInt(1000 + i), blockHash: h(i + 200) }));
  const journal: LiveJournal = { chainId: 11155111, funder: account.address, entries: receipts.map((receipt, i) => ({ id: ["vault-setup-helper", "vault-guard", "vault-delay", "vault-maintenance"][i]!, intentHash: h(i + 300), transactionHash: receipt.transactionHash, nonce: 673 + i, reserved: receipt.gasUsed * receipt.effectiveGasPrice, status: "success", receipt })) };
  const verification = { schemaVersion: 1, chainId: "11155111", packageHash: h(40), planHash: planHash(value), result: "PASS", actualCostWei: journal.entries.reduce((n, e) => n + e.reserved, 0n).toString(), transactions: receipts.map((receipt, i) => ({ id: journal.entries[i]!.id, hash: receipt.transactionHash, from: account.address, to: null, nonce: String(673 + i), chainId: "11155111", type: "0x2", value: "0", inputHash: keccak256(Object.values(value.prerequisites)[i]!.data), gas: "100000", maxFeePerGas: "10", maxPriorityFeePerGas: "1", blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, status: "0x1", contractAddress: Object.values(value.prerequisites)[i]!.expectedCreatedAddress, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), actualCostWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() })) } as const;
  const prerequisites = brandVerifiedVaultPrerequisitesForTestsOnly({ stage: "before-setup", planHash: planHash(value), safeProxyRuntimeCodeHash: h(10), setupHelper: { name: "setupHelper", address: address(1), runtimeCodeHash: h(11), bindingHash: h(1), source: "test" }, guard: { name: "guard", address: address(2), runtimeCodeHash: h(12), bindingHash: h(2), source: "test" }, delay: { name: "delay", address: address(3), runtimeCodeHash: h(13), bindingHash: h(3), source: "test" }, maintenance: { name: "maintenance", address: address(4), runtimeCodeHash: h(14), bindingHash: h(4), source: "test" } });
  const client = {
    chainId: async () => 11155111,
    block: async () => ({ number: 2000n, hash: h(500) }),
    blockHash: async (number: bigint) => receipts.find(r => r.blockNumber === number)?.blockHash ?? h(500),
    latestNonce: async () => 677,
    pendingNonce: async () => 677,
    balance: async () => 1_000_000n,
    code: async () => "0x" as Hex,
    transaction: async (hash: Hex) => {
      const i = receipts.findIndex(r => r.transactionHash === hash); const step = Object.values(value.prerequisites)[i]!;
      return { hash, from: account.address, to: undefined, nonce: 673 + i, chainId: 11155111, type: "eip1559" as const, value: 0n, input: step.data };
    },
    receipt: async (hash: Hex) => receipts.find(r => r.transactionHash === hash),
    estimateGas: async () => 100n,
    call: async () => undefined,
    fees: async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, baseFeePerGas: 1n }),
    verifyPrerequisites: async () => prerequisites,
  };
  return { value, receipts, journal, verification, prerequisites, client };
}

describe("separately approved Safe creation runner", () => {
  it("collects a nonce-current, receipt-bound, read-only quote and loads only its exact hash", async () => {
    const f = fixture();
    const quote = await collectSafeCreationQuote(f.value, f.verification, f.journal, f.client, { gasLimit: 120n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n });
    expect(quote.report).to.deep.include({ status: "AWAITING_HUMAN_REVIEW", currentFundingNonce: "677", signed: false, broadcast: false, actualPrerequisiteCostWei: "812" });
    expect(quote.report.transaction).to.deep.include({ id: "vault-safe", to: factory, data: "0x12345678", value: "0", nonce: "677" });
    expect(quote.report).not.to.have.nested.property("prerequisites[0].signature");
    const dir = mkdtempSync(join(tmpdir(), "safe-review-"));
    try {
      const written = writeSafeCreationReviewPackage(quote, dir);
      expect(loadSafeCreationApproval(f.value, f.verification, f.journal, dir, written.packageHash).reportHash).to.equal(written.packageHash);
      expect(() => loadSafeCreationApproval(f.value, f.verification, f.journal, dir, h(999))).to.throw("hash mismatch");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects cloned quotes, receipt changes, reorgs, nonce splits, fee/gas/balance/cap failures before signing", async () => {
    const f = fixture();
    const quote = await collectSafeCreationQuote(f.value, f.verification, f.journal, f.client, { gasLimit: 120n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n });
    const dir = mkdtempSync(join(tmpdir(), "safe-review-"));
    try {
      const written = writeSafeCreationReviewPackage(quote, dir);
      const approval = loadSafeCreationApproval(f.value, f.verification, f.journal, dir, written.packageHash);
      let signed = 0;
      const live: LiveContext = { funder: account.address, chainId: f.client.chainId, nonce: f.client.latestNonce, balance: f.client.balance, verify: async () => undefined, sign: async intent => { signed++; return account.signTransaction({ chainId: 11155111, type: "eip1559", to: intent.to, data: intent.data, value: intent.value, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }); }, broadcast: async raw => keccak256(raw), receipt: f.client.receipt, persist: async () => undefined };
      const prereq = brandVerifiedVaultPrerequisitesForTestsOnly({ stage: "before-setup", planHash: planHash(f.value), safeProxyRuntimeCodeHash: h(10), setupHelper: { name: "setupHelper", address: address(1), runtimeCodeHash: h(11), bindingHash: h(1), source: "test" }, guard: { name: "guard", address: address(2), runtimeCodeHash: h(12), bindingHash: h(2), source: "test" }, delay: { name: "delay", address: address(3), runtimeCodeHash: h(13), bindingHash: h(3), source: "test" }, maintenance: { name: "maintenance", address: address(4), runtimeCodeHash: h(14), bindingHash: h(4), source: "test" } });
      const context = { live, journal: f.journal, latestNonce: f.client.latestNonce, pendingNonce: f.client.pendingNonce, currentBalance: f.client.balance, safeCode: async () => "0x" as Hex, currentFees: f.client.fees, estimateGas: f.client.estimateGas, exactCall: f.client.call, canonicalBlockHash: f.client.blockHash, verifyBeforeSetup: async () => prereq, waitForReceipt: async () => undefined, verifyAfterSetup: async () => ({ ...prereq, stage: "after-setup" as const }), verifyTopology: async () => ({ ok: true, failures: [], checked: [] }) };
      await expect(executeSafeCreation(f.value, { ...approval }, context)).to.be.rejectedWith("exact opaque approval");
      const originalIntentHash = f.journal.entries[0]!.intentHash;
      f.journal.entries[0]!.intentHash = h(998);
      await expect(executeSafeCreation(f.value, approval, context)).to.be.rejectedWith("approved prerequisite journal");
      f.journal.entries[0]!.intentHash = originalIntentHash;
      await expect(executeSafeCreation(f.value, approval, { ...context, pendingNonce: async () => 678 })).to.be.rejectedWith("latest and pending nonce");
      await expect(executeSafeCreation(f.value, approval, { ...context, currentFees: async () => ({ maxFeePerGas: 11n, maxPriorityFeePerGas: 1n, baseFeePerGas: 1n }) })).to.be.rejectedWith("fee cap");
      await expect(executeSafeCreation(f.value, approval, { ...context, estimateGas: async () => 121n })).to.be.rejectedWith("gas cap");
      await expect(executeSafeCreation(f.value, approval, { ...context, currentBalance: async () => 119n })).to.be.rejectedWith("balance");
      await expect(executeSafeCreation(f.value, approval, { ...context, canonicalBlockHash: async () => h(999) })).to.be.rejectedWith("canonical receipt");
      await expect(executeSafeCreation(f.value, approval, { ...context, safeCode: async () => "0x6000" })).to.be.rejectedWith("unknown pre-existing Safe");
      await expect(executeSafeCreation(f.value, approval, { ...context, verifyBeforeSetup: async () => { throw new Error("topology prerequisite failure"); } })).to.be.rejectedWith("topology prerequisite failure");
      expect(signed).to.equal(0);
      await expect(collectSafeCreationQuote(f.value, f.verification, f.journal, { ...f.client, receipt: async () => undefined }, { gasLimit: 120n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })).to.be.rejectedWith("canonical receipt changed");
      await expect(collectSafeCreationQuote(f.value, f.verification, f.journal, { ...f.client, verifyPrerequisites: async () => { throw new Error("current prerequisite runtime changed"); } }, { gasLimit: 120n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })).to.be.rejectedWith("current prerequisite runtime changed");
      await expect(collectSafeCreationQuote(f.value, f.verification, f.journal, { ...f.client, balance: async () => 100_000_000_000_000_000n }, { gasLimit: 60_000_000_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1n })).to.be.rejectedWith("phase outlay cap");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("signs only the exact EIP-1559 Safe factory intent and requires post-setup topology", async () => {
    const f = fixture();
    const quote = await collectSafeCreationQuote(f.value, f.verification, f.journal, f.client, { gasLimit: 120n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n });
    const dir = mkdtempSync(join(tmpdir(), "safe-review-"));
    try {
      const written = writeSafeCreationReviewPackage(quote, dir);
      const approval = loadSafeCreationApproval(f.value, f.verification, f.journal, dir, written.packageHash);
      let signed = 0; let broadcast = 0; let persisted = 0;
      const safeReceipt: LiveReceipt = { transactionHash: h(700), status: "success", gasUsed: 100n, effectiveGasPrice: 2n, blockNumber: 3000n, blockHash: h(701) };
      const live: LiveContext = { funder: account.address, chainId: f.client.chainId, nonce: f.client.latestNonce, balance: f.client.balance, verify: async () => undefined, sign: async intent => { signed++; expect(intent).to.deep.include({ id: "vault-safe", to: factory, data: "0x12345678", nonce: 677, value: 0n }); return account.signTransaction({ chainId: 11155111, type: "eip1559", to: intent.to, data: intent.data, value: intent.value, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }); }, broadcast: async raw => { broadcast++; safeReceipt.transactionHash = keccak256(raw); return safeReceipt.transactionHash; }, receipt: async hash => f.receipts.find(r => r.transactionHash === hash) ?? (broadcast ? safeReceipt : undefined), persist: async () => { persisted++; } };
      const before = brandVerifiedVaultPrerequisitesForTestsOnly({ stage: "before-setup", planHash: planHash(f.value), safeProxyRuntimeCodeHash: h(10), setupHelper: { name: "setupHelper", address: address(1), runtimeCodeHash: h(11), bindingHash: h(1), source: "test" }, guard: { name: "guard", address: address(2), runtimeCodeHash: h(12), bindingHash: h(2), source: "test" }, delay: { name: "delay", address: address(3), runtimeCodeHash: h(13), bindingHash: h(3), source: "test" }, maintenance: { name: "maintenance", address: address(4), runtimeCodeHash: h(14), bindingHash: h(4), source: "test" } });
      const after = brandVerifiedVaultPrerequisitesForTestsOnly({ ...before, stage: "after-setup" });
      const context = { live, journal: f.journal, latestNonce: f.client.latestNonce, pendingNonce: f.client.pendingNonce, currentBalance: f.client.balance, safeCode: async () => "0x" as Hex, currentFees: f.client.fees, estimateGas: f.client.estimateGas, exactCall: f.client.call, canonicalBlockHash: f.client.blockHash, verifyBeforeSetup: async () => before, waitForReceipt: async () => undefined, verifyAfterSetup: async () => after, verifyTopology: async () => ({ ok: true, failures: [], checked: ["safe"] }) };
      const result = await executeSafeCreation(f.value, approval, context);
      expect(result.status).to.equal("SAFE_CREATED_TOPOLOGY_VERIFIED");
      expect({ signed, broadcast }).to.deep.equal({ signed: 1, broadcast: 1 });
      expect(persisted).to.be.greaterThan(0);
      const resumed = await executeSafeCreation(f.value, approval, { ...context, latestNonce: async () => 678, pendingNonce: async () => 678, safeCode: async () => "0x6000", verifyBeforeSetup: async () => { throw new Error("must not run pre-setup verifier for known included hash"); } });
      expect(resumed.status).to.equal("SAFE_CREATED_TOPOLOGY_VERIFIED");
      expect({ signed, broadcast }).to.deep.equal({ signed: 1, broadcast: 1 });
      f.journal.entries[0]!.reserved += 1n;
      await expect(executeSafeCreation(f.value, approval, context)).to.be.rejectedWith("approved prerequisite journal");
      f.journal.entries[0]!.reserved -= 1n;
      const safeReserved = f.journal.entries[4]!.reserved;
      f.journal.entries[4]!.reserved = 1201n;
      await expect(executeSafeCreation(f.value, approval, context)).to.be.rejectedWith("phase accounting exceeds approval");
      f.journal.entries[4]!.reserved = safeReserved;
      f.journal.entries.push({ ...f.journal.entries[4]!, id: "unexpected-extra" });
      await expect(executeSafeCreation(f.value, approval, context)).to.be.rejectedWith("only the exact vault-safe resume entry");
      f.journal.entries.pop();
      const failed = fixture();
      const failedQuote = await collectSafeCreationQuote(failed.value, failed.verification, failed.journal, failed.client, { gasLimit: 120n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n });
      expect(failedQuote.report.totalMaximumPhaseOutlayWei).to.equal("2012");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
