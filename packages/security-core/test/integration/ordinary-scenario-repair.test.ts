import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeAbiParameters, encodeFunctionData, getContract, keccak256, parseAbi, type Address, type Hex } from "viem";
import { createAutomatedCredential, signWebAuthn } from "../../scripts/live/webauthn";
import { encodeSafeContractSignature } from "../../src/signers/passkey-helpers";
import { materializeRepairPrimaryFirstSafeCall } from "../../scripts/live/ordinary-scenario-repair-adapter";
import { ZERO, safeContractSignatures } from "../helpers/safe";
import factoryArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json";
import verifierArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json";

const replaceSignerAbi = [{ type: "function", name: "replaceSigner", stateMutability: "nonpayable", inputs: [{ name: "guard", type: "address" }, { name: "role", type: "uint8" }, { name: "expectedOld", type: "address" }, { name: "replacement", type: "address" }, { name: "previousOwner", type: "address" }, { name: "threshold", type: "uint256" }, { name: "replacementProof", type: "bytes" }] }] as const;
const replacementProofHash = (chainId: bigint, safe: Address, delay: Address, guard: Address, oldSecondary: Address, replacement: Address): Hex => keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }], ["RecentTxSafeGuard.passkeyReplacement.v1", chainId, safe, delay, guard, oldSecondary, replacement]));

async function deployRealPasskey() {
  const [wallet] = await hre.viem.getWalletClients(); const publicClient = await hre.viem.getPublicClient();
  const deploy = async (artifact: any) => {
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
    return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const verifier = await deploy(verifierArtifact); const factoryAddress = await deploy(factoryArtifact);
  const factory = getContract({ address: factoryAddress, abi: parseAbi(["function createSigner(uint256,uint256,uint176) returns (address)", "function getSigner(uint256,uint256,uint176) view returns (address)"]), client: { public: publicClient, wallet } });
  const credential = createAutomatedCredential(); const args = [credential.x, credential.y, BigInt(verifier)] as const;
  await factory.write.createSigner(args); const address = await factory.read.getSigner(args);
  const signer = getContract({ address, abi: parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]), client: publicClient });
  return { credential, signer, address: address as Address };
}

describe("closed repair-to-freeze path against real local Safe/WebAuthn", () => {
  it("creates, rotates, proves identical-hash old rejection/new success, cancels, and freezes", async () => {
    const [payer, ecdsa, recipient] = await hre.viem.getWalletClients(); const client = await hre.viem.getPublicClient();
    const primary = await deployRealPasskey(); const oldSecondary = await deployRealPasskey(); const replacement = await deployRealPasskey();
    const singleton = await hre.viem.deployContract("Safe"); const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]); const safe = await hre.viem.getContractAt("Safe", proxy.address);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 120n, 600n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, primary.address, ecdsa.account.address, delay.address, 86400n, 0n]]);
    const maintenance = await hre.viem.deployContract("GuardReplacementMaintenance", [safe.address, delay.address, ZERO]); const helper = await hre.viem.deployContract("SafeAtomicSetupHelper");
    const setup = encodeFunctionData({ abi: helper.abi, functionName: "setup", args: [{ guard: guard.address, delay: delay.address, maintenance: maintenance.address, passkey: primary.address, safeContractSecondary: oldSecondary.address, ecdsaSecondary: ecdsa.account.address, periodSeconds: 86400n, periodAnchor: 0n, assets: [{ token: ZERO, basePerTransaction: 10n, stepUpPerTransaction: 30n, baseDailyLimit: 10n, instantDailyLimit: 30n, recipients: [recipient.account.address] }] }] });
    await safe.write.setup([[primary.address], 1n, helper.address, setup, ZERO, ZERO, 0n, ZERO]); await payer.sendTransaction({ to: safe.address, value: 100n });
    const digest = async (to: Address, value: bigint, data: Hex, nonce?: bigint, operation: 0 | 1 = 0) => safe.read.getTransactionHash([to, value, data, operation, 0n, 0n, 0n, ZERO, ZERO, nonce ?? await safe.read.nonce()]);
    const signatures = async (to: Address, value: bigint, data: Hex, secondary: typeof oldSecondary, nonce?: bigint) => { const safeHash = await digest(to, value, data, nonce); return { safeHash, bytes: safeContractSignatures(primary.address, secondary.address, signWebAuthn(primary.credential, safeHash), signWebAuthn(secondary.credential, safeHash)) }; };
    const execute = (to: Address, value: bigint, data: Hex, signature: Hex) => safe.write.execTransaction([to, value, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: payer.account });
    const baseHash = await digest(recipient.account.address, 10n, "0x"); await execute(recipient.account.address, 10n, "0x", encodeSafeContractSignature(primary.address, signWebAuthn(primary.credential, baseHash)));
    const step = await signatures(recipient.account.address, 20n, "0x", oldSecondary); await execute(recipient.account.address, 20n, "0x", step.bytes); expect((await guard.read.spendState([ZERO]))[2]).to.equal(30n);
    const proofHash = replacementProofHash(31337n, safe.address, delay.address, guard.address, oldSecondary.address, replacement.address); const proof = signWebAuthn(replacement.credential, proofHash);
    expect(await replacement.signer.read.isValidSignature([proofHash, proof])).to.equal("0x1626ba7e");
    const repair = encodeFunctionData({ abi: replaceSignerAbi, functionName: "replaceSigner", args: [guard.address, 1, oldSecondary.address, replacement.address, ZERO, 1n, proof] });
    const repairQueue = encodeFunctionData({ abi: delay.abi, functionName: "execTransactionFromModule", args: [maintenance.address, 0n, repair, 1] });
    const repairSafeHash = await digest(delay.address, 0n, repairQueue); const signer = (passkey: typeof primary, role: "primary" | "secondary") => ({ address: passkey.address, kind: "safe-contract" as const, role, sign: async (request: { safeTxHash: Hex }) => encodeSafeContractSignature(passkey.address, signWebAuthn(passkey.credential, request.safeTxHash)) });
    await expect(materializeRepairPrimaryFirstSafeCall({ chainId: 31337, safe: safe.address, to: delay.address, data: repairQueue, nonce: await safe.read.nonce(), safeTxHash: keccak256("0x12"), primary: signer(primary, "primary"), secondary: signer(oldSecondary, "secondary") })).to.be.rejectedWith("Safe hash mismatch");
    const repairOuter = await materializeRepairPrimaryFirstSafeCall({ chainId: 31337, safe: safe.address, to: delay.address, data: repairQueue, nonce: await safe.read.nonce(), safeTxHash: repairSafeHash, primary: signer(primary, "primary"), secondary: signer(oldSecondary, "secondary") }); await payer.sendTransaction({ to: safe.address, data: repairOuter });
    expect(await delay.read.queueNonce()).to.equal(1n); await expect(delay.write.executeNextTx([maintenance.address, 0n, repair, 1])).to.be.rejected;
    await time.increase(121); await delay.write.executeNextTx([maintenance.address, 0n, repair, 1]);
    expect((await guard.read.safeContractSecondary())[0].toLowerCase()).to.equal(replacement.address.toLowerCase()); expect(await delay.read.txNonce()).to.equal(1n);

    const proofQueue = encodeFunctionData({ abi: delay.abi, functionName: "execTransactionFromModule", args: [recipient.account.address, 1n, "0x", 0] }); const nonce = await safe.read.nonce();
    const oldAttempt = await signatures(delay.address, 0n, proofQueue, oldSecondary, nonce); const newAttempt = await signatures(delay.address, 0n, proofQueue, replacement, nonce);
    expect(oldAttempt.safeHash).to.equal(newAttempt.safeHash); const before = { nonce: await safe.read.nonce(), queue: await delay.read.queueNonce(), tx: await delay.read.txNonce(), balance: await client.getBalance({ address: recipient.account.address }) };
    await expect(execute(delay.address, 0n, proofQueue, oldAttempt.bytes)).to.be.rejected;
    expect(await safe.read.nonce()).to.equal(before.nonce); expect(await delay.read.queueNonce()).to.equal(before.queue);
    await execute(delay.address, 0n, proofQueue, newAttempt.bytes); expect(await delay.read.queueNonce()).to.equal(2n);
    const cancel = encodeFunctionData({ abi: delay.abi, functionName: "setTxNonce", args: [2n] }); const cancelSignature = await signatures(delay.address, 0n, cancel, replacement); await execute(delay.address, 0n, cancel, cancelSignature.bytes);
    expect(await delay.read.txNonce()).to.equal(2n); await time.increase(121); await expect(delay.write.executeNextTx([recipient.account.address, 1n, "0x", 0])).to.be.rejected; expect(await client.getBalance({ address: recipient.account.address })).to.equal(before.balance);
    const freeze = encodeFunctionData({ abi: guard.abi, functionName: "freeze" }); const freezeSignature = await signatures(guard.address, 0n, freeze, replacement); await execute(guard.address, 0n, freeze, freezeSignature.bytes);
    expect(await guard.read.frozen()).to.equal(true); const frozenTransfer = await digest(recipient.account.address, 1n, "0x"); const frozenPrimary = safeContractSignatures(primary.address, replacement.address, signWebAuthn(primary.credential, frozenTransfer), signWebAuthn(replacement.credential, frozenTransfer)); await expect(execute(recipient.account.address, 1n, "0x", frozenPrimary)).to.be.rejected;
  });
});
