import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import {
  hashHistoricalPrefix,
  isVerifiedHashlessStateCertificate,
  loadHashlessSourceJournalReadOnly,
  reverifyHashlessStateCertificate,
  serializeHashlessStateCertificate,
  verifyHashlessStateCertificate,
  type HashlessControlledState,
  type HashlessEvidenceProvider,
} from "../../../scripts/live/ordinary-scenario-hashless-certificate";

const fixtureRoot = join(__dirname, "../../fixtures/ordinary-hashless");
const journalFixture = readFileSync(join(fixtureRoot, "first38-live-journal-2026-10-28.json"), "utf8");
const artifact = readFileSync(join(fixtureRoot, "hashless-public-state-2026-10-28.json"), "utf8");
const artifactSha = "0xfc9c71e506c6941496501178fc2b826575ede10839fc61fbda838bb747a8f339" as Hex;
const funder = "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address;
const safe = "0xd751a1479f49d63DC61E0081B0b4d8c60623D9a6" as Address;
const delay = "0xB8E143098CcCb9935228022173c2c987DF5FD53a" as Address;
const usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const recipient = funder;
const selectedBlock = Object.freeze({ number: 12_013_857n, hash: "0x197add23b0385bce509adab0a3f3234b58b71e63d0ebccad9aa2e99ba5f44e20" as Hex, timestamp: 1_793_209_056n });
const certificateBlock = Object.freeze({ number: 12_013_934n, hash: "0x05d0f3b8f503bfee60455adc88c717e330aa2bafaffb6badca3b5c8215f3948e" as Hex, timestamp: 1_793_209_980n });
const currentBlock = Object.freeze({ number: 12_013_940n, hash: `0x${"77".repeat(32)}` as Hex, timestamp: 1_793_210_052n });
const latestBlock = Object.freeze({ number: 12_013_945n, hash: `0x${"88".repeat(32)}` as Hex, timestamp: 1_793_210_112n });
const consumingHash = "0x83923abf9c1224125296a3485f8cc0a910e7f729ea5d5a73d6f01bf1cdbfe1f5" as Hex;

const controlledState = (): HashlessControlledState => ({
  chainId: 11_155_111,
  safe,
  delay,
  usdc,
  safeNonce: 7n,
  delayQueueNonce: 3n,
  delayTxNonce: 2n,
  queue: { queueNonce: 2n, to: recipient, value: 1n, data: "0x", operation: 0, createdAt: 1_793_208_888n, expiresAt: 1_793_209_608n },
  safeNativeBalance: 1n,
  safeUsdcBalance: 20_000_000n,
  funderUsdcBalance: 0n,
  effectiveGuardWindow: 1_793_145_600n,
  nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n },
  usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n },
});

type ProviderOptions = Readonly<{
  selected?: Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>;
  certificate?: Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>;
  transaction?: Partial<Awaited<ReturnType<HashlessEvidenceProvider["readTransaction"]>>>;
  receipt?: Partial<Awaited<ReturnType<HashlessEvidenceProvider["readReceipt"]>>>;
  latestNonce?: number;
  pendingNonce?: number;
  certificateNonce?: number;
  selectedNonce?: number;
  currentNonce?: number;
  selectedState?: HashlessControlledState;
  certificateState?: HashlessControlledState;
  currentState?: HashlessControlledState;
  currentRecheckHash?: Hex;
}>;

function provider(options: ProviderOptions = {}): HashlessEvidenceProvider {
  const selected = options.selected ?? selectedBlock;
  const certificate = options.certificate ?? certificateBlock;
  const transaction = {
    hash: consumingHash,
    recoveredSender: funder,
    nonce: 809,
    to: "0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27" as Address,
    value: 0n,
    inputHash: "0x25491caa28455d896a7211a1c4532ab1e72412bdb15293292e2e37e5f9406c63" as Hex,
    gas: 21_000n,
    maxFeePerGas: 30n,
    maxPriorityFeePerGas: 2n,
    blockNumber: 12_013_885n,
    blockHash: "0x1cd3daf4cef11721feb5d564c0768f42e88d1d14c6c909e64b7cd5532b6f158b" as Hex,
    ...options.transaction,
  };
  const receipt = {
    transactionHash: consumingHash,
    status: "success" as const,
    blockNumber: 12_013_885n,
    blockHash: "0x1cd3daf4cef11721feb5d564c0768f42e88d1d14c6c909e64b7cd5532b6f158b" as Hex,
    ...options.receipt,
  };
  let currentReads = 0;
  return Object.freeze({
    readLatestBlock: async () => latestBlock,
    readBlock: async (number: bigint) => {
      if (number === selected.number) return selected;
      if (number === certificate.number) return certificate;
      if (number === transaction.blockNumber) return { number: transaction.blockNumber, hash: transaction.blockHash, timestamp: 1_793_209_392n };
      if (number === currentBlock.number) { currentReads += 1; return currentReads > 1 && options.currentRecheckHash ? { ...currentBlock, hash: options.currentRecheckHash } : currentBlock; }
      return undefined;
    },
    readTransaction: async (hash: Hex) => hash.toLowerCase() === consumingHash.toLowerCase() ? transaction : undefined,
    readReceipt: async (hash: Hex) => hash.toLowerCase() === consumingHash.toLowerCase() ? receipt : undefined,
    readTransactionCount: async (_address: Address, block: bigint | "latest" | "pending") => block === "pending" ? (options.pendingNonce ?? 811) : block === "latest" ? (options.latestNonce ?? 811) : block === selected.number ? (options.selectedNonce ?? 809) : block === certificate.number ? (options.certificateNonce ?? 811) : (options.currentNonce ?? 811),
    readControlledState: async (block: bigint) => structuredClone(block === selected.number ? (options.selectedState ?? controlledState()) : block === certificate.number ? (options.certificateState ?? controlledState()) : (options.currentState ?? controlledState())),
  } as HashlessEvidenceProvider);
}

function sourceFile(contents = journalFixture): Readonly<{ dir: string; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), "hashless-certificate-"));
  const path = join(dir, "journal.json");
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
  return { dir, path };
}

async function verify(source = sourceFile(), providers: readonly [HashlessEvidenceProvider, HashlessEvidenceProvider] = [provider(), provider()]) {
  const journal = loadHashlessSourceJournalReadOnly(source.path);
  return verifyHashlessStateCertificate(artifact, artifactSha, journal, providers);
}

describe("ordinary scenario hashless certificate", function () {
  const cleanup: string[] = [];
  afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const trackedSource = (contents = journalFixture) => { const value = sourceFile(contents); cleanup.push(value.dir); return value; };

  it("brands only an independently verified canonical certificate", async function () {
    const certificate = await verify(trackedSource());
    expect(isVerifiedHashlessStateCertificate(certificate)).to.equal(true);
    expect(certificate.nonce809.kind).to.equal("NONCE_809_INVALIDATED");
    expect(certificate.source.interruptionRevision).to.equal("1e24c636b665b8d44f5755e0e30fd6d485939d35");
    expect(certificate.source.laterCorrectedRevision).to.equal("e11a893fd36913411e7f7c4598832e96bdf368b7");
    expect(certificate.source.failureCause).to.equal("UNKNOWN");
    expect(certificate.currentSnapshot.funderUsdcBalance).to.equal(0n);
  });

  it("reverifies the recorded certificate without regenerating it after later funder traffic", async function () {
    const source = trackedSource();
    const journal = loadHashlessSourceJournalReadOnly(source.path);
    const certificate = await verifyHashlessStateCertificate(artifact, artifactSha, journal, [provider(), provider()]);
    const serialized = serializeHashlessStateCertificate(certificate);
    const reverified = await reverifyHashlessStateCertificate(serialized, certificate.certificateHash, journal, [
      provider({ latestNonce: 901, pendingNonce: 902 }),
      provider({ latestNonce: 901, pendingNonce: 902 }),
    ]);

    expect(reverified.certificateHash).to.equal(certificate.certificateHash);
    expect(reverified.currentSnapshot).to.deep.equal(certificate.currentSnapshot);
    const extra = JSON.parse(serialized); extra.trusted = true;
    await expect(reverifyHashlessStateCertificate(JSON.stringify(extra), certificate.certificateHash, journal, [provider(), provider()])).to.be.rejectedWith(/shape|certificate/i);
    await expect(reverifyHashlessStateCertificate(serialized, `0x${"00".repeat(32)}` as Hex, journal, [provider(), provider()])).to.be.rejectedWith(/hash/i);
    await expect(reverifyHashlessStateCertificate(serialized, certificate.certificateHash, journal, [provider({ selectedNonce: 810 }), provider({ selectedNonce: 810 })])).to.be.rejectedWith(/selected|809|nonce/i);
    await expect(reverifyHashlessStateCertificate(serialized, certificate.certificateHash, journal, [provider({ currentRecheckHash: `0x${"aa".repeat(32)}` as Hex }), provider({ currentRecheckHash: `0x${"aa".repeat(32)}` as Hex })])).to.be.rejectedWith(/reorg|canonical/i);
  });

  it("rejects_mutated_prefix", async function () {
    const original = JSON.parse(journalFixture) as any;
    const mutations: Array<[string, (value: any) => void]> = [
      ["row order", value => value.actions.reverse()],
      ["row status", value => { value.actions[0].status = "stopped"; }],
      ["row hash", value => { value.actions[0].evidenceHash = `0x${"11".repeat(32)}`; }],
      ["receipt", value => { value.actions[0].receipt.blockNumber = "1"; }],
      ["action count", value => { value.actions.pop(); }],
      ["entry order", value => value.liveJournal.entries.reverse()],
      ["entry status", value => { value.liveJournal.entries[0].status = "pending"; delete value.liveJournal.entries[0].receipt; }],
      ["entry hash", value => { value.liveJournal.entries[0].transactionHash = `0x${"22".repeat(32)}`; }],
      ["entry receipt", value => { value.liveJournal.entries[0].receipt.blockHash = `0x${"33".repeat(32)}`; }],
      ["entry count", value => { value.liveJournal.entries.pop(); }],
      ["row19 source hash", value => { value.actions[18].transactionHash = `0x${"44".repeat(32)}`; }],
      ["row19 source live entry", value => { value.liveJournal.entries.push({ ...value.liveJournal.entries[0], id: "native-queue-ready-execute" }); }],
    ];
    for (const [label, mutate] of mutations) {
      const value = structuredClone(original); mutate(value);
      await expect(verify(trackedSource(`${JSON.stringify(value)}\n`))).to.be.rejectedWith(/historical|source/i, label);
    }
  });

  it("keeps_hash_after_entry_growth", function () {
    const source = trackedSource();
    const journal = loadHashlessSourceJournalReadOnly(source.path);
    const before = hashHistoricalPrefix(journal);
    journal.actions.push({ id: "continuation-only", commitment: `0x${"55".repeat(32)}` as Hex, status: "stopped" });
    journal.liveJournal.entries.push({ ...journal.liveJournal.entries[0]!, id: "continuation-only" });
    expect(hashHistoricalPrefix(journal)).to.equal(before);
  });

  it("rejects a reloaded twentieth original action even with a continuation key", async function () {
    const value = JSON.parse(journalFixture) as any;
    value.actions.push({ ...value.actions[18], id: "top-level-lineage-violation" });
    value.hashlessContinuation = { actions: [] };
    const source = trackedSource(`${JSON.stringify(value)}\n`);

    await expect(verify(source)).to.be.rejectedWith(/top-level actions|19/);
  });

  it("classifies_nonce809", async function () {
    expect(isVerifiedHashlessStateCertificate(await verify(trackedSource()))).to.equal(true);

    const exactEnvelope = { to: delay, value: 0n, inputHash: "0xc1e7bbfb9942640a3d4bfadf4540cbe0f5c8bd92f1cd8adeb0ca58bcaba7c24f" as Hex, gas: 300_000n, maxFeePerGas: 28n, maxPriorityFeePerGas: 2n };
    await expect(verify(trackedSource(), [provider({ transaction: exactEnvelope }), provider({ transaction: exactEnvelope })])).to.be.rejectedWith("MATCH_FOUND_RECONCILE");

    for (const [label, providers] of [
      ["unused", [provider({ latestNonce: 809, pendingNonce: 809 }), provider({ latestNonce: 809, pendingNonce: 809 })]],
      ["pending", [provider({ latestNonce: 809, pendingNonce: 810 }), provider({ latestNonce: 809, pendingNonce: 810 })]],
      ["wrong sender", [provider({ transaction: { recoveredSender: "0x0000000000000000000000000000000000000001" as Address } }), provider({ transaction: { recoveredSender: "0x0000000000000000000000000000000000000001" as Address } })]],
      ["under six confirmations", [provider({ certificate: { ...certificateBlock, number: 12_013_889n } }), provider({ certificate: { ...certificateBlock, number: 12_013_889n } })]],
      ["provider disagreement", [provider(), provider({ transaction: { to: "0x0000000000000000000000000000000000000002" as Address } })]],
      ["reorg", [provider(), provider({ certificate: { ...certificateBlock, hash: `0x${"66".repeat(32)}` as Hex } })]],
    ] as Array<[string, [HashlessEvidenceProvider, HashlessEvidenceProvider]]>) {
      await expect(verify(trackedSource(), providers)).to.be.rejectedWith(/nonce|provider|canonical|confirmation|sender/i, label);
    }
  });

  it("accepts external funder traffic but rejects current controlled drift, reorg, and raw-window drift", async function () {
    const traffic = [provider({ currentNonce: 812, latestNonce: 813, pendingNonce: 814 }), provider({ currentNonce: 812, latestNonce: 813, pendingNonce: 814 })] as const;
    expect(isVerifiedHashlessStateCertificate(await verify(trackedSource(), traffic))).to.equal(true);

    const changed = controlledState(); changed.safeNativeBalance = 0n;
    await expect(verify(trackedSource(), [provider({ currentState: changed }), provider({ currentState: changed })])).to.be.rejectedWith(/current|controlled|state/i);

    const funderBalance = controlledState(); funderBalance.funderUsdcBalance = 1n;
    await expect(verify(trackedSource(), [provider({ currentState: funderBalance }), provider({ currentState: funderBalance })])).to.be.rejectedWith(/current|controlled|state|balance/i);

    const window = controlledState(); window.nativeSpend.window += 86_400n;
    await expect(verify(trackedSource(), [provider({ currentState: window }), provider({ currentState: window })])).to.be.rejectedWith(/window|current|controlled|state/i);

    const inventedUsdcWindow = controlledState(); inventedUsdcWindow.usdcSpend.window = inventedUsdcWindow.effectiveGuardWindow;
    await expect(verify(trackedSource(), [provider({ currentState: inventedUsdcWindow }), provider({ currentState: inventedUsdcWindow })])).to.be.rejectedWith(/window|current|controlled|state/i);

    await expect(verify(trackedSource(), [provider({ currentRecheckHash: `0x${"99".repeat(32)}` as Hex }), provider({ currentRecheckHash: `0x${"99".repeat(32)}` as Hex })])).to.be.rejectedWith(/reorg|current|canonical/i);
  });

  it("rejects_source_drift", async function () {
    const base = controlledState();
    const drifts: Array<[string, (state: HashlessControlledState) => void]> = [
      ["Safe nonce", state => { state.safeNonce = 8n; }],
      ["Delay queue nonce", state => { state.delayQueueNonce = 4n; }],
      ["Delay tx nonce", state => { state.delayTxNonce = 3n; }],
      ["queue tuple", state => { state.queue.value = 2n; }],
      ["createdAt", state => { state.queue.createdAt += 1n; }],
      ["expiry", state => { state.queue.expiresAt += 1n; }],
      ["native balance", state => { state.safeNativeBalance = 0n; }],
      ["USDC balance", state => { state.safeUsdcBalance = 19_999_999n; }],
      ["funder USDC balance", state => { state.funderUsdcBalance = 1n; }],
      ["native base counter", state => { state.nativeSpend.baseSpent -= 1n; }],
      ["native instant counter", state => { state.nativeSpend.instantSpent -= 1n; }],
      ["USDC counter", state => { state.usdcSpend.instantSpent = 1n; }],
      ["window", state => { state.effectiveGuardWindow += 86_400n; }],
    ];
    for (const [label, mutate] of drifts) {
      const state = structuredClone(base); mutate(state);
      const states = { selectedState: state, certificateState: state, currentState: state };
      await expect(verify(trackedSource(), [provider(states), provider(states)])).to.be.rejectedWith(/controlled|queue|source|state/i, label);
    }

    const locked = trackedSource(); writeFileSync(`${locked.path}.lock`, "999\n");
    expect(() => loadHashlessSourceJournalReadOnly(locked.path)).to.throw(/lock/i);
    const temporary = trackedSource(); writeFileSync(`${temporary.path}.123.tmp`, "partial");
    expect(() => loadHashlessSourceJournalReadOnly(temporary.path)).to.throw(/temp/i);
  });

  it("rejects_bad_runtime_json", async function () {
    const valid = JSON.parse(artifact) as any;
    const bad: Array<[string, unknown]> = [
      ["missing", { ...valid, selected: undefined }],
      ["malformed", "{"],
      ["extra", { ...valid, trustedSuccess: true }],
      ["coercion", { ...valid, failedOuterNonce: "809" }],
    ];
    for (const [label, value] of bad) {
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      await expect(verifyHashlessStateCertificate(serialized, artifactSha, loadHashlessSourceJournalReadOnly(trackedSource().path), [provider(), provider()])).to.be.rejectedWith(/artifact|JSON|shape|hash/i, label);
    }
    expect(isVerifiedHashlessStateCertificate({ kind: "VERIFIED_HASHLESS_STATE_CERTIFICATE", nonce809: { kind: "NONCE_809_INVALIDATED" } })).to.equal(false);
  });
});
