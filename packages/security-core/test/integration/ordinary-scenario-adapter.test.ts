import { expect } from "chai";
import hre from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { decodeEventLog, encodeFunctionData, getContract, hashTypedData, parseAbi, type Address, type Hex } from "viem";
import factoryArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json";
import verifierArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json";
import { createAutomatedCredential, signWebAuthn } from "../../scripts/live/webauthn";
import { createPasskeySignerCore } from "../../src/signers/passkey-core";
import { createEip1193SecondarySigner } from "../../src/signers/eip1193";
import { encodeGuardSafeSignatures } from "../../src/signers/guard-signatures";
import { SAFE_TX_TYPES, type SafeSignerRequest } from "../../src/signers/types";
import { createFrozenSafeSignerProvider, requireSixConfirmationReceipts, simulatePreparedOrdinaryAction } from "../../scripts/live/ordinary-scenario-adapter";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SUCCESS = parseAbi(["event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)"]);

async function deployRealPasskey() {
  const [wallet] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const deploy = async (artifact: { abi: readonly unknown[]; bytecode: Hex }) => {
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
    return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const verifier = await deploy(verifierArtifact as never);
  const factoryAddress = await deploy(factoryArtifact as never);
  const factory = getContract({ address: factoryAddress, abi: parseAbi(["function createSigner(uint256,uint256,uint176) returns (address)", "function getSigner(uint256,uint256,uint176) view returns (address)"]), client: { public: publicClient, wallet } });
  const credential = createAutomatedCredential();
  const args = [credential.x, credential.y, BigInt(verifier)] as const;
  await factory.write.createSigner(args);
  return { credential, address: await factory.read.getSigner(args) as Address };
}

describe("ordinary scenario adapter against real local Safe/WebAuthn", () => {
  it("encodes both secondary paths, estimates exact signed calldata, and confirms the canonical Safe effect at six blocks", async () => {
    const [payer, ecdsa, recipient] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();
    const primary = await deployRealPasskey();
    const contractSecondary = await deployRealPasskey();
    const singleton = await hre.viem.deployContract("Safe");
    const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]);
    const safe = await hre.viem.getContractAt("Safe", proxy.address);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 120n, 600n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, primary.address, ecdsa.account.address, delay.address, 86400n, 0n]]);
    const maintenance = await hre.viem.deployContract("GuardReplacementMaintenance", [safe.address, delay.address, ZERO]);
    const helper = await hre.viem.deployContract("SafeAtomicSetupHelper");
    const setup = encodeFunctionData({ abi: helper.abi, functionName: "setup", args: [{ guard: guard.address, delay: delay.address, maintenance: maintenance.address, passkey: primary.address, safeContractSecondary: contractSecondary.address, ecdsaSecondary: ecdsa.account.address, periodSeconds: 86400n, periodAnchor: 0n, assets: [{ token: ZERO, basePerTransaction: 10n, stepUpPerTransaction: 30n, baseDailyLimit: 10n, instantDailyLimit: 30n, recipients: [recipient.account.address] }] }] });
    await safe.write.setup([[primary.address], 1n, helper.address, setup, ZERO, ZERO, 0n, ZERO]);
    await payer.sendTransaction({ to: safe.address, value: 100n });

    const provider = { request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
      if (method === "eth_chainId") return "0x7a69";
      if (method === "eth_call") { const call = params?.[0] as { to: Address; data: Hex }; return (await publicClient.call(call)).data ?? "0x"; }
      throw new Error("unsupported test provider method");
    } };
    const signer = (value: typeof primary, role: "primary" | "secondary") => createPasskeySignerCore({ address: value.address, verifierAddress: value.address, chainId: 31337, role, provider, sign: async request => signWebAuthn(value.credential, request.safeTxHash) });
    const request = async (value: bigint): Promise<SafeSignerRequest> => {
      const message = { to: recipient.account.address, value, data: "0x" as Hex, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: await safe.read.nonce() };
      const typedData = { domain: { chainId: 31337, verifyingContract: safe.address }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx" as const, message };
      return { chainId: 31337, safe: safe.address, safeTxHash: hashTypedData(typedData), typedData };
    };
    const execute = async (value: bigint, signatures: Hex) => encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [recipient.account.address, value, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, signatures] });

    const contractRequest = await request(11n);
    const contractSignatures = await encodeGuardSafeSignatures(contractRequest, signer(primary, "primary"), signer(contractSecondary, "secondary"));
    const contractData = await execute(11n, contractSignatures);
    await publicClient.call({ account: payer.account, to: safe.address, data: contractData });

    const ecdsaRequest = await request(11n);
    const frozen = createFrozenSafeSignerProvider({ account: ecdsa.account.address, request: ecdsaRequest, signTypedData: value => ecdsa.signTypedData(value.typedData as never) });
    const signatures = await encodeGuardSafeSignatures(ecdsaRequest, signer(primary, "primary"), createEip1193SecondarySigner({ provider: frozen, account: ecdsa.account.address }));
    const data = await execute(11n, signatures);
    const block = await publicClient.getBlock();
    const prepared = { liveIntent: { id: "local-step-up", to: safe.address, value: 0n, data, nonce: 0, gas: 2_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }, requestHash: ecdsaRequest.safeTxHash, signerRolesHash: ecdsaRequest.safeTxHash, signedCalldataHash: ecdsaRequest.safeTxHash, signatureBundleHash: ecdsaRequest.safeTxHash, transientSignedCalldata: data } as const;
    const simulation = await simulatePreparedOrdinaryAction({ call: async input => (await publicClient.call({ account: input.from, to: input.to, value: input.value, data: input.data, blockNumber: input.blockNumber })).data ?? "0x", estimateGas: input => publicClient.estimateGas({ account: input.from, to: input.to, value: input.value, data: input.data, blockNumber: input.blockNumber }), blockHash: async number => (await publicClient.getBlock({ blockNumber: number })).hash! }, payer.account.address, prepared, block.number!, block.hash!, 2_000_000n);
    expect(simulation.gasEstimate < 2_000_000n).to.equal(true);
    const hash = await payer.sendTransaction({ to: safe.address, data, gas: 2_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const wrapped = requireSixConfirmationReceipts({ funder: payer.account.address, chainId: async () => 31337, nonce: async () => 0, balance: async () => 0n, sign: async () => { throw new Error("unused"); }, broadcast: async () => { throw new Error("unused"); }, receipt: async transactionHash => transactionHash === hash ? { transactionHash: hash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash } : undefined }, { blockNumber: publicClient.getBlockNumber, blockHash: async number => (await publicClient.getBlock({ blockNumber: number })).hash! });
    expect(await wrapped.receipt(hash)).to.equal(undefined);
    await mine(5);
    expect((await wrapped.receipt(hash))?.blockHash).to.equal(receipt.blockHash);
    const success = receipt.logs.flatMap(log => { try { const decoded = decodeEventLog({ abi: SUCCESS, data: log.data, topics: log.topics }); return decoded.eventName === "ExecutionSuccess" ? [decoded.args.txHash] : []; } catch { return []; } });
    expect(success).to.deep.equal([ecdsaRequest.safeTxHash]);
    expect(await publicClient.getBalance({ address: recipient.account.address }) > 0n).to.equal(true);
  });
});
