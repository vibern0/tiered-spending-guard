import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { concatHex, encodeFunctionData, getContract, keccak256, padHex, parseEther, size, toHex, zeroAddress, type Address, type Hex } from "viem";
import { createAutomatedCredential, signWebAuthn } from "../../scripts/live/webauthn";
import { safeContractSignatures } from "../helpers/safe";

const safeArtifact = require("@safe-global/safe-smart-account/build/artifacts/contracts/Safe.sol/Safe.json");
const proxyArtifact = require("@safe-global/safe-smart-account/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json");
const moduleArtifact = require("@safe-global/safe-4337/build/artifacts/contracts/Safe4337Module.sol/Safe4337Module.json");
const setupArtifact = require("@safe-global/safe-4337/build/artifacts/contracts/SafeModuleSetup.sol/SafeModuleSetup.json");
const signerFactoryArtifact = require("@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json");
const verifierArtifact = require("@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json");
const entryPointArtifact = require("@account-abstraction/contracts/artifacts/EntryPoint.json");
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;

function slot(owner: Address, payload: Hex): Hex {
  return concatHex([padHex(owner, { size: 32 }), toHex(65n, { size: 32 }), "0x00", toHex(size(payload), { size: 32 }), payload]);
}

describe("Safe 4337 route-only targets", () => {
  it("blocks a direct owner transfer to a listed token and accepts the guarded 4337 wrapper", async () => {
    const [payer, recipient] = await hre.viem.getWalletClients();
    const client = await hre.viem.getPublicClient();
    const deploy = async (a: any, args: readonly unknown[] = []) => {
      const hash = await payer.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).to.equal("success");
      return getContract({ address: receipt.contractAddress!, abi: a.abi, client: { public: client, wallet: payer } });
    };
    const verifier = await deploy(verifierArtifact);
    const signerFactory = await deploy(signerFactoryArtifact);
    const credential = createAutomatedCredential();
    const signerArgs = [credential.x, credential.y, BigInt(verifier.address)] as const;
    await signerFactory.write.createSigner(signerArgs);
    const primary = await signerFactory.read.getSigner(signerArgs) as Address;
    const secondaryCredential = createAutomatedCredential();
    const secondaryArgs = [secondaryCredential.x, secondaryCredential.y, BigInt(verifier.address)] as const;
    await signerFactory.write.createSigner(secondaryArgs);
    const secondary = await signerFactory.read.getSigner(secondaryArgs) as Address;
    const module = await deploy(moduleArtifact, [EP]);
    const setup = await deploy(setupArtifact);
    const singleton = await deploy(safeArtifact);
    const proxy = await deploy(proxyArtifact, [singleton.address]);
    const safe = getContract({ address: proxy.address, abi: safeArtifact.abi, client: { public: client, wallet: payer } });
    const router = await hre.viem.deployContract("Safe4337RestrictedRouter", [safe.address, module.address, EP]);
    const routerHash = keccak256((await client.getCode({ address: router.address }))!);
    const setupData = encodeFunctionData({ abi: setup.abi, functionName: "enableModules", args: [[router.address]] });
    await safe.write.setup([[primary], 1n, setup.address, setupData, router.address, zeroAddress, 0n, zeroAddress]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 120n, 600n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard4337", [[safe.address, primary, zeroAddress, delay.address, 86400n, 0n], routerHash]);
    const wrongGuard = await hre.viem.deployContract("TieredSpendingGuard4337", [[safe.address, primary, zeroAddress, delay.address, 86400n, 0n], keccak256("0x01")]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, parseEther("1000")]);
    const ownerCall = async (to: Address, value: bigint, data: Hex) => {
      const nonce = await safe.read.nonce();
      const digest = await safe.read.getTransactionHash([to, value, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce]);
      return safe.write.execTransaction([to, value, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, slot(primary, signWebAuthn(credential, digest))]);
    };

    await expect(ownerCall(wrongGuard.address, 0n, encodeFunctionData({ abi: wrongGuard.abi, functionName: "configureAaRouter", args: [router.address] }))).to.be.rejected;
    await ownerCall(guard.address, 0n, encodeFunctionData({ abi: guard.abi, functionName: "configureAaRouter", args: [router.address] }));
    await ownerCall(guard.address, 0n, encodeFunctionData({ abi: guard.abi, functionName: "setAssetPolicy", args: [token.address, parseEther("10"), parseEther("30"), parseEther("10"), parseEther("30"), [recipient.account.address]] }));
    await ownerCall(guard.address, 0n, encodeFunctionData({ abi: guard.abi, functionName: "configureSafeContractSecondary", args: [secondary, true] }));
    await ownerCall(safe.address, 0n, encodeFunctionData({ abi: safeArtifact.abi, functionName: "enableModule", args: [delay.address] }));
    await ownerCall(delay.address, 0n, encodeFunctionData({ abi: delay.abi, functionName: "enableModule", args: [safe.address] }));
    await ownerCall(safe.address, 0n, encodeFunctionData({ abi: safeArtifact.abi, functionName: "setModuleGuard", args: [guard.address] }));
    await ownerCall(safe.address, 0n, encodeFunctionData({ abi: safeArtifact.abi, functionName: "setGuard", args: [guard.address] }));
    await ownerCall(guard.address, 0n, encodeFunctionData({ abi: guard.abi, functionName: "addRouteOnlyTarget", args: [token.address] }));

    const nextDay = async () => time.increaseTo((Math.floor((await time.latest()) / 86400) + 1) * 86400);
    await nextDay();
    const transferData = encodeFunctionData({ abi: token.abi, functionName: "transfer", args: [recipient.account.address, parseEther("1")] });
    try {
      await ownerCall(token.address, 0n, transferData);
      expect.fail("direct listed transfer succeeded");
    } catch (error) {
      expect(String(error)).not.to.contain("direct listed transfer succeeded");
    }

    const innerNonce = await safe.read.nonce();
    const innerDigest = await safe.read.getTransactionHash([token.address, 0n, transferData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, innerNonce]);
    const wrapped = encodeFunctionData({ abi: safeArtifact.abi, functionName: "execTransaction", args: [token.address, 0n, transferData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, slot(primary, signWebAuthn(credential, innerDigest))] });
    const outer = encodeFunctionData({ abi: moduleArtifact.abi, functionName: "executeUserOp", args: [safe.address, 0n, wrapped, 0] });
    const op = { sender: safe.address, nonce: 0n, initCode: "0x", callData: outer, accountGasLimits: toHex(0n, { size: 32 }), preVerificationGas: 0n, gasFees: toHex(0n, { size: 32 }), paymasterAndData: "0x", signature: toHex(0n, { size: 12 }) };
    const opHash = await client.readContract({ address: router.address, abi: moduleArtifact.abi, functionName: "getOperationHash", args: [op] });
    const signed = { ...op, signature: concatHex([op.signature, slot(primary, signWebAuthn(credential, opHash))]) };
    expect(await client.readContract({ address: safe.address, abi: moduleArtifact.abi, functionName: "validateUserOp", args: [signed, keccak256("0x01"), 0n], account: EP })).to.equal(0n);
    await hre.network.provider.send("hardhat_impersonateAccount", [EP]);
    await hre.network.provider.send("hardhat_setBalance", [EP, "0x1000000000000000000"]);
    const epWallet = await hre.viem.getWalletClient(EP);
    await epWallet.writeContract({ address: safe.address, abi: moduleArtifact.abi, functionName: "executeUserOp", args: [safe.address, 0n, wrapped, 0] });
    expect(await token.read.balanceOf([recipient.account.address])).to.equal(parseEther("1"));
    expect((await guard.read.spendState([token.address])).slice(1)).to.deep.equal([parseEther("1"), parseEther("1")]);
    await expect(epWallet.writeContract({ address: safe.address, abi: moduleArtifact.abi, functionName: "executeUserOp", args: [token.address, 0n, transferData, 0] })).to.be.rejected;
    expect((await guard.read.spendState([token.address])).slice(1)).to.deep.equal([parseEther("1"), parseEther("1")]);

    const aaExecute = async (to: Address, data: Hex) => {
      const callData = encodeFunctionData({ abi: moduleArtifact.abi, functionName: "executeUserOp", args: [to, 0n, data, 0] });
      const nextOp = { ...op, callData };
      const nextHash = await client.readContract({ address: router.address, abi: moduleArtifact.abi, functionName: "getOperationHash", args: [nextOp] });
      const nextSigned = { ...nextOp, signature: concatHex([op.signature, slot(primary, signWebAuthn(credential, nextHash))]) };
      expect(await client.readContract({ address: safe.address, abi: moduleArtifact.abi, functionName: "validateUserOp", args: [nextSigned, keccak256("0x01"), 0n], account: EP })).to.equal(0n);
      return epWallet.writeContract({ address: safe.address, abi: moduleArtifact.abi, functionName: "executeUserOp", args: [to, 0n, data, 0] });
    };
    // Independent of the frontend, submit exact Safe transactions signed by real WebAuthn keys.
    const sendInstant = async (amount: bigint, both: boolean) => {
      const calldata = encodeFunctionData({ abi: token.abi, functionName: "transfer", args: [recipient.account.address, amount] });
      const nonce = await safe.read.nonce();
      const fields = [token.address, 0n, calldata, 0, 0n, 0n, 0n, zeroAddress, zeroAddress] as const;
      const digest = await safe.read.getTransactionHash([...fields, nonce]);
      const primarySignature = signWebAuthn(credential, digest);
      const signatures = both
        ? safeContractSignatures(primary, secondary, primarySignature, signWebAuthn(secondaryCredential, digest))
        : slot(primary, primarySignature);
      const wrapped = encodeFunctionData({ abi: safeArtifact.abi, functionName: "execTransaction", args: [...fields, signatures] });
      return aaExecute(safe.address, wrapped);
    };
    await expect(sendInstant(parseEther("9.1"), false)).to.be.rejected;
    await sendInstant(parseEther("9.1"), true);
    expect(await token.read.balanceOf([recipient.account.address])).to.equal(parseEther("10.1"));
    await expect(sendInstant(1n, false)).to.be.rejected;
    expect((await guard.read.spendState([token.address])).slice(1)).to.deep.equal([parseEther("1"), parseEther("10.1")]);
    await sendInstant(parseEther("19.9"), true);
    await expect(sendInstant(1n, true)).to.be.rejected;
    const queuedTransfer = encodeFunctionData({ abi: token.abi, functionName: "transfer", args: [recipient.account.address, parseEther("31")] });
    const queueData = encodeFunctionData({ abi: delay.abi, functionName: "execTransactionFromModule", args: [token.address, 0n, queuedTransfer, 0] });
    const queueNonce = await safe.read.nonce();
    const queueDigest = await safe.read.getTransactionHash([delay.address, 0n, queueData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, queueNonce]);
    const dual = safeContractSignatures(primary, secondary, signWebAuthn(credential, queueDigest), signWebAuthn(secondaryCredential, queueDigest));
    const queueWrapped = encodeFunctionData({ abi: safeArtifact.abi, functionName: "execTransaction", args: [delay.address, 0n, queueData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, dual] });
    await aaExecute(safe.address, queueWrapped);
    expect(await delay.read.queueNonce()).to.equal(1n);
    const readyData = encodeFunctionData({ abi: delay.abi, functionName: "executeNextTx", args: [token.address, 0n, queuedTransfer, 0] });
    await expect(aaExecute(delay.address, readyData)).to.be.rejected;
    await time.increase(120);
    await expect(delay.write.executeNextTx([token.address, 0n, queuedTransfer, 0])).to.be.rejected;
    await aaExecute(delay.address, readyData);
    expect(await token.read.balanceOf([recipient.account.address])).to.equal(parseEther("61"));
    expect((await guard.read.spendState([token.address])).slice(1)).to.deep.equal([parseEther("1"), parseEther("30")]);

    const approvalData = encodeFunctionData({ abi: token.abi, functionName: "approve", args: [recipient.account.address, 100n] });
    const approvalNonce = await safe.read.nonce();
    const approvalDigest = await safe.read.getTransactionHash([token.address, 0n, approvalData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, approvalNonce]);
    const approvalWrapped = encodeFunctionData({ abi: safeArtifact.abi, functionName: "execTransaction", args: [token.address, 0n, approvalData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, slot(primary, signWebAuthn(credential, approvalDigest))] });
    await expect(aaExecute(safe.address, approvalWrapped)).to.be.rejected;

    const queueAgain = async () => {
      const nonce = await safe.read.nonce();
      const digest = await safe.read.getTransactionHash([delay.address, 0n, queueData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce]);
      const signatures = safeContractSignatures(primary, secondary, signWebAuthn(credential, digest), signWebAuthn(secondaryCredential, digest));
      const wrappedCall = encodeFunctionData({ abi: safeArtifact.abi, functionName: "execTransaction", args: [delay.address, 0n, queueData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] });
      await aaExecute(safe.address, wrappedCall);
    };
    await queueAgain();
    const cancelData = encodeFunctionData({ abi: delay.abi, functionName: "setTxNonce", args: [2n] });
    const cancelNonce = await safe.read.nonce();
    const cancelDigest = await safe.read.getTransactionHash([delay.address, 0n, cancelData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, cancelNonce]);
    const cancelSigs = safeContractSignatures(primary, secondary, signWebAuthn(credential, cancelDigest), signWebAuthn(secondaryCredential, cancelDigest));
    await safe.write.execTransaction([delay.address, 0n, cancelData, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, cancelSigs]);
    expect(await delay.read.txNonce()).to.equal(2n);
    await expect(aaExecute(delay.address, readyData)).to.be.rejected;
    await queueAgain();
    await time.increase(721);
    await expect(aaExecute(delay.address, readyData)).to.be.rejected;
    await delay.write.skipExpired();
    expect(await delay.read.txNonce()).to.equal(3n);
    expect(await token.read.balanceOf([recipient.account.address])).to.equal(parseEther("61"));

    // Etch a real locally deployed EntryPoint 0.7 runtime at the module's pinned canonical caller.
    // The external payer funds this local account deposit; sponsorship remains a separate gate.
    const entryPointImplementation = await deploy(entryPointArtifact);
    const entryPointCode = await client.getCode({ address: entryPointImplementation.address });
    await hre.network.provider.send("hardhat_setCode", [EP, entryPointCode]);
    const entryPoint = getContract({ address: EP, abi: entryPointArtifact.abi, client: { public: client, wallet: payer } });
    await entryPoint.write.depositTo([safe.address], { value: 10n ** 18n });
    await nextDay();
    const actualTransfer = encodeFunctionData({ abi: token.abi, functionName: "transfer", args: [recipient.account.address, parseEther("1")] });
    const actualNonce = await safe.read.nonce();
    const actualDigest = await safe.read.getTransactionHash([token.address, 0n, actualTransfer, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, actualNonce]);
    const actualWrapped = encodeFunctionData({ abi: safeArtifact.abi, functionName: "execTransaction", args: [token.address, 0n, actualTransfer, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, slot(primary, signWebAuthn(credential, actualDigest))] });
    const actualCallData = encodeFunctionData({ abi: moduleArtifact.abi, functionName: "executeUserOp", args: [safe.address, 0n, actualWrapped, 0] });
    const actualOp = {
      ...op,
      nonce: await entryPoint.read.getNonce([safe.address, 0n]),
      callData: actualCallData,
      accountGasLimits: toHex((3_000_000n << 128n) | 3_000_000n, { size: 32 }),
      preVerificationGas: 100_000n,
      gasFees: toHex((1_000_000_000n << 128n) | 2_000_000_000n, { size: 32 }),
    };
    const actualHash = await client.readContract({ address: router.address, abi: moduleArtifact.abi, functionName: "getOperationHash", args: [actualOp] });
    const signedActualOp = { ...actualOp, signature: concatHex([op.signature, slot(primary, signWebAuthn(credential, actualHash))]) };
    const operationTx = await entryPoint.write.handleOps([[signedActualOp], payer.account.address]);
    expect((await client.waitForTransactionReceipt({ hash: operationTx })).status).to.equal("success");
    expect(await token.read.balanceOf([recipient.account.address])).to.equal(parseEther("62"));
    expect((await guard.read.spendState([token.address])).slice(1)).to.deep.equal([parseEther("1"), parseEther("1")]);
    expect(await entryPoint.read.getNonce([safe.address, 0n])).to.equal(1n);
    await hre.network.provider.send("hardhat_stopImpersonatingAccount", [EP]);
  });
});
