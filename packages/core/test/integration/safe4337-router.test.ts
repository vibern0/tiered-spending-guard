import { expect } from "chai";
import hre from "hardhat";
import { concatHex, encodeAbiParameters, getContract, hashTypedData, keccak256, padHex, parseAbi, size, toHex, zeroAddress, type Address, type Hex } from "viem";
import { createAutomatedCredential, signWebAuthn } from "../../scripts/live/webauthn";

const safeArtifact = require("@safe-global/safe-smart-account/build/artifacts/contracts/Safe.sol/Safe.json");
const proxyArtifact = require("@safe-global/safe-smart-account/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json");
const moduleArtifact = require("@safe-global/safe-4337/build/artifacts/contracts/Safe4337Module.sol/Safe4337Module.json");
const setupArtifact = require("@safe-global/safe-4337/build/artifacts/contracts/SafeModuleSetup.sol/SafeModuleSetup.json");
const signerFactoryArtifact = require("@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json");
const verifierArtifact = require("@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json");

const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const messageAbi = parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]);
const routerAbi = parseAbi(["function getOperationHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)"]);

function contractSlot(owner: Address, payload: Hex): Hex {
  return concatHex([padHex(owner, { size: 32 }), toHex(65n, { size: 32 }), "0x00", toHex(size(payload), { size: 32 }), payload]);
}

describe("restricted Safe 4337 fallback", () => {
  it("preserves passkey SafeOp validation and rejects arbitrary ERC-1271 messages", async () => {
    const [payer] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();
    const deploy = async (artifact: any, args: readonly unknown[] = []) => {
      const hash = await payer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      expect(receipt.status).to.equal("success");
      return getContract({ address: receipt.contractAddress!, abi: artifact.abi, client: { public: publicClient, wallet: payer } });
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
    const safe = getContract({ address: proxy.address, abi: safeArtifact.abi, client: { public: publicClient, wallet: payer } });
    const router = await hre.viem.deployContract("Safe4337RestrictedRouter", [safe.address, module.address, EP]);
    const setupData = setup.abi && (await import("viem")).encodeFunctionData({ abi: setup.abi, functionName: "enableModules", args: [[router.address]] });
    await safe.write.setup([[primary], 1n, setup.address, setupData, router.address, zeroAddress, 0n, zeroAddress]);
    expect(await safe.read.VERSION()).to.equal("1.5.0");

    const recipient = payer.account.address;
    const callData = (await import("viem")).encodeFunctionData({ abi: moduleArtifact.abi, functionName: "executeUserOp", args: [recipient, 1n, "0x", 0] });
    const op = { sender: safe.address, nonce: 0n, initCode: "0x", callData, accountGasLimits: toHex(0n, { size: 32 }), preVerificationGas: 0n, gasFees: toHex(0n, { size: 32 }), paymasterAndData: "0x", signature: toHex(0n, { size: 12 }) };
    const opHash = await publicClient.readContract({ address: router.address, abi: routerAbi, functionName: "getOperationHash", args: [op] });
    const signedOp = { ...op, signature: concatHex([op.signature, contractSlot(primary, signWebAuthn(credential, opHash))]) };
    const validation = await publicClient.readContract({ address: safe.address, abi: moduleArtifact.abi, functionName: "validateUserOp", args: [signedOp, keccak256("0x01"), 0n], account: EP });
    expect(validation).to.equal(0n);
    await expect(publicClient.readContract({ address: router.address, abi: moduleArtifact.abi, functionName: "validateUserOp", args: [signedOp, keccak256("0x01"), 0n], account: EP })).to.be.rejected;
    await expect(publicClient.readContract({ address: safe.address, abi: moduleArtifact.abi, functionName: "validateUserOp", args: [signedOp, keccak256("0x01"), 0n], account: payer.account.address })).to.be.rejected;
    await expect(hre.viem.deployContract("Safe4337RestrictedRouter", [safe.address, module.address, payer.account.address])).to.be.rejected;
    await expect(hre.viem.deployContract("Safe4337RestrictedRouter", [safe.address, payer.account.address, EP])).to.be.rejected;

    const arbitrary = keccak256("0xabcdef");
    const safeMessageHash = hashTypedData({ domain: { chainId: 31337, verifyingContract: safe.address }, types: { SafeMessage: [{ name: "message", type: "bytes" }] }, primaryType: "SafeMessage", message: { message: encodeAbiParameters([{ type: "bytes32" }], [arbitrary]) } });
    const messageSignature = contractSlot(primary, signWebAuthn(credential, safeMessageHash));
    try {
      const magic = await publicClient.readContract({ address: safe.address, abi: messageAbi, functionName: "isValidSignature", args: [arbitrary, messageSignature] });
      expect.fail(`ERC-1271 unexpectedly accepted: ${magic}`);
    } catch (error) {
      expect(String(error)).not.to.contain("ERC-1271 unexpectedly accepted");
    }
    const bytesMessageAbi = parseAbi(["function isValidSignature(bytes,bytes) view returns (bytes4)"]);
    await expect(publicClient.readContract({ address: safe.address, abi: bytesMessageAbi, functionName: "isValidSignature", args: ["0xabcdef", messageSignature] })).to.be.rejected;
    await expect(publicClient.call({ to: safe.address, data: "0xdeadbeef" })).to.be.rejected;
  });
});
