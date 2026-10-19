import { expect } from "chai";
import { keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brandVaultDeploymentPlanForTestsOnly,
  brandVerifiedVaultPrerequisitesForTestsOnly,
  planHash,
  type VaultDeploymentPlan,
  type VerifiedVaultPrerequisites,
} from "../../../src/topology/build";
import { executeVaultPrerequisites, loadReviewedVaultPrerequisiteApproval } from "../../../scripts/live/vault-runner";
import { captureVaultReviewSnapshot, collectVaultDeploymentReviewEvidence, type VaultReviewSnapshot } from "../../../scripts/live/prepare-vault-review";
import { writeReviewedVaultDeploymentPackage } from "../../../scripts/package-sepolia-rehearsal";
import type { LiveContext, LiveJournal } from "../../../scripts/live/submission";
import { OFFICIAL_DEPLOYMENT_REGISTRY } from "../../../src/config/deployments";
import { sha256 } from "../../../scripts/plan-deployment";
import { assertOrdinaryReviewPlan, buildOrdinaryReviewPolicyDraft, readOrdinaryReviewConfig, selectApprovedFees } from "../../../scripts/live/ordinary-review-profile";
import { prepareOrdinaryReviewExecutionPreflight, runOnlyWithLiveSubmitAuthorization } from "../../../scripts/live/ordinary-review-execution";
import { deriveComponentAddresses } from "../../../src/topology/addressing";

process.env.NODE_ENV = "test";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const code = "0x6000" as Hex;
const hash = keccak256(code);
const account = privateKeyToAccount(generatePrivateKey());

function plan(reviewAssets?: VaultDeploymentPlan["review"]["assets"]): VaultDeploymentPlan {
  const transaction = (nonce: bigint, created: Address) => ({ description: "test", nonce, to: address(0), value: 0n, operation: 0 as const, data: code, expectedCreatedAddress: created, creationCodeHash: hash, expectedRuntimeCodeHash: hash });
  const value = {
    unsigned: true as const, broadcast: false as const, chainId: 11155111, deployer: account.address, startingNonce: 0n, safeProxySaltNonce: 7n,
    prerequisites: { setupHelper: transaction(0n, address(1)), guard: transaction(1n, address(2)), delay: transaction(2n, address(3)), maintenance: transaction(3n, address(4)) },
    safeProxyDeployment: { ...transaction(4n, address(5)), to: address(6) },
    safeInitializer: "0x" as Hex, setupHelperCalldata: "0x" as Hex,
    review: { owners: [address(7)] as readonly [Address], threshold: 1 as const, fallbackHandler: address(0), paymentToken: address(0), payment: 0n, paymentReceiver: address(0), transactionGuard: address(2), moduleGuard: address(2), modules: [address(3)] as const, safeContractSecondary: address(8), ecdsaSecondary: address(9), assets: reviewAssets ?? [{ token: address(0), basePerTransaction: 1n, stepUpPerTransaction: 2n, baseDailyLimit: 1n, instantDailyLimit: 2n, recipients: [address(10)] }], delay: { owner: address(5), avatar: address(5), target: address(5), upstreamModules: [address(5)] as const, cooldownSeconds: 120, expirationSeconds: 600 }, periodAnchor: 0n, policyHash: hash, creationCodeHashes: { setupHelper: hash, guard: hash, delay: hash, maintenance: hash }, runtimeCodeHashes: { setupHelper: hash, guard: hash, delay: hash, maintenance: hash } },
  } satisfies VaultDeploymentPlan;
  return brandVaultDeploymentPlanForTestsOnly(Object.freeze(value));
}

function planForOrdinaryReviewConfig(config: ReturnType<typeof readOrdinaryReviewConfig>, startingNonce: bigint): VaultDeploymentPlan {
  const draft = buildOrdinaryReviewPolicyDraft(config, startingNonce);
  const components = deriveComponentAddresses({ deployer: config.funder, startingNonce });
  const base = plan(draft.assets);
  const transaction = (original: typeof base.prerequisites.setupHelper, nonce: bigint, expectedCreatedAddress: Address) => Object.freeze({ ...original, nonce, expectedCreatedAddress });
  const safe = base.safeProxyDeployment.expectedCreatedAddress;
  return brandVaultDeploymentPlanForTestsOnly(Object.freeze({
    ...base,
    deployer: config.funder,
    startingNonce,
    safeProxySaltNonce: config.safeProxySaltNonce,
    prerequisites: Object.freeze({
      setupHelper: transaction(base.prerequisites.setupHelper, startingNonce, components.setupHelper),
      guard: transaction(base.prerequisites.guard, startingNonce + 1n, components.guard),
      delay: transaction(base.prerequisites.delay, startingNonce + 2n, components.delay),
      maintenance: transaction(base.prerequisites.maintenance, startingNonce + 3n, components.maintenance),
    }),
    safeProxyDeployment: transaction(base.safeProxyDeployment, startingNonce + 4n, safe),
    review: Object.freeze({
      ...base.review,
      owners: [config.primaryPasskey] as const,
      transactionGuard: components.guard,
      moduleGuard: components.guard,
      modules: [components.delay] as const,
      safeContractSecondary: config.safeContractSecondary,
      ecdsaSecondary: config.ecdsaSecondary,
      assets: draft.assets,
      delay: Object.freeze({ ...base.review.delay, upstreamModules: [safe] as const, owner: safe, avatar: safe, target: safe }),
      periodAnchor: config.periodAnchor,
    }),
  }));
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

function reviewLimits(value: VaultDeploymentPlan, snapshot: VaultReviewSnapshot) {
  const registry = OFFICIAL_DEPLOYMENT_REGISTRY[11155111]!;
  return {
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
    safeCreationGasLimit: 50_000n,
    snapshot,
    runtimeChecks: [
      ...Object.values(registry).map((record) => ({ name: record.name, address: record.address!, runtimeCodeHash: record.runtimeCodeHash! })),
      { name: "primaryPasskey", address: value.review.owners[0], runtimeCodeHash: hash, bindingHash: hash },
      { name: "safeContractSecondary", address: value.review.safeContractSecondary, runtimeCodeHash: hash, bindingHash: hash },
      { name: "plannedSetupHelper", address: value.prerequisites.setupHelper.expectedCreatedAddress, runtimeCodeHash: hash, bindingHash: hash },
      { name: "plannedGuard", address: value.prerequisites.guard.expectedCreatedAddress, runtimeCodeHash: hash, bindingHash: hash },
      { name: "plannedDelay", address: value.prerequisites.delay.expectedCreatedAddress, runtimeCodeHash: hash, bindingHash: hash },
      { name: "plannedMaintenance", address: value.prerequisites.maintenance.expectedCreatedAddress, runtimeCodeHash: hash, bindingHash: hash },
      { name: "plannedSafeProxy", address: value.safeProxyDeployment.expectedCreatedAddress, runtimeCodeHash: hash },
    ],
    assetChecks: value.review.assets.map((asset) => asset.token.toLowerCase() === address(0)
      ? { token: asset.token, kind: "native" as const, symbol: "ETH", decimals: 18 }
      : { token: asset.token, kind: "erc20" as const, symbol: "USDC", decimals: 6, runtimeCodeHash: hash }),
  };
}

const reviewClient = (nonce = 0) => ({
  getBlock: async () => ({ number: 123n, hash }),
  getTransactionCount: async () => nonce,
  getBalance: async () => 50_000_000_000_000_000n,
  estimateGas: async () => 21_000n,
  call: async () => ({}),
});

async function reviewedPackage(value: VaultDeploymentPlan): Promise<Readonly<{ directory: string; packageHash: Hex }>> {
  const directory = mkdtempSync(join(tmpdir(), "reviewed-vault-execution-"));
  const client = reviewClient(Number(value.startingNonce));
  const snapshot = await captureVaultReviewSnapshot(client);
  const collected = await collectVaultDeploymentReviewEvidence(value, client, reviewLimits(value, snapshot));
  const result = writeReviewedVaultDeploymentPackage(value, collected, directory);
  return { directory, packageHash: result.packageHash as Hex };
}

describe("reviewed vault deployment runner", () => {
  it("uses the committed ordinary review profile for both assets and package preflight", async () => {
    const config = readOrdinaryReviewConfig(join(process.cwd(), "config/sepolia.ordinary-review.json"));
    const draft = buildOrdinaryReviewPolicyDraft(config, 545n);
    expect(draft.assets.map((asset) => asset.token.toLowerCase())).to.deep.equal([address(0), config.erc20.toLowerCase()]);
    expect(draft.assets[0]).to.include({ basePerTransaction: 10_000_000_000_000n, stepUpPerTransaction: 30_000_000_000_000n });
    expect(draft.assets[1]).to.include({ basePerTransaction: 10_000_000n, stepUpPerTransaction: 30_000_000n });
    const value = planForOrdinaryReviewConfig(config, 545n);
    expect(() => assertOrdinaryReviewPlan(config, value)).not.to.throw();
    const reviewed = await reviewedPackage(value);
    try {
      const preflight = prepareOrdinaryReviewExecutionPreflight(config, value, reviewed.directory, reviewed.packageHash);
      expect(preflight.report).to.deep.include({ packageHash: reviewed.packageHash, planHash: planHash(value), startingNonce: "545", status: "PREFLIGHT_ONLY" });
      expect(preflight.report.prerequisites).to.have.length(4);
      let submissions = 0;
      expect(await runOnlyWithLiveSubmitAuthorization(undefined, async () => { submissions += 1; })).to.deep.equal({ status: "PREFLIGHT_ONLY" });
      expect(submissions).to.equal(0);
      await expect(runOnlyWithLiveSubmitAuthorization("NO", async () => { submissions += 1; })).to.be.rejectedWith(/LIVE_SUBMIT=YES/);
      expect(submissions).to.equal(0);
    } finally {
      rmSync(reviewed.directory, { recursive: true, force: true });
    }
  });

  it("caps provider fee suggestions at approved values and fails below base fee", () => {
    expect(selectApprovedFees({ maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 2_000_000n }, 15n, { maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n })).to.deep.equal({ maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 999_985n });
    expect(() => selectApprovedFees({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, 1_000_001n, { maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_000n })).to.throw(/base fee.*approved/i);
  });

  it("collects read-only prerequisite estimates and leaves Safe creation behind an exact follow-up gate", async () => {
    const value = plan();
    const estimated: string[] = [];
    const client = {
      getBlock: async () => ({ number: 123n, hash }),
      getTransactionCount: async ({ address: deployer }) => { expect(deployer).to.equal(account.address); return 0; },
      getBalance: async ({ address: deployer }) => { expect(deployer).to.equal(account.address); return 50_000_000_000_000_000n; },
      estimateGas: async (transaction: { account: Address; data: Hex; blockNumber?: bigint }) => { expect(transaction.blockNumber).to.equal(123n); estimated.push(`${transaction.account}:${transaction.data}`); return 21_000n; },
      call: async ({ gas, blockNumber }: { gas: bigint; blockNumber?: bigint }) => { expect(gas).to.equal(25_200n); expect(blockNumber).to.equal(123n); return {}; },
    };
    const snapshot = await captureVaultReviewSnapshot(client);
    const evidence = await collectVaultDeploymentReviewEvidence(value, client, reviewLimits(value, snapshot));
    expect(estimated).to.have.length(4);
    expect(estimated.every((entry) => entry.startsWith(`${account.address}:0x6000`))).to.equal(true);
    expect(evidence.transactions.slice(0, 4).every((transaction) => transaction.estimateStatus === "estimated" && transaction.reviewedGasLimit === 25_200n && transaction.limitSimulationStatus === "eth_call-succeeded")).to.equal(true);
    expect(evidence.transactions[4]).to.include({ id: "vault-safe", estimateStatus: "deferred-until-prerequisites", reviewedGasLimit: 50_000n });
    expect(evidence.maximumReservedOutlay).to.equal(1_508_000n);
  });

  it("fails review preparation on nonce drift before estimating", async () => {
    const value = plan();
    const client = {
      getBlock: async () => ({ number: 123n, hash }),
      getTransactionCount: async () => 1,
      getBalance: async () => 50_000_000_000_000_000n,
      estimateGas: async () => { throw new Error("must not estimate"); },
      call: async () => { throw new Error("must not simulate"); },
    };
    const snapshot = await captureVaultReviewSnapshot(client);
    await expect(collectVaultDeploymentReviewEvidence(value, client, reviewLimits(value, snapshot))).to.be.rejectedWith(/nonce changed/i);
  });

  it("rejects missing checklist entries and cloned collector evidence", async () => {
    const value = plan();
    const client = reviewClient();
    const snapshot = await captureVaultReviewSnapshot(client);
    const complete = reviewLimits(value, snapshot);
    await expect(collectVaultDeploymentReviewEvidence(value, client, {
      ...complete,
      runtimeChecks: complete.runtimeChecks.slice(0, -1),
    })).to.be.rejectedWith(/runtime checklist is incomplete/i);
    const collected = await collectVaultDeploymentReviewEvidence(value, client, complete);
    expect(Object.isFrozen(collected)).to.equal(true);
    expect(Object.isFrozen(collected.runtimeChecks[0])).to.equal(true);
    const directory = mkdtempSync(join(tmpdir(), "reviewed-vault-package-clone-"));
    try {
      expect(() => writeReviewedVaultDeploymentPackage(value, { ...collected }, directory)).to.throw(/collector-produced evidence/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when the pinned review block changes before finalization", async () => {
    const value = plan();
    let blockReads = 0;
    const client = {
      ...reviewClient(),
      getBlock: async () => ({ number: 123n, hash: blockReads++ === 0 ? hash : keccak256("0x6001") }),
    };
    const snapshot = await captureVaultReviewSnapshot(client);
    await expect(collectVaultDeploymentReviewEvidence(value, client, reviewLimits(value, snapshot))).to.be.rejectedWith(/snapshot.*canonical/i);
  });

  it("fails closed when nonce or balance changes before finalization", async () => {
    const value = plan();
    for (const drift of ["nonce", "balance"] as const) {
      let nonceReads = 0;
      let balanceReads = 0;
      const client = {
        ...reviewClient(),
        getTransactionCount: async () => drift === "nonce" && nonceReads++ > 0 ? 1 : 0,
        getBalance: async () => drift === "balance" && balanceReads++ > 0 ? 49_999_999_999_999_999n : 50_000_000_000_000_000n,
      };
      const snapshot = await captureVaultReviewSnapshot(client);
      await expect(collectVaultDeploymentReviewEvidence(value, client, reviewLimits(value, snapshot))).to.be.rejectedWith(new RegExp(`${drift} changed during review`, "i"));
    }
  });

  it("packages the branded artifact-backed plan with exact decoded transactions and bounded public estimates", async () => {
    const value = plan();
    const directory = mkdtempSync(join(tmpdir(), "reviewed-vault-package-"));
    try {
      const client = reviewClient();
      const snapshot = await captureVaultReviewSnapshot(client);
      const collected = await collectVaultDeploymentReviewEvidence(value, client, reviewLimits(value, snapshot));
      const result = writeReviewedVaultDeploymentPackage(value, collected, directory);
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
      expect(manifest).to.include({ snapshotBlockNumber: "123", snapshotBlockHash: hash });
      expect(manifest.readContext).to.deep.equal({ chainState: "block-number-pinned", gasEstimates: "block-number-pinned", finalization: "canonical-block-and-latest-account-rechecked" });
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
    const fabricatedComplete = {
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
    } as const;
    try {
      expect(() => writeReviewedVaultDeploymentPackage({ ...value } as VaultDeploymentPlan, estimates, join(directory, "fabricated"))).to.throw(/reviewed planner/i);
      expect(() => writeReviewedVaultDeploymentPackage(value, estimates, join(directory, "over-budget"))).to.throw(/collector-produced evidence/i);
      expect(() => writeReviewedVaultDeploymentPackage(value, fabricatedComplete, join(directory, "forged-evidence"))).to.throw(/collector-produced evidence/i);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires a reviewed plan before signing", async () => {
    const value = plan();
    await expect(executeVaultPrerequisites({ ...value } as VaultDeploymentPlan, {} as never)).to.be.rejectedWith("reviewed planner");
  });

  it("rejects an unmatched package hash and aggregate before signing", async () => {
    const value = plan();
    const reviewed = await reviewedPackage(value);
    try {
      expect(() => loadReviewedVaultPrerequisiteApproval(value, reviewed.directory, keccak256("0x1234"))).to.throw(/package hash/i);

      const decodedPath = join(reviewed.directory, "decoded-review.json");
      const manifestPath = join(reviewed.directory, "public-manifest.json");
      const hashesPath = join(reviewed.directory, "expected-evidence-hashes.json");
      const decoded = JSON.parse(readFileSync(decodedPath, "utf8"));
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const hashes = JSON.parse(readFileSync(hashesPath, "utf8"));
      decoded.estimates.maximumReservedOutlay = "1";
      manifest.decodedReviewHash = sha256(decoded);
      hashes.decodedReviewHash = manifest.decodedReviewHash;
      hashes.publicManifestHash = sha256(manifest);
      writeFileSync(decodedPath, `${JSON.stringify(decoded, null, 2)}\n`);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(hashesPath, `${JSON.stringify(hashes, null, 2)}\n`);
      const names = ["unsigned-plan.json", "decoded-review.json", "public-manifest.json", "expected-evidence-hashes.json"];
      const mutatedHash = sha256(names.map((name) => readFileSync(join(reviewed.directory, name), "utf8")));
      expect(() => loadReviewedVaultPrerequisiteApproval(value, reviewed.directory, mutatedHash)).to.throw(/aggregate|outlay/i);
    } finally {
      rmSync(reviewed.directory, { recursive: true, force: true });
    }
  });

  it("rejects a package transaction nonce that does not match the plan", async () => {
    const value = plan();
    const reviewed = await reviewedPackage(value);
    try {
      const decodedPath = join(reviewed.directory, "decoded-review.json");
      const manifestPath = join(reviewed.directory, "public-manifest.json");
      const hashesPath = join(reviewed.directory, "expected-evidence-hashes.json");
      const decoded = JSON.parse(readFileSync(decodedPath, "utf8"));
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const hashes = JSON.parse(readFileSync(hashesPath, "utf8"));
      decoded.transactions[0].nonce = "1";
      manifest.decodedReviewHash = sha256(decoded);
      hashes.decodedReviewHash = manifest.decodedReviewHash;
      hashes.publicManifestHash = sha256(manifest);
      writeFileSync(decodedPath, `${JSON.stringify(decoded, null, 2)}\n`);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(hashesPath, `${JSON.stringify(hashes, null, 2)}\n`);
      const names = ["unsigned-plan.json", "decoded-review.json", "public-manifest.json", "expected-evidence-hashes.json"];
      const mutatedHash = sha256(names.map((name) => readFileSync(join(reviewed.directory, name), "utf8")));
      expect(() => loadReviewedVaultPrerequisiteApproval(value, reviewed.directory, mutatedHash)).to.throw(/transaction mismatch.*setup-helper/i);
    } finally {
      rmSync(reviewed.directory, { recursive: true, force: true });
    }
  });

  it("rejects fresh gas and fee bounds before signing", async () => {
    const value = plan();
    for (const excessive of ["gas", "maxFeePerGas", "maxPriorityFeePerGas"] as const) {
      const reviewed = await reviewedPackage(value);
      let signed = 0;
      const journal: LiveJournal = { chainId: 11155111, funder: account.address, entries: [] };
      const live: LiveContext = {
        funder: account.address, chainId: async () => 11155111, nonce: async () => 0,
        balance: async () => 50_000_000_000_000_000n, verify: async () => undefined,
        sign: async () => { signed += 1; throw new Error("must not sign"); }, broadcast: async () => keccak256("0x01"),
        receipt: async () => undefined, persist: async () => undefined,
      };
      try {
        const approval = loadReviewedVaultPrerequisiteApproval(value, reviewed.directory, reviewed.packageHash);
        await expect(executeVaultPrerequisites(value, approval, {
          live, journal,
          feeFor: async () => ({ gas: excessive === "gas" ? 25_201n : 21_000n, maxFeePerGas: excessive === "maxFeePerGas" ? 11n : 10n, maxPriorityFeePerGas: excessive === "maxPriorityFeePerGas" ? 11n : 1n }),
          waitForReceipt: async () => undefined,
          verifyPrerequisites: async (_plan, stage) => evidence(value, stage),
        })).to.be.rejectedWith(/reviewed.*cap/i);
        expect(signed).to.equal(0);
      } finally {
        rmSync(reviewed.directory, { recursive: true, force: true });
      }
    }
  });

  it("stops after reconciling and verifying all four prerequisites", async () => {
    const value = plan();
    const reviewed = await reviewedPackage(value);
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
    try {
      const approval = loadReviewedVaultPrerequisiteApproval(value, reviewed.directory, reviewed.packageHash);
      const result = await executeVaultPrerequisites(value, approval, {
        live, journal,
        feeFor: async () => ({ gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
        waitForReceipt: async (transactionHash) => { calls.push(`receipt:${transactionHash}`); receipts.set(transactionHash, true); },
        verifyPrerequisites: async (_plan, stage) => { calls.push(stage); return evidence(value, stage); },
      });
      expect(result.prerequisiteEvidence.stage).to.equal("before-setup");
      expect(journal.entries.map((entry) => entry.id)).to.deep.equal(["vault-setup-helper", "vault-guard", "vault-delay", "vault-maintenance"]);
      expect(journal.entries.every((entry) => entry.status === "success")).to.equal(true);
      expect(calls).to.include("before-setup");
      expect(calls).not.to.include("after-setup");
      expect(signed.size).to.equal(4);
    } finally {
      rmSync(reviewed.directory, { recursive: true, force: true });
    }
  });

  it("obtains each fee only when its nonce is ready to submit", async () => {
    const value = plan();
    const reviewed = await reviewedPackage(value);
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
    try {
      const approval = loadReviewedVaultPrerequisiteApproval(value, reviewed.directory, reviewed.packageHash);
      await executeVaultPrerequisites(value, approval, {
        live,
        journal,
        feeFor: async (transaction) => {
          expect(journal.entries).to.have.length(Number(transaction.nonce));
          feeCalls.push(transaction.description);
          return { gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
        },
        waitForReceipt: async (transactionHash) => { receipts.add(transactionHash); },
        verifyPrerequisites: async (_plan, stage) => evidence(value, stage),
      });
      expect(feeCalls).to.deep.equal(["test", "test", "test", "test"]);
    } finally {
      rmSync(reviewed.directory, { recursive: true, force: true });
    }
  });
});
