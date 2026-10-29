import { expect } from "chai";
import hre from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeEventLog, encodeFunctionData, getContract, hashTypedData, keccak256, parseAbi, type Address, type Hex } from "viem";
import factoryArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json";
import verifierArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json";
import { createAutomatedCredential, signWebAuthn } from "../../scripts/live/webauthn";
import { createPasskeySignerCore } from "../../src/signers/passkey-core";
import { createEip1193SecondarySigner } from "../../src/signers/eip1193";
import { encodeGuardSafeSignatures } from "../../src/signers/guard-signatures";
import { SAFE_TX_TYPES, type SafeSignerRequest } from "../../src/signers/types";
import { createFrozenSafeSignerProvider, createOrdinaryScenarioExecutionContext, createOrdinaryScenarioMechanicalExecutionContext, createOrdinaryScenarioMechanicalStateReader, createOrdinaryScenarioStateReader, requireSixConfirmationReceipts, simulatePreparedOrdinaryAction } from "../../scripts/live/ordinary-scenario-adapter";
import type { OrdinaryScenarioActionScope, OrdinaryScenarioJournal, OrdinaryScenarioProposal } from "../../scripts/live/ordinary-scenario-executor";
import { ActivityLedger, FileActivityStore } from "../../src/monitoring/ledger";
import { queueFingerprint, queueMonitoringFingerprint } from "../../src/queue/delay";
import { publicAlertPayloadHash } from "../../src/monitoring/notifier";

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
  it("exposes one honest-chain mechanical core delegated to by the production adapter", () => {
    expect(createOrdinaryScenarioMechanicalStateReader).to.be.a("function");
    expect(createOrdinaryScenarioMechanicalExecutionContext).to.be.a("function");
  });
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
    const simulation = await simulatePreparedOrdinaryAction({ call: async input => (await publicClient.call({ account: input.from, to: input.to, value: input.value, data: input.data, blockNumber: input.blockNumber })).data ?? "0x", estimateGas: input => publicClient.estimateGas({ account: input.from, to: input.to, value: input.value, data: input.data, blockNumber: input.blockNumber }), blockHash: async number => (await publicClient.getBlock({ blockNumber: number })).hash! }, payer.account.address, prepared, block.number!, block.hash!, 2_000_000n, "bool-true");
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

  it("runs pinned state, archive rejection, confirmation, recovery, and restarted evidence through the real mechanical callbacks", async () => {
    const [payer, ecdsa, recipient] = await hre.viem.getWalletClients();
    const client = await hre.viem.getPublicClient();
    const primary = await deployRealPasskey(); const secondary = await deployRealPasskey();
    const singleton = await hre.viem.deployContract("Safe"); const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]); const safe = await hre.viem.getContractAt("Safe", proxy.address);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 120n, 600n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, primary.address, ecdsa.account.address, delay.address, 86400n, 0n]]);
    const maintenance = await hre.viem.deployContract("GuardReplacementMaintenance", [safe.address, delay.address, ZERO]); const helper = await hre.viem.deployContract("SafeAtomicSetupHelper"); const token = await hre.viem.deployContract("ERC20Mock", [payer.account.address, 1_000n]);
    const assets = [ZERO, token.address].map(tokenAddress => ({ token: tokenAddress, basePerTransaction: 10n, stepUpPerTransaction: 30n, baseDailyLimit: 10n, instantDailyLimit: 30n, recipients: [recipient.account.address] }));
    const setup = encodeFunctionData({ abi: helper.abi, functionName: "setup", args: [{ guard: guard.address, delay: delay.address, maintenance: maintenance.address, passkey: primary.address, safeContractSecondary: secondary.address, ecdsaSecondary: ecdsa.account.address, periodSeconds: 86400n, periodAnchor: 0n, assets }] });
    await safe.write.setup([[primary.address], 1n, helper.address, setup, ZERO, ZERO, 0n, ZERO]); await payer.sendTransaction({ to: safe.address, value: 100n });
    const provider = { request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => { if (method === "eth_chainId") return "0x7a69"; if (method === "eth_call") { const call = params?.[0] as { to: Address; data: Hex }; return (await client.call(call)).data ?? "0x"; } throw new Error("unsupported test provider method"); } };
    const signer = (value: typeof primary, role: "primary" | "secondary") => createPasskeySignerCore({ address: value.address, verifierAddress: value.address, chainId: 31337, role, provider, sign: async request => signWebAuthn(value.credential, request.safeTxHash) });
    const safeRequest = async (to: Address, value: bigint, data: Hex): Promise<SafeSignerRequest> => { const message = { to, value, data, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: await safe.read.nonce() }; const typedData = { domain: { chainId: 31337, verifyingContract: safe.address }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx" as const, message }; return { chainId: 31337, safe: safe.address, safeTxHash: hashTypedData(typedData), typedData }; };
    const spend = async (value: bigint, secondaryRequired: boolean) => { const spendingRequest = await safeRequest(recipient.account.address, value, "0x"); const spendingSignatures = await encodeGuardSafeSignatures(spendingRequest, signer(primary, "primary"), secondaryRequired ? signer(secondary, "secondary") : undefined); const data = encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [recipient.account.address, value, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, spendingSignatures] }); await client.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: safe.address, data }) }); };
    await spend(6n, false); await spend(11n, true);
    const queueTuple = { safe: safe.address, delay: delay.address, to: recipient.account.address, value: 31n, data: "0x" as Hex, operation: 0 as const, queueNonce: 0n }; const fingerprint = queueFingerprint(queueTuple); const monitoringFingerprint = queueMonitoringFingerprint(queueTuple);
    const queueData = encodeFunctionData({ abi: delay.abi, functionName: "execTransactionFromModule", args: [queueTuple.to, queueTuple.value, queueTuple.data, queueTuple.operation] }); const request = await safeRequest(delay.address, 0n, queueData); const signatures = await encodeGuardSafeSignatures(request, signer(primary, "primary"), signer(secondary, "secondary"));
    const outerData = encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [delay.address, 0n, queueData, 0, 0n, 0n, 0n, ZERO, ZERO, signatures] }); const transactionHash = await payer.sendTransaction({ type: "eip1559", to: safe.address, data: outerData, gas: 10_000_000n, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }); const receipt = await client.waitForTransactionReceipt({ hash: transactionHash }); const transaction = await client.getTransaction({ hash: transactionHash }); const queueBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
    const hash = (byte: string) => keccak256(`0x${byte.repeat(32)}` as Hex); const observerEvidenceHash = hash("11");
    const controlled = (queueStatus: "EMPTY" | "QUEUED_CONDITIONAL") => ({ funderNativeBalance: "CURRENT", safeNativeBalance: "CURRENT", funderUsdcBalance: "CURRENT", safeUsdcBalance: "CURRENT", safeNonce: "CURRENT", delayQueueNonce: "CURRENT", delayTxNonce: "CURRENT", nativeSpend: { window: "CURRENT", baseSpent: "CURRENT", instantSpent: "CURRENT" }, usdcSpend: { window: "CURRENT", baseSpent: "CURRENT", instantSpent: "CURRENT" }, queueStatus, queueNonce: queueStatus === "EMPTY" ? null : "0", queueFingerprint: queueStatus === "EMPTY" ? null : fingerprint });
    const queue = { queueNonce: 0n, fingerprint, monitoringFingerprint, to: queueTuple.to, value: 31n, data: "0x" as Hex, operation: 0 as const };
    const nativeFundingAction = { id: "native-funding", index: 0, kind: "funding", asset: "native", expectedOutcome: "success", dependsOn: [], signerRoles: ["funder"], commitment: hash("10"), gasLimitCap: 100_000n, maxFeePerGasCap: 100_000_000_000n, maxPriorityFeePerGasCap: 10_000_000_000n, before: controlled("EMPTY"), after: controlled("EMPTY"), publicTransaction: { to: safe.address, value: 1n, data: "0x" } } as unknown as OrdinaryScenarioActionScope;
    const queueAction = { id: "queue-proposal", index: 0, kind: "queue-proposal", asset: "native", expectedOutcome: "success", dependsOn: [], signerRoles: ["primary-passkey", "safe-contract-secondary"], commitment: hash("12"), gasLimitCap: 2_000_000n, maxFeePerGasCap: 100_000_000_000n, maxPriorityFeePerGasCap: 10_000_000_000n, before: controlled("EMPTY"), after: controlled("QUEUED_CONDITIONAL"), safeTxHash: request.safeTxHash, safeTransaction: { ...request.typedData.message, safeNonce: request.typedData.message.nonce, safeTxHash: request.safeTxHash }, queue } as unknown as OrdinaryScenarioActionScope;
    const executeData = encodeFunctionData({ abi: delay.abi, functionName: "executeNextTx", args: [queueTuple.to, queueTuple.value, queueTuple.data, queueTuple.operation] });
    const earlyAction = { id: "early-rejection", index: 1, kind: "expected-early-rejection", asset: "native", expectedOutcome: "rejection", dependsOn: [queueAction.id], signerRoles: [], commitment: hash("13"), gasLimitCap: 300_000n, maxFeePerGasCap: 100_000_000_000n, maxPriorityFeePerGasCap: 10_000_000_000n, before: controlled("QUEUED_CONDITIONAL"), after: controlled("QUEUED_CONDITIONAL"), publicTransaction: { to: delay.address, value: 0n, data: executeData }, queue } as unknown as OrdinaryScenarioActionScope;
    const replayAction = { ...queueAction, id: "queue-replay", index: 2, kind: "expected-replay-rejection", expectedOutcome: "rejection", dependsOn: [queueAction.id] } as OrdinaryScenarioActionScope;
    const proposal = { schemaVersion: 1, authorization: "NONE", chainId: 11155111, proposalHash: hash("14"), reviewPackageHash: hash("15"), reviewArtifactBytesHash: hash("16"), planHash: hash("17"), topologyEvidenceHash: hash("18"), baselineEvidenceHash: hash("19"), publicIdentitiesHash: hash("1a"), observerEvidenceHash, safe: safe.address, guard: guard.address, delay: delay.address, funder: payer.account.address, usdc: token.address, recipient: recipient.account.address, primarySigner: primary.address, safeContractSecondary: secondary.address, ecdsaSecondary: ecdsa.account.address, periodSeconds: "86400", periodAnchor: "0", cooldownSeconds: "120", expirationSeconds: "600", limits: { nativeX: "10", nativeY: "30", usdcX: "10", usdcY: "30" }, inventory: { initialUsdcUnits: "20", recycledStepUpUsdcUnits: "10", recycledDelayedUsdcUnits: "1", grossUsdcUnits: "31" }, baselineActualCostWei: "0", phaseLimitWei: "50000000000000000", actions: [nativeFundingAction, queueAction, earlyAction, replayAction] } as unknown as OrdinaryScenarioProposal;
    const liveReceipt = { transactionHash, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash } as const;
    const journal = { schemaVersion: 1, chainId: 11155111, reviewPackageHash: proposal.reviewPackageHash, proposalHash: proposal.proposalHash, approvalHash: hash("1b"), funder: proposal.funder, liveJournal: { chainId: 11155111, funder: proposal.funder, entries: [] }, actions: [{ id: queueAction.id, commitment: queueAction.commitment, status: "confirmed", transactionHash, outerNonce: transaction.nonce, gas: transaction.gas.toString(), maxFeePerGas: transaction.maxFeePerGas!.toString(), maxPriorityFeePerGas: transaction.maxPriorityFeePerGas!.toString(), outerTo: safe.address, outerValue: "0", outerDataHash: keccak256(transaction.input), signatureBundleHash: keccak256(signatures), evidenceHash: hash("1c"), receipt: liveReceipt, queueCreatedAt: queueBlock.timestamp.toString() }] } as unknown as OrdinaryScenarioJournal;
    let profileChecks = 0;
    const verifyLocalTopology = async (rpc: typeof client, blockNumber: bigint) => { profileChecks++; const read = (address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => rpc.readContract({ address, abi, functionName, args, blockNumber } as never); const [owners, threshold, config, owner, avatar, target, primaryCode, secondaryCode] = await Promise.all([read(safe.address, parseAbi(["function getOwners() view returns (address[])"]), "getOwners"), read(safe.address, parseAbi(["function getThreshold() view returns (uint256)"]), "getThreshold"), read(guard.address, guard.abi, "config"), read(delay.address, delay.abi, "owner"), read(delay.address, delay.abi, "avatar"), read(delay.address, delay.abi, "target"), rpc.getBytecode({ address: primary.address, blockNumber }), rpc.getBytecode({ address: secondary.address, blockNumber })]); expect((owners as Address[]).map(value => value.toLowerCase())).to.deep.equal([primary.address.toLowerCase()]); expect(threshold).to.equal(1n); expect((config as readonly Address[])[0]!.toLowerCase()).to.equal(safe.address.toLowerCase()); expect((config as readonly Address[])[1]!.toLowerCase()).to.equal(primary.address.toLowerCase()); expect((owner as Address).toLowerCase()).to.equal(safe.address.toLowerCase()); expect((avatar as Address).toLowerCase()).to.equal(safe.address.toLowerCase()); expect((target as Address).toLowerCase()).to.equal(safe.address.toLowerCase()); expect(primaryCode).not.to.equal(undefined); expect(secondaryCode).not.to.equal(undefined); };
    const reader = createOrdinaryScenarioMechanicalStateReader({ expectedChainId: 31337, proposal, journal: () => journal, currentClient: client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: observerEvidenceHash }), verifyProfileAtBlock: verifyLocalTopology });
    const current = await reader(queueAction, "pre-private"); expect(current.evidenceBasis).to.deep.equal({ kind: "current-head" }); expect(current.nativeSpend.window > 0n).to.equal(true); expect(current.nativeSpend).to.include({ baseSpent: 6n, instantSpent: 17n }); expect(current.delayQueueNonce).to.equal(1n); expect(current.delayTxNonce).to.equal(0n); expect(profileChecks).to.be.greaterThan(0);
    const minedNonce = await client.getTransactionCount({ address: proposal.funder }); const nonceReads: Array<unknown> = [];
    const pendingNonceClient = new Proxy(client, { get(target, property, receiver) { if (property === "getTransactionCount") return async (args: { blockNumber?: bigint; blockTag?: string }) => { nonceReads.push(args); return args.blockTag === "pending" ? minedNonce + 1 : minedNonce; }; return Reflect.get(target, property, receiver); } });
    const pendingNonceReader = createOrdinaryScenarioMechanicalStateReader({ expectedChainId: 31337, proposal, journal: () => journal, currentClient: pendingNonceClient as typeof client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: observerEvidenceHash }), verifyProfileAtBlock: verifyLocalTopology });
    await expect(pendingNonceReader(queueAction, "pre-private")).to.be.rejectedWith(/pending|nonce.*agree|nonce.*drift/i);
    expect(nonceReads.some((args: any) => args.blockTag === "latest")).to.equal(true); expect(nonceReads.some((args: any) => args.blockTag === "pending")).to.equal(true);
    const advancedMinedNonceClient = new Proxy(client, { get(target, property, receiver) { if (property === "getTransactionCount") return async (args: { blockNumber?: bigint; blockTag?: string }) => args.blockNumber !== undefined ? minedNonce : minedNonce + 1; return Reflect.get(target, property, receiver); } });
    const advancedMinedNonceReader = createOrdinaryScenarioMechanicalStateReader({ expectedChainId: 31337, proposal, journal: () => journal, currentClient: advancedMinedNonceClient as typeof client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: observerEvidenceHash }), verifyProfileAtBlock: verifyLocalTopology });
    await expect(advancedMinedNonceReader(queueAction, "pre-private")).to.be.rejectedWith(/selected-block.*nonce drift/i);
    let blockReads = 0; const recheckingClient = new Proxy(client, { get(target, property, receiver) { if (property === "getBlock") return async (args?: unknown) => { const block = await target.getBlock(args as never); blockReads++; return blockReads === 2 ? { ...block, hash: hash("fe") } : block; }; return Reflect.get(target, property, receiver); } }); const recheckingReader = createOrdinaryScenarioMechanicalStateReader({ expectedChainId: 31337, proposal, journal: () => journal, currentClient: recheckingClient as typeof client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: observerEvidenceHash }), verifyProfileAtBlock: verifyLocalTopology }); await expect(recheckingReader(queueAction, "pre-private")).to.be.rejectedWith("block changed");
    await expect(createOrdinaryScenarioMechanicalStateReader({ expectedChainId: 11155111, proposal, journal: () => journal, currentClient: client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: observerEvidenceHash }), verifyProfileAtBlock: async () => { throw new Error("must not replace production verification"); } })(queueAction, "pre-private")).to.be.rejectedWith("chain mismatch");
    let replacementCalls = 0; const productionInput = { repository: "/not-read-before-chain-check", proposal, journal: () => journal, currentClient: client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: observerEvidenceHash }), verifyProfileAtBlock: async () => { replacementCalls++; } }; await expect(createOrdinaryScenarioStateReader(productionInput)(queueAction, "pre-private")).to.be.rejectedWith("chain mismatch"); expect(replacementCalls).to.equal(0); expect(createOrdinaryScenarioExecutionContext).to.be.a("function");
    await time.increase(121); const latest = await client.getBlock(); expect(latest.timestamp > queueBlock.timestamp + 120n).to.equal(true);
    const historical = await reader(earlyAction, "pre-private"); expect(historical.evidenceBasis).to.deep.equal({ kind: "queue-receipt", proposalActionId: queueAction.id, transactionHash }); expect(historical.blockNumber).to.equal(receipt.blockNumber); expect(historical.queue).to.include({ createdAt: queueBlock.timestamp, status: "queued" });
    const historicalWithPendingFunder = await createOrdinaryScenarioMechanicalStateReader({ expectedChainId: 31337, proposal, journal: () => journal, currentClient: pendingNonceClient as typeof client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: observerEvidenceHash }), verifyProfileAtBlock: verifyLocalTopology })(earlyAction, "pre-private");
    expect(historicalWithPendingFunder.evidenceBasis.kind).to.equal("queue-receipt");
    let signerLoads = 0; const directory = mkdtempSync(join(tmpdir(), "ordinary-real-adapter-")); const ledgerPath = join(directory, "ledger.json"); const acknowledgementPath = join(directory, "ack.json");
    const makeContext = (archiveClient = client) => createOrdinaryScenarioMechanicalExecutionContext({ expectedChainId: 31337, proposal, journal: () => journal, currentClient: client, archiveClient, observerReadiness: async () => ({ ready: true, evidenceHash: observerEvidenceHash }), live: { funder: payer.account.address, chainId: async () => 31337, nonce: async () => transaction.nonce, balance: async () => 1n, sign: async () => { throw new Error("unused"); }, broadcast: async () => { throw new Error("unused"); }, receipt: async () => liveReceipt }, loadSigners: async () => { signerLoads++; throw new Error("signer must not load during recovery"); }, observerLedgerPath: ledgerPath, receiverAcknowledgementPath: acknowledgementPath, observerEndpointHash: "0x8a3e2db19f160da76a08385670e22e08a293ee5b09276b90e74cd2dc65029ae0", now: () => new Date("2026-10-27T13:00:00Z") }, reader);
    try {
      const context = makeContext();
      const nativeFundingPrepared = await context.materialize(nativeFundingAction, current); const nativeFundingSimulation = await context.simulate(nativeFundingAction, nativeFundingPrepared, current); expect(nativeFundingSimulation.success).to.equal(true);
      const rejected = await context.proveRejection(earlyAction, historical); expect(rejected.success).to.equal(false); expect(rejected.postState.evidenceBasis).to.deep.equal(historical.evidenceBasis);
      const pending = await context.recoverPending(queueAction, journal.actions[0]!); expect(pending.data).to.equal(transaction.input); expect(pending.nonce).to.equal(transaction.nonce);
      const replay = await context.recoverReplay(replayAction, journal.actions[0]!, current); expect(keccak256(replay.transientSignedOuterTransaction!)).to.equal(transactionHash); expect(signerLoads).to.equal(0);
      const entry = { id: queueAction.id, intentHash: hash("1d"), transactionHash, nonce: transaction.nonce, reserved: 0n, status: "success" as const, receipt: liveReceipt };
      await expect(context.confirm(queueAction, entry, journal.actions[0]!)).to.be.rejectedWith("observer ledger");
      const alert = { kind: "delayed-queued" as const, chainId: 31337, safe: safe.address, delay: delay.address, transactionHash, blockNumber: receipt.blockNumber, logIndex: 0, queueNonce: 0n, queueFingerprint: fingerprint, createdAt: queueBlock.timestamp, expiresAt: queueBlock.timestamp + 720n, to: queueTuple.to, value: queueTuple.value, data: queueTuple.data, operation: 0 };
      const key = { chainId: 31337, transactionHash, blockHash: receipt.blockHash, logIndex: 0 }; const firstStore = new FileActivityStore(ledgerPath); const first = new ActivityLedger(firstStore); first.accept(key, alert); firstStore.close(); const payloadSha256 = publicAlertPayloadHash(alert); const secondStore = new FileActivityStore(ledgerPath); const second = new ActivityLedger(secondStore); second.markDelivered(key, { channel: "webhook", httpStatus: 200, payloadHash: payloadSha256, deliveredAt: "2026-10-27T12:59:00Z" }); secondStore.close();
      writeFileSync(acknowledgementPath, JSON.stringify({ schemaVersion: 1, endpointHash: "0x8a3e2db19f160da76a08385670e22e08a293ee5b09276b90e74cd2dc65029ae0", transactionHash, payloadSha256, receiverRequestId: "local-request", receiverRecordedAt: "2026-10-27T12:59:00Z", retrievedAt: "2026-10-27T12:59:30Z", retrievalProvenance: "official-receiver-api", expiresAt: "2026-10-28T18:51:57Z" }));
      const confirmation = await context.confirm(queueAction, entry, journal.actions[0]!); expect(confirmation.postState.evidenceBasis).to.deep.equal({ kind: "receipt-poststate", actionId: queueAction.id, transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }); expect(confirmation.effect).to.include({ kind: "safe-execution", safeTxHash: request.safeTxHash, queueCreatedAt: queueBlock.timestamp }); expect(confirmation.observerEvidenceHash).to.match(/^0x[0-9a-f]{64}$/);
      const reorgArchive = new Proxy(client, { get(target, property, receiver) { if (property === "getTransactionReceipt") return async () => ({ ...receipt, blockHash: hash("ff") }); return Reflect.get(target, property, receiver); } }); await expect(makeContext(reorgArchive as typeof client).confirm(queueAction, entry, journal.actions[0]!)).to.be.rejectedWith("receipt mismatch");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
