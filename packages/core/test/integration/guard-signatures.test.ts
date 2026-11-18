import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { deploySafeFixture, ZERO, ecdsaSecondaryEnvelope, fn, passkeySignature, safeContractSignatures, safeTxTypes, signSafeTransaction, transferAbi } from "../helpers/safe";

const setGuardAbi = fn("setGuard", [{ name: "guard", type: "address" }]);
const setModuleGuardAbi = fn("setModuleGuard", [{ name: "guard", type: "address" }]);
const enableModuleAbi = fn("enableModule", [{ name: "module", type: "address" }]);
const revertCallAbi = fn("revertCall", []);
const setAssetPolicyAbi = fn("setAssetPolicy", [
  { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" },
  { name: "stepUpPerTransaction", type: "uint256" }, { name: "baseDailyLimit", type: "uint256" },
  { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
]);
const configureSafeContractSecondaryAbi = fn("configureSafeContractSecondary", [
  { name: "signer", type: "address" },
  { name: "enabled", type: "bool" },
]);


describe("TieredSpendingGuard against Safe 1.5", () => {
  async function secondarySignerFixture(yubiEnabled = true, secondaryProfile: "dual" | "contract-only" = "dual") {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const safeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const wrongSafeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 10_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, secondaryProfile === "contract-only" ? ZERO : ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const ownerCall = async (to: Address, data: Hex) => {
      const signature = passkeySignature(passkey.address);
      await safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    };
    await ownerCall(guard.address, encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [safeContractSecondary.address, yubiEnabled] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: setAssetPolicyAbi, functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 1_000n, [recipient.account.address]] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: setGuardAbi, functionName: "setGuard", args: [guard.address] }));
    const transfer = (amount: bigint) => encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [recipient.account.address, amount] });
    const exec = (data: Hex, signatures: Hex) => safe.write.execTransaction([token.address, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures], { account: deployer.account });
    const ecdsaSecondaryStep = async (data: Hex) => ecdsaSecondaryEnvelope(passkey.address, await signSafeTransaction(safe, ecdsaSecondary, token.address, data));
    const safeContractSecondaryStep = (primaryPayload = "0x" as Hex, secondaryPayload = "0x" as Hex) => safeContractSignatures(passkey.address, safeContractSecondary.address, primaryPayload, secondaryPayload);
    return { ecdsaSecondary, recipient, passkey, safeContractSecondary, wrongSafeContractSecondary, safe, token, guard, transfer, exec, ecdsaSecondaryStep, safeContractSecondaryStep };
  }

  it("secondary signer matrix allows primary plus exactly one configured secondary", async () => {
    const f = await secondarySignerFixture();

    expect((await f.safe.read.getOwners()).map((owner) => owner.toLowerCase())).to.deep.equal([f.passkey.address.toLowerCase()]);

    await f.exec(f.transfer(60n), passkeySignature(f.passkey.address));
    await expect(f.exec(f.transfer(50n), passkeySignature(f.passkey.address))).to.be.rejected;
    await expect(f.exec(f.transfer(1n), passkeySignature(f.safeContractSecondary.address))).to.be.rejected;
    await expect(f.exec(f.transfer(1n), await signSafeTransaction(f.safe, f.ecdsaSecondary, f.token.address, f.transfer(1n)))).to.be.rejected;
    await expect(f.exec(f.transfer(1n), ecdsaSecondaryEnvelope(f.safeContractSecondary.address, await signSafeTransaction(f.safe, f.ecdsaSecondary, f.token.address, f.transfer(1n))))).to.be.rejected;

    await f.exec(f.transfer(300n), f.safeContractSecondaryStep());
    await f.exec(f.transfer(300n), await f.ecdsaSecondaryStep(f.transfer(300n)));

    await expect(f.exec(f.transfer(300n), safeContractSignatures(f.passkey.address, f.wrongSafeContractSecondary.address))).to.be.rejected;
    const mixed = `${f.safeContractSecondaryStep()}${(await signSafeTransaction(f.safe, f.ecdsaSecondary, f.token.address, f.transfer(300n))).slice(2)}` as Hex;
    await expect(f.exec(f.transfer(300n), mixed)).to.be.rejected;
  });

  it("secondary signer rejects disabled safe-contract signatures while keeping ECDSA secondary available", async () => {
    const f = await secondarySignerFixture(false);

    await expect(f.exec(f.transfer(300n), f.safeContractSecondaryStep())).to.be.rejected;
    await f.exec(f.transfer(300n), await f.ecdsaSecondaryStep(f.transfer(300n)));
  });

  it("contract-only profile rejects every terminal ECDSA extension", async () => {
    const f = await secondarySignerFixture(true, "contract-only");
    const data = f.transfer(300n);

    await expect(f.exec(data, await f.ecdsaSecondaryStep(data))).to.be.rejected;
    await f.exec(data, f.safeContractSecondaryStep());
    expect((await f.guard.read.spendState([f.token.address]))[2]).to.equal(300n);
  });

  it("secondary signer Safe contract signatures accept non-empty ERC-1271 payloads", async () => {
    const f = await secondarySignerFixture();

    await f.exec(f.transfer(300n), f.safeContractSecondaryStep("0x12345678", "0xabcdef"));
    expect((await f.guard.read.spendState([f.token.address]))[2]).to.equal(300n);
  });

  it("requires primary first even when a secondary address sorts before primary", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const firstSigner = await hre.viem.deployContract("Mock1271Signer");
    const secondSigner = await hre.viem.deployContract("Mock1271Signer");
    const [safeContractSecondary, passkey] = firstSigner.address.toLowerCase() < secondSigner.address.toLowerCase()
      ? [firstSigner, secondSigner]
      : [secondSigner, firstSigner];
    expect(safeContractSecondary.address.toLowerCase() < passkey.address.toLowerCase()).to.equal(true);
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 10_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const ownerCall = async (to: Address, data: Hex) => {
      const signature = passkeySignature(passkey.address);
      await safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    };
    await ownerCall(guard.address, encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [safeContractSecondary.address, true] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: setAssetPolicyAbi, functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 1_000n, [recipient.account.address]] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: setGuardAbi, functionName: "setGuard", args: [guard.address] }));

    const data = encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [recipient.account.address, 300n] });
    await expect(safe.write.execTransaction([token.address, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, safeContractSignatures(safeContractSecondary.address, passkey.address)], { account: deployer.account })).to.be.rejected;
    await safe.write.execTransaction([token.address, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, safeContractSignatures(passkey.address, safeContractSecondary.address)], { account: deployer.account });

    expect((await guard.read.spendState([token.address]))[2]).to.equal(300n);
  });

  it("accepts the configured passkey contract signature and rejects failed execution", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, ecdsaSecondary.account.address]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);

    const nonce = await safe.read.nonce();
    const setGuardData = encodeFunctionData({ abi: setGuardAbi, functionName: "setGuard", args: [guard.address] });
    const ecdsaSecondarySignature = await signSafeTransaction(safe, ecdsaSecondary, safe.address, setGuardData, { nonce });
    await safe.write.execTransaction([safe.address, 0n, setGuardData, 0, 0n, 0n, 0n, ZERO, ZERO, ecdsaSecondarySignature], { account: deployer.account });

    const ownerSignature = passkeySignature(passkey.address);
    await expect(safe.write.execTransaction([recipient.account.address, 0n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, ownerSignature], { account: deployer.account })).to.be.rejected;
    expect(await safe.read.nonce()).to.equal(nonce + 1n);

    const revertData = encodeFunctionData({ abi: revertCallAbi, functionName: "revertCall" });
    await expect(safe.write.execTransaction([passkey.address, 0n, revertData, 0, 0n, 0n, 0n, ZERO, ZERO, ownerSignature], { account: deployer.account })).to.be.rejected;
  });

  it("accepts only a real ECDSA secondary signature over the exact Safe hash and rejects mutations, wrong domains, and replay", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, ecdsaSecondary.account.address]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);

    const signSafeHash = async (nonce: bigint, domainSafe = safe.address, chainId = 31337) => ecdsaSecondary.signTypedData({
      domain: { chainId, verifyingContract: domainSafe }, types: safeTxTypes, primaryType: "SafeTx",
      message: { to: recipient.account.address, value: 0n, data: "0x", operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce },
    });
    const ownerSignature = passkeySignature(passkey.address);
    const envelope = (ecdsaSecondarySignature: Hex) => ecdsaSecondaryEnvelope(passkey.address, ecdsaSecondarySignature);

    await deployer.sendTransaction({ to: safe.address, value: 1n });
    const policyData = encodeFunctionData({ abi: setAssetPolicyAbi, functionName: "setAssetPolicy", args: [ZERO, 1n, 1n, 100n, 1_000n, [recipient.account.address]] });
    const policySignature = await signSafeTransaction(safe, ecdsaSecondary, guard.address, policyData);
    await safe.write.execTransaction([guard.address, 0n, policyData, 0, 0n, 0n, 0n, ZERO, ZERO, policySignature], { account: deployer.account });
    const setGuardData = encodeFunctionData({ abi: setGuardAbi, functionName: "setGuard", args: [guard.address] });
    const setupSignature = await signSafeTransaction(safe, ecdsaSecondary, safe.address, setGuardData);
    await safe.write.execTransaction([safe.address, 0n, setGuardData, 0, 0n, 0n, 0n, ZERO, ZERO, setupSignature], { account: deployer.account });

    const nonce = await safe.read.nonce();
    const validEcdsaSecondary = await signSafeTransaction(safe, ecdsaSecondary, recipient.account.address, "0x", { value: 1n, nonce });
    await safe.write.execTransaction([recipient.account.address, 1n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, envelope(validEcdsaSecondary)], { account: deployer.account });
    expect(await safe.read.nonce()).to.equal(nonce + 1n);

    const nextNonce = nonce + 1n;
    const nextValid = await signSafeHash(nextNonce);
    await expect(safe.write.execTransaction([guard.address, 0n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, envelope(nextValid)], { account: deployer.account })).to.be.rejected;
    await expect(safe.write.execTransaction([recipient.account.address, 1n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, envelope(nextValid)], { account: deployer.account })).to.be.rejected;
    await expect(safe.write.execTransaction([recipient.account.address, 0n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, envelope(await signSafeHash(nextNonce, safe.address, 1))], { account: deployer.account })).to.be.rejected;
    await expect(safe.write.execTransaction([recipient.account.address, 0n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, envelope(await signSafeHash(nextNonce, guard.address))], { account: deployer.account })).to.be.rejected;
    await expect(safe.write.execTransaction([recipient.account.address, 0n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, envelope(await signSafeHash(nonce))], { account: deployer.account })).to.be.rejected;
    await expect(safe.write.execTransaction([recipient.account.address, 0n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, envelope("0x")], { account: deployer.account })).to.be.rejected;
    await expect(safe.write.execTransaction([recipient.account.address, 0n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, envelope(validEcdsaSecondary)], { account: deployer.account })).to.be.rejected;
  });

  it("constrains the configured module and rolls back failed module checks", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, ecdsaSecondary.account.address]);
    const module = await hre.viem.deployContract("ModuleCaller");
    const otherModule = await hre.viem.deployContract("ModuleCaller");
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, module.address, 86400n, 0n]]);

    const ownerTx = async (to: Address, data: Hex) => {
      const signature = await signSafeTransaction(safe, ecdsaSecondary, to, data);
      await safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    };
    const enableData = encodeFunctionData({ abi: enableModuleAbi, functionName: "enableModule", args: [module.address] });
    const setModuleGuardData = encodeFunctionData({ abi: setModuleGuardAbi, functionName: "setModuleGuard", args: [guard.address] });
    const setGuardData = encodeFunctionData({ abi: setGuardAbi, functionName: "setGuard", args: [guard.address] });
    await ownerTx(safe.address, enableData);
    await ownerTx(safe.address, setModuleGuardData);
    await ownerTx(safe.address, setGuardData);

    await expect(otherModule.write.execute([safe.address, recipient.account.address, 0n, "0x", 0], { account: deployer.account })).to.be.rejected;
    await expect(module.write.execute([safe.address, passkey.address, 0n, encodeFunctionData({ abi: revertCallAbi, functionName: "revertCall" }), 0], { account: deployer.account })).to.be.rejected;
    await expect(module.write.execute([safe.address, recipient.account.address, 0n, "0x", 0], { account: deployer.account })).to.be.rejected;
  });
});
