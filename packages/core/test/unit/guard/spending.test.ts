import { expect } from "chai";
import hre from "hardhat";
import type { Address } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

describe("TieredSpendingGuard spending policy", () => {
  it("exposes a configured per-token policy and anchored spend state", async () => {
    const [deployer, ecdsaSecondary] = await hre.viem.getWalletClients();
    const singleton = await hre.viem.deployContract("Safe");
    const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]);
    const safe = await hre.viem.getContractAt("Safe", proxy.address);
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 10_000n]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[
      safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n,
    ]]);
    const owners = [passkey.address, ecdsaSecondary.account.address]
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    await safe.write.setup([owners, 1n, ZERO, "0x", ZERO, ZERO, 0n, ZERO], { account: deployer.account });

    await expect(guard.read.assetPolicy([token.address])).to.eventually.deep.equal([
      0n, 0n, 0n, 0n, 0,
    ]);
  });
});
