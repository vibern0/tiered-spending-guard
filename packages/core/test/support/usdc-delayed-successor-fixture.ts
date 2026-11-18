import type { Hex } from "viem";
import { sha256 } from "../../scripts/plan-deployment";
import {
  attachUsdcDelayedCompletionForTestsOnly,
} from "../../scripts/live/ordinary-scenario-usdc-delayed-completion-proposal";
import {
  createUsdcDelayedSuccessorSourceForTestsOnly,
  verifyUsdcDelayedSuccessorCertificateForTestsOnly,
} from "../../scripts/live/ordinary-scenario-usdc-delayed-successor-certificate";
import {
  createUsdcDelayedSuccessorProposalForTestsOnly,
  loadUsdcDelayedSuccessorApprovalForTestsOnly,
} from "../../scripts/live/ordinary-scenario-usdc-delayed-successor-proposal";
import { approvedDelayedCompletion, delayedProviders } from "./usdc-delayed-completion-fixture";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;

export const delayedSuccessorCaps = {
  safeExecutionGasLimit: "2000000",
  publicDelayGasLimit: "300000",
  maxFeePerGas: "1000000",
  maxPriorityFeePerGas: "1000000",
} as const;
export const delayedSuccessorCodeBinding = { head: h("a"), tree: h("b"), logHash: h("c") } as const;

export const delayedSuccessorObserver = {
  kind: "https-webhook" as const,
  publicId: `temporary-test-receiver:${h("d")}`,
  endpointHash: h("d"),
  startupEvidenceHash: h("e"),
  probeEvidenceHash: h("f"),
  independentFromProposer: true as const,
  readyAt: "1793365092",
  workflowScheduleSeconds: {
    review: "300",
    execution: "600",
    confirmations: "180",
    delivery: "60",
    acknowledgement: "180",
    keylessConfirmation: "180",
  },
  requiredThrough: "1793366892",
  expiresAt: "1793404800",
};

function confirmed(action: { id: string; commitment: Hex }, index: number, nonce: number) {
  const transactionHash = h(String(index + 1));
  const receipt = {
    transactionHash,
    status: "success" as const,
    gasUsed: 100_000n + BigInt(index),
    effectiveGasPrice: 100n,
    blockNumber: 12_029_600n + BigInt(index),
    blockHash: h("5678"[index / 2]!),
  };
  return {
    record: {
      id: action.id,
      commitment: action.commitment,
      status: "confirmed" as const,
      intentHash: h("a"),
      transactionHash,
      evidenceHash: h("b"),
      receipt,
      receiptInclusion: {
        transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        blockTimestamp: (1_793_364_000n + BigInt(index)).toString(),
        effectivePeriod: "1793318400",
      },
      observerEvidenceHash: index === 0 ? null : h("c"),
      outerNonce: nonce,
      ...([2, 6].includes(index) ? { queueCreatedAt: "1793364000" } : {}),
      ourReceiptGasCost: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      ourPrincipalDelta: "0",
    },
    live: {
      id: action.id,
      intentHash: h("a"),
      transactionHash,
      nonce,
      reserved: receipt.gasUsed * receipt.effectiveGasPrice,
      status: "success" as const,
      receipt,
    },
  };
}

export async function createDelayedSuccessorFixture() {
  const delayed = await approvedDelayedCompletion();
  const journal = structuredClone(attachUsdcDelayedCompletionForTestsOnly(delayed.journal, delayed.proposal, delayed.approval));
  const actions = journal.usdcDelayedCompletion!.actions;
  const broadcasts = [[0, 912], [2, 913], [4, 914], [6, 915]] as const;
  for (const [index, nonce] of broadcasts) {
    const done = confirmed(delayed.proposal.actions[index]!, index, nonce);
    actions[index] = done.record as any;
    journal.liveJournal.entries.push(done.live as any);
  }
  for (const index of [1, 3, 5, 7]) {
    const action = delayed.proposal.actions[index]!;
    actions[index] = {
      id: action.id,
      commitment: action.commitment,
      status: "rejection-proved",
      evidenceHash: h("9"),
      requestHash: action.commitment,
      outerNonce: index === 1 ? 913 : index === 3 ? 914 : index === 5 ? 915 : 916,
    } as any;
  }
  const stopped = delayed.proposal.actions[8]!;
  const materialization = {
    proposalHash: delayed.proposal.proposalHash,
    actionCommitment: stopped.commitment,
    outerNonce: 916,
    gas: "300000",
    gasEstimate: "40480",
    maxFeePerGas: "36",
    maxPriorityFeePerGas: "22",
    pinnedBlockNumber: "12029717",
    pinnedBlockHash: h("8"),
    approvedContinuationReservationWei: delayed.proposal.reservation.successorMaximumReservationWei,
    remainingReservationWei: "2600000000000",
  };
  actions[8] = {
    id: stopped.id,
    commitment: stopped.commitment,
    status: "signed-simulated",
    materializationHash: h("1"),
    prestateHash: h("2"),
    outerNonce: 916,
    maxFeePerGas: "36",
    maxPriorityFeePerGas: "22",
    funderNativeBefore: "7193973024089700",
    finalOuterMaterialization: { hash: sha256(materialization) as Hex, ...materialization },
    requestHash: stopped.commitment,
    signatureBundleHash: null,
    signedCalldataHash: h("3"),
    simulationEvidenceHash: h("4"),
    gas: "300000",
    outerTo: delayed.source.historical.prior.original.delay,
    outerValue: "0",
    outerDataHash: h("3"),
  } as any;
  return { ...delayed, journal };
}

export async function delayedSuccessorProviders(fixture: Awaited<ReturnType<typeof createDelayedSuccessorFixture>>, mutation: Record<string, unknown> = {}) {
  const queue = fixture.proposal.actions[6]!.queue!;
  const state = {
    safeNonce: 13n,
    delayQueueNonce: 6n,
    delayTxNonce: 5n,
    safeUsdcBalance: 31_000_000n,
    funderUsdcBalance: 9_000_000n,
    queue: {
      queueNonce: 5n,
      fingerprint: queue.fingerprint,
      createdAt: 1_793_364_000n,
      to: queue.to,
      value: BigInt(queue.value),
      data: queue.data,
      operation: 0,
    },
  };
  const values = { snapshotNonce: 917, latestNonce: 917, pendingNonce: 917, state, ...mutation };
  const base = await delayedProviders(fixture.historical, values, values);
  const records = [0, 2, 4, 6].map(index => fixture.journal.usdcDelayedCompletion!.actions[index] as any);
  const wrap = (provider: typeof base[number]) => ({
    ...provider,
    readReceipt: async (hash: Hex) => { const record = records.find(item => item.transactionHash === hash); return record ? { transactionHash: hash, status: record.receipt.status, blockNumber: BigInt(record.receipt.blockNumber), blockHash: record.receipt.blockHash, gasUsed: BigInt(record.receipt.gasUsed), effectiveGasPrice: BigInt(record.receipt.effectiveGasPrice) } : provider.readReceipt(hash); },
    readBlock: async (number: bigint) => { const record = records.find(item => BigInt(item.receipt.blockNumber) === number); return record ? { number, hash: record.receipt.blockHash, timestamp: BigInt(record.receiptInclusion.blockTimestamp) } : provider.readBlock(number); },
  });
  return [wrap(base[0]), wrap(base[1])] as const;
}

export async function approvedDelayedSuccessor() {
  const fixture = await createDelayedSuccessorFixture();
  const source = createUsdcDelayedSuccessorSourceForTestsOnly({
    prior: fixture.source,
    delayedCertificate: fixture.certificate,
    delayedProposal: fixture.proposal,
    delayedApproval: fixture.approval,
    journal: fixture.journal,
  });
  const certificate = await verifyUsdcDelayedSuccessorCertificateForTestsOnly(source, await delayedSuccessorProviders(fixture));
  const proposal = createUsdcDelayedSuccessorProposalForTestsOnly({ source, certificate, observer: delayedSuccessorObserver, caps: delayedSuccessorCaps, codeBinding: delayedSuccessorCodeBinding });
  const document = {
    schemaVersion: 1,
    scope: proposal.scope,
    authorization: "FOCUSED_BOUNDED_DELAYED_SUCCESSOR_AUTHORIZATION",
    authorityEvidenceHash: proposal.authorityEvidenceHash,
    proposalHash: proposal.proposalHash,
    sourceJournalHash: proposal.sourceJournalHash,
    certificateHash: proposal.certificateHash,
    codeBinding: proposal.codeBinding,
    snapshot: proposal.snapshot,
    minimumOuterNonce: proposal.minimumOuterNonce,
    effectivePeriod: proposal.effectivePeriod,
    deadline: proposal.deadline,
    observer: proposal.observer,
    schedule: proposal.schedule,
    groups: proposal.groups,
    caps: proposal.caps,
    reservation: proposal.reservation,
    maxBroadcastAttempts: 1,
    repairAuthority: "NONE",
    approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })),
  };
  const approval = loadUsdcDelayedSuccessorApprovalForTestsOnly(proposal, JSON.stringify(document), sha256(document) as Hex);
  return { ...fixture, source, certificate, proposal, approval };
}
