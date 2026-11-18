import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { deploySafeFixture, ZERO, ecdsaSecondaryEnvelope, fn, passkeySignature, safeContractSignatures, signSafeTransaction, transferAbi } from "../helpers/safe";

const configureSafeContractSecondaryAbi = fn("configureSafeContractSecondary", [
  { name: "signer", type: "address" },
  { name: "enabled", type: "bool" },
]);


describe("TieredSpendingGuard spending against Safe 1.5", () => {
  it("permits an unlisted recipient only for a primary-only transfer in open base mode", async () => {
    const [deployer, ecdsaSecondary, recipient, unlisted] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, ecdsaSecondary.account.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 1_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const sign = async (to: Address, data: Hex) => signSafeTransaction(safe, ecdsaSecondary, to, data);
    const execute = async (to: Address, data: Hex, signature: Hex) =>
      safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    const policyData = encodeFunctionData({ abi: fn("setAssetPolicy", [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" },
      { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" }, { name: "baseRecipientMode", type: "uint8" },
    ]), functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 500n, [recipient.account.address], 1] });
    await execute(guard.address, policyData, await sign(guard.address, policyData));
    const setGuard = encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [guard.address] });
    await execute(safe.address, setGuard, await sign(safe.address, setGuard));
    const transfer = (to: Address, amount: bigint) => encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [to, amount] });

    await execute(token.address, transfer(unlisted.account.address, 100n), passkeySignature(passkey.address));
    await expect(execute(token.address, transfer(unlisted.account.address, 101n), ecdsaSecondaryEnvelope(passkey.address, await signSafeTransaction(safe, ecdsaSecondary, token.address, transfer(unlisted.account.address, 101n))))).to.be.rejected;
  });

  it("secondary signer Safe contract approval spends under the shared Y limit", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const safeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, safeContractSecondary.address, ecdsaSecondary.account.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 10_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const sign = async (to: Address, data: Hex, signer = ecdsaSecondary) => signSafeTransaction(safe, signer, to, data);
    const execute = async (to: Address, data: Hex, signature: Hex) => safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    const ownerCall = async (to: Address, data: Hex) => execute(to, data, await sign(to, data));

    await ownerCall(guard.address, encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [safeContractSecondary.address, true] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: fn("setAssetPolicy", [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" },
      { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ]), functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 500n, [recipient.account.address]] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [guard.address] }));

    const transfer = (amount: bigint) => encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [recipient.account.address, amount] });
    await execute(token.address, transfer(100n), passkeySignature(passkey.address));
    await execute(token.address, transfer(300n), safeContractSignatures(passkey.address, safeContractSecondary.address));
    expect((await guard.read.spendState([token.address]))[1]).to.equal(100n);
    expect((await guard.read.spendState([token.address]))[2]).to.equal(400n);
    await expect(execute(token.address, transfer(101n), safeContractSignatures(passkey.address, safeContractSecondary.address))).to.be.rejected;
  });

  it("rejects an ECDSA passkey owner on the transfer path", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const { safe } = await deploySafeFixture(hre, deployer, [deployer.account.address, ecdsaSecondary.account.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 1_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, deployer.account.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);

    const sign = async (to: Address, data: Hex, signer = ecdsaSecondary) => signSafeTransaction(safe, signer, to, data);
    const policyData = encodeFunctionData({ abi: [{ name: "setAssetPolicy", type: "function", stateMutability: "nonpayable", inputs: [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" },
      { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ], outputs: [] }], functionName: "setAssetPolicy", args: [token.address, 100n, 200n, 100n, 200n, [recipient.account.address]] });
    await safe.write.execTransaction([guard.address, 0n, policyData, 0, 0n, 0n, 0n, ZERO, ZERO, await sign(guard.address, policyData)], { account: deployer.account });
    const setGuardData = encodeFunctionData({ abi: [{ name: "setGuard", type: "function", stateMutability: "nonpayable", inputs: [{ name: "guard", type: "address" }], outputs: [] }], functionName: "setGuard", args: [guard.address] });
    await safe.write.execTransaction([safe.address, 0n, setGuardData, 0, 0n, 0n, 0n, ZERO, ZERO, await sign(safe.address, setGuardData)], { account: deployer.account });
    const transferData = encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [recipient.account.address, 1n] });
    await expect(safe.write.execTransaction([token.address, 0n, transferData, 0, 0n, 0n, 0n, ZERO, ZERO, await sign(token.address, transferData, deployer)], { account: deployer.account })).to.be.rejected;
    expect((await guard.read.spendState([token.address]))[2]).to.equal(0n);
  });

  it("accounts base and step-up transfers under shared per-token X/Y limits", async () => {
    const [deployer, ecdsaSecondary, recipient, other] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, ecdsaSecondary.account.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 10_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);

    const sign = async (to: Address, value: bigint, data: Hex, signer = ecdsaSecondary) => signSafeTransaction(safe, signer, to, data, { value });
    const execute = async (to: Address, value: bigint, data: Hex, signature: Hex) => {
      await safe.write.execTransaction([to, value, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    };
    const passkeySig = passkeySignature(passkey.address);
    const envelope = (ecdsaSecondarySignature: Hex) => ecdsaSecondaryEnvelope(passkey.address, ecdsaSecondarySignature);

    const policyData = encodeFunctionData({ abi: [{ name: "setAssetPolicy", type: "function", stateMutability: "nonpayable", inputs: [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" },
      { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ], outputs: [] }], functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 1_000n, [recipient.account.address, other.account.address]] });
    await execute(guard.address, 0n, policyData, await sign(guard.address, 0n, policyData));
    const replacementPolicy = encodeFunctionData({ abi: [{ name: "setAssetPolicy", type: "function", stateMutability: "nonpayable", inputs: [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" },
      { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ], outputs: [] }], functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 1_000n, [recipient.account.address]] });
    await execute(guard.address, 0n, replacementPolicy, await sign(guard.address, 0n, replacementPolicy));
    expect(await guard.read.allowedRecipient([token.address, recipient.account.address])).to.equal(true);
    expect(await guard.read.allowedRecipient([token.address, other.account.address])).to.equal(false);
    const addition = encodeFunctionData({ abi: [{ name: "setAssetPolicy", type: "function", stateMutability: "nonpayable", inputs: [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" },
      { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ], outputs: [] }], functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 1_000n, [recipient.account.address, other.account.address]] });
    await expect(execute(guard.address, 0n, addition, await sign(guard.address, 0n, addition))).to.be.rejected;
    const setGuardData = encodeFunctionData({ abi: [{ name: "setGuard", type: "function", stateMutability: "nonpayable", inputs: [{ name: "guard", type: "address" }], outputs: [] }], functionName: "setGuard", args: [guard.address] });
    await execute(safe.address, 0n, setGuardData, await sign(safe.address, 0n, setGuardData));
    const transfer = (to: Address, amount: bigint) => encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [to, amount] });
    await execute(token.address, 0n, transfer(recipient.account.address, 60n), passkeySig);
    let state = await guard.read.spendState([token.address]);
    expect(state[1]).to.equal(60n);
    expect(state[2]).to.equal(60n);

    await expect(execute(token.address, 0n, transfer(recipient.account.address, 50n), passkeySig)).to.be.rejected;
    const ecdsaSecondarySignature = await sign(token.address, 0n, transfer(recipient.account.address, 300n), ecdsaSecondary);
    await execute(token.address, 0n, transfer(recipient.account.address, 300n), envelope(ecdsaSecondarySignature));
    state = await guard.read.spendState([token.address]);
    expect(state[1]).to.equal(60n);
    expect(state[2]).to.equal(360n);

    await execute(token.address, 0n, transfer(recipient.account.address, 40n), passkeySig);
    const secondEcdsaSecondarySignature = await sign(token.address, 0n, transfer(recipient.account.address, 300n), ecdsaSecondary);
    await execute(token.address, 0n, transfer(recipient.account.address, 300n), envelope(secondEcdsaSecondarySignature));
    const thirdEcdsaSecondarySignature = await sign(token.address, 0n, transfer(recipient.account.address, 300n), ecdsaSecondary);
    await execute(token.address, 0n, transfer(recipient.account.address, 300n), envelope(thirdEcdsaSecondarySignature));
    state = await guard.read.spendState([token.address]);
    expect(state[1]).to.equal(100n);
    expect(state[2]).to.equal(1_000n);

    await expect(execute(token.address, 0n, transfer(recipient.account.address, 1n), passkeySig)).to.be.rejected;
    await expect(execute(token.address, 0n, transfer(other.account.address, 1n), passkeySig)).to.be.rejected;
    const tighten = encodeFunctionData({ abi: [{ name: "setAssetPolicy", type: "function", stateMutability: "nonpayable", inputs: [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" },
      { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ], outputs: [] }], functionName: "setAssetPolicy", args: [token.address, 50n, 200n, 50n, 900n, [recipient.account.address]] });
    await execute(guard.address, 0n, tighten, passkeySig);
    const tightened = await guard.read.assetPolicy([token.address]);
    expect(tightened[0]).to.equal(50n);
    expect(tightened[2]).to.equal(50n);
    expect(tightened[3]).to.equal(900n);
  });

  it("rejects forbidden calls and non-CALL operations", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, ecdsaSecondary.account.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 1_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const policyData = encodeFunctionData({ abi: [{ name: "setAssetPolicy", type: "function", stateMutability: "nonpayable", inputs: [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" }, { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ], outputs: [] }], functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 1_000n, [recipient.account.address]] });
    const nonce = await safe.read.nonce();
    const setupSignature = await signSafeTransaction(safe, ecdsaSecondary, guard.address, policyData, { nonce });
    await safe.write.execTransaction([guard.address, 0n, policyData, 0, 0n, 0n, 0n, ZERO, ZERO, setupSignature], { account: deployer.account });
    const setGuardData = encodeFunctionData({ abi: [{ name: "setGuard", type: "function", stateMutability: "nonpayable", inputs: [{ name: "guard", type: "address" }], outputs: [] }], functionName: "setGuard", args: [guard.address] });
    const setGuardNonce = await safe.read.nonce();
    const setGuardSignature = await signSafeTransaction(safe, ecdsaSecondary, safe.address, setGuardData, { nonce: setGuardNonce });
    await safe.write.execTransaction([safe.address, 0n, setGuardData, 0, 0n, 0n, 0n, ZERO, ZERO, setGuardSignature], { account: deployer.account });
    const transfer = encodeFunctionData({ abi: [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "approve", args: [recipient.account.address, 1n] });
    const n = await safe.read.nonce();
    const signature = await signSafeTransaction(safe, ecdsaSecondary, token.address, transfer, { nonce: n });
    await expect(safe.write.execTransaction([token.address, 0n, transfer, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account })).to.be.rejected;
    expect((await guard.read.spendState([token.address]))[2]).to.equal(0n);
  });

  it("reverts a false-returning ERC20 transfer and preserves counters and balances", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, ecdsaSecondary.account.address]);
    const token = await hre.viem.deployContract("ERC20FalseReturnMock", [safe.address, 1_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const bootstrapTx = async (to: Address, data: Hex) => signSafeTransaction(safe, ecdsaSecondary, to, data);
    const policyData = encodeFunctionData({ abi: [{ name: "setAssetPolicy", type: "function", stateMutability: "nonpayable", inputs: [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" }, { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ], outputs: [] }], functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 1_000n, [recipient.account.address]] });
    await safe.write.execTransaction([guard.address, 0n, policyData, 0, 0n, 0n, 0n, ZERO, ZERO, await bootstrapTx(guard.address, policyData)], { account: deployer.account });
    const setGuardData = encodeFunctionData({ abi: [{ name: "setGuard", type: "function", stateMutability: "nonpayable", inputs: [{ name: "guard", type: "address" }], outputs: [] }], functionName: "setGuard", args: [guard.address] });
    await safe.write.execTransaction([safe.address, 0n, setGuardData, 0, 0n, 0n, 0n, ZERO, ZERO, await bootstrapTx(safe.address, setGuardData)], { account: deployer.account });
    const transferData = encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [recipient.account.address, 40n] });
    const ownerSignature = passkeySignature(passkey.address);
    await expect(safe.write.execTransaction([token.address, 0n, transferData, 0, 0n, 0n, 0n, ZERO, ZERO, ownerSignature], { account: deployer.account })).to.be.rejected;
    expect((await guard.read.spendState([token.address]))[2]).to.equal(0n);
    expect(await token.read.balanceOf([safe.address])).to.equal(1_000n);
    expect(await token.read.balanceOf([recipient.account.address])).to.equal(0n);
  });
});
