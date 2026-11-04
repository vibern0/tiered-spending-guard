import { expect } from "chai";
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { brandVerifiedDeploymentInfrastructureForTestsOnly, type DeploymentInfrastructure } from "../../../src/config/deployments";
import { policyHash, verifyVaultPrerequisites, type VaultDeploymentPlan, type VerifiedVaultPrerequisites } from "../../../src/topology/build";
import { verifyTopology, type TopologyInput } from "../../../src/topology/verify";
import { type VaultPolicy } from "../../../src/config/policy";

process.env.NODE_ENV = "test";

const a = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Address;
const h = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as Hex;
const policy: VaultPolicy = {
  chainId: 31337,
  safe: a(1),
  primary: a(2),
  passkey: a(2),
  ecdsaSecondary: a(3),
  secondaries: [
    { address: a(4), role: "secondary", kind: "safe-contract", enabled: true },
    { address: a(3), role: "secondary", kind: "ecdsa-extension", enabled: true },
  ],
  delay: a(5),
  periodSeconds: 86400,
  periodAnchor: 0n,
  cooldownSeconds: 3600,
  expirationSeconds: 86400,
  assets: [{ token: a(10), basePerTransaction: 10n, stepUpPerTransaction: 100n, baseDailyLimit: 100n, instantDailyLimit: 1000n, baseRecipientMode: "allowlisted", recipients: [a(20)] }],
};
const code = "0x6001" as Hex; const runtimeHash = keccak256(code); const zero = a(0);
const sentinel = a(1);
const FALLBACK_HANDLER_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" as Hex;
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as Hex;
const MODULE_GUARD_SLOT = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947" as Hex;
const slotWord = (address: Address) => `0x${"0".repeat(24)}${address.slice(2)}` as Hex;
const dep = (address: Address, version: string) => Object.freeze({ name: version, version, address, runtimeCodeHash: runtimeHash, evidence: "verified" as const, source: "test" });
const dependency = dep(a(30), "1.5.0");
const deployments = brandVerifiedDeploymentInfrastructureForTestsOnly(Object.freeze({
  chainId: 31337,
  deployer: a(40),
  observedDeployerNonce: 0n,
  safeSingleton: { ...dependency, supportsModuleGuards: true },
  safeProxyFactory: dep(a(31), "1.5.0"),
  passkeySignerFactory: dep(a(32), "0.2.0"),
  passkeySignerVerifier: dep(a(33), "0.2.0"),
  multiSendCallOnly: dep(a(34), "1.5.0"),
  passkeySigner: Object.freeze({ name: "passkeySigner" as const, address: a(2), runtimeCodeHash: runtimeHash, bindingHash: h(2), source: "test" }),
  dependencies: Object.freeze({
    safeSingleton: { ...dependency, supportsModuleGuards: true },
    safeProxyFactory: dep(a(31), "1.5.0"),
    passkeySignerFactory: dep(a(32), "0.2.0"),
    passkeySignerVerifier: dep(a(33), "0.2.0"),
    multiSendCallOnly: dep(a(34), "1.5.0"),
  }),
} satisfies DeploymentInfrastructure));
const expectedOwners = [a(2)];
const values: Record<string, unknown> = { masterCopy: a(30), VERSION: "1.5.0", getOwners: expectedOwners, getThreshold: 1n, fallbackSlot: slotWord(zero), guardSlot: slotWord(a(6)), moduleGuardSlot: slotWord(a(6)), safeModulesPage: [[a(5)], sentinel], config: [a(1), a(2), a(3), a(5), 86400n, 0n], safeContractSecondary: [a(4), 0, true], ecdsaSecondary: [a(3), 1, true], maintenance: a(7), maintenanceAddress: a(7), getConfiguredTokens: [a(10)], assetPolicy: [10n, 100n, 100n, 1000n], getPolicyRecipients: [a(20)], policyHash: policyHash(policy), spendState: [0n, 0n, 0n], txCooldown: 3600n, txExpiration: 86400n, owner: a(1), avatar: a(1), target: a(1), delayModulesPage: [[a(1)], sentinel], safe: a(1), delay: a(5) };
const HELPER_ABI = [{ name: "setup", type: "function", stateMutability: "nonpayable", inputs: [{ name: "params", type: "tuple", components: [{ name: "guard", type: "address" }, { name: "delay", type: "address" }, { name: "maintenance", type: "address" }, { name: "passkey", type: "address" }, { name: "safeContractSecondary", type: "address" }, { name: "ecdsaSecondary", type: "address" }, { name: "periodSeconds", type: "uint64" }, { name: "periodAnchor", type: "uint64" }, { name: "assets", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" }, { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" }] }] }], outputs: [] }] as const;

function plan(): VaultDeploymentPlan {
  const tx = (expectedCreatedAddress: Address) => ({ description: "test", nonce: 0n, to: zero, value: 0n, operation: 0 as const, data: code, expectedCreatedAddress, creationCodeHash: runtimeHash, expectedRuntimeCodeHash: runtimeHash });
  return {
    unsigned: true,
    broadcast: false,
    chainId: 31337,
    deployer: a(40),
    startingNonce: 0n,
    safeProxySaltNonce: 0n,
    prerequisites: { setupHelper: tx(a(4)), guard: tx(a(6)), delay: tx(a(5)), maintenance: tx(a(7)) },
    safeProxyDeployment: { ...tx(a(1)), to: deployments.safeProxyFactory.address },
    safeInitializer: "0x",
    setupHelperCalldata: encodeFunctionData({
      abi: HELPER_ABI,
      functionName: "setup",
      args: [{ guard: a(6), delay: a(5), maintenance: a(7), passkey: a(2), safeContractSecondary: a(4), ecdsaSecondary: a(3), periodSeconds: 86400n, periodAnchor: 0n, assets: policy.assets.map((asset) => ({ ...asset, recipients: [...asset.recipients] })) }],
    }),
    review: { owners: expectedOwners as readonly [Address], threshold: 1, fallbackHandler: zero, paymentToken: zero, payment: 0n, paymentReceiver: zero, transactionGuard: a(6), moduleGuard: a(6), modules: [a(5)], safeContractSecondary: a(2), ecdsaSecondary: a(3), assets: policy.assets, delay: { owner: a(1), avatar: a(1), target: a(1), upstreamModules: [a(1)], cooldownSeconds: 3600, expirationSeconds: 86400 }, periodAnchor: 0n, policyHash: policyHash(policy), creationCodeHashes: { setupHelper: runtimeHash, guard: runtimeHash, delay: runtimeHash, maintenance: runtimeHash }, runtimeCodeHashes: { setupHelper: runtimeHash, guard: runtimeHash, delay: runtimeHash, maintenance: runtimeHash } },
  };
}

async function prerequisites(overrides: Record<string, unknown> = {}, stage: "before-setup" | "after-setup" = "after-setup"): Promise<VerifiedVaultPrerequisites> {
  const data = { ...values, ...overrides };
  return verifyVaultPrerequisites({
    getBytecode: async () => code,
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (functionName === "config") return data.config;
      if (functionName === "maintenance") return data.maintenance;
      if (functionName === "safe") return data.safe;
      if (functionName === "delay") return data.delay;
      if (functionName === "maintenanceAddress") return data.maintenanceAddress;
      if (address === a(5) && functionName === "owner") return data.owner;
      if (address === a(5) && functionName === "avatar") return data.avatar;
      if (address === a(5) && functionName === "target") return data.target;
      return data[functionName];
    },
  }, plan(), stage);
}

async function fixture(overrides: Record<string, unknown> = {}): Promise<TopologyInput> {
  const data = { ...values, ...overrides };
  return { chainId: 31337, policy: (overrides.policy as VaultPolicy | undefined) ?? policy, safe: a(1), guard: a(6), delay: a(5), deployments, prerequisites: (overrides.prerequisites as VerifiedVaultPrerequisites | undefined) ?? await prerequisites(), client: { getBytecode: async () => code, getStorageAt: async ({ slot }: { slot: Hex }) => slot === FALLBACK_HANDLER_SLOT ? data.fallbackSlot as Hex : slot === GUARD_SLOT ? data.guardSlot as Hex : slot === MODULE_GUARD_SLOT ? data.moduleGuardSlot as Hex : undefined, readContract: async ({ address, functionName }: { address: Address; functionName: string }) => functionName === "getModulesPaginated" ? (address === a(5) ? data.delayModulesPage : data.safeModulesPage) : data[functionName] } };
}

describe("verifyTopology", () => {
  it("rejects pre-setup evidence and missing or changed live maintenance", async () => {
    const before = await prerequisites({ maintenance: zero, safeContractSecondary: [zero, 0, false] }, "before-setup");
    expect((await verifyTopology(await fixture({ prerequisites: before }))).ok).to.equal(false);
    for (const maintenance of [zero, a(99)]) {
      expect((await verifyTopology(await fixture({ maintenance }))).ok).to.equal(false);
    }
    await expect(prerequisites({ maintenanceAddress: a(99) })).to.be.rejectedWith("maintenance self mismatch");
  });
  it("accepts branded infrastructure plus branded Option B topology prerequisite evidence", async () => {
    const report = await verifyTopology(await fixture());
    expect(report.ok, report.failures.join(", ")).to.equal(true);
    expect(report.failures).to.deep.equal([]);
  });

  it("rejects structurally fabricated deployments before any topology report or RPC read", async () => { let reads = 0; const input = await fixture(); input.client.getBytecode = async () => { reads += 1; return code; }; input.client.readContract = async () => { reads += 1; return undefined; }; const report = await verifyTopology({ ...input, deployments: { ...deployments } as never }); expect(report.ok).to.equal(false); expect(report.failures).to.deep.equal(["deployments: official resolver evidence required"]); expect(report.checked).to.deep.equal([]); expect(reads).to.equal(0); });
  it("rejects structurally fabricated vault prerequisites before any topology report or RPC read", async () => { let reads = 0; const input = await fixture(); input.client.getBytecode = async () => { reads += 1; return code; }; input.client.readContract = async () => { reads += 1; return undefined; }; const report = await verifyTopology({ ...input, prerequisites: { ...input.prerequisites } as never }); expect(report.ok).to.equal(false); expect(report.failures).to.deep.equal(["prerequisites: vault component evidence required"]); expect(report.checked).to.deep.equal([]); expect(reads).to.equal(0); });

  for (const [name, override] of [["singleton", { masterCopy: a(9) }], ["version", { VERSION: "1.3.0" }], ["owners", { getOwners: [a(2), a(3)] }], ["threshold", { getThreshold: 2n }], ["fallback", { fallbackSlot: slotWord(a(9)) }], ["transaction guard", { guardSlot: slotWord(a(9)) }], ["module guard", { moduleGuardSlot: slotWord(a(9)) }], ["modules", { safeModulesPage: [[a(5), a(9)], sentinel] }], ["guard config", { config: [a(9), a(2), a(3), a(5), 86400n, 0n] }], ["safe-contract secondary", { safeContractSecondary: [a(9), 0, true] }], ["ECDSA secondary", { ecdsaSecondary: [a(3), 0, true] }], ["policy hash", { policyHash: keccak256("0x99") }], ["asset", { assetPolicy: [11n, 100n, 100n, 1000n] }], ["recipients", { getPolicyRecipients: [a(21)] }], ["counter", { spendState: [0n, 101n, 0n] }], ["Delay owner", { owner: a(9) }], ["Delay avatar", { avatar: a(9) }], ["Delay target", { target: a(9) }], ["cooldown", { txCooldown: 1n }], ["expiration", { txExpiration: 1n }], ["Delay upstream", { delayModulesPage: [[a(1), a(9)], sentinel] }]] as const) it(`fails closed on mutated ${name}`, async () => { const report = await verifyTopology(await fixture(override)); expect(report.ok).to.equal(false); });
  it("fails closed on missing bytecode or unavailable enumeration", async () => { const noCode = await fixture(); noCode.client.getBytecode = async () => undefined; expect((await verifyTopology(noCode)).ok).to.equal(false); expect((await verifyTopology(await fixture({ getConfiguredTokens: undefined }))).ok).to.equal(false); expect((await verifyTopology(await fixture({ delayModulesPage: undefined }))).ok).to.equal(false); });
  it("fails closed when policy Delay differs from verified prerequisite Delay", async () => { const mismatched = { ...policy, delay: a(9) }; expect((await verifyTopology(await fixture({ policy: mismatched }))).ok).to.equal(false); });
});
