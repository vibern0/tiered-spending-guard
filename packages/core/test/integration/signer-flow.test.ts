import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, hashTypedData, toFunctionSelector, type Address, type Hex } from "viem";
import { createEip1193SecondarySigner } from "../../../sdk/src/signers/eip1193";
import { createTestPasskeySigner } from "../helpers/passkey";
import { assertVaultSignerPair, type Eip1193Provider, type SafeSignerRequest, SAFE_TX_TYPES } from "../../../sdk/src/signers/types";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const guardPolicyAbi = [{ name: "setAssetPolicy", type: "function", stateMutability: "nonpayable", inputs: [
  { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" },
  { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
], outputs: [] }] as const;
const transferAbi = [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const queueAbi = [{ name: "execTransactionFromModule", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" }], outputs: [] }] as const;
const enableAbi = [{ name: "enableModule", type: "function", stateMutability: "nonpayable", inputs: [{ name: "module", type: "address" }], outputs: [] }] as const;
const setGuardAbi = [{ name: "setGuard", type: "function", stateMutability: "nonpayable", inputs: [{ name: "guard", type: "address" }], outputs: [] }] as const;
const setModuleGuardAbi = [{ name: "setModuleGuard", type: "function", stateMutability: "nonpayable", inputs: [{ name: "guard", type: "address" }], outputs: [] }] as const;

function walletProvider(wallet: any, publicClient: any): Eip1193Provider {
  return { request: async ({ method, params }) => {
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_accounts") return [wallet.account.address];
    if (method === "eth_signTypedData_v4") return wallet.signTypedData(JSON.parse(String((params as unknown[])[1])));
    if (method === "eth_call") return publicClient.request({ method, params });
    throw new Error(`unsupported method ${method}`);
  }};
}

describe("provider-neutral signer flow against Safe 1.5 and TieredSpendingGuard", () => {
  it("accepts passkey base, requires a secondary for step-up, queues delayed action, and rejects EOA-only paths", async () => {
    const [deployer, ecdsaSecondaryWallet, arbitraryWallet, recipient] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();
    const singleton = await hre.viem.deployContract("Safe");
    const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]);
    const safe = await hre.viem.getContractAt("Safe", proxy.address);
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    // Test-only ERC-1271 mock; this is not a WebAuthn implementation or deployment evidence.
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondaryWallet.account.address, delay.address, 86400n, 0n]]);
    await safe.write.setup([[passkey.address, ecdsaSecondaryWallet.account.address].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), 1n, ZERO, "0x", ZERO, ZERO, 0n, ZERO], { account: deployer.account });
    await deployer.sendTransaction({ to: safe.address, value: 500n });
    const provider = (wallet: typeof ecdsaSecondaryWallet) => walletProvider(wallet as never, publicClient);
    const passkeySigner = createTestPasskeySigner({ address: passkey.address, verifierAddress: passkey.address, chainId: 31337, provider: provider(deployer), sign: async () => "0x" });
    const ecdsaSecondary = createEip1193SecondarySigner({ provider: provider(ecdsaSecondaryWallet), account: ecdsaSecondaryWallet.account.address });
    assertVaultSignerPair(passkeySigner, ecdsaSecondary);
    expect(() => assertVaultSignerPair(ecdsaSecondary, passkeySigner)).to.throw("primary");
    const buildRequest = async (to: Address, value: bigint, data: Hex, providedNonce?: bigint): Promise<SafeSignerRequest> => {
      const nonce = providedNonce ?? await safe.read.nonce();
      const typedData = { domain: { chainId: 31337, verifyingContract: safe.address }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx" as const, message: { to, value, data, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce } };
      return { chainId: 31337, safe: safe.address, safeTxHash: await safe.read.getTransactionHash([to, value, data, 0, 0n, 0n, 0n, ZERO, ZERO, nonce]), typedData };
    };
    const execute = async (to: Address, value: bigint, data: Hex, signatures: Hex) => safe.write.execTransaction([to, value, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures], { account: deployer.account });
    const ownerCall = async (to: Address, data: Hex) => { const req = await buildRequest(to, 0n, data); await execute(to, 0n, data, await ecdsaSecondaryWallet.signTypedData(req.typedData)); };

    await ownerCall(guard.address, encodeFunctionData({ abi: guardPolicyAbi, functionName: "setAssetPolicy", args: [ZERO, 50n, 100n, 50n, 150n, [recipient.account.address]] }));
    await ownerCall(delay.address, encodeFunctionData({ abi: enableAbi, functionName: "enableModule", args: [safe.address] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: enableAbi, functionName: "enableModule", args: [delay.address] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: setModuleGuardAbi, functionName: "setModuleGuard", args: [guard.address] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: setGuardAbi, functionName: "setGuard", args: [guard.address] }));

    const baseData = "0x" as Hex;
    const baseRequest = await buildRequest(recipient.account.address, 40n, baseData);
    const baseSignature = await passkeySigner.sign(baseRequest);
    await execute(recipient.account.address, 40n, baseData, baseSignature);
    expect((await guard.read.spendState([ZERO]))[2]).to.equal(40n);

    const stepData = "0x" as Hex;
    const stepRequest = await buildRequest(recipient.account.address, 80n, stepData);
    await expect(execute(recipient.account.address, 80n, stepData, await passkeySigner.sign(stepRequest))).to.be.rejected;
    assertVaultSignerPair(passkeySigner, ecdsaSecondary);
    const stepSignature = `${await passkeySigner.sign(stepRequest)}${(await ecdsaSecondary.sign(stepRequest)).slice(2)}` as Hex;
    await execute(recipient.account.address, 80n, stepData, stepSignature);
    expect((await guard.read.spendState([ZERO]))[2]).to.equal(120n);

    const delayedData = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [recipient.account.address, 160n, "0x", 0] });
    const delayedRequest = await buildRequest(delay.address, 0n, delayedData);
    assertVaultSignerPair(passkeySigner, ecdsaSecondary);
    await execute(delay.address, 0n, delayedData, `${await passkeySigner.sign(delayedRequest)}${(await ecdsaSecondary.sign(delayedRequest)).slice(2)}` as Hex);
    expect(await delay.read.queueNonce()).to.equal(1n);

    await expect(delay.write.executeNextTx([recipient.account.address, 160n, "0x", 0], { account: deployer.account })).to.be.rejectedWith("cooldown");
    await hre.network.provider.send("evm_increaseTime", [10]);
    await hre.network.provider.send("evm_mine");
    await delay.write.executeNextTx([recipient.account.address, 160n, "0x", 0], { account: deployer.account });
    expect(await delay.read.txNonce()).to.equal(1n);

    const secondDelayedData = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [recipient.account.address, 170n, "0x", 0] });
    const secondDelayedRequest = await buildRequest(delay.address, 0n, secondDelayedData);
    assertVaultSignerPair(passkeySigner, ecdsaSecondary);
    await execute(delay.address, 0n, secondDelayedData, `${await passkeySigner.sign(secondDelayedRequest)}${(await ecdsaSecondary.sign(secondDelayedRequest)).slice(2)}` as Hex);
    const invalidateRequest = await buildRequest(delay.address, 0n, encodeFunctionData({ abi: [{ name: "setTxNonce", type: "function", stateMutability: "nonpayable", inputs: [{ name: "nonce", type: "uint256" }], outputs: [] }] as const, functionName: "setTxNonce", args: [2n] }));
    assertVaultSignerPair(passkeySigner, ecdsaSecondary);
    await execute(delay.address, 0n, invalidateRequest.typedData.message.data, `${await passkeySigner.sign(invalidateRequest)}${(await ecdsaSecondary.sign(invalidateRequest)).slice(2)}` as Hex);
    expect(await delay.read.txNonce()).to.equal(2n);
    await expect(delay.write.executeNextTx([recipient.account.address, 170n, "0x", 0])).to.be.rejectedWith("empty");

    const repairData = encodeFunctionData({ abi: guardPolicyAbi, functionName: "setAssetPolicy", args: [passkey.address, 40n, 90n, 40n, 140n, [recipient.account.address, ecdsaSecondaryWallet.account.address]] });
    const repairRequest = await buildRequest(guard.address, 0n, repairData);
    await expect(execute(guard.address, 0n, repairData, await ecdsaSecondaryWallet.signTypedData(repairRequest.typedData))).to.be.rejected;
    expect((await guard.read.assetPolicy([passkey.address]))[3]).to.equal(0n);
    expect(await guard.read.allowedRecipient([passkey.address, ecdsaSecondaryWallet.account.address])).to.equal(false);

    const arbitraryTransfer = await buildRequest(recipient.account.address, 1n, "0x");
    await expect(execute(recipient.account.address, 1n, "0x", await arbitraryWallet.signTypedData(arbitraryTransfer.typedData))).to.be.rejected;

    const freezeData = toFunctionSelector("freeze()") as Hex;
    const freezeRequest = await buildRequest(guard.address, 0n, freezeData);
    await expect(execute(guard.address, 0n, freezeData, await passkeySigner.sign(freezeRequest))).to.be.rejected;
    assertVaultSignerPair(passkeySigner, ecdsaSecondary);
    await execute(guard.address, 0n, freezeData, `${await passkeySigner.sign(freezeRequest)}${(await ecdsaSecondary.sign(freezeRequest)).slice(2)}` as Hex);
    expect(await guard.read.frozen()).to.equal(true);
  });
});
