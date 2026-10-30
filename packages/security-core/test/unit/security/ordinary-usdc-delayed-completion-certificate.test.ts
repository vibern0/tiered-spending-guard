import { expect } from "chai";
import {
  createUsdcDelayedCompletionSource,
  isVerifiedUsdcDelayedCompletionCertificate,
  verifyUsdcDelayedCompletionCertificate,
} from "../../../scripts/live/ordinary-scenario-usdc-delayed-completion-certificate";
import { cleanupUsdcRecycleContinuationFixtures } from "../../support/usdc-recycle-continuation-fixture";
import { createDelayedCompletionFixture, delayedProviders } from "../../support/usdc-delayed-completion-fixture";

describe("ordinary USDC delayed-completion certificate", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  it("brands only the exact stopped fresh sibling and current two-provider state", async function () {
    const fixture = await createDelayedCompletionFixture();
    const source = createUsdcDelayedCompletionSource(fixture);
    const certificate = await verifyUsdcDelayedCompletionCertificate(source, await delayedProviders(fixture.historical));
    expect(isVerifiedUsdcDelayedCompletionCertificate(certificate)).to.equal(true);
    expect(certificate).to.include({ safeNonce: 10n, delayQueueNonce: 4n, delayTxNonce: 4n, safeUsdcBalance: 0n, funderUsdcBalance: 40_000_000n, minimumOuterNonce: 871 });
    expect(certificate.rawUsdcSpend).to.deep.equal({ window: 1_793_232_000n, baseSpent: 10_000_000n, instantSpent: 20_000_000n });
    expect(certificate.stoppedRow).to.include({ id: "usdc-fresh-successor-prefund-all", status: "signed-simulated", outerNonce: 870 });
  });

  it("rejects source mutation, live-entry fabrication, and provider disagreement", async function () {
    const fixture = await createDelayedCompletionFixture();
    const changed = structuredClone(fixture.journal);
    (changed.usdcFreshSuccessor!.actions[0] as any).status = "approved";
    expect(() => createUsdcDelayedCompletionSource({ ...fixture, journal: changed })).to.throw(/stopped|signed-simulated/i);
    const live = structuredClone(fixture.journal);
    live.liveJournal.entries.push({ ...live.liveJournal.entries[0]!, id: "usdc-fresh-successor-prefund-all" });
    expect(() => createUsdcDelayedCompletionSource({ ...fixture, journal: live })).to.throw(/live|stopped/i);
    const source = createUsdcDelayedCompletionSource(fixture);
    const providers = await delayedProviders(fixture.historical);
    const disagreeing = [providers[0], { ...providers[1], readControlledState: async (block: bigint) => ({ ...(await providers[1].readControlledState(block)), safeUsdcBalance: 1n }) }] as const;
    await expect(verifyUsdcDelayedCompletionCertificate(source, disagreeing)).to.be.rejectedWith(/provider|state|disagree/i);
  });
});
