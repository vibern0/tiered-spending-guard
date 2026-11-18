import { expect } from "chai";
import { writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { sha256 } from "../../../scripts/plan-deployment";
import { loadHashlessSourceJournalReadOnly } from "../../../scripts/live/ordinary-scenario-hashless-certificate";
import {
  hashUsdcSuccessorSource,
  isVerifiedUsdcSuccessorCertificate,
  reverifyUsdcSuccessorCertificate,
  serializeUsdcSuccessorCertificate,
  verifyUsdcSuccessorCertificate,
  type UsdcSuccessorPrimaryEvidence,
  type UsdcSuccessorSource,
} from "../../../scripts/live/ordinary-scenario-usdc-successor-certificate";
import { canonicalUsdcSuccessorState as canonicalState, cleanupUsdcSuccessorFixtures, createUsdcSuccessorSource as source, fixtureHash as h, successorReceiptHashes as receiptHashes, successorSnapshot as snapshot, trackedUsdcSuccessorJournal as trackedJournal, usdcSuccessorFixture as fixture, usdcSuccessorProvider as provider } from "../../support/usdc-successor-fixture";

describe("ordinary USDC successor certificate", function () {
  afterEach(cleanupUsdcSuccessorFixtures);

  it("exact_19_10_plus3_source brands only the immutable approved predecessor", async function () {
    const src = await source();
    const certificate = await verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src), provider(1, src)]);
    expect(isVerifiedUsdcSuccessorCertificate(certificate)).to.equal(true);
    expect(isVerifiedUsdcSuccessorCertificate({ ...certificate })).to.equal(false);
    expect(certificate.effectivePeriod).to.equal(1_793_232_000n);
    expect(certificate.rawNativeSpend.window).to.equal(1_793_145_600n);
    expect(certificate.rawUsdcSpend.window).to.equal(0n);

    const started = await source(); (started.journal.hashlessContinuation!.actions[3] as any).status = "materialized";
    await expect(verifyUsdcSuccessorCertificate(started, fixture.primary, [provider(0, started), provider(1, started)])).to.be.rejectedWith(/USDC|untouched|approved/i);
    const pending = await source(); (pending.journal.liveJournal.entries as any[]).push({ ...pending.journal.liveJournal.entries[0], id: "forged", status: "pending" });
    await expect(verifyUsdcSuccessorCertificate(pending, fixture.primary, [provider(0, pending), provider(1, pending)])).to.be.rejectedWith(/live|13|source/i);
    const repair = await source(); (repair.journal as any).repairContinuation = {};
    await expect(verifyUsdcSuccessorCertificate(repair, fixture.primary, [provider(0, repair), provider(1, repair)])).to.be.rejectedWith(/repair|source/i);
    const forged = structuredClone(src) as UsdcSuccessorSource;
    await expect(verifyUsdcSuccessorCertificate(forged, fixture.primary, [provider(0, forged), provider(1, forged)])).to.be.rejectedWith(/opaque|source|authorization/i);
  });

  it("rejects source file locks, temporary files, and predecessor byte mutations", async function () {
    const locked = trackedJournal(); writeFileSync(`${locked.path}.lock`, "1\n");
    expect(() => loadHashlessSourceJournalReadOnly(locked.path)).to.throw(/lock/i);
    const temporary = trackedJournal(); writeFileSync(`${temporary.path}.x.tmp`, "partial");
    expect(() => loadHashlessSourceJournalReadOnly(temporary.path)).to.throw(/temp/i);
    const value = JSON.parse(fixture.sourceJournal); value.hashlessContinuation.actions[0].receipt.gasUsed = "40111";
    const mutated = await source(`${JSON.stringify(value)}\n`);
    await expect(verifyUsdcSuccessorCertificate(mutated, fixture.primary, [provider(0, mutated), provider(1, mutated)])).to.be.rejectedWith(/source|hash|receipt/i);
  });

  it("rejects every historical or recovery header, receipt, status, cost, and live-order mutation", async function () {
    const mutations: Array<[string, (value: any) => void]> = [
      ["historical header", value => { value.approvalHash = h("2"); }],
      ["historical receipt", value => { value.actions[0].receipt.blockHash = h("3"); }],
      ["historical status", value => { value.actions[0].status = "reverted"; }],
      ["historical cost", value => { value.actions[0].ourReceiptGasCost = "1"; }],
      ["recovery header", value => { value.hashlessContinuation.approvalHash = h("4"); }],
      ["recovery receipt", value => { value.hashlessContinuation.actions[1].receipt.blockHash = h("5"); }],
      ["recovery status", value => { value.hashlessContinuation.actions[1].status = "stopped"; }],
      ["recovery cost", value => { value.hashlessContinuation.actions[1].ourReceiptGasCost = "1"; }],
      ["extra live", value => { value.liveJournal.entries.push({ ...value.liveJournal.entries[12], id: "extra" }); }],
      ["reordered live", value => { [value.liveJournal.entries[10], value.liveJournal.entries[11]] = [value.liveJournal.entries[11], value.liveJournal.entries[10]]; }],
    ];
    for (const [label, mutate] of mutations) {
      const value = JSON.parse(fixture.sourceJournal); mutate(value);
      let rejected: unknown;
      try {
        const mutated = await source(`${JSON.stringify(value)}\n`);
        await verifyUsdcSuccessorCertificate(mutated, fixture.primary, [provider(0, mutated), provider(1, mutated)]);
      } catch (error) { rejected = error; }
      expect(rejected, label).to.be.instanceOf(Error);
    }
  });

  it("two_provider_period selects min-tip minus five and rejects missing, old, disagreeing, or reorged data", async function () {
    const src = await source();
    expect((await verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src), provider(1, src)])).snapshot.block.number).to.equal(snapshot.number);
    await expect(verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src, { missingBlock: true }), provider(1, src)])).to.be.rejectedWith(/snapshot|block|missing/i);
    await expect(verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src, { snapshot: { timestamp: 1_793_145_700n } }), provider(1, src, { snapshot: { timestamp: 1_793_145_700n } })])).to.be.rejectedWith(/period|old/i);
    await expect(verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src), provider(1, src, { snapshot: { hash: h("d") } })])).to.be.rejectedWith(/disagree|canonical|snapshot/i);
    await expect(verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src), provider(1, src, { state: { identityHash: h("6") } })])).to.be.rejectedWith(/state|identity|provider|canonical/i);
    await expect(verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src, { transactionMissing: receiptHashes[1] }), provider(1, src)])).to.be.rejectedWith(/transaction|missing/i);
    await expect(verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src, { reorgHash: h("e") }), provider(1, src, { reorgHash: h("e") })])).to.be.rejectedWith(/reorg|canonical/i);
    await expect(verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src, { receipt: { hash: receiptHashes[0], patch: { status: "reverted" } } }), provider(1, src, { receipt: { hash: receiptHashes[0], patch: { status: "reverted" } } })])).to.be.rejectedWith(/receipt|status/i);
    const falseEffects = [
      { label: "skip did not advance Delay tx nonce", hash: receiptHashes[0], patch: { delayTxNonce: 2n } },
      { label: "Safe outer success did not queue item", hash: receiptHashes[1], patch: { delayQueueNonce: 3n } },
      { label: "queue execution did not transfer principal", hash: receiptHashes[2], patch: { safeNativeBalance: 1n } },
    ] as const;
    for (const effect of falseEffects) {
      const receiptState = { hash: effect.hash, patch: effect.patch };
      await expect(verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src, { receiptState }), provider(1, src, { receiptState })]), effect.label).to.be.rejectedWith(/effect|poststate|queue|nonce/i);
    }
  });

  it("binds all three canonical recovery transactions to frozen type-2 fee envelopes", async function () {
    const src = await source();
    const mutations = [
      { label: "legacy type", patch: { type: "legacy", gasPrice: 20n, v: 22_310_258n } },
      { label: "max fee", patch: { maxFeePerGas: 21n } },
      { label: "priority fee", patch: { maxPriorityFeePerGas: 3n } },
    ];
    for (const hash of receiptHashes) for (const mutation of mutations) {
      const changed = { hash, patch: mutation.patch };
      await expect(verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src, { transaction: changed }), provider(1, src, { transaction: changed })]), `${hash}: ${mutation.label}`).to.be.rejectedWith(/transaction|envelope|type|fee/i);
    }
  });

  it("raw_native_not_effective preserves the old native tuple while deriving the actual new period", async function () {
    const src = await source();
    const certificate = await verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src), provider(1, src)]);
    expect(certificate.rawNativeSpend).to.deep.equal({ window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n });
    expect(certificate.effectivePeriod).to.equal(1_793_232_000n);
    const changed = { ...canonicalState(src.original), nativeSpend: { window: 1_793_232_000n, baseSpent: 0n, instantSpent: 0n } };
    await expect(verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src, { state: changed }), provider(1, src, { state: changed })])).to.be.rejectedWith(/native|raw|state/i);
  });

  it("primary_proofs require all pinned bytes and recompute exact delivery and acknowledgement bindings", async function () {
    const src = await source();
    await verifyUsdcSuccessorCertificate(src, fixture.primary, [provider(0, src), provider(1, src)]);
    for (const key of Object.keys(fixture.primary) as Array<keyof UsdcSuccessorPrimaryEvidence>) {
      const missing = { ...fixture.primary, [key]: "" };
      await expect(verifyUsdcSuccessorCertificate(src, missing, [provider(0, src), provider(1, src)])).to.be.rejectedWith(/primary|manifest|evidence|hash|JSON/i, key);
    }
    const ledger = JSON.parse(fixture.primary.ledgerReplacementNativeItem3); const deliveryKey = Object.keys(ledger.deliveries)[0]; ledger.deliveries[deliveryKey].payloadHash = h("f");
    await expect(verifyUsdcSuccessorCertificate(src, { ...fixture.primary, ledgerReplacementNativeItem3: `${JSON.stringify(ledger)}\n` }, [provider(0, src), provider(1, src)])).to.be.rejectedWith(/primary|hash|payload|delivery/i);
    const summaryOnly = { ...fixture.primary, ledgerSourceNativeItem2: JSON.stringify({ success: true }) };
    await expect(verifyUsdcSuccessorCertificate(src, summaryOnly, [provider(0, src), provider(1, src)])).to.be.rejectedWith(/primary|manifest|shape|ledger/i);
  });

  it("fixed_source_hash survives successor growth but not predecessor mutation", async function () {
    const src = await source(); const fixed = hashUsdcSuccessorSource(src.journal);
    src.journal.liveJournal.entries.push({ ...src.journal.liveJournal.entries[0]!, id: "usdc-successor-later" });
    (src.journal as any).usdcSuccessor = { actions: [] };
    expect(hashUsdcSuccessorSource(src.journal)).to.equal(fixed);
    (src.journal.hashlessContinuation!.actions[0] as any).evidenceHash = h("1");
    expect(hashUsdcSuccessorSource(src.journal)).not.to.equal(fixed);
  });

  it("pinned_reverify restores the brand only for exact serialized shape, hash, and canonical history", async function () {
    const src = await source(); const providers = [provider(0, src), provider(1, src)] as const;
    const certificate = await verifyUsdcSuccessorCertificate(src, fixture.primary, providers);
    const serialized = serializeUsdcSuccessorCertificate(certificate);
    const pinnedOnly = (base: UsdcSuccessorEvidenceProvider): UsdcSuccessorEvidenceProvider => ({
      ...base,
      readLatestBlock: async () => { throw new Error("must not regenerate current snapshot"); },
      readTransactionCount: async (address, block) => {
        if (block === "latest" || block === "pending") throw new Error("must not read current nonce state");
        return base.readTransactionCount(address, block);
      },
    });
    const restored = await reverifyUsdcSuccessorCertificate(serialized, certificate.certificateHash, src, fixture.primary, [pinnedOnly(provider(0, src)), pinnedOnly(provider(1, src))]);
    expect(isVerifiedUsdcSuccessorCertificate(restored)).to.equal(true);
    expect(restored.snapshot).to.deep.equal(certificate.snapshot);
    const extra = JSON.parse(serialized); extra.trusted = true;
    await expect(reverifyUsdcSuccessorCertificate(JSON.stringify(extra), certificate.certificateHash, src, fixture.primary, providers)).to.be.rejectedWith(/shape|certificate/i);
    await expect(reverifyUsdcSuccessorCertificate(serialized, h("0"), src, fixture.primary, providers)).to.be.rejectedWith(/hash/i);
  });

  it("pinned_reverify accepts later same-journal live progress but preserves strict initial admission and the fixed prefix", async function () {
    const clean = await source(); const certificate = await verifyUsdcSuccessorCertificate(clean, fixture.primary, [provider(0, clean), provider(1, clean)]);
    const value = JSON.parse(fixture.sourceJournal);
    value.liveJournal.entries.push({ ...value.liveJournal.entries[12], id: "usdc-successor-progress", transactionHash: h("7") });
    const progressed = await source(`${JSON.stringify(value)}\n`);
    await expect(verifyUsdcSuccessorCertificate(progressed, fixture.primary, [provider(0, progressed), provider(1, progressed)])).to.be.rejectedWith(/exact|source|13|progress/i);
    const restored = await reverifyUsdcSuccessorCertificate(serializeUsdcSuccessorCertificate(certificate), certificate.certificateHash, progressed, fixture.primary, [provider(0, progressed), provider(1, progressed)]);
    expect(isVerifiedUsdcSuccessorCertificate(restored)).to.equal(true);
    (progressed.journal.liveJournal.entries[12] as any).transactionHash = h("8");
    await expect(reverifyUsdcSuccessorCertificate(serializeUsdcSuccessorCertificate(certificate), certificate.certificateHash, progressed, fixture.primary, [provider(0, progressed), provider(1, progressed)])).to.be.rejectedWith(/source|hash|prefix|live/i);
  });

  it("pinned_reverify derives the effective period from the pinned snapshot timestamp", async function () {
    const src = await source(); const providers = [provider(0, src), provider(1, src)] as const;
    const certificate = await verifyUsdcSuccessorCertificate(src, fixture.primary, providers);
    const value = JSON.parse(serializeUsdcSuccessorCertificate(certificate));
    value.effectivePeriod = "1793318400";
    const { certificateHash: _oldHash, ...body } = value;
    value.certificateHash = sha256(body);
    await expect(reverifyUsdcSuccessorCertificate(`${JSON.stringify(value)}\n`, value.certificateHash, src, fixture.primary, providers)).to.be.rejectedWith(/effective period|snapshot|period/i);
  });
});
