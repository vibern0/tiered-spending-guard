import { expect } from "chai";
import { keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brandVaultDeploymentPlanForTestsOnly,
  brandVerifiedVaultPrerequisitesForTestsOnly,
  planHash,
  type VaultDeploymentPlan,
  type VerifiedVaultPrerequisites,
} from "../../../src/topology/build";
import { executeVaultDeployment } from "../../../scripts/live/vault-runner";
import { collectVaultDeploymentReviewEvidence } from "../../../scripts/live/prepare-vault-review";
import { writeReviewedVaultDeploymentPackage } from "../../../scripts/package-sepolia-rehearsal";
import type { LiveContext, LiveJournal } from "../../../scripts/live/submission";

process.env.NODE_ENV = "test";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const code = "0x6000" as Hex;
const hash = keccak256(code);
const account = privateKeyToAccount(generatePrivateKey());

function plan(): VaultDeploymentPlan {
  const transaction = (nonce: bigint, created: Address) => ({ description: "test", nonce, to: address(0), value: 0n, operation: 0 as const, data: code, expectedCreatedAddress: created, creationCodeHash: hash, expectedRuntimeCodeHash: hash });
  const value = {
    unsigned: true as const, broadcast: false as const, chainId: 11155111, deployer: account.address, startingNonce: 0n, safeProxySaltNonce: 7n,
    prerequisites: { setupHelper: transaction(0n, address(1)), guard: transaction(1n, address(2)), delay: transaction(2n, address(3)), maintenance: transaction(3n, address(4)) },
    safeProxyDeployment: { ...transaction(4n, address(5)), to: address(6) },
    safeInitializer: "0x" as Hex, setupHelperCalldata: "0x" as Hex,
    review: { owners: [address(7)] as readonly [Address], threshold: 1 as const, fallbackHandler: address(0), paymentToken: address(0), payment: 0n, paymentReceiver: address(0), transactionGuard: address(2), moduleGuard: address(2), modules: [address(3)] as const, delay: { owner: address(5), avatar: address(5), target: address(5), upstreamModules: [address(5)] as const, cooldownSeconds: 120, expirationSeconds: 600 }, periodAnchor: 0n, policyHash: hash, creationCodeHashes: { setupHelper: hash, guard: hash, delay: hash, maintenance: hash }, runtimeCodeHashes: { setupHelper: hash, guard: hash, delay: hash, maintenance: hash } },
  } satisfies VaultDeploymentPlan;
  return brandVaultDeploymentPlanForTestsOnly(Object.freeze(value));
}

function evidence(value: VaultDeploymentPlan, stage: "before-setup" | "after-setup"): VerifiedVaultPrerequisites {
  return brandVerifiedVaultPrerequisitesForTestsOnly(Object.freeze({
    stage, planHash: planHash(value), safeProxyRuntimeCodeHash: hash,
    setupHelper: { name: "setupHelper" as const, address: address(1), runtimeCodeHash: hash, bindingHash: hash, source: "test" },
    guard: { name: "guard" as const, address: address(2), runtimeCodeHash: hash, bindingHash: hash, source: "test" },
    delay: { name: "delay" as const, address: address(3), runtimeCodeHash: hash, bindingHash: hash, source: "test" },
    maintenance: { name: "maintenance" as const, address: address(4), runtimeCodeHash: hash, bindingHash: hash, source: "test" },
  }));
}

describe("reviewed vault deployment runner", () => {
  it("collects read-only prerequisite estimates and leaves Safe creation behind an exact follow-up gate", async () => {
    const value = plan();
    const estimated: string[] = [];
    const evidence = await collectVaultDeploymentReviewEvidence(value, {
      getBlockNumber: async () => 123n,
      getTransactionCount: async ({ address: deployer }) => { expect(deployer).to.equal(account.address); return 0; },
      getBalance: async ({ address: deployer }) => { expect(deployer).to.equal(account.address); return 50_000_000_000_000_000n; },
      estimateGas: async (transaction) => { estimated.push(`${transaction.account}:${transaction.data}`); return 21_000n; },
      call: async ({ gas }) => { expect(gas).to.equal(25_200n); return {}; },
    }, {
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
      safeCreationGasLimit: 50_000n,
      runtimeChecks: [{ name: "primaryPasskey", address: address(7), runtimeCodeHash: hash, bindingHash: hash }],
      assetChecks: [{ token: address(0), kind: "native", symbol: "ETH", decimals: 18 }],
    });
    expect(estimated).to.have.length(4);
    expect(estimated.every((entry) => entry.startsWith(`${account.address}:0x6000`))).to.equal(true);
    expect(evidence.transactions.slice(0, 4).every((transaction) => transaction.estimateStatus === "estimated" && transaction.reviewedGasLimit === 25_200n && transaction.limitSimulationStatus === "eth_call-succeeded")).to.equal(true);
    expect(evidence.transactions[4]).to.include({ id: "vault-safe", estimateStatus: "deferred-until-prerequisites", reviewedGasLimit: 50_000n });
    expect(evidence.maximumReservedOutlay).to.equal(1_508_000n);
  });

  it("fails review preparation on nonce drift before estimating", async () => {
    const value = plan();
    await expect(collectVaultDeploymentReviewEvidence(value, {
      getBlockNumber: async () => 123n,
      getTransactionCount: async () => 1,
      getBalance: async () => 50_000_000_000_000_000n,
      estimateGas: async () => { throw new Error("must not estimate"); },
      call: async () => { throw new Error("must not simulate"); },
    }, {
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
      safeCreationGasLimit: 50_000n,
      runtimeChecks: [{ name: "primaryPasskey", address: address(7), runtimeCodeHash: hash }],
      assetChecks: [{ token: address(0), kind: "native", symbol: "ETH", decimals: 18 }],
    })).to.be.rejectedWith(/nonce changed/i);
  });

  it("packages the branded artifact-backed plan with exact decoded transactions and bounded public estimates", () => {
    const value = plan();
    const directory = mkdtempSync(join(tmpdir(), "reviewed-vault-package-"));
    try {
      const result = writeReviewedVaultDeploymentPackage(value, {
        snapshotBlockNumber: 123n,
        observedDeployerNonce: 0n,
        funderBalance: 50_000_000_000_000_000n,
        phaseOutlayCeiling: 50_000_000_000_000_000n,
        maximumReservedOutlay: 1_508_000n,
        transactions: [
          { id: "vault-setup-helper", nonce: 0n, estimateStatus: "estimated", estimatedGas: 21_000n, reviewedGasLimit: 25_200n, limitSimulationStatus: "eth_call-succeeded", maxFeePerGas: 10n, maxPriorityFeePerGas: 1n },
          { id: "vault-guard", nonce: 1n, estimateStatus: "estimated", estimatedGas: 21_000n, reviewedGasLimit: 25_200n, limitSimulationStatus: "eth_call-succeeded", maxFeePerGas: 10n, maxPriorityFeePerGas: 1n },
          { id: "vault-delay", nonce: 2n, estimateStatus: "estimated", estimatedGas: 21_000n, reviewedGasLimit: 25_200n, limitSimulationStatus: "eth_call-succeeded", maxFeePerGas: 10n, maxPriorityFeePerGas: 1n },
          { id: "vault-maintenance", nonce: 3n, estimateStatus: "estimated", estimatedGas: 21_000n, reviewedGasLimit: 25_200n, limitSimulationStatus: "eth_call-succeeded", maxFeePerGas: 10n, maxPriorityFeePerGas: 1n },
          { id: "vault-safe", nonce: 4n, estimateStatus: "deferred-until-prerequisites", reviewedGasLimit: 50_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n },
        ],
        runtimeChecks: [{ name: "primaryPasskey", address: address(7), runtimeCodeHash: hash, bindingHash: hash }],
        assetChecks: [{ token: address(0), kind: "native", symbol: "ETH", decimals: 18 }],
      }, directory);
      expect(result.files.map((file) => file.split("/").pop()).sort()).to.deep.equal(["decoded-review.json", "expected-evidence-hashes.json", "public-manifest.json", "unsigned-plan.json"]);
      const unsignedPlan = JSON.parse(readFileSync(join(directory, "unsigned-plan.json"), "utf8"));
      const decoded = JSON.parse(readFileSync(join(directory, "decoded-review.json"), "utf8"));
      const manifest = JSON.parse(readFileSync(join(directory, "public-manifest.json"), "utf8"));
      expect(unsignedPlan.startingNonce).to.equal("0");
      expect(unsignedPlan.prerequisites.guard.data).to.equal(code);
      expect(decoded.transactions.map((transaction: { id: string }) => transaction.id)).to.deep.equal(["vault-setup-helper", "vault-guard", "vault-delay", "vault-maintenance", "vault-safe"]);
      expect(decoded.transactions[0]).to.include({ nonce: "0", to: address(0), data: code, expectedCreatedAddress: address(1) });
      expect(decoded.estimates.transactions[4]).to.include({ id: "vault-safe", estimateStatus: "deferred-until-prerequisites", reviewedGasLimit: "50000" });
      expect(manifest.status).to.equal("AWAITING_HUMAN_REVIEW");
      expect(manifest.reviewBoundary).to.match(/no signing or broadcast/i);
      expect(BigInt(decoded.estimates.maximumReservedOutlay) <= BigInt(decoded.estimates.phaseOutlayCeiling)).to.equal(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects fabricated plans and outlay estimates before writing public review artifacts", () => {
    const value = plan();
    const directory = mkdtempSync(join(tmpdir(), "reviewed-vault-package-reject-"));
    const estimates = {
      snapshotBlockNumber: 123n,
      observedDeployerNonce: 0n,
      funderBalance: 1n,
      phaseOutlayCeiling: 1n,
      maximumReservedOutlay: 2n,
      transactions: [],
      runtimeChecks: [],
      assetChecks: [],
    } as const;
    try {
      expect(() => writeReviewedVaultDeploymentPackage({ ...value } as VaultDeploymentPlan, estimates, join(directory, "fabricated"))).to.throw(/reviewed planner/i);
      expect(() => writeReviewedVaultDeploymentPackage(value, estimates, join(directory, "over-budget"))).to.throw(/outlay ceiling/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires a reviewed plan before signing", async () => {
    const value = plan();
    await expect(executeVaultDeployment({ ...value } as VaultDeploymentPlan, {} as never)).to.be.rejectedWith("reviewed planner");
  });

  it("reconciles each receipt, verifies pre-setup bindings, then verifies the completed topology", async () => {
    const value = plan();
    const journal: LiveJournal = { chainId: 11155111, funder: account.address, entries: [] };
    let nonce = 0;
    const receipts = new Map<Hex, boolean>();
    const signed = new Map<Hex, Hex>();
    const calls: string[] = [];
    const live: LiveContext = {
      funder: account.address,
      chainId: async () => 11155111,
      nonce: async () => nonce,
      balance: async () => 50_000_000_000_000_000n,
      verify: async () => { calls.push("preflight"); },
      sign: async (intent) => account.signTransaction({ chainId: 11155111, type: "eip1559", to: intent.to, data: intent.data, value: intent.value, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }),
      broadcast: async (raw) => { const txHash = keccak256(raw); signed.set(txHash, raw); nonce += 1; return txHash; },
      receipt: async (transactionHash) => receipts.get(transactionHash) ? { transactionHash, status: "success" as const, gasUsed: 21_000n, effectiveGasPrice: 1n, blockNumber: 1n, blockHash: hash } : undefined,
      persist: async () => undefined,
    };
    const result = await executeVaultDeployment(value, {
      live, journal,
      feeFor: async () => ({ gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      waitForReceipt: async (transactionHash) => { calls.push(`receipt:${transactionHash}`); receipts.set(transactionHash, true); },
      verifyPrerequisites: async (_plan, stage) => { calls.push(stage); return evidence(value, stage); },
      verifyTopology: async () => ({ ok: true, failures: [], checked: ["all"] }),
    });
    expect(result.topology.ok).to.equal(true);
    expect(journal.entries.map((entry) => entry.id)).to.deep.equal(["vault-setup-helper", "vault-guard", "vault-delay", "vault-maintenance", "vault-safe"]);
    expect(journal.entries.every((entry) => entry.status === "success")).to.equal(true);
    expect(calls).to.include.members(["before-setup", "after-setup"]);
    expect(signed.size).to.equal(5);
  });

  it("obtains each fee only when its nonce is ready to submit", async () => {
    const value = plan();
    const journal: LiveJournal = { chainId: 11155111, funder: account.address, entries: [] };
    let nonce = 0;
    const receipts = new Set<Hex>();
    const feeCalls: string[] = [];
    const live: LiveContext = {
      funder: account.address,
      chainId: async () => 11155111,
      nonce: async () => nonce,
      balance: async () => 50_000_000_000_000_000n,
      verify: async () => undefined,
      sign: async (intent) => account.signTransaction({ chainId: 11155111, type: "eip1559", to: intent.to, data: intent.data, value: intent.value, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }),
      broadcast: async (raw) => { const transactionHash = keccak256(raw); nonce += 1; return transactionHash; },
      receipt: async (transactionHash) => receipts.has(transactionHash) ? { transactionHash, status: "success" as const, gasUsed: 21_000n, effectiveGasPrice: 1n, blockNumber: 1n, blockHash: hash } : undefined,
      persist: async () => undefined,
    };
    await executeVaultDeployment(value, {
      live,
      journal,
      feeFor: async (transaction) => {
        expect(journal.entries).to.have.length(Number(transaction.nonce));
        feeCalls.push(transaction.description);
        return { gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
      },
      waitForReceipt: async (transactionHash) => { receipts.add(transactionHash); },
      verifyPrerequisites: async (_plan, stage) => evidence(value, stage),
      verifyTopology: async () => ({ ok: true, failures: [], checked: ["all"] }),
    });
    expect(feeCalls).to.deep.equal(["test", "test", "test", "test", "test"]);
  });
});
