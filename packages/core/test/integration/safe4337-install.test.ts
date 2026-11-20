import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, getContract, keccak256, size, zeroAddress, type Address, type Hex } from "viem";
import { createAutomatedCredential, signWebAuthn } from "../../scripts/live/webauthn";
import { buildSafe4337RouteInstall, verifySafe4337RouteTopology } from "../../../sdk/src/topology/safe4337-route-install";
import { encodeSafeContractSignature } from "../../../sdk/src/signers/passkey-helpers";

const safeArtifact = require("@safe-global/safe-smart-account/build/artifacts/contracts/Safe.sol/Safe.json");
const proxyArtifact = require("@safe-global/safe-smart-account/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json");
const multiSendArtifact = require("@safe-global/safe-smart-account/build/artifacts/contracts/libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json");
const moduleArtifact = require("@safe-global/safe-4337/build/artifacts/contracts/Safe4337Module.sol/Safe4337Module.json");
const setupArtifact = require("@safe-global/safe-4337/build/artifacts/contracts/SafeModuleSetup.sol/SafeModuleSetup.json");
const signerFactoryArtifact = require("@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json");
const verifierArtifact = require("@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json");
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const SENTINEL = "0x0000000000000000000000000000000000000001" as Address;
const FALLBACK_SLOT = "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5" as Hex;
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as Hex;
const MODULE_GUARD_SLOT = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947" as Hex;

describe("existing Safe 4337 route installation", () => {
  it("atomically replaces the standard fallback/module and installs both guard slots", async () => {
    const [payer, recipient] = await hre.viem.getWalletClients();
    const client = await hre.viem.getPublicClient();
    const deploy = async (artifact: any, args: readonly unknown[] = []) => {
      const hash = await payer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).to.equal("success");
      return getContract({ address: receipt.contractAddress!, abi: artifact.abi, client: { public: client, wallet: payer } });
    };
    const verifier = await deploy(verifierArtifact);
    const signerFactory = await deploy(signerFactoryArtifact);
    const credential = createAutomatedCredential();
    const signerArgs = [credential.x, credential.y, BigInt(verifier.address)] as const;
    await signerFactory.write.createSigner(signerArgs);
    const primary = await signerFactory.read.getSigner(signerArgs) as Address;
    const module = await deploy(moduleArtifact, [EP]);
    const setup = await deploy(setupArtifact);
    const singleton = await deploy(safeArtifact);
    const proxy = await deploy(proxyArtifact, [singleton.address]);
    const safe = getContract({ address: proxy.address, abi: safeArtifact.abi, client: { public: client, wallet: payer } });
    const setupData = encodeFunctionData({ abi: setup.abi, functionName: "enableModules", args: [[module.address]] });
    await safe.write.setup([[primary], 1n, setup.address, setupData, module.address, zeroAddress, 0n, zeroAddress]);
    expect(await safe.read.isModuleEnabled([module.address])).to.equal(true);

    const router = await hre.viem.deployContract("Safe4337RestrictedRouter", [safe.address, module.address, EP]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 120n, 600n]);
    const routerHash = keccak256((await client.getCode({ address: router.address }))!);
    const guard = await hre.viem.deployContract("TieredSpendingGuard4337", [[safe.address, primary, zeroAddress, delay.address, 86400n, 0n], routerHash]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 1000n]);
    const multiSend = await deploy(multiSendArtifact);
    const ownerCall = async (to: Address, data: Hex, operation: 0 | 1 = 0) => {
      const nonce = await safe.read.nonce();
      const digest = await safe.read.getTransactionHash([to, 0n, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce]);
      const sig = encodeSafeContractSignature(primary, signWebAuthn(credential, digest));
      const hash = await safe.write.execTransaction([to, 0n, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, sig]);
      expect((await client.waitForTransactionReceipt({ hash })).status).to.equal("success");
    };
    await ownerCall(guard.address, encodeFunctionData({ abi: guard.abi, functionName: "configureAaRouter", args: [router.address] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: guard.abi, functionName: "setAssetPolicy", args: [token.address, 10n, 30n, 10n, 30n, [recipient.account.address]] }));
    await ownerCall(delay.address, encodeFunctionData({ abi: delay.abi, functionName: "enableModule", args: [safe.address] }));

    const codeHash = async (address: Address) => keccak256((await client.getCode({ address }))!);
    const topologyInput = {
      safe: safe.address, standardModule: module.address, router: router.address, delay: delay.address, guard: guard.address, multiSendCallOnly: multiSend.address,
      primary, entryPoint: EP,
      hashes: { safe: await codeHash(safe.address), standardModule: await codeHash(module.address), router: await codeHash(router.address), delay: await codeHash(delay.address), guard: await codeHash(guard.address) },
      client: { getBytecode: ({ address }: { address: Address }) => client.getCode({ address }), getStorageAt: ({ address, slot }: { address: Address; slot: Hex }) => client.getStorageAt({ address, slot }), readContract: (args: any) => client.readContract(args) },
    };
    const before = await verifySafe4337RouteTopology(topologyInput, "before");
    expect(before.failures).to.deep.equal([]);
    expect((await verifySafe4337RouteTopology({ ...topologyInput, hashes: { ...topologyInput.hashes, router: zeroAddress } }, "before")).ok).to.equal(false);
    expect((await verifySafe4337RouteTopology({ ...topologyInput, multiSendCallOnly: payer.account.address }, "before")).ok).to.equal(false);
    await ownerCall(safe.address, encodeFunctionData({ abi: safeArtifact.abi, functionName: "enableModule", args: [payer.account.address] }));
    expect((await verifySafe4337RouteTopology(topologyInput, "before")).ok).to.equal(false);
    await ownerCall(safe.address, encodeFunctionData({ abi: safeArtifact.abi, functionName: "disableModule", args: [SENTINEL, payer.account.address] }));

    const readAddress = async (slot: Hex) => `0x${(await safe.read.getStorageAt([slot, 1n])).slice(-40)}`.toLowerCase();
    expect(await readAddress(FALLBACK_SLOT)).to.equal(module.address.toLowerCase());
    const installInput = { safe: safe.address, standardModule: module.address, router: router.address, delay: delay.address, guard: guard.address, multiSendCallOnly: multiSend.address };
    const invalid = buildSafe4337RouteInstall({ ...installInput, guard: payer.account.address });
    await expect(ownerCall(invalid.to, invalid.data, invalid.operation)).to.be.rejected;
    expect(await safe.read.isModuleEnabled([module.address])).to.equal(true);
    expect(await readAddress(FALLBACK_SLOT)).to.equal(module.address.toLowerCase());
    expect(await readAddress(GUARD_SLOT)).to.equal(zeroAddress);
    expect(await readAddress(MODULE_GUARD_SLOT)).to.equal(zeroAddress);

    const plan = buildSafe4337RouteInstall(installInput);
    await ownerCall(plan.to, plan.data, plan.operation);
    expect(await safe.read.isModuleEnabled([module.address])).to.equal(false);
    expect(await safe.read.isModuleEnabled([router.address])).to.equal(true);
    expect(await safe.read.isModuleEnabled([delay.address])).to.equal(true);
    expect(await readAddress(FALLBACK_SLOT)).to.equal(router.address.toLowerCase());
    expect(await readAddress(GUARD_SLOT)).to.equal(guard.address.toLowerCase());
    expect(await readAddress(MODULE_GUARD_SLOT)).to.equal(guard.address.toLowerCase());
    expect((await verifySafe4337RouteTopology(topologyInput, "after")).ok).to.equal(true);
    const [modules, next] = await safe.read.getModulesPaginated([SENTINEL, 10n]);
    expect(modules.map((x: Address) => x.toLowerCase()).sort()).to.deep.equal([router.address.toLowerCase(), delay.address.toLowerCase()].sort());
    expect(next.toLowerCase()).to.equal(SENTINEL.toLowerCase());
    expect(size(plan.data)).to.be.greaterThan(100);
  });
});
