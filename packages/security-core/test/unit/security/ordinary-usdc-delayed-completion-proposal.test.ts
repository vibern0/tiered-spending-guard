import { expect } from "chai";
import { decodeFunctionData, type Hex } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import {
  DELAYED_COMPLETION_GROUPS,
  DELAYED_COMPLETION_SCHEDULE,
  attachUsdcDelayedCompletion,
  createUsdcDelayedCompletionProposal,
  loadUsdcDelayedCompletionApproval,
  parseUsdcDelayedCompletionProposal,
} from "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-proposal";
import { createUsdcDelayedCompletionSourceForTestsOnly, verifyUsdcDelayedCompletionCertificate } from "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-certificate";
import { cleanupUsdcRecycleContinuationFixtures } from "../../support/usdc-recycle-continuation-fixture";
import { createDelayedCompletionFixture, delayedCaps, delayedObserver, delayedProviders } from "../../support/usdc-delayed-completion-fixture";

const ids = ["prefund-all", "direct-above-y-rejection", "queue-cancel", "queue-cancel-early-rejection", "queue-cancel-action", "queue-cancelled-execution-rejection", "queue-expiry", "queue-expiry-early-rejection", "queue-expiry-skip", "queue-expired-execution-rejection", "queue-execute", "queue-execute-early-rejection", "queue-ready-execute"].map(id => `usdc-delayed-completion-${id}`);
const tokenAbi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool" }] }] as const;

describe("ordinary USDC delayed-completion proposal", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  async function fixture() {
    const base = await createDelayedCompletionFixture();
  const source = createUsdcDelayedCompletionSourceForTestsOnly(base);
    const certificate = await verifyUsdcDelayedCompletionCertificate(source, await delayedProviders(base.historical));
    const proposal = createUsdcDelayedCompletionProposal({ source, certificate, observer: delayedObserver, caps: delayedCaps });
    return { ...base, source, certificate, proposal };
  }

  it("constructs exactly thirteen Z-only rows with seven broadcasts and six proofs", async function () {
    const { proposal } = await fixture();
    expect(proposal.actions.map(action => action.id)).to.deep.equal(ids);
    expect(proposal.actions.filter(action => action.expectedOutcome === "success")).to.have.length(7);
    expect(proposal.actions.filter(action => action.expectedOutcome === "rejection")).to.have.length(6);
    expect(proposal.actions.filter(action => action.safeTransaction).map(action => action.safeTransaction!.nonce)).to.deep.equal(["10", "10", "11", "12", "13"]);
    for (const action of proposal.actions.filter(action => action.queue)) {
      const decoded = decodeFunctionData({ abi: tokenAbi, data: action.queue!.data });
      expect(decoded.args?.[1]).to.equal(31_000_000n);
    }
    expect(proposal.actions[0]!.before).to.include({ safeNonce: "10", delayQueueNonce: "4", delayTxNonce: "4", safeUsdcBalance: "0", funderUsdcBalance: "40000000", usdcBaseSpent: "10000000", usdcInstantSpent: "20000000" });
    expect(proposal.actions[12]!.after).to.include({ safeNonce: "14", delayQueueNonce: "7", delayTxNonce: "7", safeUsdcBalance: "0", funderUsdcBalance: "40000000", usdcBaseSpent: "10000000", usdcInstantSpent: "20000000" });
  });

  it("binds exact caps, schedule, accounting, parser, approval, and append-only attachment", async function () {
    const { journal, source, certificate, proposal } = await fixture();
    expect(DELAYED_COMPLETION_SCHEDULE.reviewAdmission).to.equal("3600");
    expect(DELAYED_COMPLETION_GROUPS.map(group => group.budgetSeconds)).to.deep.equal(["300", "600", "1200", "600"]);
    expect(proposal.reservation).to.include({ successorMaximumReservationWei: "9340292000000", newGrossUsdcAllowance: "31000000", aggregateGrossUsdcAllowance: "51000000", inwardUsdcFunding: "31000000", maximumCumulativeOutlayWei: "140501418272986" });
    expect(parseUsdcDelayedCompletionProposal(JSON.stringify(proposal), source, certificate).proposalHash).to.equal(proposal.proposalHash);
    const document = { schemaVersion: 1, scope: proposal.scope, authorization: "FOCUSED_BOUNDED_DELAYED_COMPLETION_AUTHORIZATION", authorityEvidenceHash: proposal.authorityEvidenceHash, proposalHash: proposal.proposalHash, sourceJournalHash: proposal.sourceJournalHash, certificateHash: proposal.certificateHash, snapshot: proposal.snapshot, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, observer: proposal.observer, schedule: proposal.schedule, groups: proposal.groups, caps: proposal.caps, reservation: proposal.reservation, maxBroadcastAttempts: 1, repairAuthority: "NONE", approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
    const approval = loadUsdcDelayedCompletionApproval(proposal, JSON.stringify(document), sha256(document) as Hex);
    const before = JSON.stringify(journal);
    const attached = attachUsdcDelayedCompletion(journal, proposal, approval);
    expect(JSON.stringify({ ...attached, usdcDelayedCompletion: undefined })).to.equal(JSON.stringify({ ...JSON.parse(before), usdcDelayedCompletion: undefined }));
    expect(attached.usdcDelayedCompletion.actions).to.have.length(13);
    expect(() => attachUsdcDelayedCompletion(attached, proposal, approval)).to.throw(/already|attached/i);
  });
});
