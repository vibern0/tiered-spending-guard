import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, getContract, hashTypedData, parseAbi, type Address, type Hex } from "viem";
import factoryArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json";
import verifierArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json";
import { createAutomatedCredential, signWebAuthn } from "../../scripts/live/webauthn";
import { createPasskeySignerCore } from "../../src/signers/passkey-core";
import { encodeGuardSafeSignatures } from "../../src/signers/guard-signatures";
import { SAFE_TX_TYPES } from "../../src/signers/types";
import { createOrdinaryScenarioMechanicalExecutionContext } from "../../scripts/live/ordinary-scenario-adapter";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

describe("ordinary USDC successor real adapter boundary", function () {
  it("executes real WebAuthn-authorized USDC base and queues the delayed successor path through Safe and Delay", async function () {
    const [payer, ecdsa, recipient] = await hre.viem.getWalletClients(); const client = await hre.viem.getPublicClient();
    const deploy = async (artifact: { abi: readonly unknown[]; bytecode: Hex }) => (await client.waitForTransactionReceipt({ hash: await payer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode }) })).contractAddress!;
    const verifier = await deploy(verifierArtifact as never); const factoryAddress = await deploy(factoryArtifact as never); const factory = getContract({ address: factoryAddress, abi: parseAbi(["function createSigner(uint256,uint256,uint176) returns (address)", "function getSigner(uint256,uint256,uint176) view returns (address)"]), client: { public: client, wallet: payer } });
    const createSigner = async () => { const credential = createAutomatedCredential(); const args = [credential.x, credential.y, BigInt(verifier)] as const; await factory.write.createSigner(args); return { credential, address: await factory.read.getSigner(args) as Address }; };
    const primarySigner = await createSigner(); const secondarySigner = await createSigner(); const primary = primarySigner.address;
    const singleton = await hre.viem.deployContract("Safe"); const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]); const safe = await hre.viem.getContractAt("Safe", proxy.address); const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 120n, 600n]); const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, primary, ecdsa.account.address, delay.address, 86400n, 0n]]); const maintenance = await hre.viem.deployContract("GuardReplacementMaintenance", [safe.address, delay.address, ZERO]); const helper = await hre.viem.deployContract("SafeAtomicSetupHelper"); const token = await hre.viem.deployContract("ERC20Mock", [payer.account.address, 100n]);
    const setup = encodeFunctionData({ abi: helper.abi, functionName: "setup", args: [{ guard: guard.address, delay: delay.address, maintenance: maintenance.address, passkey: primary, safeContractSecondary: secondarySigner.address, ecdsaSecondary: ecdsa.account.address, periodSeconds: 86400n, periodAnchor: 0n, assets: [{ token: token.address, basePerTransaction: 10n, stepUpPerTransaction: 30n, baseDailyLimit: 10n, instantDailyLimit: 30n, recipients: [recipient.account.address] }] }] });
    await safe.write.setup([[primary], 1n, helper.address, setup, ZERO, ZERO, 0n, ZERO]); await token.write.transfer([safe.address, 20n]);
    const provider = { request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => { if (method === "eth_chainId") return "0x7a69"; if (method === "eth_call") return (await client.call(params?.[0] as never)).data ?? "0x"; throw new Error("unsupported"); } };
    const passkey = (signer: typeof primarySigner, role: "primary" | "secondary") => createPasskeySignerCore({ address: signer.address, verifierAddress: signer.address, chainId: 31337, role, provider, sign: async request => signWebAuthn(signer.credential, request.safeTxHash) });
    const submit = async (to: Address, data: Hex, secondary = false) => {
      const message = { to, value: 0n, data, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: await safe.read.nonce() }; const typedData = { domain: { chainId: 31337, verifyingContract: safe.address }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx" as const, message }; const safeTxHash = hashTypedData(typedData); const localHash = safeTxHash;
      const action = { id: secondary ? "usdc-successor-queue-execute" : "usdc-successor-base-x", kind: secondary ? "queue-proposal" : "base-transfer", asset: "USDC", expectedOutcome: "success", signerRoles: secondary ? ["primary-passkey", "safe-contract-secondary"] : ["primary-passkey"], dependsOn: [], commitment: localHash, gasLimitCap: 2_000_000n, maxFeePerGasCap: 100_000_000_000n, maxPriorityFeePerGasCap: 10_000_000_000n, safeTxHash, safeTransaction: { ...message, safeNonce: message.nonce, safeTxHash } };
      const proposal = { chainId: 31337, safe: safe.address, guard: guard.address, delay: delay.address, funder: payer.account.address, usdc: token.address, primarySigner: primary, safeContractSecondary: secondarySigner.address, ecdsaSecondary: ecdsa.account.address, topologyEvidenceHash: localHash, planHash: localHash, actions: [action] };
      const context = createOrdinaryScenarioMechanicalExecutionContext({ expectedChainId: 31337, proposal, journal: () => ({ actions: [] }), currentClient: client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: localHash }), live: {}, loadSigners: async () => ({ primary: passkey(primarySigner, "primary"), ...(secondary ? { secondary: passkey(secondarySigner, "secondary") } : {}) }) } as never, (async () => { throw new Error("state reader unused during materialization"); }) as never);
      const prepared = await context.materialize(action as never, { outerNonce: 0, fees: { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }, nativeSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n }, usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n } } as never);
      return client.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: safe.address, data: prepared.liveIntent.data }) });
    };
    const transfer = encodeFunctionData({ abi: token.abi, functionName: "transfer", args: [recipient.account.address, 10n] }); expect((await submit(token.address, transfer)).status).to.equal("success"); expect(await token.read.balanceOf([recipient.account.address])).to.equal(10n);
    const delayedTransfer = encodeFunctionData({ abi: token.abi, functionName: "transfer", args: [recipient.account.address, 21n] }); const queue = encodeFunctionData({ abi: delay.abi, functionName: "execTransactionFromModule", args: [token.address, 0n, delayedTransfer, 0] }); expect((await submit(delay.address, queue, true)).status).to.equal("success"); expect(await delay.read.queueNonce()).to.equal(1n);
  });
});
