import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Address, Hex } from "viem";
import { createOrdinaryScenarioProposal } from "../../../scripts/live/ordinary-scenario-executor";
import {
  loadHashlessSourceJournalReadOnly,
  reverifyHashlessStateCertificate,
  type HashlessControlledState,
  type HashlessEvidenceProvider,
} from "../../../scripts/live/ordinary-scenario-hashless-certificate";
import {
  loadExpiredHashlessContinuationApproval,
  parseExpiredHashlessContinuationProposal,
} from "../../../scripts/live/ordinary-scenario-hashless-continuation";
import {
  hashUsdcSuccessorSource,
  isVerifiedUsdcSuccessorCertificate,
  reverifyUsdcSuccessorCertificate,
  serializeUsdcSuccessorCertificate,
  verifyUsdcSuccessorCertificate,
  type UsdcSuccessorCanonicalState,
  type UsdcSuccessorEvidenceProvider,
  type UsdcSuccessorPrimaryEvidence,
  type UsdcSuccessorSource,
} from "../../../scripts/live/ordinary-scenario-usdc-successor-certificate";

const fixture = JSON.parse(readFileSync(join(__dirname, "../../fixtures/ordinary-usdc-successor-source.public.json"), "utf8")) as {
  sourceJournal: string;
  recoveryCertificate: string;
  recoveryProposal: string;
  recoveryApproval: string;
  primary: UsdcSuccessorPrimaryEvidence;
};
const review = readFileSync(join(__dirname, "../../fixtures/ordinary-scenario-review.public.json"), "utf8");
const recoveryCertificateHash = "0x43742e96deb6855d1b2e86b268080892c700f453ffd36da4284de3ec2d252efc" as Hex;
const recoveryApprovalHash = "0x644bf0b6e9cd4710683717511db665684ff31a86107198282d2364c9816dee26" as Hex;
const funder = "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address;
const safe = "0xd751a1479f49d63DC61E0081B0b4d8c60623D9a6" as Address;
const delay = "0xB8E143098CcCb9935228022173c2c987DF5FD53a" as Address;
const usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const h = (byte: string): Hex => `0x${byte.repeat(64)}` as Hex;

const oldSelected = { number: 12_013_857n, hash: "0x197add23b0385bce509adab0a3f3234b58b71e63d0ebccad9aa2e99ba5f44e20" as Hex, timestamp: 1_793_209_056n };
const oldCertified = { number: 12_013_934n, hash: "0x05d0f3b8f503bfee60455adc88c717e330aa2bafaffb6badca3b5c8215f3948e" as Hex, timestamp: 1_793_209_980n };
const oldCurrent = { number: 12_015_137n, hash: "0x5780a696dd3173c1e9c428047eb6bc9d0da9785bce47652659998fee64d8bac2" as Hex, timestamp: 1_793_224_428n };
const oldTxBlock = { number: 12_013_885n, hash: "0x1cd3daf4cef11721feb5d564c0768f42e88d1d14c6c909e64b7cd5532b6f158b" as Hex, timestamp: 1_793_209_392n };
const oldTxHash = "0x83923abf9c1224125296a3485f8cc0a910e7f729ea5d5a73d6f01bf1cdbfe1f5" as Hex;
const oldState = (): HashlessControlledState => ({
  chainId: 11_155_111, safe, delay, usdc, safeNonce: 7n, delayQueueNonce: 3n, delayTxNonce: 2n,
  queue: { queueNonce: 2n, to: funder, value: 1n, data: "0x", operation: 0, createdAt: 1_793_208_888n, expiresAt: 1_793_209_608n },
  safeNativeBalance: 1n, safeUsdcBalance: 20_000_000n, funderUsdcBalance: 0n, effectiveGuardWindow: 1_793_145_600n,
  nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n },
  usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n },
});
function oldProvider(): HashlessEvidenceProvider {
  const tx = { type: "legacy" as const, chainId: 11_155_111, gasPrice: 100_000n, v: 22_310_258n, hash: oldTxHash, recoveredSender: funder, nonce: 809, to: "0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27" as Address, value: 0n, inputHash: "0x25491caa28455d896a7211a1c4532ab1e72412bdb15293292e2e37e5f9406c63" as Hex, gas: 1_820_162n, blockNumber: oldTxBlock.number, blockHash: oldTxBlock.hash };
  return {
    readLatestBlock: async () => ({ number: oldCurrent.number + 5n, hash: h("9"), timestamp: oldCurrent.timestamp + 60n }),
    readBlock: async number => number === oldSelected.number ? oldSelected : number === oldCertified.number ? oldCertified : number === oldCurrent.number ? oldCurrent : number === oldTxBlock.number ? oldTxBlock : undefined,
    readTransaction: async hash => hash === oldTxHash ? tx : undefined,
    readReceipt: async hash => hash === oldTxHash ? { transactionHash: hash, status: "success", blockNumber: oldTxBlock.number, blockHash: oldTxBlock.hash } : undefined,
    readTransactionCount: async (_address, block) => block === oldSelected.number ? 809 : block === oldCertified.number ? 811 : 823,
    readControlledState: async () => structuredClone(oldState()),
  };
}

const cleanup: string[] = [];
function trackedJournal(raw = fixture.sourceJournal) {
  const dir = mkdtempSync(join(tmpdir(), "usdc-successor-source-")); cleanup.push(dir);
  const path = join(dir, "journal.json"); writeFileSync(path, raw);
  return { path, journal: loadHashlessSourceJournalReadOnly(path) };
}

async function source(raw = fixture.sourceJournal): Promise<UsdcSuccessorSource> {
  const original = createOrdinaryScenarioProposal(review, { expectedPackageHash: "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", expectedArtifactBytesHash: "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831" });
  const { journal } = trackedJournal(raw);
  const recoveryCertificate = await reverifyHashlessStateCertificate(fixture.recoveryCertificate, recoveryCertificateHash, journal, [oldProvider(), oldProvider()]);
  const recovery = parseExpiredHashlessContinuationProposal(fixture.recoveryProposal, original, journal, recoveryCertificate);
  const recoveryApproval = loadExpiredHashlessContinuationApproval(recovery, fixture.recoveryApproval, recoveryApprovalHash);
  return { original, recovery, recoveryApproval, journal };
}

const snapshot = { number: 12_016_005n, hash: h("a"), timestamp: 1_793_232_050n };
const tips = [{ number: 12_016_010n, hash: h("b"), timestamp: 1_793_232_110n }, { number: 12_016_012n, hash: h("c"), timestamp: 1_793_232_134n }] as const;
const receiptHashes = [
  "0x0b80a651b416e815930f1664558c29bee5525f496b1410291d40295f85eb11f7",
  "0x5dc85b25ee465159478ddb989dfb7818b9423a7f146510494f8108c3edb0aa3e",
  "0xd99c42d02e46371d4e94cb4ebdb85fd0a5d7127e0fe0399346590e9a9fac10fe",
] as const satisfies readonly Hex[];

function canonicalState(original: UsdcSuccessorSource["original"]): UsdcSuccessorCanonicalState {
  return {
    blockNumber: snapshot.number, blockHash: snapshot.hash, chainId: 11_155_111,
    identityHash: original.publicIdentitiesHash, topologyHash: original.topologyEvidenceHash,
    policyHash: "0x5b19fb0f9dcc35db4d45ec227f01348985431d74a2092d887bc7b4f26ade4a82",
    safe: original.safe, guard: original.guard, delay: original.delay, funder: original.funder, usdc: original.usdc, recipient: original.recipient,
    primarySigner: original.primarySigner, safeContractSecondary: original.safeContractSecondary, ecdsaSecondary: original.ecdsaSecondary,
    safeNonce: 8n, delayQueueNonce: 4n, delayTxNonce: 4n, queue: null,
    safeNativeBalance: 0n, safeUsdcBalance: 20_000_000n, funderUsdcBalance: 0n,
    nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n },
    usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n },
  };
}

function recoveryPostState(src: UsdcSuccessorSource, index: number, block: Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>): UsdcSuccessorCanonicalState {
  const state = { ...canonicalState(src.original), blockNumber: block.number, blockHash: block.hash };
  if (index === 0) return { ...state, safeNonce: 7n, delayQueueNonce: 3n, delayTxNonce: 3n, safeNativeBalance: 1n };
  if (index === 1) {
    const action = src.recovery.actions[1]!; const queue = action.queue!;
    return { ...state, safeNonce: 8n, delayQueueNonce: 4n, delayTxNonce: 3n, safeNativeBalance: 1n, queue: { queueNonce: BigInt(queue.queueNonce), fingerprint: queue.fingerprint, createdAt: block.timestamp, to: queue.to, value: BigInt(queue.value), data: queue.data, operation: queue.operation } };
  }
  return state;
}

type ProviderMutation = Readonly<{ tip?: typeof tips[number]; snapshot?: Partial<typeof snapshot>; state?: Partial<UsdcSuccessorCanonicalState>; receiptState?: Readonly<{ hash: Hex; patch: Partial<UsdcSuccessorCanonicalState> }>; missingBlock?: boolean; reorgHash?: Hex; receipt?: Readonly<{ hash: Hex; patch: Record<string, unknown> }>; transactionMissing?: Hex; latestNonce?: number; pendingNonce?: number }>;
function provider(index: 0 | 1, src: UsdcSuccessorSource, mutation: ProviderMutation = {}): UsdcSuccessorEvidenceProvider {
  const records = src.journal.hashlessContinuation!.actions.slice(0, 3) as any[];
  const state = { ...canonicalState(src.original), ...mutation.state } as UsdcSuccessorCanonicalState;
  const blocks = new Map<bigint, any>([[snapshot.number, { ...snapshot, ...mutation.snapshot }]]);
  for (const record of records) blocks.set(BigInt(record.receipt.blockNumber), { number: BigInt(record.receipt.blockNumber), hash: record.receipt.blockHash, timestamp: 1_793_230_000n + BigInt(records.indexOf(record) * 500) });
  return {
    readLatestBlock: async () => mutation.tip ?? tips[index],
    readBlock: async number => {
      if (mutation.missingBlock && number === snapshot.number) return undefined;
      const block = blocks.get(number); if (!block) return undefined;
      if (mutation.reorgHash && number === snapshot.number) return { ...block, hash: mutation.reorgHash };
      return block;
    },
    readTransaction: async hash => {
      if (mutation.transactionMissing === hash) return undefined;
      const record = records.find(item => item.transactionHash === hash); if (!record) return undefined;
      return { hash, from: funder, nonce: record.outerNonce, to: record.outerTo, value: BigInt(record.outerValue), inputHash: record.outerDataHash, gas: BigInt(record.gas), type: "eip1559", chainId: 11_155_111, maxFeePerGas: BigInt(record.maxFeePerGas), maxPriorityFeePerGas: BigInt(record.maxPriorityFeePerGas), blockNumber: BigInt(record.receipt.blockNumber), blockHash: record.receipt.blockHash };
    },
    readReceipt: async hash => {
      const record = records.find(item => item.transactionHash === hash); if (!record) return undefined;
      const value = { transactionHash: hash, status: record.receipt.status, blockNumber: BigInt(record.receipt.blockNumber), blockHash: record.receipt.blockHash, gasUsed: BigInt(record.receipt.gasUsed), effectiveGasPrice: BigInt(record.receipt.effectiveGasPrice) };
      return mutation.receipt?.hash === hash ? { ...value, ...mutation.receipt.patch } as any : value;
    },
    readTransactionCount: async (_address, block) => block === snapshot.number ? 831 : block === "latest" ? (mutation.latestNonce ?? 831) : (mutation.pendingNonce ?? 831),
    readControlledState: async blockNumber => {
      const index = records.findIndex(item => blockNumber === BigInt(item.receipt.blockNumber));
      const block = blocks.get(blockNumber);
      const receiptState = index >= 0 && block ? recoveryPostState(src, index, block) : state;
      if (mutation.receiptState) {
        const record = records.find(item => item.transactionHash === mutation.receiptState!.hash);
        if (record && blockNumber === BigInt(record.receipt.blockNumber)) return { ...structuredClone(receiptState), ...mutation.receiptState.patch };
      }
      return structuredClone(receiptState);
    },
  };
}

describe("ordinary USDC successor certificate", function () {
  afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
});
