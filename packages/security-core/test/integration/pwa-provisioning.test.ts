import { expect } from "chai";
import { readFileSync } from "node:fs";
import { decodeFunctionData, getContractAddress, keccak256, type Address, type Hex } from "viem";
import {
  createPwaProvisioningPlan,
  createDurablePwaProvisioningExecutionContext,
  brandPwaProvisioningExecutionContextForTestsOnly,
  executePwaProvisioning,
  type PwaProvisioningTransaction,
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

function planningInfrastructure(confirmedProvisioningPrefixLength = 0, observedCurrentDeployerNonce = observedNonce + BigInt(confirmedProvisioningPrefixLength)): PwaPlanningInfrastructure {
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
    observedCurrentDeployerNonce,
    confirmedProvisioningPrefixLength,
    ...dependencies,
    primaryPasskeySigner: Object.freeze({ name: "passkeySigner", address: primary, expectedRuntimeCodeHash: hash(code(35)), bindingHash: hash(code(36)), source: "factory prediction", binding: { ...primaryCredential, verifiers: BigInt(dependencies.passkeySignerVerifier.address) } }),
    secondaryPasskeySigner: Object.freeze({ name: "passkeySigner", address: secondary, expectedRuntimeCodeHash: hash(code(37)), bindingHash: hash(code(38)), source: "factory prediction", binding: { ...secondaryCredential, verifiers: BigInt(dependencies.passkeySignerVerifier.address) } }),
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

async function plan(confirmedProvisioningPrefixLength = 0) {
  const infrastructure = planningInfrastructure(confirmedProvisioningPrefixLength);
  return createPwaProvisioningPlan({
    profile: profile(),
    deployer,
    expectedDeployerNonce: observedNonce,
    safeProxySaltNonce: 7n,
    primaryCredential,
    secondaryCredential,
    infrastructure,
    artifacts: reviewedArtifacts(),
    confirmedProvisioningPrefixLength,
    client: {
      async getBytecode({ address: target }) {
        if (confirmedProvisioningPrefixLength > 0 && target.toLowerCase() === primary.toLowerCase()) return code(35);
        if (confirmedProvisioningPrefixLength > 1 && target.toLowerCase() === secondary.toLowerCase()) return code(37);
        return undefined;
      },
      async readContract({ functionName, args }) {
        if (functionName !== "getSigner") throw new Error(`unexpected read ${functionName}`);
        return BigInt(String(args?.[0])) === primaryCredential.x ? primary : secondary;
      },
    },
  });
}

async function successorPlan(confirmedSuccessorTransactionCount: 0 | 1 | 2 | 3 | 4 | 5 = 0) {
  const prerequisiteStartingNonce = observedNonce + 4n;
  const expectedCurrentDeployerNonce = prerequisiteStartingNonce + BigInt(confirmedSuccessorTransactionCount);
  return createPwaProvisioningPlan({
    profile: profile(),
    deployer,
    expectedDeployerNonce: observedNonce,
    expectedCurrentDeployerNonce,
    prerequisiteStartingNonce,
    confirmedSuccessorTransactionCount,
    safeProxySaltNonce: 7n,
    primaryCredential,
    secondaryCredential,
    infrastructure: planningInfrastructure(2, expectedCurrentDeployerNonce),
    artifacts: reviewedArtifacts(),
    confirmedProvisioningPrefixLength: 2,
    client: {
      async getBytecode({ address: target }) {
        if (target.toLowerCase() === primary.toLowerCase()) return code(35);
        if (target.toLowerCase() === secondary.toLowerCase()) return code(37);
        return undefined;
      },
      async readContract({ args }) { return BigInt(String(args?.[0])) === primaryCredential.x ? primary : secondary; },
    },
  });
}

async function prefixOneSuccessorPlan(confirmedSuccessorTransactionCount: 0 | 1 | 2 | 3 | 4 | 5 | 6 = 0, laterNonceAdvance = 0n) {
  const successorStartingNonce = observedNonce + 2n;
  const expectedCurrentDeployerNonce = successorStartingNonce + BigInt(confirmedSuccessorTransactionCount) + laterNonceAdvance;
  const verifiedDeploymentPrefixLength = confirmedSuccessorTransactionCount > 0 ? 2 : 1;
  return createPwaProvisioningPlan({
    profile: profile(),
    deployer,
    expectedDeployerNonce: observedNonce,
    expectedCurrentDeployerNonce,
    successorStartingNonce,
    confirmedSuccessorTransactionCount,
    safeProxySaltNonce: 7n,
    primaryCredential,
    secondaryCredential,
    infrastructure: planningInfrastructure(verifiedDeploymentPrefixLength, expectedCurrentDeployerNonce),
    artifacts: reviewedArtifacts(),
    confirmedProvisioningPrefixLength: 1,
    verifiedDeploymentPrefixLength,
    client: {
      async getBytecode({ address: target }) {
        if (target.toLowerCase() === primary.toLowerCase()) return code(35);
        if (verifiedDeploymentPrefixLength > 1 && target.toLowerCase() === secondary.toLowerCase()) return code(37);
        return undefined;
      },
      async readContract({ args }) { return BigInt(String(args?.[0])) === primaryCredential.x ? primary : secondary; },
    },
  });
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
      baseRecipientMode: profile().baseRecipientMode,
      recipients: [...profile().elevatedRecipients],
    }]);
    for (const transaction of first.transactions.slice(0, 2)) {
      const decoded = decodeFunctionData({ abi: CREATE_SIGNER_ABI, data: transaction.data });
      expect(decoded.functionName).to.equal("createSigner");
      expect(decoded.args[2]).to.equal(BigInt(first.infrastructure.passkeySignerVerifier.address));
    }
    expect(first.transactions[0]!.expectedRuntimeCodeHash).not.to.equal(first.transactions[1]!.expectedRuntimeCodeHash);
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
    await expect(createPwaProvisioningPlan({ ...base, profile: { ...base.profile, elevatedRecipients: [address(9)] } as never })).to.be.rejected;
    await expect(createPwaProvisioningPlan({ ...base, profile: { ...base.profile, token: address(9) } as never })).to.be.rejected;
    await expect(createPwaProvisioningPlan({ ...base, profile: { ...base.profile, limits: { ...base.profile.limits, baseDailyLimit: 2n } } as never })).to.be.rejected;
    await expect(createPwaProvisioningPlan({ ...base, profile: { ...base.profile, limits: { ...base.profile.limits, instantDailyLimit: 4n } } as never })).to.be.rejected;
    await expect(createPwaProvisioningPlan({ ...base, profile: { ...base.profile, delay: { ...base.profile.delay, cooldownSeconds: 121 } } as never })).to.be.rejected;
    await expect(createPwaProvisioningPlan({ ...base, artifacts: { ...base.artifacts } as never })).to.be.rejectedWith(/artifact/i);
    const changedFactory = { ...base.infrastructure, passkeySignerFactory: dependency("changed", 99) } as PwaPlanningInfrastructure;
    await expect(createPwaProvisioningPlan({ ...base, infrastructure: changedFactory })).to.be.rejectedWith(/planning infrastructure/i);
  });

  it("rebuilds only an explicitly verified recovery prefix while the fresh path stays strict", async () => {
    for (const prefixLength of [1, 2, 3, 4, 5, 6]) {
      const recovered = await plan(prefixLength);
      expect(recovered.transactions[0]!.nonce).to.equal(observedNonce);
      expect(recovered.infrastructure.confirmedProvisioningPrefixLength).to.equal(prefixLength);
    }
    const infrastructure = planningInfrastructure();
    await expect(createPwaProvisioningPlan({
      profile: profile(), deployer, expectedDeployerNonce: observedNonce, safeProxySaltNonce: 7n,
      primaryCredential, secondaryCredential, infrastructure, artifacts: reviewedArtifacts(),
      client: {
        async getBytecode({ address: target }) { return target.toLowerCase() === primary.toLowerCase() ? code(35) : undefined; },
        async readContract({ args }) { return BigInt(String(args?.[0])) === primaryCredential.x ? primary : secondary; },
      },
    })).to.be.rejectedWith(/already exists/i);
  });

  it("preserves signer lineage while rebasing only the successor suffix", async () => {
    const original = await plan(2);
    const successor = await successorPlan();
    expect(successor.transactions.map(({ nonce }) => nonce)).to.deep.equal([11n, 12n, 15n, 16n, 17n, 18n, 19n]);
    expect(successor.transactions.slice(0, 2)).to.deep.equal(original.transactions.slice(0, 2));
    expect(successor.transactions[2]!.expectedCreatedAddress).not.to.equal(original.transactions[2]!.expectedCreatedAddress);
    expect(successor.planHash).not.to.equal(original.planHash);
  });

  it("preserves one confirmed signer and rebases the secondary plus prerequisites", async () => {
    const original = await plan(1);
    const successor = await prefixOneSuccessorPlan();
    expect(successor.transactions.map(({ id, nonce }) => [id, nonce])).to.deep.equal([
      ["primary-signer", 11n], ["secondary-signer", 13n], ["setup-helper", 14n], ["guard", 15n], ["delay", 16n], ["maintenance", 17n], ["safe-proxy", 18n],
    ]);
    expect(successor.transactions[0]).to.deep.equal(original.transactions[0]);
    expect(successor.transactions[1]!.data).to.equal(original.transactions[1]!.data);
    expect(successor.transactions[1]!.expectedCreatedAddress).to.equal(original.transactions[1]!.expectedCreatedAddress);
    expect(successor.transactions[2]!.expectedCreatedAddress).not.to.equal(original.transactions[2]!.expectedCreatedAddress);
    expect(successor.planHash).not.to.equal(original.planHash);
  });

  it("rebuilds the prefix-one successor at every suffix restart nonce", async () => {
    const initial = await prefixOneSuccessorPlan();
    for (const confirmed of [1, 2, 3, 4, 5, 6] as const) {
      const recovered = await prefixOneSuccessorPlan(confirmed);
      expect(recovered.transactions).to.deep.equal(initial.transactions);
      expect(recovered.planHash).to.equal(initial.planHash);
      expect(recovered.infrastructure.observedCurrentDeployerNonce).to.equal(observedNonce + 2n + BigInt(confirmed));
    }
  });

  it("rebuilds the real successor planner at every incomplete suffix restart nonce", async () => {
    const initial = await successorPlan();
    for (const confirmed of [1, 2, 3, 4, 5] as const) {
      const recovered = await successorPlan(confirmed);
      expect(recovered.transactions).to.deep.equal(initial.transactions);
      expect(recovered.planHash).to.equal(initial.planHash);
      expect(recovered.infrastructure.observedCurrentDeployerNonce).to.equal(observedNonce + 4n + BigInt(confirmed));
    }
  });

  it("rebuilds a completed successor with its original package after later deployer activity", async () => {
    const original = await prefixOneSuccessorPlan(6);
    const recovered = await prefixOneSuccessorPlan(6, 9n);
    expect(recovered.transactions).to.deep.equal(original.transactions);
    expect(recovered.planHash).to.equal(original.planHash);
    expect(recovered.infrastructure.observedCurrentDeployerNonce).to.equal(28n);
    await expect(prefixOneSuccessorPlan(5, 9n)).to.be.rejectedWith(/nonce/i);
    await expect(prefixOneSuccessorPlan(6, -1n)).to.be.rejectedWith(/nonce/i);
  });

  it("never submits the Safe if any prerequisite fails", async () => {
    const value = await plan();
    const submitted: string[] = [];
    process.env.NODE_ENV = "test";
    await expect(executePwaProvisioning(value, brandPwaProvisioningExecutionContextForTestsOnly({
      async confirmedPrefixLength() { return 0; },
      async currentDeployerNonce() { return observedNonce; },
      async authorize(transaction) { return { ...transaction, gasLimit: 1_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; },
      async submit(transaction) {
        submitted.push(transaction.id);
        if (transaction.id === "maintenance") throw new Error("constructor reverted");
        return { transactionHash: hash(code(submitted.length)), receipt: { status: "success", blockNumber: BigInt(submitted.length) } };
      },
      async verifyFinalTopology() { throw new Error("must not verify"); },
    }))).to.be.rejectedWith(/constructor reverted/);
    expect(submitted).not.to.include("safe-proxy");
  });

  it("skips the confirmed nonce prefix and authorizes each missing transaction before submission", async () => {
    const value = await plan();
    const events: string[] = [];
    process.env.NODE_ENV = "test";
    const result = await executePwaProvisioning(value, brandPwaProvisioningExecutionContextForTestsOnly({
      async confirmedPrefixLength() { return 2; },
      async currentDeployerNonce() { return observedNonce + 2n; },
      async authorize(transaction) {
        events.push(`authorize:${transaction.id}`);
        return { ...transaction, gasLimit: 1_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
      },
      async submit(transaction) {
        events.push(`submit:${transaction.id}`);
        return { transactionHash: hash(code(Number(transaction.nonce))), receipt: { status: "success", blockNumber: transaction.nonce } };
      },
      async verifyFinalTopology() { events.push("verify"); return hash(code(99)); },
    }));

    expect(events.slice(0, 4)).to.deep.equal(["authorize:setup-helper", "submit:setup-helper", "authorize:guard", "submit:guard"]);
    expect(events).not.to.include("authorize:primary-signer");
    expect(events).not.to.include("submit:secondary-signer");
    expect(events.at(-1)).to.equal("verify");
    expect(result.safe).to.equal(value.safe);
  });

  it("rejects unrelated nonce advancement instead of skipping a missing reviewed transaction", async () => {
    const value = await plan();
    const authorize = async (transaction: PwaProvisioningTransaction) => ({ ...transaction, gasLimit: 1_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    await expect(executePwaProvisioning(value, brandPwaProvisioningExecutionContextForTestsOnly({
      async confirmedPrefixLength() { return 2; },
      async currentDeployerNonce() { return observedNonce + 4n; },
      authorize,
      async submit() { throw new Error("must not submit"); },
      async verifyFinalTopology() { throw new Error("must not verify"); },
    }))).to.be.rejectedWith(/first missing reviewed transaction setup-helper: expected .* observed/i);
  });

  it("uses the next reviewed row nonce for an approved noncontiguous successor", async () => {
    const value = await successorPlan();
    const submitted: string[] = [];
    await executePwaProvisioning(value, brandPwaProvisioningExecutionContextForTestsOnly({
      async confirmedPrefixLength() { return 2; },
      async currentDeployerNonce() { return observedNonce + 4n; },
      async authorize(transaction) { return { ...transaction, gasLimit: 1_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }; },
      async submit(transaction) { submitted.push(transaction.id); return { transactionHash: hash(code(Number(transaction.nonce))), receipt: { status: "success", blockNumber: transaction.nonce } }; },
      async verifyFinalTopology() { return hash(code(99)); },
    }));
    expect(submitted).to.deep.equal(["setup-helper", "guard", "delay", "maintenance", "safe-proxy"]);
  });

  for (const laterNonceAdvance of [0n, 9n]) it(`restores a complete journal read-only after ${laterNonceAdvance} later transactions`, async () => {
    const value = await successorPlan(5);
    let authorizations = 0;
    let submissions = 0;
    const topology = hash(code(99));
    const result = await executePwaProvisioning(value, brandPwaProvisioningExecutionContextForTestsOnly({
      async confirmedPrefixLength() { return value.transactions.length; },
      async currentDeployerNonce() { return value.transactions.at(-1)!.nonce + 1n + laterNonceAdvance; },
      async authorize(transaction) { authorizations += 1; return { ...transaction, gasLimit: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }; },
      async submit() { submissions += 1; throw new Error("must not submit"); },
      async completedSetupReceipt() { return { transactionHash: hash(code(98)), blockNumber: 100n }; },
      async verifyFinalTopology() { return topology; },
    }));
    expect(result.topologyReportHash).to.equal(topology);
    expect(authorizations).to.equal(0);
    expect(submissions).to.equal(0);
  });

  it("rejects a completed journal when the live nonce is behind its confirmed deployment", async () => {
    const value = await plan();
    await expect(executePwaProvisioning(value, brandPwaProvisioningExecutionContextForTestsOnly({
      async confirmedPrefixLength() { return 7; },
      async currentDeployerNonce() { return 17n; },
      async submit() { throw new Error("must not submit"); },
      async completedSetupReceipt() { throw new Error("must not accept regressed nonce"); },
      async verifyFinalTopology() { throw new Error("must not verify"); },
    }))).to.be.rejectedWith(/nonce/i);
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
      async getBytecode({ address: target }: { address: Address }) { return broadcastHash && target.toLowerCase() === value.transactions[0]!.expectedCreatedAddress.toLowerCase() ? code(35) : undefined; },
      async readContract() { throw new Error("not reached"); },
      async getStorageAt() { return undefined; },
      async estimateGas() { return 50_000n; },
      async estimateFeesPerGas() { return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }; },
      async getBlockNumber() { return 15n; },
      async getTransactionReceipt({ hash: transactionHash }: { hash: Hex }) { return { transactionHash, status: "success" as const, gasUsed: 50_000n, effectiveGasPrice: 1n, blockNumber: 10n, blockHash: hash(code(10)) }; },
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
      ["primary-signer", code(35)], ["secondary-signer", code(37)], ["setup-helper", code(80)], ["guard", code(81)], ["delay", code(82)], ["maintenance", code(83)],
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

  it("rejects secondary signer runtime drift during final topology verification", async () => {
    const value = await plan();
    const dependencyCode = new Map(Object.entries(value.infrastructure.dependencies).map(([name, item]) => [item.address.toLowerCase(), code({ safeSingleton: 30, safeProxyFactory: 31, passkeySignerFactory: 32, passkeySignerVerifier: 33, multiSendCallOnly: 34 }[name as keyof typeof value.infrastructure.dependencies])]));
    const context = createDurablePwaProvisioningExecutionContext({
      plan: value,
      journal: { chainId: 11155111, funder: deployer, entries: [] },
      liveContext: { funder: deployer, chainId: async () => 11155111, nonce: async () => 18, balance: async () => 0n, verify: async () => undefined, sign: async () => { throw new Error("not reached"); }, broadcast: async () => { throw new Error("not reached"); }, receipt: async () => undefined, persist: async () => undefined },
      client: {
        async getTransactionCount() { return 18n; },
        async getBytecode({ address: target }) {
          if (target.toLowerCase() === secondary.toLowerCase()) return code(99);
          if (target.toLowerCase() === primary.toLowerCase()) return code(35);
          return dependencyCode.get(target.toLowerCase());
        },
        async readContract() { throw new Error("secondary runtime drift was not checked first"); },
        async getStorageAt() { return undefined; },
      },
    });

    await expect(context.verifyFinalTopology(value)).to.be.rejectedWith(/secondary passkey signer runtime changed/i);
  });

  it("rejects a live nonce behind the completed deployment before final infrastructure verification", async () => {
    const value = await plan();
    const denied = async () => { throw new Error("read-only completed restoration must not write"); };
    const context = createDurablePwaProvisioningExecutionContext({
      plan: value,
      journal: { chainId: 11155111, funder: deployer, entries: [] },
      liveContext: { funder: deployer, chainId: async () => 11155111, nonce: async () => 17, balance: async () => 0n, verify: denied, sign: denied, broadcast: denied, receipt: denied, persist: denied },
      client: {
        async getTransactionCount() { return 17n; },
        async getBytecode({ address: target }) { return target.toLowerCase() === secondary.toLowerCase() ? code(37) : undefined; },
        async readContract() { throw new Error("regressed deployment must not reach infrastructure verification"); },
        async getStorageAt() { return undefined; },
      },
    });
    await expect(context.verifyFinalTopology(value)).to.be.rejectedWith(/current deployer nonce is behind the completed deployment/i);
  });
  it("reconciles pending known hash before requesting any new authorization", async () => {
    const value = await plan();
    let authorizations = 0;
    let submissions = 0;
    let resumed = 0;
    await executePwaProvisioning(value, brandPwaProvisioningExecutionContextForTestsOnly({
      async confirmedPrefixLength() { return 6; },
      async currentDeployerNonce() { return value.transactions[6]!.nonce; },
      async resumePending(transaction) { resumed += 1; expect(transaction.id).to.equal("safe-proxy"); return { transactionHash: hash(code(98)), receipt: { status: "success", blockNumber: 100n } }; },
      async authorize() { authorizations += 1; throw new Error("already signed envelope must not be requoted"); },
      async submit() { submissions += 1; throw new Error("must not submit"); },
      async verifyFinalTopology() { return hash(code(99)); },
    }));
    expect({ authorizations, submissions, resumed }).to.deep.equal({ authorizations: 0, submissions: 0, resumed: 1 });
  });

});
