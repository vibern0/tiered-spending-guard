import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeFunctionData, toHex, type Address, type Hex } from "viem";
import { deploySafeFixture, ZERO, safeTxTypes as types } from "../helpers/safe";

describe("spending stateful invariants", () => {
  it("keeps counters bounded and monotonic within a window across mixed attempts", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, ecdsaSecondary.account.address]);
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 100_000n]);
    const tokenTwo = await hre.viem.deployContract("ERC20Mock", [safe.address, 100_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const transfer = (tokenRecipient: Address, amount: bigint) => encodeFunctionData({ abi: [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "transfer", args: [tokenRecipient, amount] });
    const sign = async (to: Address, data: Hex, signer = ecdsaSecondary) => signer.signTypedData({
      domain: { chainId: 31337, verifyingContract: safe.address }, types, primaryType: "SafeTx",
      message: { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: await safe.read.nonce() },
    });
    const setPolicy = (asset: Address) => encodeFunctionData({ abi: [{ name: "setAssetPolicy", type: "function", stateMutability: "nonpayable", inputs: [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" }, { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ], outputs: [] }], functionName: "setAssetPolicy", args: [asset, 100n, 300n, 100n, 1_000n, [recipient.account.address]] });
    await safe.write.execTransaction([guard.address, 0n, setPolicy(token.address), 0, 0n, 0n, 0n, ZERO, ZERO, await sign(guard.address, setPolicy(token.address))], { account: deployer.account });
    await safe.write.execTransaction([guard.address, 0n, setPolicy(tokenTwo.address), 0, 0n, 0n, 0n, ZERO, ZERO, await sign(guard.address, setPolicy(tokenTwo.address))], { account: deployer.account });
    const setGuardData = encodeFunctionData({ abi: [{ name: "setGuard", type: "function", stateMutability: "nonpayable", inputs: [{ name: "guard", type: "address" }], outputs: [] }], functionName: "setGuard", args: [guard.address] });
    await safe.write.execTransaction([safe.address, 0n, setGuardData, 0, 0n, 0n, 0n, ZERO, ZERO, await sign(safe.address, setGuardData)], { account: deployer.account });
    const ownerSignature = `0x${passkey.address.slice(2).padStart(64, "0")}${toHex(65n, { size: 32 }).slice(2)}00${toHex(0n, { size: 32 }).slice(2)}` as Hex;
    const stepUp = async (asset: Address, data: Hex) => {
      const ecdsaSecondarySignature = await sign(asset, data, ecdsaSecondary);
      return `${ownerSignature}${ecdsaSecondarySignature.slice(2)}${toHex((ecdsaSecondarySignature.length - 2) / 2, { size: 32 }).slice(2)}b730773ff261bde7bdf630037533d4522df4bf5695e820c5373a22210670f2f9` as Hex;
    };
    const assets = [token.address, tokenTwo.address];
    const initialBalance = 100_000n;
    const previous = new Map<Address, { window: bigint; spent: bigint }>();
    let seed = 0x9e3779b9;
    for (let index = 0; index < 40; ++index) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      if (index === 20) {
        const before = await guard.read.spendState([token.address]);
        await time.increaseTo(Number(before[0] + 86400n));
      }
      const asset = assets[seed % assets.length];
      const amount = BigInt((seed % 180) + 1);
      const elevated = seed % 3 === 0;
      const authorizedRecipient = seed % 4 !== 0;
      const target = authorizedRecipient ? recipient.account.address : deployer.account.address;
      const data = transfer(target, amount);
      const signature = elevated ? await stepUp(asset, data) : ownerSignature;
      const safeBefore = await (asset === token.address ? token : tokenTwo).read.balanceOf([safe.address]);
      const recipientBefore = await (asset === token.address ? token : tokenTwo).read.balanceOf([recipient.account.address]);
      try {
        await safe.write.execTransaction([asset, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
      } catch {
        // Rejected attempts must not move balances or consume spend.
      }
      const tokenContract = asset === token.address ? token : tokenTwo;
      const safeAfter = await tokenContract.read.balanceOf([safe.address]);
      const recipientAfter = await tokenContract.read.balanceOf([recipient.account.address]);
      expect(safeAfter + recipientAfter).to.equal(initialBalance);
      if (!authorizedRecipient) expect(recipientAfter).to.equal(recipientBefore);
      const state = await guard.read.spendState([asset]);
      expect(state[1] <= 100n).to.equal(true);
      expect(state[2] <= 1_000n).to.equal(true);
      const prior = previous.get(asset);
      if (prior && prior.window === state[0]) expect(state[2] >= prior.spent).to.equal(true);
      previous.set(asset, { window: state[0], spent: state[2] });
      if (authorizedRecipient && safeAfter !== safeBefore) expect(safeBefore - safeAfter).to.equal(amount);
    }
    const before = await guard.read.spendState([token.address]);
    await time.increaseTo(Number(before[0] + 86400n));
    await safe.write.execTransaction([token.address, 0n, transfer(recipient.account.address, 100n), 0, 0n, 0n, 0n, ZERO, ZERO, ownerSignature], { account: deployer.account });
    const after = await guard.read.spendState([token.address]);
    expect(after[0]).to.equal(before[0] + 86400n);
    expect(after[1]).to.equal(100n);
    expect(after[2]).to.equal(100n);
  });
});
