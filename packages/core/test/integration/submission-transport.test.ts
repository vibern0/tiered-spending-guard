import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { brandVerifiedDeploymentInfrastructureForTestsOnly, type VerifiedDeploymentInfrastructure } from "../../../sdk/src/config/deployments";
import { queueFingerprint } from "../../../sdk/src/queue/delay";
import { SAFE_TX_TYPES, type SafeTxMessage } from "../../../sdk/src/signers/types";
import { type TopologyReport } from "../../../sdk/src/topology/verify";
import {
  deploymentInfrastructureHash,
  type RelayerContext,
  validateAndBroadcast,
} from "../../../sdk/src/transport/relayer";
import { type DelayExecutionRequest, type SafeExecutionRequest } from "../../../sdk/src/transport/types";
import { deploySafeFixture, ZERO, ecdsaSecondaryEnvelope, fn, passkeySignature, queueAbi, signSafeTransaction, transferAbi } from "../helpers/safe";

process.env.NODE_ENV = "test";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const a = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const freezeAbi = fn("freeze", []);
const transactionAddedEvent = parseAbiItem("event TransactionAdded(uint256 indexed queueNonce, bytes32 indexed txHash, address to, uint256 value, bytes data, uint8 operation)");
const replaceSignerAbi = fn("replaceSigner", [
  { name: "guard", type: "address" },
  { name: "role", type: "uint8" },
  { name: "expectedOld", type: "address" },
  { name: "replacement", type: "address" },
  { name: "previousOwner", type: "address" },
  { name: "threshold", type: "uint256" },
  { name: "replacementProof", type: "bytes" },
]);

function verifiedDeployments(): VerifiedDeploymentInfrastructure {
  const dependency = Object.freeze({
    name: "integration",
    version: "1.5.0",
    address: a(90),
    runtimeCodeHash: h(90),
    evidence: "verified" as const,
    source: "integration test",
  });
  return brandVerifiedDeploymentInfrastructureForTestsOnly(Object.freeze({
    chainId: 31337,
    deployer: a(80),
    observedDeployerNonce: 0n,
    safeSingleton: dependency,
    safeProxyFactory: dependency,
    passkeySignerFactory: dependency,
    passkeySignerVerifier: dependency,
    multiSendCallOnly: dependency,
    passkeySigner: Object.freeze({ name: "passkeySigner" as const, address: a(91), runtimeCodeHash: h(91), bindingHash: h(92), source: "integration test" }),
    dependencies: Object.freeze({
      safeSingleton: dependency,
      safeProxyFactory: dependency,
      passkeySignerFactory: dependency,
      passkeySignerVerifier: dependency,
      multiSendCallOnly: dependency,
    }),
  }));
}

describe("submission transport", () => {
  async function fixture() {
    const [deployer, ecdsaSecondary, recipient, replacement] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const { safe, owners } = await deploySafeFixture(hre, deployer, [passkey.address, ecdsaSecondary.account.address]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const maintenance = await hre.viem.deployContract("GuardReplacementMaintenance", [safe.address, delay.address, ZERO]);
    await deployer.sendTransaction({ to: safe.address, value: 500n });

    const ownerTx = async (to: Address, data: Hex, signer = ecdsaSecondary) => {
      const signature = await signSafeTransaction(safe, signer, to, data);
      await safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    };
    await ownerTx(delay.address, encodeFunctionData({ abi: fn("enableModule", [{ name: "module", type: "address" }]), functionName: "enableModule", args: [safe.address] }));
    await ownerTx(safe.address, encodeFunctionData({ abi: fn("enableModule", [{ name: "module", type: "address" }]), functionName: "enableModule", args: [delay.address] }));
    await ownerTx(guard.address, encodeFunctionData({ abi: fn("setMaintenance", [{ name: "replacementMaintenance", type: "address" }]), functionName: "setMaintenance", args: [maintenance.address] }));
    await ownerTx(safe.address, encodeFunctionData({ abi: fn("setModuleGuard", [{ name: "guard", type: "address" }]), functionName: "setModuleGuard", args: [guard.address] }));
    await ownerTx(guard.address, encodeFunctionData({ abi: fn("setAssetPolicy", [
      { name: "token", type: "address" },
      { name: "basePerTransaction", type: "uint256" },
      { name: "stepUpPerTransaction", type: "uint256" },
      { name: "baseDailyLimit", type: "uint256" },
      { name: "instantDailyLimit", type: "uint256" },
      { name: "recipients", type: "address[]" },
    ]), functionName: "setAssetPolicy", args: [ZERO, 50n, 100n, 50n, 100n, [recipient.account.address]] }));
    await ownerTx(safe.address, encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [guard.address] }));

    const deployments = verifiedDeployments();
    const deploymentsHash = deploymentInfrastructureHash(deployments);
    const policyHash = await guard.read.policyHash();
    const publicClient = await hre.viem.getPublicClient();
    const topology = async (): Promise<TopologyReport> => ({ ok: true, failures: [], checked: ["real Safe/Delay fixture"] });
    const context = (): RelayerContext => ({
      readers: {
        chainId: async () => 31337,
        deployments: async () => deployments,
        topology,
        safeNonce: async () => safe.read.nonce(),
        policyHash: async () => guard.read.policyHash(),
        spendState: async (_guard, token) => {
          const [window, baseSpent, instantSpent] = await guard.read.spendState([token]);
          return { window, baseSpent, instantSpent };
        },
        delayItem: async (_delay, nonce) => {
          const logs = await publicClient.getLogs({ address: delay.address, event: transactionAddedEvent, fromBlock: 0n, toBlock: "latest" });
          const log = logs.find((entry) => entry.args.queueNonce === nonce);
          const txHash = await delay.read.getTxHash([nonce]);
          const createdAt = await delay.read.getTxCreatedAt([nonce]);
          if (!log) return { txHash, createdAt, to: ZERO, value: 0n, data: "0x" as Hex, operation: 0 };
          return {
            txHash,
            createdAt,
            to: getAddress(log.args.to),
            value: log.args.value,
            data: log.args.data,
            operation: log.args.operation,
          };
        },
        delayNonce: async () => delay.read.txNonce(),
        blockTimestamp: async () => BigInt((await publicClient.getBlock()).timestamp),
        receipt: async (hash) => {
          const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => undefined);
          return receipt ? { transactionHash: hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status } : undefined;
        },
      },
      broadcaster: {
        executeSafe: async (target, exactCalldata) => deployer.sendTransaction({ to: target, data: exactCalldata }),
        executeDelay: async (target, exactCalldata) => deployer.sendTransaction({ to: target, data: exactCalldata }),
      },
    });
    const safeRequest = (tx: SafeTxMessage, signatures: Hex, expectedSpend: SafeExecutionRequest["expectedSpend"]): SafeExecutionRequest => ({
      version: 1,
      kind: "safe-execution",
      idempotencyKey: keccak256(tx.data),
      chainId: 31337,
      deploymentsHash,
      policyHash,
      safe: getAddress(safe.address),
      guard: getAddress(guard.address),
      asset: ZERO,
      transaction: tx,
      safeTxHash: hashTypedData({ domain: { chainId: 31337, verifyingContract: getAddress(safe.address) }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: tx }),
      signatures,
      expectedSpend,
    });

    return { deployer, ecdsaSecondary, recipient, replacement, safe, passkey, delay, guard, maintenance, owners, context, safeRequest };
  }

  it("relays passkey base, passkey-plus-secondary step-up, and ready Delay execution without relayer authority", async () => {
    const f = await fixture();
    const relayerIsOwner = (await f.safe.read.getOwners()).some((owner: Address) => owner.toLowerCase() === f.deployer.account.address.toLowerCase());
    expect(relayerIsOwner).to.equal(false);
    expect(await f.safe.read.isModuleEnabled([f.deployer.account.address])).to.equal(false);

    const unauthorizedTransfer = encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [f.recipient.account.address, 1n] });
    const unauthorizedSignature = await signSafeTransaction(f.safe, f.deployer, ZERO, unauthorizedTransfer);
    await expect(f.safe.write.execTransaction([ZERO, 1n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, unauthorizedSignature], { account: f.deployer.account })).to.be.rejected;
    await expect(f.safe.write.execTransactionFromModule([f.recipient.account.address, 1n, "0x", 0], { account: f.deployer.account })).to.be.rejected;
    const freeze = encodeFunctionData({ abi: freezeAbi, functionName: "freeze" });
    await expect(f.safe.write.execTransaction([f.guard.address, 0n, freeze, 0, 0n, 0n, 0n, ZERO, ZERO, unauthorizedSignature], { account: f.deployer.account })).to.be.rejected;
    const repair = encodeFunctionData({ abi: replaceSignerAbi, functionName: "replaceSigner", args: [f.guard.address, 1, f.ecdsaSecondary.account.address, f.replacement.account.address, f.owners[0], 1n, "0x"] });
    await expect(f.safe.write.execTransaction([f.maintenance.address, 0n, repair, 1, 0n, 0n, 0n, ZERO, ZERO, unauthorizedSignature], { account: f.deployer.account })).to.be.rejected;

    const spend = async (): Promise<SafeExecutionRequest["expectedSpend"]> => {
      const [window, baseSpent, instantSpent] = await f.guard.read.spendState([ZERO]);
      return { window, baseSpent, instantSpent };
    };
    const baseTx: SafeTxMessage = { to: getAddress(f.recipient.account.address), value: 40n, data: "0x", operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: await f.safe.read.nonce() };
    const baseResult = await validateAndBroadcast(f.safeRequest(baseTx, passkeySignature(f.passkey.address), await spend()), f.context());
    expect(baseResult.kind).to.be.oneOf(["submitted", "confirmed"]);
    expect((await f.guard.read.spendState([ZERO]))[1]).to.equal(40n);

    const stepTx: SafeTxMessage = { ...baseTx, value: 60n, nonce: await f.safe.read.nonce() };
    const ecdsaSecondarySig = await signSafeTransaction(f.safe, f.ecdsaSecondary, stepTx.to, stepTx.data, { value: stepTx.value, nonce: stepTx.nonce });
    const stepResult = await validateAndBroadcast(f.safeRequest(stepTx, ecdsaSecondaryEnvelope(f.passkey.address, ecdsaSecondarySig), await spend()), f.context());
    expect(stepResult.kind, "reason" in stepResult ? stepResult.reason : stepResult.kind).to.be.oneOf(["submitted", "confirmed"]);
    expect((await f.guard.read.spendState([ZERO]))[2]).to.equal(100n);

    const queueData = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.recipient.account.address, 110n, "0x", 0] });
    const queueTx: SafeTxMessage = { ...baseTx, to: getAddress(f.delay.address), value: 0n, data: queueData, nonce: await f.safe.read.nonce() };
    const queueSig = await signSafeTransaction(f.safe, f.ecdsaSecondary, queueTx.to, queueTx.data, { value: queueTx.value, nonce: queueTx.nonce });
    const queueResult = await validateAndBroadcast(f.safeRequest(queueTx, ecdsaSecondaryEnvelope(f.passkey.address, queueSig), await spend()), f.context());
    expect(queueResult.kind).to.be.oneOf(["submitted", "confirmed"]);
    expect(await f.delay.read.queueNonce()).to.equal(1n);
    await time.increase(10);
    const createdAt = await f.delay.read.getTxCreatedAt([0n]);
    const delayRequest: DelayExecutionRequest = {
      version: 1,
      kind: "delay-execution",
      idempotencyKey: h(55),
      chainId: 31337,
      deploymentsHash: deploymentInfrastructureHash(await f.context().readers.deployments()),
      policyHash: await f.guard.read.policyHash(),
      safe: getAddress(f.safe.address),
      guard: getAddress(f.guard.address),
      delay: getAddress(f.delay.address),
      queueNonce: 0n,
      queueFingerprint: queueFingerprint({ safe: f.safe.address, delay: f.delay.address, to: f.recipient.account.address, value: 110n, data: "0x", operation: 0, queueNonce: 0n }),
      to: getAddress(f.recipient.account.address),
      value: 110n,
      data: "0x",
      operation: 0,
      createdAt,
      cooldownSeconds: 10n,
      expirationSeconds: 60n,
    };
    const delayResult = await validateAndBroadcast(delayRequest, f.context());
    expect(delayResult.kind).to.be.oneOf(["submitted", "confirmed"]);
  });
});
