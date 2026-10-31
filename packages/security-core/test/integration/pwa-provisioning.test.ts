import { expect } from "chai";
import { readFileSync } from "node:fs";
import { decodeFunctionData, getContractAddress, keccak256, type Address, type Hex } from "viem";
import {
  createPwaProvisioningPlan,
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

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const code = (n: number) => `0x60${n.toString(16).padStart(2, "0")}` as Hex;
const hash = (value: Hex) => keccak256(value);
const deployer = address(100);
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
});
