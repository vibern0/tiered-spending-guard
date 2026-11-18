import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { ZERO, ecdsaSecondaryEnvelope, fn, passkeySignature, queueAbi, signSafeTransaction } from "../helpers/safe";
const setNonceAbi = fn("setTxNonce", [{ name: "nonce", type: "uint256" }]);
const configureSafeContractSecondaryAbi = fn("configureSafeContractSecondary", [
  { name: "signer", type: "address" },
  { name: "enabled", type: "bool" },
]);
const replaceSignerAbi = fn("replaceSigner", [{ name: "guard", type: "address" }, { name: "role", type: "uint8" }, { name: "expectedOld", type: "address" }, { name: "replacement", type: "address" }, { name: "previousOwner", type: "address" }, { name: "threshold", type: "uint256" }, { name: "replacementProof", type: "bytes" }]);

describe("local time-controlled security rehearsal", () => {
  it("proves real X/Y spending, delayed cancellation/expiry/execution, and delayed Option B repair", async () => {
    const publicClient = await hre.viem.getPublicClient();
    const network = await publicClient.getChainId();
    expect(network).to.equal(31337);
    const [deployer, ecdsaSecondary, recipient, replacement] = await hre.viem.getWalletClients();
    const singleton = await hre.viem.deployContract("Safe");
    const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]);
    const safe = await hre.viem.getContractAt("Safe", proxy.address);
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const safeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const maintenance = await hre.viem.deployContract("GuardReplacementMaintenance", [safe.address, delay.address, ZERO]);
    const owners = [passkey.address];
    await safe.write.setup([owners, 1n, ZERO, "0x", ZERO, ZERO, 0n, ZERO], { account: deployer.account });
    expect((await safe.read.getOwners()).map((owner) => owner.toLowerCase())).to.deep.equal(owners.map((owner) => owner.toLowerCase()));
    await deployer.sendTransaction({ to: safe.address, value: 500n });

    const sign = async (to: Address, value: bigint, data: Hex, signer = ecdsaSecondary) => signSafeTransaction(safe, signer, to, data, { chainId: network, value });
    const exec = (to: Address, value: bigint, data: Hex, signature: Hex, operation = 0 as const) => safe.write.execTransaction([to, value, data, operation, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    const ownerCall = async (to: Address, data: Hex) => exec(to, 0n, data, passkeySignature(passkey.address));
    const passkeySig = passkeySignature(passkey.address);
    const envelope = (signature: Hex) => ecdsaSecondaryEnvelope(passkey.address, signature);
    const passkeyAndSecondary = async (to: Address, value: bigint, data: Hex) => envelope(await sign(to, value, data, ecdsaSecondary));

    await ownerCall(delay.address, encodeFunctionData({ abi: fn("enableModule", [{ name: "module", type: "address" }]), functionName: "enableModule", args: [safe.address] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: fn("enableModule", [{ name: "module", type: "address" }]), functionName: "enableModule", args: [delay.address] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [safeContractSecondary.address, true] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: fn("setMaintenance", [{ name: "replacementMaintenance", type: "address" }]), functionName: "setMaintenance", args: [maintenance.address] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: fn("setModuleGuard", [{ name: "guard", type: "address" }]), functionName: "setModuleGuard", args: [guard.address] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: fn("setAssetPolicy", [{ name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" }, { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" }]), functionName: "setAssetPolicy", args: [ZERO, 25n, 100n, 50n, 100n, [recipient.account.address]] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [guard.address] }));

    await exec(recipient.account.address, 25n, "0x", passkeySig);
    await exec(recipient.account.address, 25n, "0x", passkeySig);
    expect((await guard.read.spendState([ZERO]))[1]).to.equal(50n);
    expect((await guard.read.spendState([ZERO]))[2]).to.equal(50n);
    await expect(exec(recipient.account.address, 1n, "0x", passkeySig)).to.be.rejected;

    const stepSignature = await sign(recipient.account.address, 50n, "0x", ecdsaSecondary);
    await exec(recipient.account.address, 50n, "0x", envelope(stepSignature));
    expect((await guard.read.spendState([ZERO]))[2]).to.equal(100n);
    await expect(exec(recipient.account.address, 101n, "0x", passkeySig)).to.be.rejected;
    await time.increase(86401);

    const queue = async (value: bigint, data: Hex = "0x", target: Address = recipient.account.address, operation = 0 as const, signer = ecdsaSecondary, includeSecondary = true) => {
      const inner = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [target, value, data, operation] });
      const signature = await sign(delay.address, 0n, inner, signer);
      await exec(delay.address, 0n, inner, includeSecondary ? envelope(signature) : signature);
      return { inner, target, value, data, operation };
    };
    const beforeCancelSafe = await publicClient.getBalance({ address: safe.address });
    const beforeCancelRecipient = await publicClient.getBalance({ address: recipient.account.address });
    const first = await queue(150n);
    expect(await delay.read.queueNonce()).to.equal(1n);
    await expect(delay.write.executeNextTx([first.target, first.value, first.data, first.operation], { account: deployer.account })).to.be.rejected;
    await exec(delay.address, 0n, encodeFunctionData({ abi: setNonceAbi, functionName: "setTxNonce", args: [1n] }), await passkeyAndSecondary(delay.address, 0n, encodeFunctionData({ abi: setNonceAbi, functionName: "setTxNonce", args: [1n] })));
    await time.increase(11);
    await expect(delay.write.executeNextTx([first.target, first.value, first.data, first.operation], { account: deployer.account })).to.be.rejected;
    expect(await publicClient.getBalance({ address: safe.address })).to.equal(beforeCancelSafe);
    expect(await publicClient.getBalance({ address: recipient.account.address })).to.equal(beforeCancelRecipient);

    const second = await queue(150n);
    await time.increase(11);
    await delay.write.executeNextTx([second.target, second.value, second.data, second.operation], { account: deployer.account });
    expect(await publicClient.getBalance({ address: recipient.account.address })).to.equal(beforeCancelRecipient + 150n);

    const expired = await queue(150n);
    const txNonceBeforeExpiry = await delay.read.txNonce();
    const cooldown = await delay.read.txCooldown();
    const expiration = await delay.read.txExpiration();
    await time.increase(cooldown + expiration + 1n);
    await delay.write.skipExpired({ account: deployer.account });
    expect(await delay.read.txNonce()).to.equal(txNonceBeforeExpiry + 1n);
    await expect(delay.write.executeNextTx([expired.target, expired.value, expired.data, expired.operation], { account: deployer.account })).to.be.rejected;
    expect(await publicClient.getBalance({ address: safe.address })).to.equal(beforeCancelSafe - 150n);
    expect(await publicClient.getBalance({ address: recipient.account.address })).to.equal(beforeCancelRecipient + 150n);

    const freeze = encodeFunctionData({ abi: fn("freeze", []), functionName: "freeze", args: [] });
    await exec(guard.address, 0n, freeze, await passkeyAndSecondary(guard.address, 0n, freeze));
    expect(await guard.read.frozen()).to.equal(true);
    const ecdsaSecondaryIndex = owners.findIndex((owner) => owner.toLowerCase() === ecdsaSecondary.account.address.toLowerCase());
    const previousOwner = ZERO;
    const repair = encodeFunctionData({ abi: replaceSignerAbi, functionName: "replaceSigner", args: [guard.address, 1, ecdsaSecondary.account.address, replacement.account.address, previousOwner, 1n, "0x"] });
    const repairQueue = await queue(0n, repair, maintenance.address, 1, ecdsaSecondary, true);
    await expect(delay.write.executeNextTx([repairQueue.target, repairQueue.value, repairQueue.data, repairQueue.operation], { account: deployer.account })).to.be.rejected;
    await time.increase(11);
    await delay.write.executeNextTx([repairQueue.target, repairQueue.value, repairQueue.data, repairQueue.operation], { account: deployer.account });
    expect((await guard.read.config())[2].toLowerCase()).to.equal(replacement.account.address.toLowerCase());
    expect((await safe.read.getOwners()).map((owner) => owner.toLowerCase())).to.deep.equal([passkey.address.toLowerCase()]);
  });
});
