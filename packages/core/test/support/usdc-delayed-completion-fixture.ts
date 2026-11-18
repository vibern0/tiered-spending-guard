import { sha256 } from "../../scripts/plan-deployment";
import {
  attachUsdcFreshSuccessor,
  createUsdcFreshSuccessorProposal,
  loadUsdcFreshSuccessorApproval,
} from "../../scripts/live/ordinary-scenario-usdc-fresh-successor-proposal";
import { verifyUsdcFreshSuccessorCertificate } from "../../scripts/live/ordinary-scenario-usdc-fresh-successor-certificate";
import {
  createFreshSource,
  freshPrimary,
  freshProviders,
  freshSnapshot,
} from "./usdc-fresh-successor-fixture";
import type { Hex } from "viem";
import { createUsdcDelayedCompletionSourceForTestsOnly, verifyUsdcDelayedCompletionCertificateForTestsOnly } from "../../scripts/live/ordinary-scenario-usdc-delayed-completion-certificate";
import { createUsdcDelayedCompletionProposalForTestsOnly, loadUsdcDelayedCompletionApprovalForTestsOnly } from "../../scripts/live/ordinary-scenario-usdc-delayed-completion-proposal";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;
export const delayedCaps = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } as const;
const freshObserver = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${h("1")}`, endpointHash: h("1"), startupEvidenceHash: h("2"), probeEvidenceHash: h("3"), independentFromProposer: true as const, readyAt: freshSnapshot.timestamp.toString(), workflowScheduleSeconds: { review: "3600", execution: "7200", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" }, requiredThrough: (freshSnapshot.timestamp + 11_640n).toString(), expiresAt: "1793404800" };

export const delayedObserver = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${h("4")}`, endpointHash: h("4"), startupEvidenceHash: h("5"), probeEvidenceHash: h("6"), independentFromProposer: true as const, readyAt: freshSnapshot.timestamp.toString(), workflowScheduleSeconds: { review: "600", execution: "1800", confirmations: "180", delivery: "60", acknowledgement: "180", keylessConfirmation: "180" }, requiredThrough: (freshSnapshot.timestamp + 3_600n).toString(), expiresAt: "1793404800" };

function approvalDocument(proposal: ReturnType<typeof createUsdcFreshSuccessorProposal>) {
  return { schemaVersion: 1, scope: proposal.scope, authorization: "FOCUSED_BOUNDED_SUCCESSOR_AUTHORIZATION", authorityEvidenceHash: proposal.authorityEvidenceHash, proposalHash: proposal.proposalHash, sourceHash: proposal.sourceHash, certificateHash: proposal.certificateHash, snapshot: proposal.snapshot, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, observer: proposal.observer, schedule: proposal.schedule, groups: proposal.groups, caps: proposal.caps, reservation: proposal.reservation, maxBroadcastAttempts: 1, repairAuthority: "NONE", approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
}

export async function createDelayedCompletionFixture() {
  const historical = await createFreshSource();
  const freshCertificate = await verifyUsdcFreshSuccessorCertificate(historical, freshPrimary, await freshProviders(historical));
  const freshProposal = createUsdcFreshSuccessorProposal({ source: historical, certificate: freshCertificate, observer: freshObserver, caps: delayedCaps });
  const document = approvalDocument(freshProposal);
  const freshApproval = loadUsdcFreshSuccessorApproval(freshProposal, JSON.stringify(document), sha256(document) as Hex);
  const attached = attachUsdcFreshSuccessor(historical.prior.journal, freshProposal, freshApproval);
  const journal = structuredClone(attached);
  const row = journal.usdcFreshSuccessor!.actions[0]!;
  journal.usdcFreshSuccessor!.actions[0] = {
    id: row.id,
    commitment: row.commitment,
    status: "signed-simulated",
    materializationHash: h("7"),
    prestateHash: h("8"),
    outerNonce: 905,
    maxFeePerGas: "69",
    maxPriorityFeePerGas: "51",
    funderNativeBefore: "7193973545294610",
    finalOuterMaterialization: (() => { const facts = { proposalHash: freshProposal.proposalHash, actionCommitment: row.commitment, outerNonce: 905, gas: "740292", gasEstimate: "154151", maxFeePerGas: "69", maxPriorityFeePerGas: "51", pinnedBlockNumber: "12027487", pinnedBlockHash: h("c"), approvedContinuationReservationWei: freshProposal.reservation.successorMaximumReservationWei, remainingReservationWei: freshProposal.reservation.successorMaximumReservationWei }; return { hash: sha256(facts) as Hex, ...facts }; })(),
    requestHash: row.commitment,
    signatureBundleHash: null,
    signedCalldataHash: h("9"),
    simulationEvidenceHash: h("a"),
    gas: "740292",
    outerTo: historical.prior.original.usdc,
    outerValue: "0",
    outerDataHash: h("9"),
  };
  return { historical, freshCertificate, freshProposal, freshApproval, journal };
}

export async function delayedProviders(historical: Awaited<ReturnType<typeof createFreshSource>>, mutation: Record<string, unknown> = {}) {
  return freshProviders(historical, { snapshotNonce: 906, latestNonce: 906, pendingNonce: 906, ...mutation }, { snapshotNonce: 906, latestNonce: 906, pendingNonce: 906, ...mutation });
}

export async function approvedDelayedCompletion() {
  const base = await createDelayedCompletionFixture();
  const source = createUsdcDelayedCompletionSourceForTestsOnly(base);
  const certificate = await verifyUsdcDelayedCompletionCertificateForTestsOnly(source, await delayedProviders(base.historical));
  const proposal = createUsdcDelayedCompletionProposalForTestsOnly({ source, certificate, observer: delayedObserver, caps: delayedCaps });
  const document = { schemaVersion: 1, scope: proposal.scope, authorization: "FOCUSED_BOUNDED_DELAYED_COMPLETION_AUTHORIZATION", authorityEvidenceHash: proposal.authorityEvidenceHash, proposalHash: proposal.proposalHash, sourceJournalHash: proposal.sourceJournalHash, certificateHash: proposal.certificateHash, snapshot: proposal.snapshot, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, observer: proposal.observer, schedule: proposal.schedule, groups: proposal.groups, caps: proposal.caps, reservation: proposal.reservation, maxBroadcastAttempts: 1, repairAuthority: "NONE", approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
  const approval = loadUsdcDelayedCompletionApprovalForTestsOnly(proposal, JSON.stringify(document), sha256(document) as Hex);
  return { ...base, source, certificate, proposal, approval };
}
