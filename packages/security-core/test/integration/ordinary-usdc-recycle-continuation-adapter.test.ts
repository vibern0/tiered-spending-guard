import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, getContract, hashTypedData, keccak256, parseAbi, type Address, type Hex } from "viem";
import factoryArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json";
import verifierArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json";
import { createAutomatedCredential, signWebAuthn } from "../../scripts/live/webauthn";
import { createPasskeySignerCore } from "../../src/signers/passkey-core";
import { createEip1193SecondarySigner } from "../../src/signers/eip1193";
import { SAFE_TX_TYPES } from "../../src/signers/types";
import {
  createUsdcRecycleContinuationExecutionView,
} from "../../scripts/live/ordinary-scenario-executor";
import { createFrozenSafeSignerProvider, createOrdinaryScenarioMechanicalExecutionContext } from "../../scripts/live/ordinary-scenario-adapter";
import {
  cleanupUsdcRecycleContinuationFixtures,
  createApprovedUsdcRecycleContinuation,
} from "../support/usdc-recycle-continuation-fixture";

describe("ordinary USDC recycle continuation adapter", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  it("requires exact canonical ISO observer bounds for the new execution view", async function () {
    const f = await createApprovedUsdcRecycleContinuation();
    const view = createUsdcRecycleContinuationExecutionView(f.source, f.proposal, f.approval);
    const base = { expectedChainId: 11_155_111, proposal: view, journal: () => f.journal, currentClient: {}, archiveClient: {}, observerReadiness: async () => ({ ready: true, evidenceHash: f.proposal.observer.probeEvidenceHash }), verifyProfileAtBlock: async () => undefined, live: {}, loadSigners: async () => { throw new Error("unused"); } };
    const readyAt = new Date(Number(BigInt(f.proposal.observer.readyAt) * 1000n)).toISOString();
    const expiresAt = new Date(Number(BigInt(f.proposal.observer.expiresAt) * 1000n)).toISOString();
    expect(() => createOrdinaryScenarioMechanicalExecutionContext(base as never, (async () => { throw new Error("unused"); }) as never)).to.throw(/observer ready and expiry forwarding/i);
    expect(() => createOrdinaryScenarioMechanicalExecutionContext({ ...base, receiverReadyAt: readyAt, receiverExpiresAt: expiresAt } as never, (async () => { throw new Error("unused"); }) as never)).not.to.throw();
    expect(() => createOrdinaryScenarioMechanicalExecutionContext({ ...base, receiverReadyAt: f.proposal.observer.readyAt, receiverExpiresAt: f.proposal.observer.expiresAt } as never, (async () => { throw new Error("unused"); }) as never)).to.throw(/observer ready and expiry forwarding/i);
  });

  it("executes real 31337 WebAuthn transfer, cancellation, expiry, and ready branches", async function () {
    const ZERO = "0x0000000000000000000000000000000000000000" as Address;
    const [payer, ecdsa, recipient] = await hre.viem.getWalletClients(); const client = await hre.viem.getPublicClient();
    const deploy = async (artifact: { abi: readonly unknown[]; bytecode: Hex }) => (await client.waitForTransactionReceipt({ hash: await payer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode }) })).contractAddress!;
    const verifier = await deploy(verifierArtifact as never); const factoryAddress = await deploy(factoryArtifact as never); const factory = getContract({ address: factoryAddress, abi: parseAbi(["function createSigner(uint256,uint256,uint176) returns (address)", "function getSigner(uint256,uint256,uint176) view returns (address)"]), client: { public: client, wallet: payer } });
    const createSigner = async () => { const credential = createAutomatedCredential(); const args = [credential.x, credential.y, BigInt(verifier)] as const; await factory.write.createSigner(args); return { credential, address: await factory.read.getSigner(args) as Address }; };
    const primarySigner = await createSigner(); const secondarySigner = await createSigner(); const primary = primarySigner.address;
    const singleton = await hre.viem.deployContract("Safe"); const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]); const safe = await hre.viem.getContractAt("Safe", proxy.address); const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 120n, 600n]); const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, primary, ecdsa.account.address, delay.address, 86400n, 0n]]); const maintenance = await hre.viem.deployContract("GuardReplacementMaintenance", [safe.address, delay.address, ZERO]); const helper = await hre.viem.deployContract("SafeAtomicSetupHelper"); const token = await hre.viem.deployContract("ERC20Mock", [payer.account.address, 200n]);
    const setup = encodeFunctionData({ abi: helper.abi, functionName: "setup", args: [{ guard: guard.address, delay: delay.address, maintenance: maintenance.address, passkey: primary, safeContractSecondary: secondarySigner.address, ecdsaSecondary: ecdsa.account.address, periodSeconds: 86400n, periodAnchor: 0n, assets: [{ token: token.address, basePerTransaction: 10n, stepUpPerTransaction: 30n, baseDailyLimit: 10n, instantDailyLimit: 30n, recipients: [recipient.account.address] }] }] });
    await safe.write.setup([[primary], 1n, helper.address, setup, ZERO, ZERO, 0n, ZERO]); await token.write.transfer([safe.address, 100n]);
    const provider = { request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => { if (method === "eth_chainId") return "0x7a69"; if (method === "eth_call") return (await client.call(params?.[0] as never)).data ?? "0x"; throw new Error("unsupported"); } };
    const passkey = (signer: typeof primarySigner, role: "primary" | "secondary") => createPasskeySignerCore({ address: signer.address, verifierAddress: signer.address, chainId: 31337, role, provider, sign: async request => signWebAuthn(signer.credential, request.safeTxHash) });
    const safeSubmit = async (id: string, kind: "base-transfer" | "queue-proposal" | "queue-cancellation", to: Address, data: Hex, secondary?: "contract" | "ecdsa") => {
      const message = { to, value: 0n, data, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: await safe.read.nonce() }; const typedData = { domain: { chainId: 31337, verifyingContract: safe.address }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx" as const, message }; const safeTxHash = hashTypedData(typedData);
      const action = { id, kind, asset: "USDC", expectedOutcome: "success", signerRoles: secondary === "contract" ? ["primary-passkey", "safe-contract-secondary"] : secondary === "ecdsa" ? ["primary-passkey", "legacy-ecdsa-secondary"] : ["primary-passkey"], dependsOn: [], commitment: safeTxHash, gasLimitCap: 2_000_000n, maxFeePerGasCap: 100_000_000_000n, maxPriorityFeePerGasCap: 10_000_000_000n, safeTxHash, safeTransaction: { ...message, safeNonce: message.nonce, safeTxHash } };
      const proposal = { chainId: 31337, safe: safe.address, guard: guard.address, delay: delay.address, funder: payer.account.address, usdc: token.address, primarySigner: primary, safeContractSecondary: secondarySigner.address, ecdsaSecondary: ecdsa.account.address, topologyEvidenceHash: safeTxHash, planHash: safeTxHash, actions: [action] };
      const context = createOrdinaryScenarioMechanicalExecutionContext({ expectedChainId: 31337, proposal, journal: () => ({ actions: [] }), currentClient: client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: safeTxHash }), live: {}, loadSigners: async () => ({ primary: passkey(primarySigner, "primary"), ...(secondary === "contract" ? { secondary: passkey(secondarySigner, "secondary") } : secondary === "ecdsa" ? { secondary: createEip1193SecondarySigner({ account: ecdsa.account.address, provider: createFrozenSafeSignerProvider({ account: ecdsa.account.address, request: { chainId: 31337, safe: safe.address, safeTxHash, typedData }, signTypedData: request => ecdsa.signTypedData(request.typedData as never) }) }) } : {}) }) } as never, (async () => { throw new Error("state reader unused during materialization"); }) as never);
      const prepared = await context.materialize(action as never, { outerNonce: 0, fees: { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }, nativeSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n }, usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n } } as never);
      return client.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: safe.address, data: prepared.liveIntent.data }) });
    };
    let delayedTransfer = "0x" as Hex;
    const publicDelay = async (id: string, kind: "queue-expiry" | "ready-delay-execution", data: Hex, queueNonce: bigint, fingerprint: Hex) => {
      const action = { id, kind, asset: "USDC", expectedOutcome: "success", signerRoles: [], dependsOn: [], commitment: keccak256(data), gasLimitCap: 300_000n, maxFeePerGasCap: 100_000_000_000n, maxPriorityFeePerGasCap: 10_000_000_000n, publicTransaction: { to: delay.address, value: 0n, data }, queue: { queueNonce, fingerprint, monitoringFingerprint: fingerprint, to: token.address, value: 0n, data: delayedTransfer, operation: 0 } };
      const proposal = { chainId: 31337, safe: safe.address, guard: guard.address, delay: delay.address, funder: payer.account.address, usdc: token.address, primarySigner: primary, safeContractSecondary: secondarySigner.address, ecdsaSecondary: ecdsa.account.address, topologyEvidenceHash: action.commitment, planHash: action.commitment, actions: [action] };
      const context = createOrdinaryScenarioMechanicalExecutionContext({ expectedChainId: 31337, proposal, journal: () => ({ actions: [] }), currentClient: client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: action.commitment }), live: {}, loadSigners: async () => { throw new Error("public Delay lifecycle must remain keyless"); } } as never, (async () => { throw new Error("state reader unused during materialization"); }) as never);
      const prepared = await context.materialize(action as never, { outerNonce: 0, fees: { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }, nativeSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n }, usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n } } as never);
      return client.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: prepared.liveIntent.to, value: prepared.liveIntent.value, data: prepared.liveIntent.data }) });
    };
    const transfer = encodeFunctionData({ abi: token.abi, functionName: "transfer", args: [recipient.account.address, 10n] }); expect((await safeSubmit("usdc-recycle-continuation-base-mechanics", "base-transfer", token.address, transfer)).status).to.equal("success");
    delayedTransfer = encodeFunctionData({ abi: token.abi, functionName: "transfer", args: [recipient.account.address, 31n] }); const queue = encodeFunctionData({ abi: delay.abi, functionName: "execTransactionFromModule", args: [token.address, 0n, delayedTransfer, 0] });
    expect((await safeSubmit("usdc-recycle-continuation-queue-cancel", "queue-proposal", delay.address, queue, "contract")).status).to.equal("success"); const cancel = encodeFunctionData({ abi: delay.abi, functionName: "setTxNonce", args: [1n] }); expect((await safeSubmit("usdc-recycle-continuation-queue-cancel-action", "queue-cancellation", delay.address, cancel, "ecdsa")).status).to.equal("success");
    expect((await safeSubmit("usdc-recycle-continuation-queue-expiry", "queue-proposal", delay.address, queue, "contract")).status).to.equal("success"); const expiryFingerprint = await delay.read.getTxHash([1n]); await hre.network.provider.send("evm_increaseTime", [721]); await hre.network.provider.send("evm_mine"); const skip = encodeFunctionData({ abi: delay.abi, functionName: "skipExpired" }); expect((await publicDelay("usdc-recycle-continuation-queue-expiry-skip", "queue-expiry", skip, 1n, expiryFingerprint)).status).to.equal("success");
    expect((await safeSubmit("usdc-recycle-continuation-queue-execute", "queue-proposal", delay.address, queue, "contract")).status).to.equal("success"); const readyFingerprint = await delay.read.getTxHash([2n]); await hre.network.provider.send("evm_increaseTime", [121]); await hre.network.provider.send("evm_mine"); const execute = encodeFunctionData({ abi: delay.abi, functionName: "executeNextTx", args: [token.address, 0n, delayedTransfer, 0] }); expect((await publicDelay("usdc-recycle-continuation-queue-ready-execute", "ready-delay-execution", execute, 2n, readyFingerprint)).status).to.equal("success");
    expect(await delay.read.txNonce()).to.equal(3n); expect(await token.read.balanceOf([recipient.account.address])).to.equal(41n);
  });
});
