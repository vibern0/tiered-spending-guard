import { expect } from "chai";
import hre from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, type Address, type Hex } from "viem";
import { ZERO, fn } from "../helpers/safe";
import { brandVerifiedDeploymentInfrastructureForTestsOnly, type DeploymentInfrastructure } from "../../src/config/deployments";
import { policyHash, verifyVaultPrerequisites, type VaultDeploymentPlan } from "../../src/topology/build";
import { verifyTopology } from "../../src/topology/verify";
import type { VaultPolicy } from "../../src/config/policy";

const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as Hex;
const MODULE_GUARD_SLOT = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947" as Hex;
const FALLBACK_HANDLER_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" as Hex;
const SENTINEL_MODULES = "0x0000000000000000000000000000000000000001" as Address;

const SAFE_SETUP_ABI = fn("setup", [
  { name: "owners", type: "address[]" },
  { name: "threshold", type: "uint256" },
  { name: "to", type: "address" },
  { name: "data", type: "bytes" },
  { name: "fallbackHandler", type: "address" },
  { name: "paymentToken", type: "address" },
  { name: "payment", type: "uint256" },
  { name: "paymentReceiver", type: "address" },
]);

const HELPER_SETUP_ABI = fn("setup", [
  {
    name: "params",
    type: "tuple",
    components: [
      { name: "guard", type: "address" },
      { name: "delay", type: "address" },
      { name: "maintenance", type: "address" },
      { name: "passkey", type: "address" },
      { name: "safeContractSecondary", type: "address" },
      { name: "ecdsaSecondary", type: "address" },
      { name: "periodSeconds", type: "uint64" },
      { name: "periodAnchor", type: "uint64" },
      {
        name: "assets",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "basePerTransaction", type: "uint256" },
          { name: "stepUpPerTransaction", type: "uint256" },
          { name: "baseDailyLimit", type: "uint256" },
          { name: "instantDailyLimit", type: "uint256" },
          { name: "recipients", type: "address[]" },
        ],
      },
    ],
  },
]);

const FACTORY_ABI = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    type: "event",
    name: "ProxyCreation",
    inputs: [
      { name: "proxy", type: "address", indexed: false },
      { name: "singleton", type: "address", indexed: false },
    ],
    anonymous: false,
  },
] as const;

const FACTORY_ARTIFACT = JSON.parse(
  readFileSync(
    join(process.cwd(), "node_modules/@safe-global/safe-smart-account/build/artifacts/contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json"),
    "utf8",
  ),
) as { abi: typeof FACTORY_ABI; bytecode: Hex };
const SAFE_PROXY_ARTIFACT = JSON.parse(
  readFileSync(
    join(process.cwd(), "node_modules/@safe-global/safe-smart-account/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json"),
    "utf8",
  ),
) as { bytecode: Hex };

function storageAddress(word: Hex): Address {
  return `0x${word.slice(-40)}` as Address;
}

function brandTestInfrastructure(value: DeploymentInfrastructure) {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    return brandVerifiedDeploymentInfrastructureForTestsOnly(value);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

describe("atomic Option B topology via SafeAtomicSetupHelper", () => {
  async function deployAtomicTopology(secondaryProfile: "dual" | "contract-only" = "dual") {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const client = await hre.viem.getPublicClient();
    const helper = await hre.viem.deployContract("SafeAtomicSetupHelper");
    const singleton = await hre.viem.deployContract("Safe");
    const factoryHash = await deployer.deployContract({ abi: FACTORY_ARTIFACT.abi, bytecode: FACTORY_ARTIFACT.bytecode });
    const factoryReceipt = await client.waitForTransactionReceipt({ hash: factoryHash });
    const factory = { address: factoryReceipt.contractAddress as Address };
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const safeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const startingNonce = BigInt(await client.getTransactionCount({ address: deployer.account.address }));
    const saltNonce = 99n;
    const owners = [passkey.address] as const;
    const configuredEcdsaSecondary = secondaryProfile === "contract-only" ? ZERO : ecdsaSecondary.account.address;

    const placeholderPolicy = {
      token: ZERO,
      basePerTransaction: 50n,
      stepUpPerTransaction: 100n,
      baseDailyLimit: 50n,
      instantDailyLimit: 100n,
      recipients: [recipient.account.address],
    };

    const guardAddress = getContractAddress({ from: deployer.account.address, nonce: startingNonce });
    const delayAddress = getContractAddress({ from: deployer.account.address, nonce: startingNonce + 1n });
    const maintenanceAddress = getContractAddress({ from: deployer.account.address, nonce: startingNonce + 2n });
    const helperData = encodeFunctionData({
      abi: HELPER_SETUP_ABI,
      functionName: "setup",
      args: [{
        guard: guardAddress,
        delay: delayAddress,
        maintenance: maintenanceAddress,
        passkey: passkey.address,
        safeContractSecondary: safeContractSecondary.address,
        ecdsaSecondary: configuredEcdsaSecondary,
        periodSeconds: 86400,
        periodAnchor: 0,
        assets: [placeholderPolicy],
      }],
    });
    const initializerWithoutSafeAddress = encodeFunctionData({
      abi: SAFE_SETUP_ABI,
      functionName: "setup",
      args: [owners, 1n, helper.address, helperData, ZERO, ZERO, 0n, ZERO],
    });

    const salt = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [keccak256(initializerWithoutSafeAddress), saltNonce]));
    const predictedSafe = getContractAddress({
      opcode: "CREATE2",
      from: factory.address,
      salt,
      bytecode: `${SAFE_PROXY_ARTIFACT.bytecode}${encodeAbiParameters([{ type: "address" }], [singleton.address]).slice(2)}` as Hex,
    });
    expect(initializerWithoutSafeAddress.toLowerCase()).not.to.contain("000000000000000000000000" + predictedSafe.slice(2).toLowerCase());

    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[predictedSafe, passkey.address, configuredEcdsaSecondary, delayAddress, 86400n, 0n]]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [predictedSafe, predictedSafe, predictedSafe, 10n, 60n]);
    const maintenance = await hre.viem.deployContract("GuardReplacementMaintenance", [predictedSafe, delay.address, ZERO]);
    expect(guard.address.toLowerCase()).to.equal(guardAddress.toLowerCase());
    expect(delay.address.toLowerCase()).to.equal(delayAddress.toLowerCase());
    expect(maintenance.address.toLowerCase()).to.equal(maintenanceAddress.toLowerCase());

    const createData = encodeFunctionData({ abi: FACTORY_ABI, functionName: "createProxyWithNonce", args: [singleton.address, initializerWithoutSafeAddress, saltNonce] });
    const hash = await deployer.sendTransaction({ to: factory.address, data: createData });
    await client.waitForTransactionReceipt({ hash });
    const safeAddress = predictedSafe;
    const safe = await hre.viem.getContractAt("Safe", safeAddress);
    expect(await client.getBytecode({ address: safeAddress })).not.to.equal(undefined);

    return { client, deployer, ecdsaSecondary, configuredEcdsaSecondary, recipient, helper, singleton, factory, passkey, safeContractSecondary, guard, delay, maintenance, safe, safeAddress, initializerWithoutSafeAddress };
  }

  it("atomically creates a sole-primary-owner Safe and guard-only secondaries", async () => {
    const f = await deployAtomicTopology();

    expect((await f.safe.read.getOwners()).map((owner) => owner.toLowerCase()).sort()).to.deep.equal(
      [f.passkey.address.toLowerCase()],
    );
    expect(await f.safe.read.getThreshold()).to.equal(1n);
    expect(storageAddress((await f.client.getStorageAt({ address: f.safeAddress, slot: FALLBACK_HANDLER_SLOT }))!).toLowerCase()).to.equal(ZERO);
    expect(storageAddress((await f.client.getStorageAt({ address: f.safeAddress, slot: GUARD_SLOT }))!).toLowerCase()).to.equal(f.guard.address.toLowerCase());
    expect(storageAddress((await f.client.getStorageAt({ address: f.safeAddress, slot: MODULE_GUARD_SLOT }))!).toLowerCase()).to.equal(f.guard.address.toLowerCase());

    const modules = await f.safe.read.getModulesPaginated([SENTINEL_MODULES, 10n]);
    expect(modules[0].map((module) => module.toLowerCase())).to.deep.equal([f.delay.address.toLowerCase()]);
    expect(await f.delay.read.isModuleEnabled([f.safeAddress])).to.equal(true);
    expect((await f.delay.read.owner()).toLowerCase()).to.equal(f.safeAddress.toLowerCase());
    expect((await f.delay.read.avatar()).toLowerCase()).to.equal(f.safeAddress.toLowerCase());
    expect((await f.delay.read.target()).toLowerCase()).to.equal(f.safeAddress.toLowerCase());
    expect((await f.guard.read.maintenance()).toLowerCase()).to.equal(f.maintenance.address.toLowerCase());
    expect((await f.guard.read.config())[0].toLowerCase()).to.equal(f.safeAddress.toLowerCase());
    expect((await f.guard.read.safeContractSecondary())[0].toLowerCase()).to.equal(f.safeContractSecondary.address.toLowerCase());
    expect((await f.guard.read.safeContractSecondary())[2]).to.equal(true);
    expect((await f.guard.read.assetPolicy([ZERO]))[3]).to.equal(100n);
    expect(await f.guard.read.allowedRecipient([ZERO, f.recipient.account.address])).to.equal(true);
  });

  it("atomically installs one primary and one contract secondary with ECDSA disabled", async () => {
    const f = await deployAtomicTopology("contract-only");

    expect((await f.safe.read.getOwners()).map((owner) => owner.toLowerCase())).to.deep.equal([f.passkey.address.toLowerCase()]);
    expect(await f.safe.read.getThreshold()).to.equal(1n);
    expect(storageAddress((await f.client.getStorageAt({ address: f.safeAddress, slot: FALLBACK_HANDLER_SLOT }))!).toLowerCase()).to.equal(ZERO);
    expect(storageAddress((await f.client.getStorageAt({ address: f.safeAddress, slot: GUARD_SLOT }))!).toLowerCase()).to.equal(f.guard.address.toLowerCase());
    expect(storageAddress((await f.client.getStorageAt({ address: f.safeAddress, slot: MODULE_GUARD_SLOT }))!).toLowerCase()).to.equal(f.guard.address.toLowerCase());
    expect((await f.safe.read.getModulesPaginated([SENTINEL_MODULES, 10n]))[0].map((module) => module.toLowerCase())).to.deep.equal([f.delay.address.toLowerCase()]);

    const contractSecondary = await f.guard.read.safeContractSecondary();
    expect(contractSecondary[0].toLowerCase()).to.equal(f.safeContractSecondary.address.toLowerCase());
    expect(contractSecondary[1]).to.equal(0);
    expect(contractSecondary[2]).to.equal(true);
    const ecdsaSecondary = await f.guard.read.ecdsaSecondary();
    expect(ecdsaSecondary[0].toLowerCase()).to.equal(ZERO);
    expect(ecdsaSecondary[1]).to.equal(1);
    expect(ecdsaSecondary[2]).to.equal(false);
  });

  it("passes the post-setup prerequisite and full topology verifiers on the real Safe 1.5 proxy", async () => {
    const f = await deployAtomicTopology();
    const runtime = async (address: Address) => keccak256((await f.client.getBytecode({ address }))!);
    const policy: VaultPolicy = { chainId: 31337, safe: f.safeAddress, primary: f.passkey.address, passkey: f.passkey.address, ecdsaSecondary: f.ecdsaSecondary.account.address, secondaries: [{ address: f.safeContractSecondary.address, role: "secondary", kind: "safe-contract", enabled: true }, { address: f.ecdsaSecondary.account.address, role: "secondary", kind: "ecdsa-extension", enabled: true }], delay: f.delay.address, periodSeconds: 86400, periodAnchor: 0n, cooldownSeconds: 10, expirationSeconds: 60, assets: [{ token: ZERO, basePerTransaction: 50n, stepUpPerTransaction: 100n, baseDailyLimit: 50n, instantDailyLimit: 100n, recipients: [f.recipient.account.address] }] };
    const tx = async (address: Address) => ({ description: "verified local fixture", nonce: 0n, to: ZERO, value: 0n, operation: 0 as const, data: "0x60" as Hex, expectedCreatedAddress: address, creationCodeHash: keccak256("0x60"), expectedRuntimeCodeHash: await runtime(address) });
    const plan: VaultDeploymentPlan = { unsigned: true, broadcast: false, chainId: 31337, deployer: f.deployer.account.address, startingNonce: 0n, safeProxySaltNonce: 99n, prerequisites: { setupHelper: await tx(f.helper.address), guard: await tx(f.guard.address), delay: await tx(f.delay.address), maintenance: await tx(f.maintenance.address) }, safeProxyDeployment: { ...(await tx(f.safeAddress)), to: f.factory.address }, safeInitializer: f.initializerWithoutSafeAddress, setupHelperCalldata: encodeFunctionData({ abi: HELPER_SETUP_ABI, functionName: "setup", args: [{ guard: f.guard.address, delay: f.delay.address, maintenance: f.maintenance.address, passkey: f.passkey.address, safeContractSecondary: f.safeContractSecondary.address, ecdsaSecondary: f.ecdsaSecondary.account.address, periodSeconds: 86400n, periodAnchor: 0n, assets: policy.assets.map(asset => ({ ...asset, recipients: [...asset.recipients] })) }] }), review: { owners: [f.passkey.address], threshold: 1, fallbackHandler: ZERO, paymentToken: ZERO, payment: 0n, paymentReceiver: ZERO, transactionGuard: f.guard.address, moduleGuard: f.guard.address, modules: [f.delay.address], safeContractSecondary: f.safeContractSecondary.address, ecdsaSecondary: f.ecdsaSecondary.account.address, assets: policy.assets, delay: { owner: f.safeAddress, avatar: f.safeAddress, target: f.safeAddress, upstreamModules: [f.safeAddress], cooldownSeconds: 10, expirationSeconds: 60 }, periodAnchor: 0n, policyHash: policyHash(policy), creationCodeHashes: { setupHelper: keccak256("0x60"), guard: keccak256("0x60"), delay: keccak256("0x60"), maintenance: keccak256("0x60") }, runtimeCodeHashes: { setupHelper: await runtime(f.helper.address), guard: await runtime(f.guard.address), delay: await runtime(f.delay.address), maintenance: await runtime(f.maintenance.address) } } };
    const prerequisites = await verifyVaultPrerequisites(f.client, plan, "after-setup");
    const dep = (address: Address, version: string) => Object.freeze({ name: version, version, address, runtimeCodeHash: keccak256("0x60"), evidence: "verified" as const, source: "local fixture" });
    const singleton = { ...dep(f.singleton.address, "1.5.0"), supportsModuleGuards: true };
    const deployments = brandTestInfrastructure(Object.freeze({ chainId: 31337, deployer: f.deployer.account.address, observedDeployerNonce: 0n, safeSingleton: singleton, safeProxyFactory: dep(f.factory.address, "1.5.0"), passkeySignerFactory: dep(f.factory.address, "0.2.0"), passkeySignerVerifier: dep(f.factory.address, "0.2.0"), multiSendCallOnly: dep(f.factory.address, "1.5.0"), passkeySigner: { name: "passkeySigner" as const, address: f.passkey.address, runtimeCodeHash: await runtime(f.passkey.address), bindingHash: keccak256("0x60"), source: "local fixture" }, dependencies: { safeSingleton: singleton, safeProxyFactory: dep(f.factory.address, "1.5.0"), passkeySignerFactory: dep(f.factory.address, "0.2.0"), passkeySignerVerifier: dep(f.factory.address, "0.2.0"), multiSendCallOnly: dep(f.factory.address, "1.5.0") } } satisfies DeploymentInfrastructure));
    const moduleSlot = (module: Address) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [module, 3n]));
    const readDelayModules = async (start: Address, pageSize: bigint) => {
      const modules: Address[] = [];
      let cursor = start;
      for (let i = 0n; i < pageSize; i++) {
        const word = await f.client.getStorageAt({ address: f.delay.address, slot: moduleSlot(cursor) });
        if (!word) throw new Error("Delay module linked-list storage is absent");
        const next = storageAddress(word);
        if (next.toLowerCase() === SENTINEL_MODULES.toLowerCase()) return [modules, SENTINEL_MODULES] as const;
        if (next === ZERO || modules.some(module => module.toLowerCase() === next.toLowerCase())) throw new Error("Delay module linked list is corrupt");
        modules.push(next);
        cursor = next;
      }
      return [modules, cursor] as const;
    };
    const topologyClient = { ...f.client, readContract: async (args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) => {
      // The compiler-compat fixture omits the view, so enumerate its actual
      // Zodiac modules mapping instead of substituting the expected result.
      if (args.address.toLowerCase() === f.delay.address.toLowerCase() && args.functionName === "getModulesPaginated") {
        const [start, pageSize] = args.args as readonly [Address, bigint];
        return readDelayModules(start, pageSize);
      }
      return f.client.readContract(args as never);
    } };
    const report = await verifyTopology({ chainId: 31337, policy, safe: f.safeAddress, guard: f.guard.address, delay: f.delay.address, deployments, prerequisites, client: topologyClient });
    expect(report.ok, report.failures.join(", ")).to.equal(true);

    await hre.network.provider.send("hardhat_setStorageAt", [f.delay.address, moduleSlot(SENTINEL_MODULES), encodeAbiParameters([{ type: "address" }], [f.recipient.account.address])]);
    await hre.network.provider.send("hardhat_setStorageAt", [f.delay.address, moduleSlot(f.recipient.account.address), encodeAbiParameters([{ type: "address" }], [f.safeAddress])]);
    const rejected = await verifyTopology({ chainId: 31337, policy, safe: f.safeAddress, guard: f.guard.address, delay: f.delay.address, deployments, prerequisites, client: topologyClient });
    expect(rejected.ok).to.equal(false);
    expect(rejected.failures).to.include("only Safe upstream module");
  });

  it("rejects direct helper calls outside Safe setup delegatecall", async () => {
    const f = await deployAtomicTopology();
    const params = { guard: f.guard.address, delay: f.delay.address, maintenance: f.maintenance.address, passkey: f.passkey.address, safeContractSecondary: f.safeContractSecondary.address, ecdsaSecondary: f.ecdsaSecondary.account.address, periodSeconds: 86400n, periodAnchor: 0n, assets: [] };
    await expect(f.helper.write.setup([params], { account: f.deployer.account })).to.be.rejected;
  });

  async function expectCreationRevertsWith(overrides: Readonly<{ assetBasePerTransaction?: bigint; guardEcdsaSecondary?: Address; helperSafeContractSecondary?: Address; extraOwner?: boolean }> = {}) {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const client = await hre.viem.getPublicClient();
    const helper = await hre.viem.deployContract("SafeAtomicSetupHelper");
    const singleton = await hre.viem.deployContract("Safe");
    const factoryHash = await deployer.deployContract({ abi: FACTORY_ARTIFACT.abi, bytecode: FACTORY_ARTIFACT.bytecode });
    const factoryReceipt = await client.waitForTransactionReceipt({ hash: factoryHash });
    const factory = { address: factoryReceipt.contractAddress as Address };
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const safeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const startingNonce = BigInt(await client.getTransactionCount({ address: deployer.account.address }));
    const guardAddress = getContractAddress({ from: deployer.account.address, nonce: startingNonce });
    const delayAddress = getContractAddress({ from: deployer.account.address, nonce: startingNonce + 1n });
    const maintenanceAddress = getContractAddress({ from: deployer.account.address, nonce: startingNonce + 2n });
    const owners = overrides.extraOwner ? [passkey.address, safeContractSecondary.address] : [passkey.address];
    const badAsset = { token: ZERO, basePerTransaction: overrides.assetBasePerTransaction ?? 0n, stepUpPerTransaction: 100n, baseDailyLimit: 50n, instantDailyLimit: 100n, recipients: [recipient.account.address] };
    const helperData = encodeFunctionData({
      abi: HELPER_SETUP_ABI,
      functionName: "setup",
      args: [{
        guard: guardAddress,
        delay: delayAddress,
        maintenance: maintenanceAddress,
        passkey: passkey.address,
        safeContractSecondary: overrides.helperSafeContractSecondary ?? safeContractSecondary.address,
        ecdsaSecondary: ecdsaSecondary.account.address,
        periodSeconds: 86400,
        periodAnchor: 0,
        assets: [badAsset],
      }],
    });
    const initializer = encodeFunctionData({ abi: SAFE_SETUP_ABI, functionName: "setup", args: [owners, 1n, helper.address, helperData, ZERO, ZERO, 0n, ZERO] });
    const saltNonce = 100n;
    const salt = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [keccak256(initializer), saltNonce]));
    const predictedSafe = getContractAddress({ opcode: "CREATE2", from: factory.address, salt, bytecode: `${SAFE_PROXY_ARTIFACT.bytecode}${encodeAbiParameters([{ type: "address" }], [singleton.address]).slice(2)}` as Hex });
    await hre.viem.deployContract("TieredSpendingGuard", [[predictedSafe, passkey.address, overrides.guardEcdsaSecondary ?? ecdsaSecondary.account.address, delayAddress, 86400n, 0n]]);
    await hre.viem.deployContract("ZodiacDelayV1_1_1", [predictedSafe, predictedSafe, predictedSafe, 10n, 60n]);
    await hre.viem.deployContract("GuardReplacementMaintenance", [predictedSafe, delayAddress, ZERO]);
    const createData = encodeFunctionData({ abi: FACTORY_ABI, functionName: "createProxyWithNonce", args: [singleton.address, initializer, saltNonce] });

    await expect(deployer.sendTransaction({ to: factory.address, data: createData })).to.be.rejected;
    expect(await client.getBytecode({ address: predictedSafe })).to.equal(undefined);
  }

  it("reverts Safe creation when an inner policy call fails", async () => {
    await expectCreationRevertsWith();
  });

  it("rejects a secondary added as a Safe owner during atomic setup", async () => {
    await expectCreationRevertsWith({ assetBasePerTransaction: 50n, extraOwner: true });
  });

  it("rejects atomic setup without a contract secondary", async () => {
    await expectCreationRevertsWith({ assetBasePerTransaction: 50n, helperSafeContractSecondary: ZERO });
  });

  it("reverts Safe creation when the guard signer binding differs from helper params", async () => {
    const [, , wrongEcdsaSecondary] = await hre.viem.getWalletClients();
    await expectCreationRevertsWith({ assetBasePerTransaction: 50n, guardEcdsaSecondary: wrongEcdsaSecondary.account.address });
  });
});
