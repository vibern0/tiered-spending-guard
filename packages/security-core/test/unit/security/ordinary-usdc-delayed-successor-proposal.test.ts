import { expect } from "chai";
import { decodeFunctionData } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import { usdcDelayedSuccessorSourceJournalBytesSha256 } from "../../../scripts/live/ordinary-scenario-usdc-delayed-successor-certificate";
import { createUsdcDelayedSuccessorSourceForTestsOnly } from "../../../scripts/live/ordinary-scenario-usdc-delayed-successor-certificate";
import {
  attachUsdcDelayedSuccessorForTestsOnly,
  createUsdcDelayedSuccessorProposal,
  loadUsdcDelayedSuccessorApprovalForTestsOnly,
} from "../../../scripts/live/ordinary-scenario-usdc-delayed-successor-proposal";
import { approvedDelayedSuccessor, delayedSuccessorCaps, delayedSuccessorObserver } from "../../support/usdc-delayed-successor-fixture";

const TOKEN_ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

describe("ordinary USDC delayed-tier successor proposal", function () {
  it("builds only the five literal Z-tier rows and exact terminal state", async function () {
    const fixture = await approvedDelayedSuccessor();
    expect(fixture.proposal.actions.map(action => action.id)).to.deep.equal([
      "usdc-delayed-successor-skip-expired",
      "usdc-delayed-successor-expired-execution-rejection",
      "usdc-delayed-successor-queue-execute",
      "usdc-delayed-successor-queue-execute-early-rejection",
      "usdc-delayed-successor-queue-ready-execute",
    ]);
    expect(fixture.proposal.actions.map(action => action.expectedOutcome)).to.deep.equal(["success", "rejection", "success", "rejection", "success"]);
    expect(fixture.proposal.actions.filter(action => action.expectedOutcome === "success")).to.have.length(3);
    expect(fixture.proposal.actions[2]!.signerRoles).to.deep.equal(["primary-passkey", "safe-contract-secondary"]);
    expect(fixture.proposal.actions[0]!.before).to.include({ safeNonce: "13", delayQueueNonce: "6", delayTxNonce: "5", safeUsdcBalance: "31000000", funderUsdcBalance: "9000000" });
    expect(fixture.proposal.actions[4]!.after).to.include({ safeNonce: "14", delayQueueNonce: "7", delayTxNonce: "7", safeUsdcBalance: "0", funderUsdcBalance: "40000000" });
  });

  it("binds the exact 31-USDC transfer, reservation, aggregate cap, and no funding", async function () {
    const fixture = await approvedDelayedSuccessor();
    const queue = fixture.proposal.actions[2]!;
    const decoded = decodeFunctionData({ abi: TOKEN_ABI, data: queue.queue!.data });
    expect(decoded.functionName).to.equal("transfer");
    expect(decoded.args?.[1]).to.equal(31_000_000n);
    expect(fixture.proposal.reservation).to.include({ successorMaximumReservationWei: "2600000000000", newGrossUsdcAllowance: "31000000", aggregateGrossUsdcAllowance: "51000000", inwardUsdcFunding: "0" });
    expect(fixture.proposal.actions.some(action => action.kind.includes("fund"))).to.equal(false);
    expect(fixture.proposal.repairAuthority).to.equal("NONE");
  });

  it("separates production proposal authority and rejects changed approval bytes", async function () {
    const fixture = await approvedDelayedSuccessor();
    expect(() => createUsdcDelayedSuccessorProposal({ source: fixture.source, certificate: fixture.certificate, observer: delayedSuccessorObserver, caps: delayedSuccessorCaps })).to.throw(/production|opaque|certificate/i);
    const document: any = {
      schemaVersion: 1,
      scope: fixture.proposal.scope,
      authorization: "FOCUSED_BOUNDED_DELAYED_SUCCESSOR_AUTHORIZATION",
      authorityEvidenceHash: fixture.proposal.authorityEvidenceHash,
      proposalHash: fixture.proposal.proposalHash,
      sourceJournalHash: fixture.proposal.sourceJournalHash,
      certificateHash: fixture.proposal.certificateHash,
      snapshot: fixture.proposal.snapshot,
      minimumOuterNonce: fixture.proposal.minimumOuterNonce,
      effectivePeriod: fixture.proposal.effectivePeriod,
      deadline: fixture.proposal.deadline,
      observer: fixture.proposal.observer,
      schedule: fixture.proposal.schedule,
      groups: fixture.proposal.groups,
      caps: fixture.proposal.caps,
      reservation: structuredClone(fixture.proposal.reservation),
      maxBroadcastAttempts: 1,
      repairAuthority: "NONE",
      approvedActions: fixture.proposal.actions.map(({ id, commitment }) => ({ id, commitment })),
    };
    document.reservation.successorMaximumReservationWei = "1";
    expect(() => loadUsdcDelayedSuccessorApprovalForTestsOnly(fixture.proposal, JSON.stringify(document), sha256(document) as `0x${string}`)).to.throw(/binding|reservation/i);
  });

  it("attaches once without changing predecessor bytes", async function () {
    const fixture = await approvedDelayedSuccessor();
    const before = usdcDelayedSuccessorSourceJournalBytesSha256(fixture.journal);
    const attached = attachUsdcDelayedSuccessorForTestsOnly(fixture.journal, fixture.proposal, fixture.approval);
    expect(usdcDelayedSuccessorSourceJournalBytesSha256(attached)).to.equal(before);
    expect(attached.usdcDelayedSuccessor.actions).to.have.length(5);
    expect(attached.usdcDelayedSuccessor.actions.every(action => action.status === "approved")).to.equal(true);
    expect(() => attachUsdcDelayedSuccessorForTestsOnly(attached, fixture.proposal, fixture.approval)).to.throw(/already|successor|attachment/i);
  });

  it("reconstructs the same immutable source after descendant live progress", async function () {
    const fixture = await approvedDelayedSuccessor();
    const attached = attachUsdcDelayedSuccessorForTestsOnly(fixture.journal, fixture.proposal, fixture.approval);
    const transactionHash = `0x${"7".repeat(64)}` as const, intentHash = `0x${"8".repeat(64)}` as const;
    attached.liveJournal.entries.push({ id: fixture.proposal.actions[0]!.id, intentHash, transactionHash, nonce: 917, reserved: 1n, status: "pending" });
    const rebuilt = createUsdcDelayedSuccessorSourceForTestsOnly({ prior: fixture.source.prior, delayedCertificate: fixture.source.delayedCertificate, delayedProposal: fixture.source.delayedProposal, delayedApproval: fixture.source.delayedApproval, journal: attached });
    expect(rebuilt.sourceJournalHash).to.equal(fixture.source.sourceJournalHash);
  });
});
