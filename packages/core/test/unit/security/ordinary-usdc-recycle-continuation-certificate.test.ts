import { expect } from "chai";
import { symlinkSync, writeFileSync } from "node:fs";
import type { Hex } from "viem";
import {
  hashUsdcRecycleContinuationSource,
  isVerifiedUsdcRecycleContinuationCertificate,
  loadUsdcRecycleContinuationSourceJournalReadOnly,
  reverifyUsdcRecycleContinuationCertificate,
  serializeUsdcRecycleContinuationCertificate,
  verifyUsdcRecycleContinuationCertificate,
} from "../../../scripts/live/ordinary-scenario-usdc-recycle-continuation-certificate";
import {
  canonicalRecycleState,
  cleanupUsdcRecycleContinuationFixtures,
  createUsdcRecycleContinuationSource,
  recycleFixture,
  recycleProviders,
  recycleSnapshot,
  sourceWithPinnedJournal,
  trackedRecycleJournal,
} from "../../support/usdc-recycle-continuation-fixture";

const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;

describe("ordinary USDC recycle continuation certificate", function () {
  afterEach(cleanupUsdcRecycleContinuationFixtures);

  it("exact_partial_source brands only the complete frozen stopped source and old opaque authority", async function () {
    const source = await createUsdcRecycleContinuationSource();
    const certificate = await verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source));
    expect(isVerifiedUsdcRecycleContinuationCertificate(certificate)).to.equal(true);
    expect(isVerifiedUsdcRecycleContinuationCertificate({ ...certificate })).to.equal(false);
    expect(certificate.sourceJournalBytesSha256).to.equal("0x3d860cf927ccbdd6cfe45864aa42cd60577f8e7745db046e061613e6d3242dae");
    expect(certificate.currentCheckpoint).to.deep.equal({ blockNumber: recycleSnapshot.number.toString(), blockHash: recycleSnapshot.hash, stateHash: certificate.currentCheckpoint.stateHash, snapshotNonce: 870, latestNonce: 870, pendingNonce: 870 });
    expect(certificate.rawNativeSpend).to.deep.equal({ window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n });
    expect(certificate.rawUsdcSpend).to.deep.equal({ window: 1_793_232_000n, baseSpent: 10_000_000n, instantSpent: 20_000_000n });
    expect(certificate.aggregateKnownChargeWei).to.equal(124_953_955_544n);
    expect(hashUsdcRecycleContinuationSource(source)).to.equal(certificate.sourceHash);
    expect(() => hashUsdcRecycleContinuationSource({ ...source, priorApproval: { ...source.priorApproval } as any })).to.throw(/opaque|approval|source/i);
    const alteredOriginal = { ...source, prior: { ...source.prior, original: { ...source.prior.original, recipient: `0x${"1".repeat(40)}` } } } as any;
    const alteredRecovery = { ...source, prior: { ...source.prior, recovery: { ...source.prior.recovery, observer: { ...source.prior.recovery.observer, publicId: "forged" } } } } as any;
    const alteredRecoveryApproval = { ...source, prior: { ...source.prior, recoveryApproval: { ...source.prior.recoveryApproval } } } as any;
    expect(() => hashUsdcRecycleContinuationSource(alteredOriginal)).to.throw(/original|lineage|source|opaque/i);
    expect(() => hashUsdcRecycleContinuationSource(alteredRecovery)).to.throw(/recovery|lineage|source|opaque/i);
    expect(() => hashUsdcRecycleContinuationSource(alteredRecoveryApproval)).to.throw(/approval|authorization|source|opaque/i);
  });

  it("rejects source locks, temporary files, symlinks, changed bytes, extra state, and secret-shaped fixtures", async function () {
    const locked = trackedRecycleJournal(); writeFileSync(`${locked.path}.lock`, "1\n");
    expect(() => loadUsdcRecycleContinuationSourceJournalReadOnly(locked.path)).to.throw(/lock/i);
    const temporary = trackedRecycleJournal(); writeFileSync(`${temporary.path}.partial.tmp`, "partial");
    expect(() => loadUsdcRecycleContinuationSourceJournalReadOnly(temporary.path)).to.throw(/temp/i);
    const linked = trackedRecycleJournal(); const alias = `${linked.path}.alias`; symlinkSync(linked.path, alias);
    expect(() => loadUsdcRecycleContinuationSourceJournalReadOnly(alias)).to.throw(/direct|symbolic|regular/i);
    for (const mutate of [
      (value: any) => { value.pending = {}; },
      (value: any) => { value.repairContinuation = {}; },
      (value: any) => { value.usdcSuccessor.actions[2].materializationHash = h("1"); },
      (value: any) => { value.liveJournal.entries.push({ ...value.liveJournal.entries[14], id: "extra" }); },
    ]) {
      const value = JSON.parse(recycleFixture.sourceJournal); mutate(value);
      expect(() => trackedRecycleJournal(`${JSON.stringify(value)}\n`).journal).to.throw(/source|shape|bytes|exact|initial/i);
    }
    const texts = Object.values(recycleFixture);
    const serialized = texts.map(value => typeof value === "string" ? value : JSON.stringify(value)).join("\n");
    expect(serialized).not.to.match(/privateKey|mnemonic|seedPhrase|rawTransaction|signedTransaction/i);
  });

  it("admits the reviewed delayed successor only as a pinned descendant field", function () {
    const value = JSON.parse(recycleFixture.sourceJournal); value.usdcDelayedSuccessor = { scope: "ordinary-usdc-delayed-tier-successor-v1" };
    expect(() => trackedRecycleJournal(`${JSON.stringify(value)}\n`, "pinned").journal).not.to.throw();
    expect(() => trackedRecycleJournal(`${JSON.stringify(value)}\n`, "initial").journal).to.throw(/shape|initial|source/i);
  });

  it("rejects every old header, row, materialization, receipt, cost, inclusion, and live-prefix mutation", async function () {
    const mutations: Array<[string, (value: any) => void]> = [
      ["header", value => { value.usdcSuccessor.approvalHash = h("2"); }],
      ["row", value => { value.usdcSuccessor.actions[3].status = "confirmed"; }],
      ["materialization", value => { value.usdcSuccessor.actions[2].outerNonce = 870; }],
      ["receipt", value => { value.usdcSuccessor.actions[0].receipt.blockHash = h("3"); }],
      ["cost", value => { value.usdcSuccessor.actions[1].ourReceiptGasCost = "1"; }],
      ["inclusion", value => { value.usdcSuccessor.actions[0].receiptInclusion.blockTimestamp = "1793318400"; }],
      ["live status", value => { value.liveJournal.entries[14].status = "pending"; }],
      ["live order", value => { [value.liveJournal.entries[13], value.liveJournal.entries[14]] = [value.liveJournal.entries[14], value.liveJournal.entries[13]]; }],
    ];
    for (const [label, mutate] of mutations) {
      const value = JSON.parse(recycleFixture.sourceJournal); mutate(value);
      expect(() => trackedRecycleJournal(`${JSON.stringify(value)}\n`).journal, label).to.throw();
    }
  });

  it("different_869_only requires the exact recovered legacy invalidation, six confirmations, gas product, and poststate", async function () {
    const source = await createUsdcRecycleContinuationSource();
    const valid = await verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source));
    expect(valid.invalidation).to.include({ transactionHash: "0xa81d6df9e9720da44c096b713fdf389fa28ae41aee2224d7f492560ee864781e", recoveredSender: source.prior.original.funder, nonce: 869, gasCost: 124_785_100_000n, cause: "UNKNOWN" });
    const row = source.prior.journal.usdcSuccessor!.actions[2] as any;
    const matching = { hash: valid.invalidation.transactionHash, patch: { type: "eip1559", to: row.outerTo, value: BigInt(row.outerValue), inputHash: row.outerDataHash, gas: BigInt(row.gas), maxFeePerGas: BigInt(row.maxFeePerGas), maxPriorityFeePerGas: BigInt(row.maxPriorityFeePerGas) } } as const;
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { transaction: matching }, { transaction: matching }))).to.be.rejectedWith(/MATCH_FOUND_RECONCILE|matching/i);
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { snapshotNonce: 869 }, { snapshotNonce: 869 }))).to.be.rejectedWith(/869|nonce|unused/i);
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { pendingNonce: 871 }, { pendingNonce: 871 }))).to.be.rejectedWith(/pending|nonce|disagree/i);
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { transaction: { hash: valid.invalidation.transactionHash, patch: { from: h("0").slice(0, 42) } } }, { transaction: { hash: valid.invalidation.transactionHash, patch: { from: h("0").slice(0, 42) } } }))).to.be.rejectedWith(/sender|transaction|legacy/i);
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { receipt: { hash: valid.invalidation.transactionHash, patch: { gasUsed: 1n } } }, { receipt: { hash: valid.invalidation.transactionHash, patch: { gasUsed: 1n } } }))).to.be.rejectedWith(/gas|receipt|product/i);
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { receiptState: { hash: valid.invalidation.transactionHash, patch: { safeNonce: 9n } } }, { receiptState: { hash: valid.invalidation.transactionHash, patch: { safeNonce: 9n } } }))).to.be.rejectedWith(/poststate|effect|nonce/i);
    const shallow = { snapshot: { number: 12_019_398n }, tip: { number: 12_019_403n, hash: h("9"), timestamp: 1_793_275_680n } } as const;
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, shallow, shallow))).to.be.rejectedWith(/confirmation|six/i);
  });

  it("canonical_checkpoint selects min-head minus five and rejects profile, reorg, period, and nonce disagreement", async function () {
    const source = await createUsdcRecycleContinuationSource();
    const unequal = await verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source));
    expect(unequal.currentCheckpoint.blockNumber).to.equal("12019400");
    const dynamic = await verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { snapshotNonce: 901 }, { snapshotNonce: 901 }));
    expect(dynamic.currentCheckpoint.snapshotNonce).to.equal(901);
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, {}, { snapshot: { hash: h("4") } }))).to.be.rejectedWith(/snapshot|provider|canonical|disagree/i);
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { state: { identityHash: h("5") } }, { state: { identityHash: h("5") } }))).to.be.rejectedWith(/profile|state|identity|topology/i);
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { reorgHash: h("6") }, { reorgHash: h("6") }))).to.be.rejectedWith(/reorg|canonical/i);
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { snapshot: { timestamp: 1_793_145_700n } }, { snapshot: { timestamp: 1_793_145_700n } }))).to.be.rejectedWith(/period|window/i);
    await expect(verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source, { latestNonce: 871 }, { latestNonce: 871 }))).to.be.rejectedWith(/nonce|snapshot|latest/i);
  });

  it("source_primary requires the exact manifest, watcher payload, delivery, acknowledgement, expiry, and hashes", async function () {
    const source = await createUsdcRecycleContinuationSource();
    await verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, await recycleProviders(source));
    for (const key of Object.keys(recycleFixture.primary) as Array<keyof typeof recycleFixture.primary>) {
      await expect(verifyUsdcRecycleContinuationCertificate(source, { ...recycleFixture.primary, [key]: "" }, await recycleProviders(source)), key).to.be.rejectedWith(/primary|manifest|hash|JSON/i);
    }
    const ledger = JSON.parse(recycleFixture.primary.stepUpLedger); const delivery = ledger.deliveries[Object.keys(ledger.deliveries)[0]]; delivery.payloadHash = h("7");
    await expect(verifyUsdcRecycleContinuationCertificate(source, { ...recycleFixture.primary, stepUpLedger: `${JSON.stringify(ledger)}\n` }, await recycleProviders(source))).to.be.rejectedWith(/primary|hash|delivery|payload/i);
    const ack = JSON.parse(recycleFixture.primary.stepUpAcknowledgement); ack.expiresAt = "2026-10-30T11:26:18Z";
    await expect(verifyUsdcRecycleContinuationCertificate(source, { ...recycleFixture.primary, stepUpAcknowledgement: `${JSON.stringify(ack)}\n` }, await recycleProviders(source))).to.be.rejectedWith(/primary|ack|expiry|hash/i);
    await expect(verifyUsdcRecycleContinuationCertificate(source, { ...recycleFixture.primary, stepUpLedger: JSON.stringify({ success: true }) }, await recycleProviders(source))).to.be.rejectedWith(/primary|ledger|shape|hash/i);
  });

  it("pinned_reverify restores only exact recorded evidence and permits sibling growth without source mutation", async function () {
    const source = await createUsdcRecycleContinuationSource(); const providers = await recycleProviders(source);
    const certificate = await verifyUsdcRecycleContinuationCertificate(source, recycleFixture.primary, providers);
    const serialized = serializeUsdcRecycleContinuationCertificate(certificate);
    const restored = await reverifyUsdcRecycleContinuationCertificate(serialized, certificate.certificateHash, source, recycleFixture.primary, providers);
    expect(isVerifiedUsdcRecycleContinuationCertificate(restored)).to.equal(true);
    const progressedValue = JSON.parse(recycleFixture.sourceJournal);
    progressedValue.usdcRecycleContinuation = { schemaVersion: 1, actions: [] };
    progressedValue.liveJournal.entries.push({ ...progressedValue.liveJournal.entries[14], id: "usdc-recycle-continuation-progress", transactionHash: h("8") });
    const progressed = sourceWithPinnedJournal(source, `${JSON.stringify(progressedValue)}\n`);
    await expect(verifyUsdcRecycleContinuationCertificate(progressed, recycleFixture.primary, await recycleProviders(progressed))).to.be.rejectedWith(/initial|exact|progress|source/i);
    expect(isVerifiedUsdcRecycleContinuationCertificate(await reverifyUsdcRecycleContinuationCertificate(serialized, certificate.certificateHash, progressed, recycleFixture.primary, await recycleProviders(progressed)))).to.equal(true);
    (progressed.prior.journal.usdcSuccessor!.actions[0] as any).receiptInclusion.blockTimestamp = "1793318400";
    await expect(reverifyUsdcRecycleContinuationCertificate(serialized, certificate.certificateHash, progressed, recycleFixture.primary, await recycleProviders(progressed))).to.be.rejectedWith(/source|prefix|inclusion|hash/i);
    const extra = JSON.parse(serialized); extra.trusted = true;
    await expect(reverifyUsdcRecycleContinuationCertificate(JSON.stringify(extra), certificate.certificateHash, source, recycleFixture.primary, providers)).to.be.rejectedWith(/shape|certificate/i);
  });
});
