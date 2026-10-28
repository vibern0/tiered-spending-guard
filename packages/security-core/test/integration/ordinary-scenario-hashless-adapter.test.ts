import { expect } from "chai";
import hre from "hardhat";
import { keccak256, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createExpiredHashlessContinuationExecutionView, type CanonicalOrdinaryScenarioState, type OrdinaryScenarioActionScope } from "../../scripts/live/ordinary-scenario-executor";
import { createOrdinaryScenarioMechanicalExecutionContext, createOrdinaryScenarioMechanicalStateReader } from "../../scripts/live/ordinary-scenario-adapter";
import { submitLiveIntentForChain, type LiveJournal } from "../../scripts/live/submission";
import { hashlessContinuationFixture } from "../support/hashless-continuation-fixture";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

describe("ordinary scenario expired hashless adapter", function () {
  it("actual_adapter_uses_closed_lineage_and_reads_only_heads3_through6", async function () {
    const { original, journal, proposal, h, current } = await hashlessContinuationFixture();
    const view = createExpiredHashlessContinuationExecutionView(original, proposal);
    expect(view.proposal.actions.slice(18).map(action => action.commitment)).to.deep.equal(proposal.actions.map(action => action.commitment));
    expect(view.proposal.actions).not.to.include(original.actions[18]);
    for (let index = 19; index < original.actions.length; index++) expect(view.proposal.actions.find(action => action.id === original.actions[index]!.id)!.commitment).to.not.equal(original.actions[index]!.commitment);
    const mutable = structuredClone(journal.hashlessContinuation!); mutable.actions = proposal.actions.map((action, index) => ({ id: action.id, commitment: action.commitment, status: action.expectedOutcome === "success" ? "confirmed" as const : "rejection-proved" as const, evidenceHash: keccak256(`0x${(index + 1).toString(16).padStart(2, "0")}` as Hex) })); (journal as any).hashlessContinuation = mutable;
    let selected!: OrdinaryScenarioActionScope; let feeHeuristicCalls = 0; const createdAt = 1_793_210_052n;
    const client = {
      getBlock: async () => ({ number: current.number, hash: current.hash, timestamp: createdAt, baseFeePerGas: 10n }), getChainId: async () => 11155111,
      getTransactionCount: async () => 810, getBalance: async ({ address }: { address: Address }) => address.toLowerCase() === original.funder.toLowerCase() ? 10n ** 18n : BigInt(selected.after.safeNativeBalance),
      estimateFeesPerGas: async () => { feeHeuristicCalls++; return { maxFeePerGas: 28n, maxPriorityFeePerGas: 2n }; },
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "balanceOf") return (args![0] as Address).toLowerCase() === original.funder.toLowerCase() ? BigInt(selected.after.funderUsdcBalance) : BigInt(selected.after.safeUsdcBalance);
        if (functionName === "nonce") return BigInt(selected.after.safeNonce); if (functionName === "queueNonce") return BigInt(selected.after.delayQueueNonce); if (functionName === "txNonce") return BigInt(selected.after.delayTxNonce);
        if (functionName === "spendState") return (args![0] as Address).toLowerCase() === ZERO ? [1_793_145_600n, BigInt(selected.after.nativeBaseSpent), BigInt(selected.after.nativeInstantSpent)] : [1_793_145_600n, BigInt(selected.after.usdcBaseSpent), BigInt(selected.after.usdcInstantSpent)];
        if (functionName === "getTxCreatedAt") return createdAt; if (functionName === "getTxHash") return selected.queue!.fingerprint;
        throw new Error(`unexpected fixture read ${address}:${functionName}`);
      },
    } as never;
    const reader = createOrdinaryScenarioMechanicalStateReader({ expectedChainId: 11155111, proposal: view, journal: () => journal, currentClient: client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: proposal.observer.probeEvidenceHash }), verifyProfileAtBlock: async () => undefined });
    const heads = view.proposal.actions.slice(18).filter(action => action.kind === "queue-proposal"); expect(heads.map(action => action.queue!.queueNonce)).to.deep.equal([3n, 4n, 5n, 6n]);
    for (selected of heads) {
      const state = await reader(selected, "pre-private", { actionId: selected.id, transactionHash: h("d"), blockNumber: current.number, blockHash: current.hash });
      expect(state.queue).to.deep.include({ queueNonce: selected.queue!.queueNonce, fingerprint: selected.queue!.fingerprint, createdAt, status: "queued", operation: 0 }); expect(state.dependencies.map(item => item.actionId)).to.deep.equal(selected.dependsOn);
    }
    const wrong = structuredClone(heads[1]!) as any; wrong.after.queueFingerprint = h("e"); selected = wrong; await expect(reader(wrong, "pre-private", { actionId: wrong.id, transactionHash: h("f"), blockNumber: current.number, blockHash: current.hash })).to.be.rejectedWith(/head is missing|ambiguous/i);
    selected = heads[0]!; const record = mutable.actions.find(action => action.id === selected.id)! as any; record.status = "signed-simulated"; record.maxFeePerGas = "17"; record.maxPriorityFeePerGas = "1"; const frozen = await reader(selected, "pre-outer"); expect(frozen.fees).to.deep.equal({ maxFeePerGas: 17n, maxPriorityFeePerGas: 1n }); expect(feeHeuristicCalls).to.equal(5);
    const context = createOrdinaryScenarioMechanicalExecutionContext({ expectedChainId: 11155111, proposal: view, journal: () => journal, currentClient: client, archiveClient: client, observerReadiness: async () => ({ ready: true, evidenceHash: proposal.observer.probeEvidenceHash }), live: { funder: original.funder, chainId: async () => 11155111, nonce: async () => 810, balance: async () => 10n ** 18n, sign: async () => { throw new Error("not used"); }, broadcast: async () => { throw new Error("not used"); }, receipt: async () => undefined }, loadSigners: async () => { throw new Error("not used for public Delay action"); } } as never, reader);
    selected = view.proposal.actions[18]!; const prepared = await context.materialize(selected, { outerNonce: 810, fees: { maxFeePerGas: 17n, maxPriorityFeePerGas: 1n } } as CanonicalOrdinaryScenarioState); expect(prepared.liveIntent).to.include({ id: proposal.actions[0]!.id, to: proposal.actions[0]!.transaction.to, nonce: 810 });
  });

  it("durable_hash_precedes_one_broadcast_and_ambiguous_resume_never_resigns", async function () {
    const [payer] = await hre.viem.getWalletClients(); const client = await hre.viem.getPublicClient(); const local = privateKeyToAccount(generatePrivateKey()); await client.waitForTransactionReceipt({ hash: await payer.sendTransaction({ to: local.address, value: 10n ** 18n }) }); const nonce = await client.getTransactionCount({ address: local.address });
    const journal: LiveJournal = { chainId: 31337, funder: local.address, entries: [] }; let persists = 0; let signs = 0; let broadcasts = 0;
    const intent = { id: "continuation-local-proof", to: local.address, data: "0x" as Hex, value: 0n, nonce, gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    const context = { funder: local.address, chainId: async () => 31337, nonce: async () => nonce, balance: async () => client.getBalance({ address: local.address }), verify: async () => undefined, sign: async () => { signs++; return local.signTransaction({ type: "eip1559", chainId: 31337, to: intent.to, value: intent.value, data: intent.data, nonce: intent.nonce, gas: intent.gas, maxFeePerGas: intent.maxFeePerGas, maxPriorityFeePerGas: intent.maxPriorityFeePerGas }); }, broadcast: async () => { broadcasts++; throw new Error("ambiguous local transport"); }, receipt: async () => undefined, persist: async () => { persists++; } };
    await expect(submitLiveIntentForChain(intent, journal, context, 31337)).to.be.rejectedWith(/outcome unknown/i); expect({ persists, signs, broadcasts, entries: journal.entries.length }).to.deep.equal({ persists: 1, signs: 1, broadcasts: 1, entries: 1 });
    const resumed = await submitLiveIntentForChain(intent, journal, context, 31337); expect(resumed.status).to.equal("pending"); expect({ signs, broadcasts }).to.deep.equal({ signs: 1, broadcasts: 1 });
  });
});
