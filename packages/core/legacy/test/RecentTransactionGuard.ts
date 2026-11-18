import {
  loadFixture,
  mine,
} from "@nomicfoundation/hardhat-toolbox-viem/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, parseEther } from "viem";

const AddressZero = "0x0000000000000000000000000000000000000000";

export interface MetaTransaction {
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
  operation: number;
}

interface SafeTransaction extends MetaTransaction {
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: `0x${string}`;
  refundReceiver: `0x${string}`;
  nonce: `0x${string}`;
}

const buildSafeTransaction = (template: {
  to: `0x${string}`;
  value?: bigint;
  data?: `0x${string}`;
  operation?: number;
  safeTxGas?: bigint;
  baseGas?: bigint;
  gasPrice?: bigint;
  gasToken?: `0x${string}`;
  refundReceiver?: `0x${string}`;
  nonce: `0x${string}`;
}): SafeTransaction => {
  return {
    to: template.to,
    value: template.value || 0n,
    data: template.data || "0x",
    operation: template.operation || 0,
    safeTxGas: template.safeTxGas || 0n,
    baseGas: template.baseGas || 0n,
    gasPrice: template.gasPrice || 0n,
    gasToken: template.gasToken || AddressZero,
    refundReceiver: template.refundReceiver || AddressZero,
    nonce: template.nonce,
  };
};

describe("RecentTransactionGuard", function () {
  async function deployRecentTransactionGuardFixture() {
    const [owner, otherAccount] = await hre.viem.getWalletClients();

    const gnosisSafeMock = await hre.viem.deployContract("GnosisSafeMock", []);
    const recentTransactionGuard = await hre.viem.deployContract(
      "RecentTransactionGuard",
      []
    );
    const erc20Mock = await hre.viem.deployContract("ERC20Mock", [
      gnosisSafeMock.address,
      parseEther("1000"),
    ]);

    await recentTransactionGuard.write.setPublicSafeValidatorAddress([
      otherAccount.account.address,
    ]);
    await recentTransactionGuard.write.updateBlockValidationIntervalThreshold([
      80n,
    ]);
    await recentTransactionGuard.write.updateBlockValidationTimeoutThreshold([
      10n,
    ]);
    await gnosisSafeMock.write.setGuard([recentTransactionGuard.address]);

    const publicClient = await hre.viem.getPublicClient();

    return {
      gnosisSafeMock,
      recentTransactionGuard,
      erc20Mock,
      owner,
      otherAccount,
      publicClient,
    };
  }

  it("Should succeed if validated within time", async function () {
    const {
      gnosisSafeMock,
      recentTransactionGuard,
      erc20Mock,
      owner,
      otherAccount,
    } = await loadFixture(deployRecentTransactionGuardFixture);

    const data = encodeFunctionData({
      abi: erc20Mock.abi,
      functionName: "transfer",
      args: [otherAccount.account.address, parseEther("1")],
    });

    const tx = buildSafeTransaction({
      to: owner.account.address,
      nonce: "0x1",
      data,
      operation: 0,
      gasPrice: 1n,
      safeTxGas: 3000n,
      refundReceiver: otherAccount.account.address,
    });
    await recentTransactionGuard.write.validateNext({
      account: otherAccount.account,
    });

    await expect(
      gnosisSafeMock.write.execTransaction([
        tx.to,
        tx.value,
        tx.data,
        tx.operation,
        tx.safeTxGas,
        tx.baseGas,
        tx.gasPrice,
        tx.gasToken,
        tx.refundReceiver,
        tx.nonce,
      ])
    ).to.be.fulfilled;
  });

  it("Should revert if validation time has passed", async function () {
    const {
      gnosisSafeMock,
      recentTransactionGuard,
      erc20Mock,
      owner,
      otherAccount,
    } = await loadFixture(deployRecentTransactionGuardFixture);

    const data = encodeFunctionData({
      abi: erc20Mock.abi,
      functionName: "transfer",
      args: [otherAccount.account.address, parseEther("1")],
    });

    const tx = buildSafeTransaction({
      to: owner.account.address,
      nonce: "0x1",
      data,
      operation: 0,
      gasPrice: 1n,
      safeTxGas: 3000n,
      refundReceiver: otherAccount.account.address,
    });
    await recentTransactionGuard.write.validateNext({
      account: otherAccount.account,
    });

    await mine(150);

    await expect(
      gnosisSafeMock.write.execTransaction([
        tx.to,
        tx.value,
        tx.data,
        tx.operation,
        tx.safeTxGas,
        tx.baseGas,
        tx.gasPrice,
        tx.gasToken,
        tx.refundReceiver,
        tx.nonce,
      ])
    ).to.be.rejectedWith("Transaction validation interval not reached");
  });

  it("Should revert without validation", async function () {
    const { gnosisSafeMock, erc20Mock, owner, otherAccount } =
      await loadFixture(deployRecentTransactionGuardFixture);

    const data = encodeFunctionData({
      abi: erc20Mock.abi,
      functionName: "transfer",
      args: [otherAccount.account.address, parseEther("1")],
    });

    const tx = buildSafeTransaction({
      to: owner.account.address,
      nonce: "0x1",
      data,
      operation: 0,
      gasPrice: 1n,
      safeTxGas: 3000n,
      refundReceiver: otherAccount.account.address,
    });

    await expect(
      gnosisSafeMock.write.execTransaction([
        tx.to,
        tx.value,
        tx.data,
        tx.operation,
        tx.safeTxGas,
        tx.baseGas,
        tx.gasPrice,
        tx.gasToken,
        tx.refundReceiver,
        tx.nonce,
      ])
    ).to.be.rejectedWith("Transaction validation interval not reached");
  });
});
