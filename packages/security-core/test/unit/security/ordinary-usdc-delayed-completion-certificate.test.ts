import { expect } from "chai";
import {
  createUsdcDelayedCompletionSource,
  createUsdcDelayedCompletionSourceForTestsOnly,
  isVerifiedUsdcDelayedCompletionCertificate,
  reverifyUsdcDelayedCompletionCertificateForTestsOnly,
  serializeUsdcDelayedCompletionCertificate,
  verifyUsdcDelayedCompletionCertificate,
  verifyUsdcDelayedCompletionCertificateForTestsOnly,
} from "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-certificate";
import { cleanupUsdcRecycleContinuationFixtures } from "../../support/usdc-recycle-continuation-fixture";
import { createDelayedCompletionFixture, delayedProviders } from "../../support/usdc-delayed-completion-fixture";
import { sha256 } from "../../../scripts/plan-deployment";

describe("ordinary USDC delayed-completion certificate", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  it("does not admit test-only source authority through the production verifier", async function () {
    const fixture = await createDelayedCompletionFixture();
    const source = createUsdcDelayedCompletionSourceForTestsOnly(fixture);
    await expect(verifyUsdcDelayedCompletionCertificate(source, await delayedProviders(fixture.historical))).to.be.rejectedWith(/pinned|production|source/i);
  });

  it("brands only the exact stopped fresh sibling and current two-provider state", async function () {
    const fixture = await createDelayedCompletionFixture();
    const source = createUsdcDelayedCompletionSourceForTestsOnly(fixture);
    const certificate = await verifyUsdcDelayedCompletionCertificateForTestsOnly(source, await delayedProviders(fixture.historical));
    expect(isVerifiedUsdcDelayedCompletionCertificate(certificate)).to.equal(true);
    expect(certificate).to.include({ safeNonce: 10n, delayQueueNonce: 4n, delayTxNonce: 4n, safeUsdcBalance: 0n, funderUsdcBalance: 40_000_000n, minimumOuterNonce: 906 });
    expect(certificate.rawUsdcSpend).to.deep.equal({ window: 1_793_232_000n, baseSpent: 10_000_000n, instantSpent: 20_000_000n });
    expect(certificate.stoppedRow).to.include({ id: "usdc-fresh-successor-prefund-all", status: "signed-simulated", outerNonce: 905 });
  });

  it("rejects source mutation, live-entry fabrication, and provider disagreement", async function () {
    const fixture = await createDelayedCompletionFixture();
    const changed = structuredClone(fixture.journal);
    (changed.usdcFreshSuccessor!.actions[0] as any).status = "approved";
    expect(() => createUsdcDelayedCompletionSourceForTestsOnly({ ...fixture, journal: changed })).to.throw(/stopped|signed-simulated/i);
    const live = structuredClone(fixture.journal);
    live.liveJournal.entries.push({ ...live.liveJournal.entries[0]!, id: "usdc-fresh-successor-prefund-all" });
    expect(() => createUsdcDelayedCompletionSourceForTestsOnly({ ...fixture, journal: live })).to.throw(/live|stopped/i);
    expect(() => createUsdcDelayedCompletionSource(fixture)).to.throw(/pinned|nonce-905|source/i);
    const source = createUsdcDelayedCompletionSourceForTestsOnly(fixture);
    const providers = await delayedProviders(fixture.historical);
    const disagreeing = [providers[0], { ...providers[1], readControlledState: async (block: bigint) => ({ ...(await providers[1].readControlledState(block)), safeUsdcBalance: 1n }) }] as const;
    await expect(verifyUsdcDelayedCompletionCertificateForTestsOnly(source, disagreeing)).to.be.rejectedWith(/provider|state|disagree/i);
  });

  it("reverifies the exact recorded snapshot while allowing later resolved nonce progress", async function () {
    const fixture = await createDelayedCompletionFixture();
    const source = createUsdcDelayedCompletionSourceForTestsOnly(fixture);
    const certificate = await verifyUsdcDelayedCompletionCertificateForTestsOnly(source, await delayedProviders(fixture.historical));
    const restored = await reverifyUsdcDelayedCompletionCertificateForTestsOnly(serializeUsdcDelayedCompletionCertificate(certificate), certificate.certificateHash, source, await delayedProviders(fixture.historical, { latestNonce: 907, pendingNonce: 907 }));
    expect(isVerifiedUsdcDelayedCompletionCertificate(restored)).to.equal(true);
    expect(restored.certificateHash).to.equal(certificate.certificateHash);
  });

  it("rebuilds every recorded claim from the authenticated source and canonical providers", async function () {
    const fixture = await createDelayedCompletionFixture(), source = createUsdcDelayedCompletionSourceForTestsOnly(fixture), providers = await delayedProviders(fixture.historical);
    const certificate = await verifyUsdcDelayedCompletionCertificateForTestsOnly(source, providers), value: any = JSON.parse(serializeUsdcDelayedCompletionCertificate(certificate));
    value.effectivePeriod = String(BigInt(value.effectivePeriod) + 86_400n); const { certificateHash: _old, ...body } = value; value.certificateHash = sha256(body);
    await expect(reverifyUsdcDelayedCompletionCertificateForTestsOnly(JSON.stringify(value), value.certificateHash, source, providers)).to.be.rejectedWith(/unchecked|changed|hash|claim/i);
    await expect(reverifyUsdcDelayedCompletionCertificateForTestsOnly(serializeUsdcDelayedCompletionCertificate(certificate), certificate.certificateHash, source, [providers[0], providers[0]])).to.be.rejectedWith(/independent/i);
  });

  it("requires the first clean nonce to be exactly the stopped nonce plus one", async function () {
    const fixture = await createDelayedCompletionFixture(), source = createUsdcDelayedCompletionSourceForTestsOnly(fixture);
    await expect(verifyUsdcDelayedCompletionCertificateForTestsOnly(source, await delayedProviders(fixture.historical, { snapshotNonce: 907, latestNonce: 907, pendingNonce: 907 }))).to.be.rejectedWith(/consume|nonce/i);
  });
});
