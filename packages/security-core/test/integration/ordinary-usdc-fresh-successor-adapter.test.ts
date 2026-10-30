import { expect } from "chai";
import hre from "hardhat";
import { decodeFunctionData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sha256 } from "../../scripts/plan-deployment";
import { createUsdcFreshSuccessorExecutionView } from "../../scripts/live/ordinary-scenario-executor";
import { createOrdinaryScenarioMechanicalExecutionContext } from "../../scripts/live/ordinary-scenario-adapter";
import { attachUsdcFreshSuccessor, createUsdcFreshSuccessorProposal, loadUsdcFreshSuccessorApproval } from "../../scripts/live/ordinary-scenario-usdc-fresh-successor-proposal";
import { verifyUsdcFreshSuccessorCertificate } from "../../scripts/live/ordinary-scenario-usdc-fresh-successor-certificate";
import { submitLiveIntentForChain, type LiveJournal } from "../../scripts/live/submission";
import { cleanupUsdcRecycleContinuationFixtures } from "../support/usdc-recycle-continuation-fixture";
import { createFreshSource, freshPrimary, freshProviders, freshSnapshot } from "../support/usdc-fresh-successor-fixture";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
const caps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;
const observer = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${h("1")}`, endpointHash: h("1"), startupEvidenceHash: h("2"), probeEvidenceHash: h("3"), independentFromProposer: true as const, readyAt: freshSnapshot.timestamp.toString(), workflowScheduleSeconds: { review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" }, requiredThrough: (freshSnapshot.timestamp + 11_640n).toString(), expiresAt: "1793404800" };
const tokenAbi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

describe("ordinary USDC fresh successor adapter", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  it("forwards exact observer bounds and materializes prefund as one signer-free public transfer", async function () {
    const source = await createFreshSource(); const certificate = await verifyUsdcFreshSuccessorCertificate(source, freshPrimary, await freshProviders(source)); const proposal = createUsdcFreshSuccessorProposal({ source, certificate, observer, caps });
    const document = { schemaVersion: 1, scope: proposal.scope, authorization: "FOCUSED_BOUNDED_SUCCESSOR_AUTHORIZATION", authorityEvidenceHash: proposal.authorityEvidenceHash, proposalHash: proposal.proposalHash, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, snapshot: proposal.snapshot, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, observer: proposal.observer, schedule: proposal.schedule, groups: proposal.groups, caps: proposal.caps, reservation: proposal.reservation, maxBroadcastAttempts: 1, repairAuthority: "NONE", approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
    const approval = loadUsdcFreshSuccessorApproval(proposal, JSON.stringify(document), sha256(document) as Hex); const journal = attachUsdcFreshSuccessor(source.prior.journal, proposal, approval); const view = createUsdcFreshSuccessorExecutionView(source, proposal, approval); const prefund = view.proposal.actions[5]!;
    const base = { expectedChainId: 11_155_111, proposal: view, journal: () => journal, currentClient: {}, archiveClient: {}, observerReadiness: async () => ({ ready: true, evidenceHash: proposal.observer.probeEvidenceHash }), live: {}, loadSigners: async () => { throw new Error("prefund must not load Safe signers"); } };
    const state = { outerNonce: 870, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: 1_793_232_000n, baseSpent: 10_000_000n, instantSpent: 20_000_000n } };
    expect(() => createOrdinaryScenarioMechanicalExecutionContext(base as never, (async () => { throw new Error("unused"); }) as never)).to.throw(/observer ready and expiry forwarding/i);
    const readyAt = new Date(Number(BigInt(proposal.observer.readyAt) * 1000n)).toISOString(), expiresAt = new Date(Number(BigInt(proposal.observer.expiresAt) * 1000n)).toISOString();
    const context = createOrdinaryScenarioMechanicalExecutionContext({ ...base, receiverReadyAt: readyAt, receiverExpiresAt: expiresAt } as never, (async () => { throw new Error("unused"); }) as never);
    const prepared = await context.materialize(prefund, state as never);
    expect(prepared.liveIntent).to.include({ id: "usdc-fresh-successor-prefund-all", to: source.prior.original.usdc, nonce: 870, gas: 740_292n });
    const decoded = decodeFunctionData({ abi: tokenAbi, data: prepared.liveIntent.data });
    expect(decoded.args).to.deep.equal([source.prior.original.safe, 31_000_000n]);
    expect(prepared.signatureBundleHash).to.equal(null);
  });

  it("persists one durable intent hash before the sole broadcast and never signs or broadcasts it twice", async function () {
    const [payer] = await hre.viem.getWalletClients(); const client = await hre.viem.getPublicClient(); const local = privateKeyToAccount(generatePrivateKey());
    await client.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: local.address, value: 10n ** 18n }) }); const nonce = await client.getTransactionCount({ address: local.address });
    const journal: LiveJournal = { chainId: 31337, funder: local.address, entries: [] }; const order: string[] = []; let signs = 0, broadcasts = 0;
    const intent = { id: "usdc-fresh-successor-prefund-all", to: local.address, data: "0x" as Hex, value: 0n, nonce, gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    const context = { funder: local.address, chainId: async () => 31337, nonce: async () => nonce, balance: async () => client.getBalance({ address: local.address }), verify: async () => undefined, sign: async () => { signs++; return local.signTransaction({ type: "eip1559", chainId: 31337, to: intent.to, value: intent.value, data: intent.data, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }); }, persist: async () => { order.push("persist"); expect(journal.entries[0]?.transactionHash).to.match(/^0x[0-9a-f]{64}$/); }, broadcast: async () => { order.push("broadcast"); broadcasts++; throw new Error("ambiguous local transport"); }, receipt: async () => undefined };
    await expect(submitLiveIntentForChain(intent, journal, context, 31337)).to.be.rejectedWith(/outcome unknown/i);
    expect(order).to.deep.equal(["persist", "broadcast"]); expect({ signs, broadcasts }).to.deep.equal({ signs: 1, broadcasts: 1 });
    expect((await submitLiveIntentForChain(intent, journal, context, 31337)).status).to.equal("pending"); expect({ signs, broadcasts }).to.deep.equal({ signs: 1, broadcasts: 1 });
  });
});
