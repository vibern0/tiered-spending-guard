import { expect } from "chai";
import { readFileSync } from "node:fs";
import { decodeFunctionData, getContractAddress, keccak256, type Address, type Hex } from "viem";
import {
  createPwaProvisioningPlan,
  createDurablePwaProvisioningExecutionContext,
  brandPwaProvisioningExecutionContextForTestsOnly,
  executeApprovedPwaProvisioning,
  provisioningPackageHash,
  type PwaProvisioningApproval,
} from "../../src/pwa/provisioning";
import { loadPwaPhaseOneProfile } from "../../src/pwa/profile";
import {
  brandPwaPlanningInfrastructureForTestsOnly,
  type PwaPlanningInfrastructure,
  type VerifiedDependency,
} from "../../src/config/deployments";
import { brandReviewedVaultArtifactsForTestsOnly } from "../../src/topology/reviewed-artifacts";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { LiveContext, LiveJournal } from "../../scripts/live/submission";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const code = (n: number) => `0x60${n.toString(16).padStart(2, "0")}` as Hex;
const hash = (value: Hex) => keccak256(value);
const account = privateKeyToAccount(generatePrivateKey());
const deployer = account.address;
const observedNonce = 11n;
const primary = address(201);
const secondary = address(202);
const primaryCredential = { x: 1n, y: 2n } as const;
const secondaryCredential = { x: 3n, y: 4n } as const;
const CREATE_SIGNER_ABI = [{ name: "createSigner", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] }] as const;

function dependency(name: string, n: number, supportsModuleGuards = false): VerifiedDependency {
  return Object.freeze({ name, version: "test", address: address(n), runtimeCodeHash: hash(code(n)), evidence: "verified", source: "reviewed test fixture", ...(supportsModuleGuards ? { supportsModuleGuards: true } : {}) });
}

function planningInfrastructure(): PwaPlanningInfrastructure {
  const dependencies = Object.freeze({
    safeSingleton: dependency("Safe singleton", 30, true),
    safeProxyFactory: dependency("Safe proxy factory", 31),
    passkeySignerFactory: dependency("passkey signer factory", 32),
    passkeySignerVerifier: dependency("P-256 verifier", 33),
    multiSendCallOnly: dependency("MultiSendCallOnly", 34),
  });
  process.env.NODE_ENV = "test";
  return brandPwaPlanningInfrastructureForTestsOnly(Object.freeze({
    chainId: 11155111,
    deployer,
    observedDeployerNonce: observedNonce,
    ...dependencies,
    primaryPasskeySigner: Object.freeze({ name: "passkeySigner", address: primary, expectedRuntimeCodeHash: hash(code(35)), bindingHash: hash(code(36)), source: "factory prediction", binding: { ...primaryCredential, verifiers: BigInt(dependencies.passkeySignerVerifier.address) } }),
    dependencies,
  }));
}

function reviewedArtifacts() {
  process.env.NODE_ENV = "test";
  return brandReviewedVaultArtifactsForTestsOnly({
    safeProxyCreationCode: code(44),
    setupHelperCreationCode: code(40),
    guardCreationCode: code(41),
    delayCreationCode: code(42),
    maintenanceCreationCode: code(43),
    prerequisiteRuntimeCodeHashes: { setupHelper: hash(code(80)), guard: hash(code(81)), delay: hash(code(82)), maintenance: hash(code(83)) },
    safeProxyRuntimeCodeHash: hash(code(84)),
  });
}

function profile() {
  return loadPwaPhaseOneProfile(JSON.parse(readFileSync("config/sepolia.pwa-phase-one.json", "utf8")));
}

async function plan() {
  const infrastructure = planningInfrastructure();
  return createPwaProvisioningPlan({
    profile: profile(),
    deployer,
    expectedDeployerNonce: observedNonce,
    safeProxySaltNonce: 7n,
    primaryCredential,
    secondaryCredential,
    infrastructure,
    artifacts: reviewedArtifacts(),
    client: {
      async getBytecode() { return undefined; },
      async readContract({ functionName, args }) {
        if (functionName !== "getSigner") throw new Error(`unexpected read ${functionName}`);
        return BigInt(String(args?.[0])) === primaryCredential.x ? primary : secondary;
      },
    },
  });
}

function approvalFor(value: Awaited<ReturnType<typeof plan>>): PwaProvisioningApproval {
  return {
    formatVersion: 1,
    scope: "sepolia-pwa-provisioning",
    packageHash: provisioningPackageHash(value),
    planHash: value.planHash,
    transactions: value.transactions.map((transaction) => ({
      id: transaction.id,
      nonce: transaction.nonce.toString(),
      gasLimit: "1000000",
      maxFeePerGas: "2000000000",
      maxPriorityFeePerGas: "1000000000",
    })),
  };
}

describe("PWA provisioning", () => {
  it("plans two signer factory calls, four prerequisites, and one atomic Safe in deterministic order", async () => {
    const first = await plan();
    const second = await plan();
    const serialize = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

    expect(serialize(first)).to.equal(serialize(second));
    expect(first.transactions.map(({ id, nonce }) => [id, nonce])).to.deep.equal([
      ["primary-signer", 11n], ["secondary-signer", 12n], ["setup-helper", 13n], ["guard", 14n], ["delay", 15n], ["maintenance", 16n], ["safe-proxy", 17n],
    ]);
    expect(first.primaryPasskey.toLowerCase()).to.equal(primary.toLowerCase());
    expect(first.secondaryPasskey.toLowerCase()).to.equal(secondary.toLowerCase());
    expect(first.vaultPlan.review.owners.map((item) => item.toLowerCase())).to.deep.equal([primary.toLowerCase()]);
    expect(first.vaultPlan.review.safeContractSecondary.toLowerCase()).to.equal(secondary.toLowerCase());
    expect(first.vaultPlan.review.ecdsaSecondary).to.equal(address(0));
    expect(first.vaultPlan.review.fallbackHandler).to.equal(address(0));
    expect(first.vaultPlan.review.modules).to.deep.equal([first.delay]);
    expect(first.vaultPlan.review.assets).to.deep.equal([{
      token: profile().token,
      basePerTransaction: profile().limits.basePerTransaction,
      stepUpPerTransaction: profile().limits.stepUpPerTransaction,
      baseDailyLimit: profile().limits.baseDailyLimit,
      instantDailyLimit: profile().limits.instantDailyLimit,
      recipients: [profile().recipient],
    }]);
    for (const transaction of first.transactions.slice(0, 2)) {
      const decoded = decodeFunctionData({ abi: CREATE_SIGNER_ABI, data: transaction.data });
      expect(decoded.functionName).to.equal("createSigner");
      expect(decoded.args[2]).to.equal(BigInt(first.infrastructure.passkeySignerVerifier.address));
    }
  });

  it("rejects changed credential, factory prediction, nonce, salt, profile, or reviewed artifact evidence", async () => {
    const base = {
      profile: profile(), deployer, expectedDeployerNonce: observedNonce, safeProxySaltNonce: 7n,
      primaryCredential, secondaryCredential, infrastructure: planningInfrastructure(), artifacts: reviewedArtifacts(),
      client: { async getBytecode() { return undefined; }, async readContract({ args }: { args?: readonly unknown[] }) { return BigInt(String(args?.[0])) === 1n ? primary : secondary; } },
    };
    await expect(createPwaProvisioningPlan({ ...base, primaryCredential: { ...primaryCredential, x: 9n } })).to.be.rejected;
    await expect(createPwaProvisioningPlan({ ...base, expectedDeployerNonce: 12n })).to.be.rejectedWith(/nonce/i);
    await expect(createPwaProvisioningPlan({ ...base, safeProxySaltNonce: -1n })).to.be.rejectedWith(/salt/i);
    await expect(createPwaProvisioningPlan({ ...base, profile: { ...base.profile, recipient: address(9) } as never })).to.be.rejected;
    await expect(createPwaProvisioningPlan({ ...base, profile: { ...base.profile, token: address(9) } as never })).to.be.rejected;
    await expect(createPwaProvisioningPlan({ ...base, profile: { ...base.profile, limits: { ...base.profile.limits, baseDailyLimit: 2n } } as never })).to.be.rejected;
    await expect(createPwaProvisioningPlan({ ...base, profile: { ...base.profile, limits: { ...base.profile.limits, instantDailyLimit: 4n } } as never })).to.be.rejected;
    await expect(createPwaProvisioningPlan({ ...base, profile: { ...base.profile, delay: { ...base.profile.delay, cooldownSeconds: 121 } } as never })).to.be.rejected;
    await expect(createPwaProvisioningPlan({ ...base, artifacts: { ...base.artifacts } as never })).to.be.rejectedWith(/artifact/i);
    const changedFactory = { ...base.infrastructure, passkeySignerFactory: dependency("changed", 99) } as PwaPlanningInfrastructure;
    await expect(createPwaProvisioningPlan({ ...base, infrastructure: changedFactory })).to.be.rejectedWith(/planning infrastructure/i);
  });

  it("never submits the Safe if any prerequisite fails", async () => {
    const value = await plan();
    const submitted: string[] = [];
    process.env.NODE_ENV = "test";
    await expect(executeApprovedPwaProvisioning(value, approvalFor(value), brandPwaProvisioningExecutionContextForTestsOnly({
      async currentDeployerNonce() { return observedNonce; },
      async submit(transaction) {
        submitted.push(transaction.id);
        if (transaction.id === "maintenance") throw new Error("constructor reverted");
        return { transactionHash: hash(code(submitted.length)), receipt: { status: "success", blockNumber: BigInt(submitted.length) } };
      },
      async verifyFinalTopology() { throw new Error("must not verify"); },
    }))).to.be.rejectedWith(/constructor reverted/);
    expect(submitted).not.to.include("safe-proxy");
  });

  it("uses durable submission and rejects fresh code drift before signing", async () => {
    const value = await plan();
    const journal: LiveJournal = { chainId: 11155111, funder: deployer, entries: [] };
    let signed = 0;
    let broadcastHash: Hex | undefined;
    const liveContext: LiveContext = {
      funder: deployer,
      chainId: async () => 11155111,
      nonce: async () => Number(observedNonce),
      balance: async () => 10n ** 18n,
      verify: async () => undefined,
      sign: async (intent) => { signed += 1; return account.signTransaction({ chainId: 11155111, type: "eip1559", to: intent.to, data: intent.data, value: intent.value, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }); },
      broadcast: async (raw) => { broadcastHash = keccak256(raw); return broadcastHash; },
      receipt: async (transactionHash) => broadcastHash ? { transactionHash, status: "success", gasUsed: 50_000n, effectiveGasPrice: 1n, blockNumber: 10n, blockHash: hash(code(10)) } : undefined,
      persist: async () => undefined,
    };
    const client = {
      async getTransactionCount() { return observedNonce; },
      async getBytecode() { return undefined; },
      async readContract() { throw new Error("not reached"); },
      async getStorageAt() { return undefined; },
    };
    const context = createDurablePwaProvisioningExecutionContext({ plan: value, journal, liveContext, client });
    const first = value.transactions[0]!;
    await expect(context.submit({ ...first, gasLimit: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).to.eventually.have.nested.property("receipt.status", "success");
    expect(signed).to.equal(1);
    expect(journal.entries).to.have.length(1);

    const drifted = createDurablePwaProvisioningExecutionContext({ plan: value, journal: { chainId: 11155111, funder: deployer, entries: [] }, liveContext, client: { ...client, async getBytecode({ address: target }: { address: Address }) { return target.toLowerCase() === value.guard.toLowerCase() ? code(99) : undefined; } } });
    await expect(drifted.submit({ ...first, gasLimit: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).to.be.rejectedWith(/already has code/i);
    expect(signed).to.equal(1);

    const safeTransaction = value.transactions.at(-1)!;
    const runtimeById = new Map([
      ["primary-signer", code(35)], ["secondary-signer", code(35)], ["setup-helper", code(80)], ["guard", code(81)], ["delay", code(82)], ["maintenance", code(83)],
    ]);
    const beforeSafe = createDurablePwaProvisioningExecutionContext({
      plan: value,
      journal: { chainId: 11155111, funder: deployer, entries: [] },
      liveContext: { ...liveContext, nonce: async () => Number(safeTransaction.nonce) },
      client: {
        ...client,
        async getTransactionCount() { return safeTransaction.nonce; },
        async getBytecode({ address: target }: { address: Address }) { const planned = value.transactions.find((item) => item.expectedCreatedAddress.toLowerCase() === target.toLowerCase()); return planned ? runtimeById.get(planned.id) : undefined; },
        async readContract() { throw new Error("prerequisite binding recheck reached"); },
      },
    });
    await expect(beforeSafe.submit({ ...safeTransaction, gasLimit: 1_000_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).to.be.rejectedWith(/prerequisite binding recheck reached/);
    expect(signed).to.equal(1);
  });
});
