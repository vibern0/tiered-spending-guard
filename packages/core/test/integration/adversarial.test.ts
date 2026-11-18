import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeFunctionData, toHex, type Address, type Hex } from "viem";
import { deploySafeFixture, ZERO, ecdsaSecondaryEnvelope, fn, passkeySignature, safeContractSignatures, signSafeTransaction, transferAbi } from "../helpers/safe";

const configureSafeContractSecondaryAbi = fn("configureSafeContractSecondary", [
  { name: "signer", type: "address" },
  { name: "enabled", type: "bool" },
]);

describe("Task 10 adversarial threat-model matrix", () => {
  async function fixture() {
    const [deployer, ecdsaSecondary, recipient, other] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, ecdsaSecondary.account.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 10_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const sign = async (to: Address, data: Hex, signer = ecdsaSecondary, value = 0n, operation = 0 as const) => signSafeTransaction(safe, signer, to, data, { value, operation });
    const exec = async (to: Address, data: Hex, signature: Hex, value = 0n, operation = 0 as const) => safe.write.execTransaction([to, value, data, operation, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    const ownerCall = async (to: Address, data: Hex) => exec(to, data, await sign(to, data));
    const passkeySig = passkeySignature(passkey.address);
    const transfer = (to: Address, amount: bigint) => encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [to, amount] });
    await ownerCall(guard.address, encodeFunctionData({ abi: fn("setAssetPolicy", [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" }, { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ]), functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 1_000n, [recipient.account.address]] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: fn("setModuleGuard", [{ name: "guard", type: "address" }]), functionName: "setModuleGuard", args: [guard.address] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [guard.address] }));
    const step = async (to: Address, data: Hex) => ecdsaSecondaryEnvelope(passkey.address, await sign(to, data, ecdsaSecondary));
    return { deployer, ecdsaSecondary, recipient, other, safe, passkey, token, guard, sign, exec, ownerCall, passkeySig, step, transfer };
  }

  it("secondary signer adversarially rejects mixed Safe-contract and ECDSA secondaries", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const safeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, safeContractSecondary.address, ecdsaSecondary.account.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 10_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const sign = async (to: Address, data: Hex, signer = ecdsaSecondary) => signSafeTransaction(safe, signer, to, data);
    const exec = async (to: Address, data: Hex, signature: Hex) => safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    const ownerCall = async (to: Address, data: Hex) => exec(to, data, await sign(to, data));
    await ownerCall(guard.address, encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [safeContractSecondary.address, true] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: fn("setAssetPolicy", [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" }, { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ]), functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 1_000n, [recipient.account.address]] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [guard.address] }));
    const data = encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [recipient.account.address, 300n] });
    const safeSecondary = safeContractSignatures(passkey.address, safeContractSecondary.address);
    const ecdsaSecondarySignature = await sign(token.address, data, ecdsaSecondary);
    const mixed = `${safeSecondary}${ecdsaSecondarySignature.slice(2)}` as Hex;

    await expect(exec(token.address, data, mixed)).to.be.rejected;
    await exec(token.address, data, safeSecondary);
  });

  it("contract-only profile has no ECDSA approval path", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const safeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 10_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ZERO, delay.address, 86400n, 0n]]);
    const ownerSignature = passkeySignature(passkey.address);
    const ownerCall = (to: Address, data: Hex) => safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, ownerSignature], { account: deployer.account });
    await ownerCall(guard.address, encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [safeContractSecondary.address, true] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: fn("setAssetPolicy", [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" }, { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ]), functionName: "setAssetPolicy", args: [token.address, 100n, 300n, 100n, 1_000n, [recipient.account.address]] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [guard.address] }));
    const data = encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [recipient.account.address, 300n] });
    const extension = ecdsaSecondaryEnvelope(passkey.address, await signSafeTransaction(safe, ecdsaSecondary, token.address, data));

    await expect(safe.write.execTransaction([token.address, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, extension], { account: deployer.account })).to.be.rejected;
    await safe.write.execTransaction([token.address, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, safeContractSignatures(passkey.address, safeContractSecondary.address)], { account: deployer.account });
  });

  it("bounds split base X and combined immediate Y spending", async () => {
    const f = await fixture();
    await f.exec(f.token.address, f.transfer(f.recipient.account.address, 60n), f.passkeySig);
    await f.exec(f.token.address, f.transfer(f.recipient.account.address, 40n), f.passkeySig);
    await expect(f.exec(f.token.address, f.transfer(f.recipient.account.address, 1n), f.passkeySig)).to.be.rejected;
    await f.exec(f.token.address, f.transfer(f.recipient.account.address, 300n), await f.step(f.token.address, f.transfer(f.recipient.account.address, 300n)));
    await expect(f.exec(f.token.address, f.transfer(f.recipient.account.address, 601n), await f.step(f.token.address, f.transfer(f.recipient.account.address, 601n)))).to.be.rejected;
    expect((await f.guard.read.spendState([f.token.address]))[1]).to.equal(100n);
    expect((await f.guard.read.spendState([f.token.address]))[2]).to.equal(400n);
  });

  it("rolls back counters on failed execution and resets both counters at the anchored boundary", async () => {
    const f = await fixture();
    await expect(f.exec(f.token.address, f.transfer(f.recipient.account.address, 101n), f.passkeySig)).to.be.rejected;
    expect((await f.guard.read.spendState([f.token.address]))[2]).to.equal(0n);
    await f.exec(f.token.address, f.transfer(f.recipient.account.address, 100n), f.passkeySig);
    const before = await f.guard.read.spendState([f.token.address]);
    await time.increaseTo(Number(before[0] + 86400n));
    expect(await f.guard.read.spendState([f.token.address])).to.deep.equal(before);
    await f.exec(f.token.address, f.transfer(f.recipient.account.address, 100n), f.passkeySig);
    const after = await f.guard.read.spendState([f.token.address]);
    expect(after[0]).to.equal(before[0] + 86400n); expect(after[1]).to.equal(100n); expect(after[2]).to.equal(100n);
  });

  it("rejects wrong signer combinations, mutations, replay, and approved-hash signatures", async () => {
    const f = await fixture(); const data = f.transfer(f.recipient.account.address, 1n);
    await expect(f.exec(f.token.address, data, await f.sign(f.token.address, data, f.ecdsaSecondary))).to.be.rejected;
    const valid = await f.step(f.token.address, data);
    await f.exec(f.token.address, data, valid);
    await expect(f.exec(f.token.address, data, valid)).to.be.rejected;
    await expect(f.exec(f.token.address, f.transfer(f.recipient.account.address, 2n), valid)).to.be.rejected;
    const approvedHash = `0x${f.passkey.address.slice(2).padStart(64, "0")}${toHex(0n, { size: 32 }).slice(2)}01` as Hex;
    await expect(f.exec(f.token.address, data, approvedHash)).to.be.rejected;
  });

  it("rejects arbitrary messages, fallback installation, approvals, batches, delegatecalls, and unknown calldata", async () => {
    const f = await fixture();
    const cases: Array<[Address, Hex, 0 | 1]> = [
      [f.token.address, encodeFunctionData({ abi: fn("approve", [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }]), functionName: "approve", args: [f.recipient.account.address, 1n] }), 0],
      [f.token.address, "0x12345678" as Hex, 0],
      [f.safe.address, encodeFunctionData({ abi: fn("setFallbackHandler", [{ name: "handler", type: "address" }]), functionName: "setFallbackHandler", args: [f.other.account.address] }), 0],
      [f.safe.address, encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [ZERO] }), 0],
      [f.token.address, f.transfer(f.recipient.account.address, 1n), 1],
    ];
    for (const [to, data, operation] of cases) await expect(f.exec(to, data, f.passkeySig, 0n, operation)).to.be.rejected;
    const batch = encodeFunctionData({ abi: fn("multiSend", [{ name: "transactions", type: "bytes" }]), functionName: "multiSend", args: ["0x"] });
    await expect(f.exec(f.token.address, batch, f.passkeySig)).to.be.rejected;
  });

  it("rejects extra modules, direct Delay injection, and missing dual-guard topology", async () => {
    const f = await fixture(); const caller = await hre.viem.deployContract("ModuleCaller");
    await expect(caller.write.execute([f.safe.address, f.token.address, 0n, f.transfer(f.recipient.account.address, 1n), 0])).to.be.rejected;
    const modules = await f.safe.read.getModulesPaginated(["0x0000000000000000000000000000000000000001", 10n]);
    expect(modules[0]).to.deep.equal([]);
  });

  it("rejects removing either guard and rejects replacing only one guard slot", async () => {
    const f = await fixture();
    const setGuard = (name: "setGuard" | "setModuleGuard", guard: Address) => encodeFunctionData({ abi: fn(name, [{ name: "guard", type: "address" }]), functionName: name, args: [guard] });
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [f.safe.address, f.safe.address, f.safe.address, 10n, 60n]);
    const replacement = await hre.viem.deployContract("TieredSpendingGuard", [[f.safe.address, f.passkey.address, f.ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    for (const [target, data] of ([[f.safe.address, setGuard("setGuard", ZERO)], [f.safe.address, setGuard("setModuleGuard", ZERO)], [f.safe.address, setGuard("setGuard", replacement.address)], [f.safe.address, setGuard("setModuleGuard", replacement.address)]] as const)) {
      await expect(f.exec(target, data, await f.sign(target, data))).to.be.rejected;
      const client = await hre.viem.getPublicClient();
      const guardSlot = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as Hex;
      const moduleGuardSlot = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947" as Hex;
      expect((await client.getStorageAt({ address: f.safe.address, slot: guardSlot })!).toLowerCase().endsWith(f.guard.address.slice(2).toLowerCase())).to.equal(true);
      expect((await client.getStorageAt({ address: f.safe.address, slot: moduleGuardSlot })!).toLowerCase().endsWith(f.guard.address.slice(2).toLowerCase())).to.equal(true);
    }
  });
});
