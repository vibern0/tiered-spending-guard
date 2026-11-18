import { expect } from "chai";
import { sha256 } from "../../../scripts/plan-deployment";
import {
  FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH,
  FRESH_SUCCESSOR_SCOPE,
  hashUsdcFreshSuccessorSource,
  isVerifiedUsdcFreshSuccessorCertificate,
  reverifyUsdcFreshSuccessorCertificate,
  serializeUsdcFreshSuccessorCertificate,
  verifyUsdcFreshSuccessorCertificate,
} from "../../../scripts/live/ordinary-scenario-usdc-fresh-successor-certificate";
import {
  createFreshSource,
  freshFaucetBlock,
  freshPrimary,
  freshProviders,
  freshSnapshot,
} from "../../support/usdc-fresh-successor-fixture";

describe("ordinary USDC fresh-period successor certificate", function () {
  it("binds the selected closed scope and exact authorized faucet transaction", function () {
    expect(FRESH_SUCCESSOR_SCOPE).to.equal("ordinary-usdc-fresh-period-successor-v1");
    expect(FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH).to.equal(
      "0x6230026c81cc67ce4aa3cf713838875c7b1d770cbe0f9b48b7b4b3b49f1a59fa",
    );
  });

  it("brands only the exact frozen source, historical proof, faucet receipt, and fresh checkpoint", async function () {
    const source = await createFreshSource();
    const certificate = await verifyUsdcFreshSuccessorCertificate(source, freshPrimary, await freshProviders(source));
    expect(isVerifiedUsdcFreshSuccessorCertificate(certificate)).to.equal(true);
    expect(isVerifiedUsdcFreshSuccessorCertificate({ ...certificate })).to.equal(false);
    expect(certificate.effectivePeriod).to.equal(1_793_318_400n);
    expect(certificate.currentCheckpoint).to.include({ blockNumber: freshSnapshot.number.toString(), blockHash: freshSnapshot.hash, snapshotNonce: 870, latestNonce: 870, pendingNonce: 870 });
    expect(certificate.rawUsdcSpend).to.deep.equal({ window: 1_793_232_000n, baseSpent: 10_000_000n, instantSpent: 20_000_000n });
    expect(certificate.safeUsdcBalance).to.equal(0n);
    expect(certificate.funderUsdcBalance).to.equal(40_000_000n);
    expect(certificate.faucet).to.deep.include({ transactionHash: FRESH_SUCCESSOR_FAUCET_TRANSACTION_HASH, blockNumber: freshFaucetBlock.number, blockHash: freshFaucetBlock.hash, amount: 20_000_000n, preBalance: 20_000_000n, postBalance: 40_000_000n });
    expect(hashUsdcFreshSuccessorSource(source)).to.equal(certificate.sourceHash);
  });

  it("rejects faucet envelope, receipt, canonicality, balance, confirmation, and provider disagreement", async function () {
    const source = await createFreshSource();
    const cases: Array<[string, any, RegExp]> = [
      ["recipient", { faucetTransaction: { inputHash: `0x${"1".repeat(64)}` } }, /faucet|input|transfer/i],
      ["token", { faucetTransaction: { to: source.prior.original.safe } }, /faucet|token|transaction/i],
      ["amount effect", { faucetPostBalance: 39_000_000n }, /faucet|balance|amount/i],
      ["prebalance", { faucetPreBalance: 19_000_000n }, /faucet|balance|amount/i],
      ["receipt", { faucetReceipt: { gasUsed: 1n } }, /faucet|receipt|gas/i],
      ["transfer recipient", { faucetLog: { to: source.prior.original.safe } }, /faucet|transfer|recipient|log/i],
      ["transfer amount", { faucetLog: { amount: 19_000_000n } }, /faucet|transfer|amount|log/i],
      ["removed transfer", { faucetLog: { removed: true } }, /faucet|transfer|removed|log/i],
      ["missing removed flag", { faucetLog: { removed: undefined } }, /faucet|transfer|removed|log/i],
      ["missing transfer", { omitFaucetLog: true }, /faucet|transfer|missing|log/i],
      ["reorg", { reorgHash: `0x${"2".repeat(64)}` }, /reorg|canonical/i],
      ["nonce", { pendingNonce: 871 }, /nonce|pending|disagree/i],
    ];
    for (const [label, mutation, error] of cases) {
      await expect(verifyUsdcFreshSuccessorCertificate(source, freshPrimary, await freshProviders(source, mutation, mutation)), label).to.be.rejectedWith(error);
    }
    await expect(verifyUsdcFreshSuccessorCertificate(source, freshPrimary, await freshProviders(source, {}, { state: { funderUsdcBalance: 41_000_000n } }))).to.be.rejectedWith(/provider|disagree|state/i);
    await expect(verifyUsdcFreshSuccessorCertificate(source, freshPrimary, await freshProviders(source, { snapshot: { number: freshFaucetBlock.number + 4n } }, { snapshot: { number: freshFaucetBlock.number + 4n } }))).to.be.rejectedWith(/confirmation|six/i);
  });

  it("uses the funder nonce and permits live nonce progress beyond the historical snapshot", async function () {
    const source = await createFreshSource();
    const advanced = { snapshotNonce: 871, latestNonce: 871, pendingNonce: 871 };
    const certificate = await verifyUsdcFreshSuccessorCertificate(source, freshPrimary, await freshProviders(source, advanced, advanced));
    expect(certificate.currentCheckpoint).to.include({ snapshotNonce: 871, latestNonce: 871, pendingNonce: 871 });
  });

  it("reverifies only the exact serialized certificate against fresh canonical reads", async function () {
    const source = await createFreshSource();
    const certificate = await verifyUsdcFreshSuccessorCertificate(source, freshPrimary, await freshProviders(source));
    const serialized = serializeUsdcFreshSuccessorCertificate(certificate);
    const restored = await reverifyUsdcFreshSuccessorCertificate(serialized, certificate.certificateHash, source, freshPrimary, await freshProviders(source));
    expect(isVerifiedUsdcFreshSuccessorCertificate(restored)).to.equal(true);
    const progressed = await reverifyUsdcFreshSuccessorCertificate(
      serialized,
      certificate.certificateHash,
      source,
      freshPrimary,
      await freshProviders(source, { latestNonce: 871, pendingNonce: 871 }, { latestNonce: 871, pendingNonce: 871 }),
    );
    expect(progressed.currentCheckpoint).to.deep.equal(certificate.currentCheckpoint);
    const changed = JSON.parse(serialized); changed.faucet.amount = "19000000";
    await expect(reverifyUsdcFreshSuccessorCertificate(JSON.stringify(changed), certificate.certificateHash, source, freshPrimary, await freshProviders(source))).to.be.rejectedWith(/certificate|hash|faucet|amount/i);
    const extra = JSON.parse(serialized); extra.trusted = true;
    await expect(reverifyUsdcFreshSuccessorCertificate(JSON.stringify(extra), certificate.certificateHash, source, freshPrimary, await freshProviders(source))).to.be.rejectedWith(/shape|certificate/i);
    for (const changedCheckpoint of [
      { stateHash: `0x${"0".repeat(64)}` },
      { snapshotNonce: -1, latestNonce: -1, pendingNonce: -1 },
    ]) {
      const forged = JSON.parse(serialized);
      Object.assign(forged.currentCheckpoint, changedCheckpoint);
      const { certificateHash: _oldHash, ...forgedBody } = forged;
      forged.certificateHash = sha256(forgedBody);
      await expect(
        reverifyUsdcFreshSuccessorCertificate(JSON.stringify(forged), forged.certificateHash, source, freshPrimary, await freshProviders(source)),
      ).to.be.rejectedWith(/checkpoint|state|nonce|snapshot/i);
    }
  });
});
