import { expect } from "chai";
import {
  createUsdcDelayedSuccessorSource,
  createUsdcDelayedSuccessorSourceForTestsOnly,
  isVerifiedUsdcDelayedSuccessorCertificate,
  isVerifiedUsdcDelayedSuccessorCertificateForTestsOnly,
  verifyUsdcDelayedSuccessorCertificate,
  verifyUsdcDelayedSuccessorCertificateForTestsOnly,
} from "../../../scripts/live/ordinary-scenario-usdc-delayed-successor-certificate";
import {
  createDelayedSuccessorFixture,
  delayedSuccessorProviders,
} from "../../support/usdc-delayed-successor-fixture";

describe("ordinary USDC delayed-tier successor certificate", function () {
  it("separates test source and certificate authority from production", async function () {
    const fixture = await createDelayedSuccessorFixture();
    const input = { prior: fixture.source, delayedCertificate: fixture.certificate, delayedProposal: fixture.proposal, delayedApproval: fixture.approval, journal: fixture.journal };
    const source = createUsdcDelayedSuccessorSourceForTestsOnly(input);
    await expect(verifyUsdcDelayedSuccessorCertificate(source, await delayedSuccessorProviders(fixture))).to.be.rejectedWith(/production|pinned|source/i);
    const certificate = await verifyUsdcDelayedSuccessorCertificateForTestsOnly(source, await delayedSuccessorProviders(fixture));
    expect(isVerifiedUsdcDelayedSuccessorCertificate(certificate)).to.equal(false);
    expect(isVerifiedUsdcDelayedSuccessorCertificateForTestsOnly(certificate)).to.equal(true);
    expect(() => createUsdcDelayedSuccessorSource(input)).to.throw(/production|pinned|source|journal/i);
  });

  it("binds the exact progressed predecessor and active expired queue", async function () {
    const fixture = await createDelayedSuccessorFixture();
    const source = createUsdcDelayedSuccessorSourceForTestsOnly({ prior: fixture.source, delayedCertificate: fixture.certificate, delayedProposal: fixture.proposal, delayedApproval: fixture.approval, journal: fixture.journal });
    const certificate = await verifyUsdcDelayedSuccessorCertificateForTestsOnly(source, await delayedSuccessorProviders(fixture));
    expect(certificate).to.include({ minimumOuterNonce: 917, safeNonce: 13n, delayQueueNonce: 6n, delayTxNonce: 5n, safeUsdcBalance: 31_000_000n, funderUsdcBalance: 9_000_000n });
    expect(certificate.activeQueue).to.include({ queueNonce: 5n });
    expect(certificate.stoppedRow).to.include({ id: "usdc-delayed-completion-queue-expiry-skip", status: "signed-simulated", outerNonce: 916 });
    expect(source.journal.liveJournal.entries).to.have.length(19);
  });

  it("rejects predecessor mutation, wrong stopped state, and provider disagreement", async function () {
    const fixture = await createDelayedSuccessorFixture();
    const input = { prior: fixture.source, delayedCertificate: fixture.certificate, delayedProposal: fixture.proposal, delayedApproval: fixture.approval, journal: fixture.journal };
    const changed = structuredClone(fixture.journal);
    (changed.usdcDelayedCompletion!.actions[8] as any).status = "approved";
    expect(() => createUsdcDelayedSuccessorSourceForTestsOnly({ ...input, journal: changed })).to.throw(/stopped|row|status/i);
    const old = structuredClone(fixture.journal);
    old.usdcDelayedCompletion!.actions[0] = { ...old.usdcDelayedCompletion!.actions[0]!, id: "changed" } as any;
    expect(() => createUsdcDelayedSuccessorSourceForTestsOnly({ ...input, journal: old })).to.throw(/catalog|predecessor|row/i);
    const source = createUsdcDelayedSuccessorSourceForTestsOnly(input);
    const providers = await delayedSuccessorProviders(fixture);
    const disagreeing = await delayedSuccessorProviders(fixture, { state: { safeNonce: 14n } });
    await expect(verifyUsdcDelayedSuccessorCertificateForTestsOnly(source, [providers[0], disagreeing[1]])).to.be.rejectedWith(/provider|state|disagree/i);
  });

  it("accepts the first clean nonce after the stopped row and rejects a pending split", async function () {
    const fixture = await createDelayedSuccessorFixture();
    const source = createUsdcDelayedSuccessorSourceForTestsOnly({ prior: fixture.source, delayedCertificate: fixture.certificate, delayedProposal: fixture.proposal, delayedApproval: fixture.approval, journal: fixture.journal });
    const certificate = await verifyUsdcDelayedSuccessorCertificateForTestsOnly(source, await delayedSuccessorProviders(fixture, { snapshotNonce: 920, latestNonce: 920, pendingNonce: 920 }));
    expect(certificate.minimumOuterNonce).to.equal(920);
    await expect(verifyUsdcDelayedSuccessorCertificateForTestsOnly(source, await delayedSuccessorProviders(fixture, { snapshotNonce: 920, latestNonce: 920, pendingNonce: 921 }))).to.be.rejectedWith(/pending|nonce|inconsistent/i);
  });
});
